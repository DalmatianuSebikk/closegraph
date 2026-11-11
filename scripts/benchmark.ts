import { join, resolve } from "node:path";
import { indexRepo, prepareProject } from "../src/indexer/pipeline.js";
import { extractFile } from "../src/indexer/extract.js";

const repoRoot = resolve(process.argv[2] ?? join(import.meta.dir, "..", "vendor/excalidraw"));

const { store, metrics } = indexRepo(repoRoot);
const stats = store.stats();
const inProject = metrics.resolved + metrics.unresolved;
const resolutionRate = inProject > 0 ? metrics.resolved / inProject : 1;

const report = {
  repo: repoRoot,
  files: stats.files,
  functions: stats.functions,
  classes: stats.classes,
  callSites: metrics.callSites,
  resolved: metrics.resolved,
  unresolved: metrics.unresolved,
  external: metrics.external,
  dynamicImports: metrics.dynamicImports,
  resolutionRate: Number(resolutionRate.toFixed(4)),
  durationMs: metrics.durationMs,
};

console.log(JSON.stringify(report, null, 2));

/** Protocol (plan): below the 0.80 bar, measure the unresolved breakdown by target shape/kind FIRST. */
function printUnresolvedBreakdown(): void {
  const { project, relPaths, reExported } = prepareProject(repoRoot);
  const buckets = new Map<string, { count: number; examples: string[] }>();
  for (const relPath of relPaths) {
    const sourceFile = project.getSourceFile(join(repoRoot, relPath));
    if (sourceFile === undefined) continue;
    extractFile(project, sourceFile, repoRoot, relPath, reExported.get(sourceFile), (info) => {
      if (info.outcome.kind !== "unresolved") return;
      const kinds = [...new Set(info.declKinds)].sort();
      const bucket =
        kinds.length === 0
          ? "no-symbol-or-declaration (genuinely unknown)"
          : kinds.some((k) => k === "MethodSignature" || k === "PropertySignature")
            ? `interface-like (${kinds.join("|")})`
            : `other (${kinds.join("|")})`;
      const entry = buckets.get(bucket) ?? { count: 0, examples: [] };
      entry.count++;
      if (entry.examples.length < 5) entry.examples.push(info.outcome.targetName);
      buckets.set(bucket, entry);
    });
  }
  const rows = [...buckets.entries()].sort((a, b) => b[1].count - a[1].count);
  console.log("\nunresolved breakdown by target shape/kind:");
  for (const [bucket, { count, examples }] of rows) {
    console.log(`  ${String(count).padStart(5)}  ${bucket}`);
    console.log(`         e.g. ${examples.join(", ")}`);
  }
}

if (resolutionRate < 0.8) printUnresolvedBreakdown();

