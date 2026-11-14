import { join, resolve } from "node:path";
import { appendFileSync, existsSync } from "node:fs";
import { indexRepo, prepareProject } from "../src/indexer/pipeline.js";
import { extractFile } from "../src/indexer/extract.js";
import { createQueryTool } from "../src/tools/query.js";
import { createBlastRadiusTool } from "../src/tools/blast-radius.js";
import { createSubgraphTool } from "../src/tools/subgraph.js";
import { createReportTool } from "../src/tools/report.js";
import type { GraphService, GraphHandle } from "../src/tools/graph-service.js";
import type { Info } from "@opencode/plugin/promise/tool";

/**
 * Exact UTF-8 byte length of a tool result's model-facing content — Batch A verified
 * `content` is the only model-visible channel, so bytes(content) is the token-spend proxy.
 */
export function contentBytes(content: string | readonly unknown[] | undefined): number {
  if (typeof content === "string") return new TextEncoder().encode(content).length;
  if (Array.isArray(content)) return new TextEncoder().encode(JSON.stringify(content)).length;
  return 0;
}

/** avg / p95 / p100 over byte counts — nearest-rank percentile on the ascending sort
 *  (deterministic: same bytes in ⇒ same numbers out, no interpolation, no timing). */
export function outputByteStats(bytes: number[]): { avg: number; p95: number; p100: number } {
  const sorted = [...bytes].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return { avg: 0, p95: 0, p100: 0 };
  return {
    avg: sorted.reduce((a, b) => a + b, 0) / n,
    p95: sorted[Math.ceil(0.95 * n) - 1],
    p100: sorted[n - 1],
  };
}

/** 10 representative refs pinned from the excalidraw fixture (pinned commit in
 *  docs/superpowers/spikes/m1-benchmark.md) — the SAME list every run, by design. */
const BENCHMARK_REFS = {
  hubs: [
    "packages/math/src/point.ts#pointFrom", // 235 callers
    "packages/element/src/Scene.ts#Scene.getNonDeletedElementsMap", // 140 callers
  ],
  entryPoints: [
    "examples/with-script-in-browser/components/ExampleApp.tsx#ExampleApp",
    "excalidraw-app/app-language/LanguageList.tsx#LanguageList",
  ],
  leaves: [
    "dev-docs/src/components/Homepage/index.tsx#Feature",
    "dev-docs/src/components/Homepage/index.tsx#HomepageFeatures",
  ],
  mid: [
    "excalidraw-app/App.tsx#initializeScene",
    "excalidraw-app/collab/Collab.tsx#Collab._reconcileElements",
  ],
  misses: ["noSuchFunctionXYZ", "totallyMissingRefABC"],
} as const;

const ALL_REFS = [...BENCHMARK_REFS.hubs, ...BENCHMARK_REFS.entryPoints, ...BENCHMARK_REFS.leaves, ...BENCHMARK_REFS.mid, ...BENCHMARK_REFS.misses];

const toolCtx = {
  signal: new AbortController().signal,
  progress: async (_update: Record<string, unknown>) => {},
} as unknown as Parameters<Info["execute"]>[1];

/** After the resolution run: execute the 4 tools over the pinned refs, print avg/p95/p100
 *  output bytes per tool + total (bytes only — no timing noise). */
async function runToolByteMetrics(handle: GraphHandle): Promise<void> {
  const service: GraphService = {
    // reuse the already-indexed graph — never re-index inside the metric pass
    get: async () => handle,
    invalidate() {},
  };
  const perTool: { tool: string; bytes: number[] }[] = [
    { tool: "closegraph_query", bytes: [] },
    { tool: "closegraph_blast_radius", bytes: [] },
    { tool: "closegraph_subgraph", bytes: [] },
    { tool: "closegraph_report", bytes: [] },
  ];
  const [query, blast, subgraph, report] = [
    createQueryTool(service),
    createBlastRadiusTool(service),
    createSubgraphTool(service),
    createReportTool(service),
  ];
  for (const ref of ALL_REFS) {
    perTool[0].bytes.push(contentBytes((await query.execute({ ref }, toolCtx)).content));
    perTool[1].bytes.push(contentBytes((await blast.execute({ ref, direction: "callers" }, toolCtx)).content));
    perTool[2].bytes.push(contentBytes((await subgraph.execute({ refs: [ref] }, toolCtx)).content));
  }
  // report takes no refs — one call, a constant cost
  perTool[3].bytes.push(contentBytes((await report.execute({}, toolCtx)).content));

  const header = "tool output bytes (model-facing content, UTF-8) over the 10 pinned refs (report: 1 call)";
  const cols = ["tool", "n", "avg", "p95", "p100", "total"].map((c) => c.padStart(c === "tool" ? 26 : 8)).join("");
  const rows = perTool.map(({ tool, bytes }) => {
    const s = outputByteStats(bytes);
    const total = bytes.reduce((a, b) => a + b, 0);
    return [tool, String(bytes.length), String(Math.round(s.avg)), String(s.p95), String(s.p100), String(total)]
      .map((c, i) => c.padStart(i === 0 ? 26 : 8))
      .join("");
  });
  const grand = perTool.reduce((sum, { bytes }) => sum + bytes.reduce((a, b) => a + b, 0), 0);
  const table = [cols, ...rows, `${"TOTAL".padStart(26)}${String(perTool.reduce((s, t) => s + t.bytes.length, 0)).padStart(8)}${"".padStart(8)}${"".padStart(8)}${"".padStart(8)}${String(grand).padStart(8)}`].join("\n");
  console.log(`\n${header}\n${table}`);

  // append the same table to the benchmark report md when it is present (docs are private)
  const md = join(import.meta.dir, "..", "docs", "superpowers", "spikes", "m1-benchmark.md");
  if (existsSync(md)) {
    appendFileSync(md, `\n## Tool output bytes — ${new Date().toISOString()}\n\n\`\`\`\n${table}\n\`\`\`\n`);
  }
}

function main(): void {
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

  // Task 9: per-tool token-spend metrics over the already-indexed graph
  void runToolByteMetrics({ store, metrics, source: "built", staleness: "fresh" });
}

if (import.meta.main) main();
