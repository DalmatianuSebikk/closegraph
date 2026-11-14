/**
 * RPC method handlers (plan 3 Task 2): thin, sync-over-cached-service implementations
 * of the ./rpc contract. Every success payload carries source + staleness (Ruling 13);
 * GraphUnavailableError becomes a typed payload instead of throwing across the boundary.
 */
import type { GraphHandle, GraphService } from "./tools/graph-service.js";
import { GraphUnavailableError } from "./tools/graph-service.js";
import type { GraphServicePool } from "./tools/service-pool.js";
import { resolveRef } from "./tools/resolve-ref.js";
import { riskBucket, riskExplain, type RiskFacts } from "./view/risk.js";
import { buildPaletteIndex, type PaletteIndex } from "./view/palette-index.js";
import type { GraphNode } from "./graph/types.js";
import type { EgoNeighbor } from "../rpc/index.js";
import type {
  EgoGraphPayload,
  FileSummary,
  FilesPayload,
  FileSymbolsPayload,
  NodeDetailPayload,
  PaletteSearchPayload,
  SymbolSummary,
  UnavailablePayload,
} from "../rpc/index.js";

/** The framework passes (input, ctx); schemas validate input before we see it. */
interface RpcContext {
  signal?: AbortSignal;
}

type Handler<O> = (input: unknown, ctx: RpcContext) => Promise<O>;

/** Defensive re-check of one required string field (the schema gate runs first; this is the belt). */
function stringField(input: unknown, key: string): string {
  if (typeof input !== "object" || input === null) throw new TypeError(`rpc input must be an object with a "${key}" string`);
  const value = (input as Record<string, unknown>)[key];
  if (typeof value !== "string") throw new TypeError(`rpc input "${key}" must be a string`);
  return value;
}

