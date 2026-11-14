import { existsSync } from "node:fs";
import { join } from "node:path";
import { Project, SyntaxKind } from "ts-morph";
import type { GraphStore } from "../graph/store.js";
import { createMemoryStore } from "../graph/memory.js";
import type { GraphEdge } from "../graph/types.js";
import { makeNodeId } from "../graph/types.js";
import type { CallMetrics, ReExportMap } from "./extract.js";
import { collectReExportMap, extractFile } from "./extract.js";
import { resolveImports } from "./resolve.js";
import { SKIP_DIR_NAMES } from "../packs/discover.js";
import { registerPacks } from "../packs/index.js";
import { runPackPasses } from "./pack-pipeline.js";

/** Per-language roll-up of one merged index run. inferred counts cross-file
 *  pack resolutions only (ts-morph edges are never inferred); external counts
 *  sites that produced no edge at all (e.g. bash toolchain commands). */
export interface LanguageRunMetrics {
  files: number;
  callSites: number;
  resolved: number;
  unresolved: number;
  external: number;
  inferred: number;
  unparseable: number;
  dangerousSinks: number;
}

export type IndexMetrics = IndexResult["metrics"];

export interface IndexResult {
  store: GraphStore;
  metrics: CallMetrics & {
    files: number;
    dynamicImports: number;
    durationMs: number;
    /** keys: "typescript" | "javascript" + pack ids ("python" | "php" | "bash"), files > 0 only */
    languages: Record<string, LanguageRunMetrics>;
  };
}

const SKIPPED_DIRS = new Set(SKIP_DIR_NAMES); // shared with pack discovery — vendor/ joins the TS pass here
const TS_SOURCE_GLOB = "**/*.{ts,tsx}";
const ALLOWJS_SOURCE_GLOB = "**/*.{ts,tsx,js,jsx,mjs,cjs}";

/** True for files the allowJs glob admits as JavaScript (not .ts/.tsx). */
function isJsFile(relPath: string): boolean {
  return /\.(js|jsx|mjs|cjs)$/.test(relPath);
}

/** Repo-relative posix paths of all indexable source files, deterministic order. */
function globSourceFiles(repoRoot: string, glob: string): string[] {
  const scanner = new Bun.Glob(glob);
  const out: string[] = [];
  for (const entry of scanner.scanSync({ cwd: repoRoot })) {
    const segments = entry.split(/[\\/]/);
    if (segments.some((segment) => SKIPPED_DIRS.has(segment))) continue;
    out.push(segments.join("/"));
  }
  return out.sort();
}

export interface PreparedProject {
  project: Project;
  relPaths: string[];
  reExported: ReExportMap;
  /** false ⇒ the allowJs line-item is active (no tsconfig.json at the root) */
  hasTsconfig: boolean;
}

/** Glob + one shared Project (repo tsconfig when present) + precomputed re-export map.
 *  WITHOUT a tsconfig the allowJs line-item applies: allowJs compiler options and
 *  the widened js glob (a standalone-JS repo indexes instead of failing). WITH a
 *  tsconfig nothing widens — existing repos' graphs must not move. */
export function prepareProject(repoRoot: string): PreparedProject {
  const tsconfigPath = join(repoRoot, "tsconfig.json");
  const hasTsconfig = existsSync(tsconfigPath);
  const relPaths = globSourceFiles(repoRoot, hasTsconfig ? TS_SOURCE_GLOB : ALLOWJS_SOURCE_GLOB);

  const project = hasTsconfig
    ? new Project({ tsConfigFilePath: tsconfigPath })
    : new Project({ compilerOptions: { allowJs: true } });
  // guarantee every walked file is in the project even when the tsconfig's
  // include is narrower or solution-style; already-present files are left alone
  const missing = relPaths.filter((rel) => project.getSourceFile(join(repoRoot, rel)) === undefined);
  if (missing.length > 0) project.addSourceFilesAtPaths(missing.map((rel) => join(repoRoot, rel)));

  return { project, relPaths, reExported: collectReExportMap(project), hasTsconfig };
}

