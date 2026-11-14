import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { indexRepo } from "./indexer/pipeline.js";
import { isStale, restoreSnapshot, takeSnapshot } from "./graph/snapshot.js";
import type { GraphStore } from "./graph/store.js";
import type { SnapshotData } from "./graph/snapshot.js";
import type { CallMetrics } from "./indexer/extract.js";
import type { GraphEdge } from "./graph/types.js";

const USAGE =
  "usage: bun run src/cli.ts <repoPath> [--snapshot out.json] [--export graph.json] [--callers <qualifiedName>] [hook install|uninstall]";

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) return undefined;
  return value;
}

const positional = process.argv.slice(2).filter((a) => !a.startsWith("--") && !isFlagValue(a));
function isFlagValue(arg: string): boolean {
  const prev = process.argv[process.argv.indexOf(arg) - 1];
  return prev === "--snapshot" || prev === "--callers" || prev === "--export";
}

const repoPath = resolve(positional[0] ?? "");
const snapshotPath = argValue("--snapshot");
const exportPath = argValue("--export");
const callersName = argValue("--callers");

// --snapshot/--export with a missing or flag-like value would silently skip writing
// (argValue yields undefined) — that deserves a usage error
if (process.argv.includes("--snapshot") && snapshotPath === undefined) {
  console.error(`[codegraph] --snapshot requires a file path value\n${USAGE}`);
  process.exit(1);
}
if (process.argv.includes("--export") && exportPath === undefined) {
  console.error(`[codegraph] --export requires a file path value\n${USAGE}`);
  process.exit(1);
}

// the only multi-positional form is `hook install|uninstall`
const hookMode = positional[1] === "hook";
if (positional.length > 1 && !(hookMode && positional.length === 3)) {
  console.error(USAGE);
  process.exit(1);
}
if (hookMode && positional[2] !== "install" && positional[2] !== "uninstall") {
  console.error(`[closegraph] hook expects install or uninstall (got ${positional[2] ?? "nothing"})\n${USAGE}`);
  process.exit(1);
}

if (positional.length === 0) {
  console.error(USAGE);
  process.exit(1);
}
if (!existsSync(repoPath)) {
  console.error(`[closegraph] no such directory: ${repoPath}`);
  process.exit(1);
}

/** Marker line proving a post-commit hook is ours — uninstall refuses foreign hooks. */
const HOOK_MARKER = "# closegraph post-commit hook";

if (hookMode) {
  // hook takes no flags — a silent drop would lie about what ran (review M5)
  const strayFlags = process.argv.slice(2).filter((a) => a.startsWith("--"));
  if (strayFlags.length > 0) {
    console.error(`[closegraph] unknown flag in hook mode: ${strayFlags.join(", ")} — hook takes no flags\n${USAGE}`);
    process.exit(1);
  }
  const gitDir = join(repoPath, ".git");
  if (!existsSync(gitDir)) {
    console.error(`[closegraph] not a git repo: ${repoPath} — the post-commit hook needs one`);
    process.exit(1);
  }
  // linked worktrees/submodules carry .git as a FILE — mkdir would die on ENOTDIR (review M3)
  if (statSync(gitDir).isFile()) {
    console.error(
      `[closegraph] ${repoPath} looks like a linked worktree or submodule (.git is a file) — install the hook from the main checkout`,
    );
    process.exit(1);
  }
  mkdirSync(join(repoPath, ".git", "hooks"), { recursive: true });
  const hook = join(repoPath, ".git", "hooks", "post-commit");
  if (positional[2] === "install") {
    if (existsSync(hook)) {
      console.error(`[closegraph] refusing to overwrite existing post-commit hook: ${hook}`);
      process.exit(1);
    }
    const cliAbs = resolve(import.meta.path);
    // the refresh lands on a *.snapshot.json path — gitignored by the closegraph convention
    const snapshotOut = join(repoPath, "closegraph.snapshot.json");
    // every path is shell-quoted (spaces survive, review I1) and the re-index is
    // backgrounded so a commit never blocks on ts-morph (review I2); `|| true`
    // keeps a missing bun or a crashed index invisible to git either way
    const snippet = [
      "#!/bin/sh",
      `${HOOK_MARKER} — refresh the code-graph snapshot after every commit`,
      `bun run "${cliAbs}" "${repoPath}" --snapshot "${snapshotOut}" >/dev/null 2>&1 || true &`,
      "",
    ].join("\n");
    writeFileSync(hook, snippet, { mode: 0o755 });
    console.log(`[closegraph] post-commit hook installed → ${hook}`);
    console.log(`[closegraph] it re-indexes ${repoPath} in the background after every commit, refreshing ${snapshotOut}`);
    // the hook's snapshot must not surface as untracked noise in THIS repo (final
    // review I1): if nothing ignores it, exclude it locally — never edit .gitignore
    if (!snapshotIgnored(repoPath, snapshotOut)) {
      const exclude = join(repoPath, ".git", "info", "exclude");
      try {
        mkdirSync(dirname(exclude), { recursive: true });
        appendFileSync(exclude, `\n# closegraph post-commit hook artifact\n${basename(snapshotOut)}\n`);
        console.log(
          `[closegraph] ${basename(snapshotOut)} is not git-ignored — added it to .git/info/exclude (local only; your worktree stays clean)`,
        );
      } catch {
        console.error(
          `[closegraph] warning: ${basename(snapshotOut)} is not git-ignored and .git/info/exclude is not writable — add it to your .gitignore or it will show as untracked`,
        );
      }
    }
    process.exit(0);
  }
  // uninstall
  if (!existsSync(hook)) {
    console.log(`[closegraph] no closegraph hook installed at ${hook}`);
    process.exit(0);
  }
  if (!readFileSync(hook, "utf8").includes(HOOK_MARKER)) {
    console.error(`[closegraph] refusing to remove a non-closegraph hook: ${hook}`);
    process.exit(1);
  }
  rmSync(hook);
  console.log("[closegraph] post-commit hook removed");
  process.exit(0);
}