function optionalNumberField(input: unknown, key: string): number | undefined {
  const value = (input as Record<string, unknown>)[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number") throw new TypeError(`rpc input "${key}" must be a number`);
  return value;
}

function optionalStringField(input: unknown, key: string): string | undefined {
  const value = (input as Record<string, unknown>)[key];
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new TypeError(`rpc input "${key}" must be a string`);
  return value;
}

function provenance(handle: GraphHandle): { source: GraphHandle["source"]; staleness: GraphHandle["staleness"] } {
  return { source: handle.source, staleness: handle.staleness };
}

function factsFor(handle: GraphHandle, node: GraphNode): RiskFacts {
  return {
    exported: node.exported,
    callers: handle.store.callers(node.id).length,
    // superseded by reachedFromEntries in v1.1; recomputed if Plan 4 consumes it
    transitiveCallers: 0,
    reachedFromEntries: entryReachFor(handle).get(node.id) ?? 0,
  };
}

/** File risk facts = aggregation over the file's symbols (any exported, unique direct
 *  callers, max single-symbol entry-reach — v1.1's max-over-symbols rule). Shared by
 *  files() AND nodeDetail's File branch so the map marker and the detail panel can
 *  never disagree for the same ref (final review I1). */
function fileFacts(handle: GraphHandle, file: GraphNode): RiskFacts {
  const symbols = handle.store.nodesOfFile(file.id);
  const callerIds = new Set<string>();
  let reachedFromEntries = 0;
  const reach = entryReachFor(handle);
  for (const sym of symbols) {
    for (const caller of handle.store.callers(sym.id)) callerIds.add(caller.id);
    reachedFromEntries = Math.max(reachedFromEntries, reach.get(sym.id) ?? 0);
  }
  return {
    exported: symbols.some((s) => s.exported),
    callers: callerIds.size,
    // superseded by reachedFromEntries in v1.1; recomputed if Plan 4 consumes it
    transitiveCallers: 0,
    reachedFromEntries,
  };
}

/** File risk = the bucket of the file's aggregate facts (any exported, unique callers, union
 *  fan-in); the v1.1 entry-reach factor aggregates as max-over-symbols (the deepest single
 *  symbol's exposure defines the file's tier — a sum would let two safe symbols outrank a hub). */
function fileSummary(handle: GraphHandle, file: GraphNode): FileSummary {
  const symbols = handle.store.nodesOfFile(file.id);
  let unresolvedCalls = 0;
  for (const sym of symbols) {
    for (const edge of handle.store.edgesFrom(sym.id, "calls")) {
      if (edge.unresolved) unresolvedCalls++;
    }
  }
  return {
    ref: file.qualifiedName,
    language: file.language ?? "typescript",
    symbols: symbols.length,
    unresolvedCalls,
    riskBucket: riskBucket(fileFacts(handle, file)),
  };
}

function symbolSummary(handle: GraphHandle, node: GraphNode): SymbolSummary {
  return {
    ref: node.qualifiedName,
    kind: node.kind as "Function" | "Class",
    callers: handle.store.callers(node.id).length,
    callees: handle.store.callees(node.id).length,
    riskBucket: riskBucket(factsFor(handle, node)),
  };
}

/** Max neighbors per side in an egoGraph payload — the view caps, the totals disclose. */
export const EGO_CAP = 15;

/** One ego-graph node. File neighbors aggregate their symbols' facts (same source as the
 *  file map — parity with nodeDetail's File branch, final review I1). */
function egoNeighbor(handle: GraphHandle, node: GraphNode): EgoNeighbor {
  return {
    ref: node.qualifiedName,
    kind: node.kind as "Function" | "Class" | "File",
    riskBucket: riskBucket(node.kind === "File" ? fileFacts(handle, node) : factsFor(handle, node)),
    callers: handle.store.callers(node.id).length,
    callees: handle.store.callees(node.id).length,
  };
}

/** Palette index per graph handle. Pinned assumption: handle identity tracks graph version
 *  (invalidate() → rebuild → new handle), so the WeakMap never serves a stale index; a future
 *  in-place store mutation (Plan 4 watcher) must invalidate the handle or this cache lies. */
const paletteIndexes = new WeakMap<GraphHandle, PaletteIndex>();

function paletteFor(handle: GraphHandle): PaletteIndex {
  let index = paletteIndexes.get(handle);
  if (index === undefined) {
    index = buildPaletteIndex(handle.store.allNodes().map((n) => n.qualifiedName));
    paletteIndexes.set(handle, index);
  }
  return index;
}

/** File-summaries cache per graph handle. Same pinned assumption as the palette cache:
 *  handle identity tracks graph version (invalidate() → rebuild → new handle), so the
 *  WeakMap never serves stale summaries; a future in-place store mutation (Plan 4 watcher)
 *  must invalidate the handle or these caches lie. Keeps every `r` refresh and route open
 *  O(1) instead of re-aggregating every file (final review I2). */
const fileSummaries = new WeakMap<GraphHandle, FileSummary[]>();

function summariesFor(handle: GraphHandle): FileSummary[] {
  let summaries = fileSummaries.get(handle);
  if (summaries === undefined) {
    summaries = handle.store
      .allNodes()
      .filter((n) => n.kind === "File")
      .sort(byQualifiedName)
      .map((file) => fileSummary(handle, file));
    fileSummaries.set(handle, summaries);
  }
  return summaries;
}

/** Entry-reach counts per graph handle — same pinned assumption as the palette cache above:
 *  handle identity tracks graph version, so a rebuilt graph lands as a new handle.
 *  SHARED (Batch B review R-A): the closegraph_report tool consumes this same function —
 *  there is exactly one entry-reach implementation, never a fork. */
const entryReachMaps = new WeakMap<GraphHandle, Map<string, number>>();

/** Node id → number of DISTINCT entry points that reach it within depth 3 over forward
 *  (callees) edges. Entry point = an exported Function/Class with zero resolved direct
 *  callers (File nodes are never entry points). An entry point does not count as reaching
 *  itself; other entries reaching it (directly or via a cycle) do. */
export function entryReachFor(handle: GraphHandle): Map<string, number> {
  let reach = entryReachMaps.get(handle);
  if (reach !== undefined) return reach;
  reach = new Map<string, number>();

  const store = handle.store;
  const entries = store
    .allNodes()
    .filter((n) => (n.kind === "Function" || n.kind === "Class") && n.exported && store.callers(n.id).length === 0);

  for (const entry of entries) {
    const seen = new Set<string>([entry.id]);
    let frontier: string[] = [entry.id];
    for (let depth = 0; depth < 3 && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const callee of store.callees(id)) {
          if (seen.has(callee.id)) continue;
          seen.add(callee.id);
          next.push(callee.id);
        }
      }
      frontier = next;
    }
    for (const id of seen) {
      if (id === entry.id) continue;
      reach.set(id, (reach.get(id) ?? 0) + 1);
    }
  }

  entryReachMaps.set(handle, reach);
  return reach;
}

function kindOf(handle: GraphHandle, ref: string): string {
  for (const kind of ["Function", "Class", "File"] as const) {
    if (handle.store.getNode(`${kind}:${ref}`) !== undefined) return kind;
  }
  return "unknown";
}

/** Code-unit ordering (no localeCompare) — same-graph ⇒ same output on every machine, matching the view modules. */
function byQualifiedName(a: { qualifiedName: string }, b: { qualifiedName: string }): number {
  return a.qualifiedName < b.qualifiedName ? -1 : a.qualifiedName > b.qualifiedName ? 1 : 0;
}

/**
 * Handlers accept a single GraphService (single-project hosts — unchanged
 * behavior) or a GraphServicePool (shared services): every call resolves the
 * service from its OPTIONAL `root` payload, defaulting to the setup root. A
 * HOME/filesystem-root payload hits the same per-root guard as a direct build
 * and degrades to the typed unavailable payload, never a 500.
 */