/** The ts-morph pass over TypeScript/JavaScript files (the pre-pack pipeline body). */
export function indexTsRepo(repoRoot: string): IndexResult {
  const startedAt = performance.now();
  const { project, relPaths, reExported, hasTsconfig } = prepareProject(repoRoot);
  const store = createMemoryStore();
  const metrics: IndexResult["metrics"] = {
    callSites: 0,
    resolved: 0,
    external: 0,
    unresolved: 0,
    files: 0,
    dynamicImports: 0,
    durationMs: 0,
    languages: {},
  };
  const pendingEdges: GraphEdge[] = [];
  const walked = new Set(relPaths);

  for (const relPath of relPaths) {
    const sourceFile = project.getSourceFile(join(repoRoot, relPath));
    if (sourceFile === undefined) continue;

    const extraction = extractFile(project, sourceFile, repoRoot, relPath, reExported.get(sourceFile));
    // allowJs line-item: nodes of .js* files index as javascript, .ts* stay typescript
    if (!hasTsconfig && isJsFile(relPath)) {
      for (const node of extraction.nodes) node.language = "javascript";
    }
    for (const node of extraction.nodes) store.upsertNode(node);
    pendingEdges.push(...extraction.edges, ...extraction.callEdges);

    // imports edges between File nodes (Task 9 resolution), closed over the walked set
    const fileId = makeNodeId("File", relPath);
    for (const target of resolveImports(project, sourceFile, repoRoot)) {
      if (!walked.has(target)) continue;
      pendingEdges.push({ kind: "imports", from: fileId, to: makeNodeId("File", target) });
    }

    // dynamic import() is not an edge in v1 — counted in pipeline stats only
    metrics.dynamicImports += sourceFile
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter((call) => call.getExpression().getKind() === SyntaxKind.ImportKeyword)
      .length;

    // per-language roll-up alongside the global one
    const language = !hasTsconfig && isJsFile(relPath) ? "javascript" : "typescript";
    const lang =
      metrics.languages[language] ??
      { files: 0, callSites: 0, resolved: 0, unresolved: 0, external: 0, inferred: 0, unparseable: 0, dangerousSinks: 0 };
    lang.files++;
    lang.callSites += extraction.metrics.callSites;
    lang.resolved += extraction.metrics.resolved;
    lang.external += extraction.metrics.external;
    lang.unresolved += extraction.metrics.unresolved;
    metrics.languages[language] = lang;

    metrics.files++;
    metrics.callSites += extraction.metrics.callSites;
    metrics.resolved += extraction.metrics.resolved;
    metrics.external += extraction.metrics.external;
    metrics.unresolved += extraction.metrics.unresolved;
  }

  // all nodes are upserted before any edge lands: dangling edges are dropped by
  // snapshots and skew store stats (both endpoints must exist)
  for (const edge of pendingEdges) store.addEdge(edge);

  metrics.durationMs = Math.round(performance.now() - startedAt);
  return { store, metrics };
}

/**
 * Full index of a repo — the canonical entry: the ts-morph TypeScript/JavaScript
 * pass plus every registered language pack merged into ONE store. Skips
 * node_modules/.git/dist/build/coverage/vendor. registerPacks() is called here
 * (idempotent), so the merged index always sees the production packs.
 */
export async function indexRepo(repoRoot: string): Promise<IndexResult> {
  const startedAt = performance.now();
  registerPacks();
  const result = indexTsRepo(repoRoot);
  const { store } = result;

  // walked = files actually in the index; pack passes add their own as discovered
  const walked = new Set(store.allNodes().filter((n) => n.kind === "File").map((n) => n.filePath));
  const { metrics: packMetrics } = await runPackPasses(repoRoot, store, walked);

  for (const [language, lang] of Object.entries(packMetrics)) {
    result.metrics.languages[language] = lang;
    result.metrics.files += lang.files;
    result.metrics.callSites += lang.callSites;
    result.metrics.resolved += lang.resolved;
    result.metrics.unresolved += lang.unresolved;
    result.metrics.external += lang.external;
  }
  result.metrics.durationMs = Math.round(performance.now() - startedAt);
  return result;
}
