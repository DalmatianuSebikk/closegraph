/**
 * RPC method handlers (plan 3 Task 2): thin, sync-over-cached-service implementations
 * of the ./rpc contract. Every success payload carries source + staleness (Ruling 13);
 * GraphUnavailableError becomes a typed payload instead of throwing across the boundary.
 */
import type { GraphHandle, GraphService } from "./tools/graph-service.js";
import { GraphUnavailableError } from "./tools/graph-service.js";
import { resolveRef } from "./tools/resolve-ref.js";
import { riskBucket, riskExplain, type RiskFacts } from "./view/risk.js";
import { buildPaletteIndex, type PaletteIndex } from "./view/palette-index.js";
import type { GraphNode } from "./graph/types.js";
import type {
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

function provenance(handle: GraphHandle): { source: GraphHandle["source"]; staleness: GraphHandle["staleness"] } {
  return { source: handle.source, staleness: handle.staleness };
}

function factsFor(handle: GraphHandle, node: GraphNode): RiskFacts {
  return {
    exported: node.exported,
    callers: handle.store.callers(node.id).length,
    transitiveCallers: handle.store.transitiveCallers([node.id]).size,
  };
}

/** File risk = the bucket of the file's aggregate facts (any exported, unique callers, union fan-in). */
function fileSummary(handle: GraphHandle, file: GraphNode): FileSummary {
  const symbols = handle.store.nodesOfFile(file.id);
  const callerIds = new Set<string>();
  let unresolvedCalls = 0;
  for (const sym of symbols) {
    for (const caller of handle.store.callers(sym.id)) callerIds.add(caller.id);
    for (const edge of handle.store.edgesFrom(sym.id, "calls")) {
      if (edge.unresolved) unresolvedCalls++;
    }
  }
  const facts: RiskFacts = {
    exported: symbols.some((s) => s.exported),
    callers: callerIds.size,
    transitiveCallers: handle.store.transitiveCallers(symbols.map((s) => s.id)).size,
  };
  return {
    ref: file.qualifiedName,
    symbols: symbols.length,
    unresolvedCalls,
    riskBucket: riskBucket(facts),
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

/** Palette index per graph handle: rebuilt only when the underlying graph changes. */
const paletteIndexes = new WeakMap<GraphHandle, PaletteIndex>();

function paletteFor(handle: GraphHandle): PaletteIndex {
  let index = paletteIndexes.get(handle);
  if (index === undefined) {
    index = buildPaletteIndex(handle.store.allNodes().map((n) => n.qualifiedName));
    paletteIndexes.set(handle, index);
  }
  return index;
}

function kindOf(handle: GraphHandle, ref: string): string {
  for (const kind of ["Function", "Class", "File"] as const) {
    if (handle.store.getNode(`${kind}:${ref}`) !== undefined) return kind;
  }
  return "unknown";
}

export function createRpcHandlers(service: GraphService): {
  files: Handler<FilesPayload>;
  fileSymbols: Handler<FileSymbolsPayload>;
  nodeDetail: Handler<NodeDetailPayload>;
  paletteSearch: Handler<PaletteSearchPayload>;
} {
  async function guard<T>(fn: (handle: GraphHandle) => T | Promise<T>): Promise<T | UnavailablePayload> {
    try {
      return await fn(await service.get());
    } catch (err) {
      if (err instanceof GraphUnavailableError) return { error: "unavailable", message: err.message };
      throw err;
    }
  }

  return {
    async files(_input, _ctx) {
      return guard((handle) => ({
        ...provenance(handle),
        files: handle.store
          .allNodes()
          .filter((n) => n.kind === "File")
          .sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName))
          .map((file) => fileSummary(handle, file)),
      }));
    },

    async fileSymbols(input, _ctx) {
      return guard((handle) => {
        const file = handle.store.getNode(`File:${stringField(input, "file")}`);
        if (file === undefined) return { ...provenance(handle), symbols: [] };
        const symbols = handle.store
          .nodesOfFile(file.id)
          .filter((n) => n.kind === "Function" || n.kind === "Class")
          .sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName))
          .map((n) => symbolSummary(handle, n));
        return { ...provenance(handle), symbols };
      });
    },

    async nodeDetail(input, _ctx) {
      return guard((handle) => {
        const resolution = resolveRef(handle, stringField(input, "ref"));
        if (resolution.node === undefined) {
          return { error: "not-found", suggestions: resolution.candidates.map((n) => n.qualifiedName) };
        }
        const node = resolution.node;
        const facts = factsFor(handle, node);
        return {
          ...provenance(handle),
          node,
          signature: node.signature,
          callers: handle.store.callers(node.id).map((n) => n.qualifiedName).sort(),
          callees: handle.store.callees(node.id).map((n) => n.qualifiedName).sort(),
          unresolvedCount: handle.store.edgesFrom(node.id, "calls").filter((e) => e.unresolved === true).length,
          risk: { bucket: riskBucket(facts), because: riskExplain(facts) },
        };
      });
    },

    async paletteSearch(input, _ctx) {
      return guard((handle) => ({
        matches: paletteFor(handle)
          .search(stringField(input, "prefix"), optionalNumberField(input, "limit") ?? 20)
          .map((m) => ({ ref: m.ref, kind: kindOf(handle, m.ref) })),
      }));
    },
  };
}