export function createRpcHandlers(services: GraphService | GraphServicePool): {
  files: Handler<FilesPayload>;
  fileSymbols: Handler<FileSymbolsPayload>;
  nodeDetail: Handler<NodeDetailPayload>;
  paletteSearch: Handler<PaletteSearchPayload>;
  egoGraph: Handler<EgoGraphPayload>;
} {
  const resolveService =
    "resolve" in services ? (root: string | undefined) => services.resolve(root) : () => services as GraphService;

  async function guard<T>(input: unknown, fn: (handle: GraphHandle) => T | Promise<T>): Promise<T | UnavailablePayload> {
    try {
      const service = resolveService(optionalStringField(input, "root"));
      return await fn(await service.get());
    } catch (err) {
      if (err instanceof GraphUnavailableError) return { error: "unavailable", message: err.message };
      throw err;
    }
  }

  return {
    async files(_input, _ctx) {
      return guard(_input, (handle) => ({
        ...provenance(handle),
        files: summariesFor(handle),
      }));
    },

    async fileSymbols(input, _ctx) {
      return guard(input, (handle) => {
        const file = handle.store.getNode(`File:${stringField(input, "file")}`);
        if (file === undefined) return { ...provenance(handle), symbols: [] };
        const symbols = handle.store
          .nodesOfFile(file.id)
          .filter((n) => n.kind === "Function" || n.kind === "Class")
          .sort(byQualifiedName)
          .map((n) => symbolSummary(handle, n));
        return { ...provenance(handle), symbols };
      });
    },

    async nodeDetail(input, _ctx) {
      return guard(input, (handle) => {
        const resolution = resolveRef(handle, stringField(input, "ref"));
        if (resolution.node === undefined) {
          return {
            ...provenance(handle),
            error: "not-found",
            ambiguous: resolution.ambiguous,
            suggestions: resolution.candidates.map((n) => n.qualifiedName),
          };
        }
        const node = resolution.node;
        // File nodes aggregate their symbols' facts (same source as the file map) —
        // Ruling 5 entry points are exported Function/Class only, and every File node
        // is exported:true, so factsFor would falsely call every file an entry point (I1).
        const facts = node.kind === "File" ? fileFacts(handle, node) : factsFor(handle, node);
        return {
          ...provenance(handle),
          node,
          signature: node.signature,
          callers: handle.store.callers(node.id).map((n) => n.qualifiedName).sort(),
          callees: handle.store.callees(node.id).map((n) => n.qualifiedName).sort(),
          unresolvedCount: handle.store.edgesFrom(node.id, "calls").filter((e) => e.unresolved === true).length,
          ...(node.dangerousCalls !== undefined && node.dangerousCalls.length > 0
            ? { dangerousCalls: node.dangerousCalls }
            : {}),
          risk: { bucket: riskBucket(facts), because: riskExplain(facts) },
        };
      });
    },

    async paletteSearch(input, _ctx) {
      return guard(input, (handle) => ({
        ...provenance(handle),
        matches: paletteFor(handle)
          .search(stringField(input, "prefix"), optionalNumberField(input, "limit") ?? 20)
          .map((m) => ({ ref: m.ref, kind: kindOf(handle, m.ref) })),
      }));
    },

    async egoGraph(input, _ctx) {
      return guard(input, (handle) => {
        const resolution = resolveRef(handle, stringField(input, "ref"));
        if (resolution.node === undefined) {
          // the SAME not-found shape nodeDetail builds — one miss contract for the TUI
          return {
            ...provenance(handle),
            error: "not-found" as const,
            ambiguous: resolution.ambiguous,
            suggestions: resolution.candidates.map((n) => n.qualifiedName),
          };
        }
        const center = resolution.node;
        // center excluded from both sides (self-recursion must not list itself);
        // sides are code-unit sorted BEFORE slicing so the cap keeps a stable head
        const others = (nodes: GraphNode[]) =>
          nodes.filter((n) => n.id !== center.id).sort(byQualifiedName);
        const callerNodes = others(handle.store.callers(center.id));
        const calleeNodes = others(handle.store.callees(center.id));
        return {
          ...provenance(handle),
          center: egoNeighbor(handle, center),
          callers: callerNodes.slice(0, EGO_CAP).map((n) => egoNeighbor(handle, n)),
          callees: calleeNodes.slice(0, EGO_CAP).map((n) => egoNeighbor(handle, n)),
          totalCallers: callerNodes.length,
          totalCallees: calleeNodes.length,
          unresolvedOut: handle.store.edgesFrom(center.id, "calls").filter((e) => e.unresolved === true).length,
        };
      });
    },
  };
}
