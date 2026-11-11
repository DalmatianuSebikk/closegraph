import { existsSync } from "node:fs";
import { join } from "node:path";
import { Project, SyntaxKind } from "ts-morph";
import type { GraphStore } from "../graph/store.js";
import { createMemoryStore } from "../graph/memory.js";
import type { GraphEdge } from "../graph/types.js";
import { makeNodeId } from "../graph/types.js";
import type { CallMetrics } from "./extract.js";
import { collectReExportMap, extractFile } from "./extract.js";
import { resolveImports } from "./resolve.js";

export interface IndexResult {
  store: GraphStore;
  metrics: CallMetrics & { files: number; dynamicImports: number; durationMs: number };
}

const SKIPPED_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage"]);
const SOURCE_GLOB = "**/*.{ts,tsx}";

/** Repo-relative posix paths of all indexable source files, deterministic order. */
function globSourceFiles(repoRoot: string): string[] {
  const glob = new Bun.Glob(SOURCE_GLOB);
  const out: string[] = [];
  for (const entry of glob.scanSync({ cwd: repoRoot })) {
    const segments = entry.split(/[\\/]/);
    if (segments.some((segment) => SKIPPED_DIRS.has(segment))) continue;
    out.push(segments.join("/"));
  }
  return out.sort();
}

/** Full index of a repo. Skips node_modules/.git/dist/build/coverage. */
export function indexRepo(repoRoot: string): IndexResult {
  const startedAt = performance.now();
  const relPaths = globSourceFiles(repoRoot);

  const tsconfigPath = join(repoRoot, "tsconfig.json");
  const project = existsSync(tsconfigPath)
    ? new Project({ tsConfigFilePath: tsconfigPath })
    : new Project({ skipAddingFilesFromTsConfig: false });
  // guarantee every walked file is in the project even when the tsconfig's
  // include is narrower or solution-style; already-present files are left alone
  const missing = relPaths.filter((rel) => project.getSourceFile(join(repoRoot, rel)) === undefined);
  if (missing.length > 0) project.addSourceFilesAtPaths(missing.map((rel) => join(repoRoot, rel)));

  const reExported = collectReExportMap(project);
  const store = createMemoryStore();
  const metrics: IndexResult["metrics"] = {
    callSites: 0,
    resolved: 0,
    external: 0,
    unresolved: 0,
    files: 0,
    dynamicImports: 0,
    durationMs: 0,
  };
  const pendingEdges: GraphEdge[] = [];
  const walked = new Set(relPaths);

  for (const relPath of relPaths) {
    const sourceFile = project.getSourceFile(join(repoRoot, relPath));
    if (sourceFile === undefined) continue;

    const extraction = extractFile(project, sourceFile, repoRoot, relPath, reExported.get(sourceFile));
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
