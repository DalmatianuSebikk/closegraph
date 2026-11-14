import type { Info } from "@opencode/plugin/promise/tool";
import { createGraphService, GraphUnavailableError, type GraphService, type GraphHandle } from "./graph-service.js";
import { capList, graphMeta, stalenessNoteLines } from "./render-utils.js";
import { riskBucket } from "../view/risk.js";
// shared entry-reach (Batch B review R-A): one implementation, exported by the rpc side
import { entryReachFor } from "../rpc-methods.js";

/** Hub list and entry-sample caps: the report is an overview, not an index dump. */
const TOP_HUBS = 10;
const TOP_ENTRIES = 10;

/** Code-unit ordering (no localeCompare) — same-graph ⇒ same output on every machine, matching the view modules. */
function byQualifiedName(a: { qualifiedName: string }, b: { qualifiedName: string }): number {
  return a.qualifiedName < b.qualifiedName ? -1 : a.qualifiedName > b.qualifiedName ? 1 : 0;
}

interface Hub {
  readonly ref: string;
  readonly callers: number;
  readonly risk: "low" | "medium" | "high";
}

interface ReportData {
  readonly counts: { files: number; functions: number; classes: number; callEdges: number };
  readonly resolution: { resolved: number; total: number; basis: "sites" | "edges" };
  readonly hubs: Hub[];
  readonly hiddenHubs: number;
  readonly entryPoints: { count: number; sample: string[]; hidden: number };
}

/**
 * Report cache per graph handle. Same pinned assumption as the rpc side's caches in
 * src/rpc-methods.ts (summariesFor et al.): handle identity tracks graph version
 * (invalidate() → rebuild → new handle), so the WeakMap never serves a stale report;
 * a future in-place store mutation (Plan 4 watcher) must invalidate the handle or
 * this cache lies.
 */
const reportCache = new WeakMap<GraphHandle, ReportData>();

function computeReport(handle: GraphHandle): ReportData {
  const store = handle.store;
  const nodes = store.allNodes();
  const files = nodes.filter((n) => n.kind === "File").length;
  const functions = nodes.filter((n) => n.kind === "Function").length;
  const classes = nodes.filter((n) => n.kind === "Class").length;
  let callEdges = 0;
  for (const node of nodes) callEdges += store.edgesFrom(node.id, "calls").length;

  // resolution: site-based when built (ts-morph saw every call site); the snapshot only
  // persists edges, so its metrics are edge-based — say so instead of faking precision
  const metrics = handle.metrics;
  const basis = handle.source === "built" ? "sites" : "edges";

  const reach = entryReachFor(handle);
  const hubs = nodes
    .filter((n) => (n.kind === "Function" || n.kind === "Class") && store.callers(n.id).length > 0)
    .map((n) => {
      const callers = store.callers(n.id).length;
      return {
        ref: n.qualifiedName,
        callers,
        risk: riskBucket({
          exported: n.exported,
          callers,
          // superseded by reachedFromEntries in v1.1 — riskBucket no longer reads it
          transitiveCallers: 0,
          reachedFromEntries: reach.get(n.id) ?? 0,
        }),
      };
    })
    .sort((a, b) => b.callers - a.callers || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  const shownHubs = hubs.slice(0, TOP_HUBS);

  const entries = nodes
    .filter((n) => (n.kind === "Function" || n.kind === "Class") && n.exported && store.callers(n.id).length === 0)
    .sort(byQualifiedName)
    .map((n) => n.qualifiedName);
  const { shown: sample, hidden } = capList(entries, TOP_ENTRIES);

  return {
    counts: { files, functions, classes, callEdges },
    resolution: { resolved: metrics.resolved, total: metrics.callSites, basis },
    hubs: shownHubs,
    hiddenHubs: hubs.length - shownHubs.length,
    entryPoints: { count: entries.length, sample, hidden },
  };
}

function reportFor(handle: GraphHandle): ReportData {
  let data = reportCache.get(handle);
  if (data === undefined) {
    data = computeReport(handle);
    reportCache.set(handle, data);
  }
  return data;
}

function renderReport(handle: GraphHandle, data: ReportData): string {
  const lines: string[] = [`closegraph report — graph: ${handle.source}, ${handle.staleness}`];
  lines.push(...stalenessNoteLines(handle));
  lines.push(
    `counts: ${data.counts.files} files, ${data.counts.functions} functions, ${data.counts.classes} classes, ${data.counts.callEdges} call edges`,
  );
  const { resolved, total, basis } = data.resolution;
  if (total === 0) {
    lines.push("resolution: no call sites indexed");
  } else if (basis === "sites") {
    lines.push(`resolution: ${resolved}/${total} call sites resolved (${Math.round((100 * resolved) / total)}%)`);
  } else {
    lines.push(
      `resolution: ${resolved}/${total} edges resolved (${Math.round((100 * resolved) / total)}%, edge-based — snapshot carries no per-site metrics)`,
    );
  }
  lines.push("top fan-in hubs (max 10):");
  if (data.hubs.length === 0) {
    lines.push("  (no symbol has a caller)");
  } else {
    data.hubs.forEach((hub, i) => {
      lines.push(`  ${i + 1}. ${hub.ref} — ${hub.callers} caller${hub.callers === 1 ? "" : "s"}, risk: ${hub.risk}`);
    });
    if (data.hiddenHubs > 0) lines.push(`  … +${data.hiddenHubs} more`);
  }
  lines.push(`entry points: ${data.entryPoints.count} exported symbols with no callers`);
  for (const ref of data.entryPoints.sample) lines.push(`  - ${ref}`);
  if (data.entryPoints.hidden > 0) lines.push(`  … +${data.entryPoints.hidden} more`);
  return lines.join("\n");
}

/** closegraph_report: one-call graph overview — counts, resolution, fan-in hubs, entry points. */
export function createReportTool(service: GraphService): Info {
  return {
    name: "closegraph_report",
    description:
      "One-call overview of the code graph: file/function/class/edge counts, call-resolution rate, top fan-in hubs with risk buckets, and entry points. " +
      "Call it first to orient before drilling in with closegraph_query, closegraph_blast_radius, or closegraph_subgraph. " +
      "Prefer this tool over reading whole files to understand structure or impact.",
    input: { type: "object", properties: {}, additionalProperties: false },
    async execute(_input: Record<string, never>, ctx) {
      let handle: GraphHandle;
      try {
        handle = await service.get((msg) => void ctx.progress({ message: msg }));
      } catch (error) {
        if (error instanceof GraphUnavailableError) {
          return { content: `graph unavailable: ${error.message}` };
        }
        throw error;
      }

      const data = reportFor(handle);
      return {
        content: renderReport(handle, data),
        // metadata is not model-visible; content is the source of truth — this mirrors it for UI
        metadata: {
          counts: data.counts,
          resolution: data.resolution,
          hubs: data.hubs,
          hiddenHubs: data.hiddenHubs,
          entryPoints: data.entryPoints,
          graph: graphMeta(handle),
        },
      };
    },
  };
}

/**
 * Ready-made instance over the process working directory; plugin setup rebuilds it with ctx.storage.
 * @internal test convenience only — the rpc handlers and TUI must build their own service
 * bound to the plugin context root (Ruling 6).
 */
export const reportTool: Info = createReportTool(createGraphService(process.cwd()));