function currentGitHead(): string | undefined {
  try {
    const head = execSync("git rev-parse HEAD", { cwd: repoPath, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return head === "" ? undefined : head;
  } catch {
    return undefined; // not a git repo
  }
}

interface LoadedGraph {
  store: GraphStore;
  /** site-based metrics when freshly indexed; undefined when reused from a snapshot */
  metrics?: CallMetrics & { files: number; dynamicImports: number; durationMs: number };
}

/**
 * Atomic file write (review M1): temp file in the SAME directory, then rename —
 * POSIX rename is atomic, so concurrent hook-triggered runs can never interleave
 * into a torn snapshot (the reader self-heals, but never even sees a partial file).
 * The finally-cleanup covers a failed rename leaving the dot-prefixed temp behind
 * (final-review carried (a): the temp's `.tmp-<pid>` suffix escapes `*.snapshot.json`).
 */
function writeAtomic(path: string, contents: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}`);
  writeFileSync(tmp, contents);
  try {
    renameSync(tmp, path);
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { force: true });
  }
}

/** True when git already ignores the path: `git check-ignore -q`, with a simple
 *  .gitignore-glob scan as the fallback for check-ignore failures (final review I1). */
function snapshotIgnored(repo: string, path: string): boolean {
  const check = Bun.spawnSync(["git", "check-ignore", "-q", "--", path], {
    cwd: repo,
    stdout: "ignore",
    stderr: "ignore",
  });
  if (check.exitCode === 0) return true;
  const gitignore = join(repo, ".gitignore");
  if (!existsSync(gitignore)) return false;
  const base = basename(path);
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return readFileSync(gitignore, "utf8")
    .split("\n")
    .some((line) => {
      const pattern = line.trim();
      if (pattern === "" || pattern.startsWith("#") || pattern.startsWith("!")) return false;
      const glob = new RegExp(`^${pattern.split("*").map(escape).join(".*")}$`);
      return glob.test(base) || glob.test(`/${base}`);
    });
}

function loadGraph(): LoadedGraph {
  // snapshot reuse: staleness needs a gitHead on BOTH sides (ledger Ruling 13 —
  // undefined on either side means "cannot detect staleness", i.e. not stale)
  if (snapshotPath !== undefined && existsSync(snapshotPath)) {
    let snap: SnapshotData | undefined;
    try {
      snap = JSON.parse(readFileSync(snapshotPath, "utf8")) as SnapshotData;
      // same repoRoot match the plugin side performs (graph-service): a snapshot from
      // another repo must never be served for this one (final review M8)
      if (snap.repoRoot !== repoPath) {
        console.log(
          `[closegraph] snapshot ${snapshotPath} was taken for a different repo (${String(snap.repoRoot)}) — refusing it, reindexing`,
        );
      } else {
        const store = restoreSnapshot(snap);
        const head = currentGitHead();
        if (snap.gitHead === undefined || head === undefined) {
          const why = snap.gitHead === undefined ? "snapshot has no git head" : "repo has no git head";
          console.log(`[closegraph] cannot detect staleness (${why}) — reusing snapshot ${snapshotPath}`);
          return { store };
        }
        if (!isStale(snap, head)) {
          console.log(`[closegraph] snapshot ${snapshotPath} is up to date — reusing`);
          return { store };
        }
        console.log(`[closegraph] snapshot ${snapshotPath} is stale — reindexing`);
      }
    } catch (error) {
      console.log(`[closegraph] snapshot ${snapshotPath} unreadable (${(error as Error).message}) — reindexing`);
    }
  }
  const result = indexRepo(repoPath);
  console.log(`[closegraph] indexed ${result.metrics.files} files in ${result.metrics.durationMs}ms`);
  if (snapshotPath !== undefined) {
    writeAtomic(snapshotPath, JSON.stringify(takeSnapshot(result.store, repoPath, currentGitHead()), null, 2));
    console.log(`[closegraph] snapshot written to ${snapshotPath}`);
  }
  return result;
}

const { store, metrics } = loadGraph();

const stats = store.stats();
console.log(
  `files: ${stats.files}  functions: ${stats.functions}  classes: ${stats.classes}  edges: ${stats.edges}  unresolvedCalls: ${stats.unresolvedCalls}`,
);

/** Export-only provenance tag (Ruling 5: computed from existing edge fields, no core schema change):
 *  - calls to `external:*` targets → "external" (callee could not be pinned to a project node)
 *  - calls flagged unresolved with a project id → "unresolved" (defensive: today's indexer
 *    always pairs unresolved with external: targets, but the export computes from fields)
 *  - everything else → "resolved" (contains/imports are syntax facts; calls that resolved). */
function edgeProvenance(edge: GraphEdge): "resolved" | "unresolved" | "external" {
  if (edge.kind === "calls" && edge.to.startsWith("external:")) return "external";
  if (edge.kind === "calls" && edge.unresolved === true) return "unresolved";
  return "resolved";
}

if (exportPath !== undefined) {
  const snap = takeSnapshot(store, repoPath, currentGitHead());
  const enriched: SnapshotData = {
    ...snap,
    edges: snap.edges.map((e) => ({ ...e, provenance: edgeProvenance(e) })),
  };
  // graph.json is the file users are told to commit — it gets the same atomic
  // write as the snapshot (final review M7)
  writeAtomic(exportPath, JSON.stringify(enriched, null, 2));
  console.log(`[closegraph] graph.json exported to ${exportPath} (${enriched.edges.length} edges tagged with provenance)`);
}

if (metrics !== undefined) {
  const denominator = metrics.resolved + metrics.unresolved;
  const rate = denominator > 0 ? metrics.resolved / denominator : 1;
  console.log(`resolution rate: ${rate.toFixed(4)} (callSites: ${metrics.callSites}, external: ${metrics.external}, dynamicImports: ${metrics.dynamicImports})`);
} else {
  // snapshots persist edges, not per-site metrics: fall back to an edge-based rate
  let resolvedCalls = 0;
  let unresolvedCalls = 0;
  for (const node of store.allNodes()) {
    for (const edge of store.edgesFrom(node.id, "calls")) {
      if (edge.unresolved) unresolvedCalls++;
      else resolvedCalls++;
    }
  }
  const denominator = resolvedCalls + unresolvedCalls;
  console.log(`resolution rate: ${(denominator > 0 ? resolvedCalls / denominator : 1).toFixed(4)} (edge-based; index without an existing snapshot for site-based metrics)`);
}

if (callersName !== undefined) {
  const nodeId = callersName.includes(":") ? callersName : `Function:${callersName}`;
  if (store.getNode(nodeId) === undefined) {
    console.error(`[closegraph] symbol not found: ${callersName} (looked for node ${nodeId})`);
    process.exit(1);
  }
  const blastRadius = store.transitiveCallers([nodeId]);
  console.log(`transitive callers (blast radius) of ${nodeId}: ${blastRadius.size}`);
  for (const id of [...blastRadius].sort()) {
    const node = store.getNode(id);
    console.log(`  - ${node?.qualifiedName ?? id}`);
  }
}
