import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { indexRepo } from "./indexer/pipeline.js";
import { isStale, restoreSnapshot, takeSnapshot } from "./graph/snapshot.js";
import type { GraphStore } from "./graph/store.js";
import type { SnapshotData } from "./graph/snapshot.js";
import type { CallMetrics } from "./indexer/extract.js";

const USAGE = "usage: bun run src/cli.ts <repoPath> [--snapshot out.json] [--callers <qualifiedName>]";

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
  return prev === "--snapshot" || prev === "--callers";
}

const repoPath = resolve(positional[0] ?? "");
const snapshotPath = argValue("--snapshot");
const callersName = argValue("--callers");

// --snapshot with a missing or flag-like value would silently skip writing
// the snapshot (argValue yields undefined) — that deserves a usage error
if (process.argv.includes("--snapshot") && snapshotPath === undefined) {
  console.error(`[codegraph] --snapshot requires a file path value\n${USAGE}`);
  process.exit(1);
}

if (positional.length === 0 || positional.length > 1) {
  console.error(USAGE);
  process.exit(1);
}
if (!existsSync(repoPath)) {
  console.error(`[closegraph] no such directory: ${repoPath}`);
  process.exit(1);
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

function loadGraph(): LoadedGraph {
  // snapshot reuse: staleness needs a gitHead on BOTH sides (ledger Ruling 13 —
  // undefined on either side means "cannot detect staleness", i.e. not stale)
  if (snapshotPath !== undefined && existsSync(snapshotPath)) {
    let snap: SnapshotData | undefined;
    try {
      snap = JSON.parse(readFileSync(snapshotPath, "utf8")) as SnapshotData;
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
    } catch (error) {
      console.log(`[closegraph] snapshot ${snapshotPath} unreadable (${(error as Error).message}) — reindexing`);
    }
  }
  const result = indexRepo(repoPath);
  console.log(`[closegraph] indexed ${result.metrics.files} files in ${result.metrics.durationMs}ms`);
  if (snapshotPath !== undefined) {
    writeFileSync(snapshotPath, JSON.stringify(takeSnapshot(result.store, repoPath, currentGitHead()), null, 2));
    console.log(`[closegraph] snapshot written to ${snapshotPath}`);
  }
  return result;
}

const { store, metrics } = loadGraph();

const stats = store.stats();
console.log(
  `files: ${stats.files}  functions: ${stats.functions}  classes: ${stats.classes}  edges: ${stats.edges}  unresolvedCalls: ${stats.unresolvedCalls}`,
);

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
