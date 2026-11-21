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
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import type { EgoNeighbor, WirePair } from "../rpc/index.js";
import type {
  EgoGraphPayload,
  EgoSourcePayload,
  FileSourcePayload,
  FileSummary,
  FilesPayload,
  FileSymbolsPayload,
  NodeDetailPayload,
  PaletteSearchPayload,
  SourceSpan,
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

/** Signature clip for ego boxes (the box row is ~14-21 chars; 48 is the payload bound,
 *  the view's fit() clips further). */
const EGO_SIG_CLIP = 48;
/** Sink badges carried per ego node; the full count rides `sinksTotal`. */
const EGO_SINKS_CAP = 4;
/** Lines in a lazy egoSource preview — a peek, not a dump. */
export const EGO_SOURCE_LINES = 10;

/** Lines in a whole-file source window — a readable analysis pane, not an
 *  unbounded dump; the payload keeps the TRUE totalLines so the footer can
 *  disclose everything the cap hides. */
export const FILE_SOURCE_LINES = 2000;

/** Distinct intra-file wire pairs carried on fileSymbols; exact total rides `wiresTotal`. */
const WIRES_CAP = 120;

/** Distinct resolved caller→callee pairs among the file's own Function/Class symbols:
 *  deduped, self-recursion excluded, sorted (from, to), capped at WIRES_CAP. */
function intraFileWires(handle: GraphHandle, symbols: GraphNode[]): { wires: WirePair[]; wiresTotal: number; wiresTruncated?: true } {
  const inFile = new Set(symbols.map((n) => n.id));
  const seen = new Set<string>();
  const pairs: WirePair[] = [];
  for (const n of symbols) {
    for (const callee of handle.store.callees(n.id)) {
      if (callee.id === n.id || !inFile.has(callee.id)) continue;
      const key = `${n.qualifiedName}|${callee.qualifiedName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ from: n.qualifiedName, to: callee.qualifiedName });
    }
  }
  pairs.sort((a, b) => (a.from === b.from ? (a.to < b.to ? -1 : 1) : a.from < b.from ? -1 : 1));
  const wires = pairs.slice(0, WIRES_CAP);
  return wires.length < pairs.length ? { wires, wiresTotal: pairs.length, wiresTruncated: true } : { wires, wiresTotal: pairs.length };
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max - 1) + "…" : value;
}

/** One ego-graph node. File neighbors aggregate their symbols' facts (same source as the
 *  file map — parity with nodeDetail's File branch, final review I1). */
function egoNeighbor(handle: GraphHandle, node: GraphNode): EgoNeighbor {
  const facts = node.kind === "File" ? fileFacts(handle, node) : factsFor(handle, node);
  const dangerous = node.dangerousCalls ?? [];
  return {
    ref: node.qualifiedName,
    kind: node.kind as "Function" | "Class" | "File",
    riskBucket: riskBucket(facts),
    callers: handle.store.callers(node.id).length,
    callees: handle.store.callees(node.id).length,
    // NOTE: keys with undefined values are OMITTED, never emitted — the opencode host
    // JSON-validates rpc outputs and rejects undefined-valued keys (live 500:
    // rpc.invalid_output "Expected JSON value"). Pack nodes (bash/python/php) have no
    // signature; plain JSON.stringify would hide this, the host does not.
    ...(node.signature !== undefined ? { signature: clip(node.signature, EGO_SIG_CLIP) } : {}),
    file: node.filePath,
    startLine: node.span.start.line,
    riskReason: riskExplain(facts).join(", "),
    sinks: dangerous.slice(0, EGO_SINKS_CAP).map((d) => ({ name: d.name, count: d.count })),
    sinksTotal: dangerous.length,
    exported: node.exported,
    language: node.language ?? "typescript",
    unresolvedCount: handle.store.edgesFrom(node.id, "calls").filter((e) => e.unresolved === true).length,
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
  egoSource: Handler<EgoSourcePayload>;
  fileSource: Handler<FileSourcePayload>;
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
        if (file === undefined) return { ...provenance(handle), symbols: [], wires: [], wiresTotal: 0 };
        const symbols = handle.store
          .nodesOfFile(file.id)
          .filter((n) => n.kind === "Function" || n.kind === "Class")
          .sort(byQualifiedName);
        const wires = intraFileWires(handle, symbols);
        return { ...provenance(handle), symbols: symbols.map((n) => symbolSummary(handle, n)), ...wires };
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
          // OMITTED when absent (never undefined-valued) — the host's output JSON
          // validation rejects undefined keys; pack nodes carry no signature
          ...(node.signature !== undefined ? { signature: node.signature } : {}),
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

    /** Lazy source preview (the ego screen's `i` overlay): signature + the first
     *  EGO_SOURCE_LINES from the node's start line, read from DISK under the caller's
     *  root — the graph is the ref index, the filesystem is the source of truth. The
     *  root stays schema-optional like every method, but the disk read needs one: a
     *  no-root call degrades to the typed unavailable, never a wrong-directory read. */
    async egoSource(input, _ctx) {
      const root = optionalStringField(input, "root");
      if (root === undefined) {
        return { error: "unavailable", message: "egoSource requires a root — the TUI always sends one" };
      }
      return guard(input, async (handle) => {
        const resolution = resolveRef(handle, stringField(input, "ref"));
        if (resolution.node === undefined) {
          // the SAME not-found shape egoGraph/nodeDetail build — one miss contract
          return {
            ...provenance(handle),
            error: "not-found" as const,
            ambiguous: resolution.ambiguous,
            suggestions: resolution.candidates.map((n) => n.qualifiedName),
          };
        }
        const node = resolution.node;
        // path-escape belt: node.filePath comes from the index (repo-relative), but a
        // hand-built or future-watcher store must never read OUTSIDE the root
        const abs = resolvePath(root, node.filePath);
        if (abs !== resolvePath(root) && !abs.startsWith(resolvePath(root) + "/")) {
          return { error: "unavailable", message: `source outside root: ${node.filePath}` };
        }
        try {
          const content = await readFile(abs, "utf8");
          const all = content.split("\n");
          const start = Math.max(0, Math.min(node.span.start.line - 1, all.length));
          return {
            ...provenance(handle),
            ref: node.qualifiedName,
            ...(node.signature !== undefined ? { signature: node.signature } : {}),
            file: node.filePath,
            startLine: node.span.start.line,
            lines: all.slice(start, start + EGO_SOURCE_LINES),
          };
        } catch {
          return { error: "unavailable", message: `source unreadable: ${node.filePath}` };
        }
      });
    },

    /** Whole-file source window (the IDE screen's `s` overlay). The graph is the
     *  ref index: `file` must be an indexed File node; the optional `ref` adds a
     *  span anchor when it resolves INSIDE this file (unknown ref or a ref that
     *  lives elsewhere → span omitted silently, the file still loads). With a
     *  span the window starts 25 lines before the span start so the symbol is
     *  on screen; without one it starts at line 1. */
    async fileSource(input, _ctx): Promise<FileSourcePayload> {
      const root = optionalStringField(input, "root");
      if (root === undefined) {
        return { error: "unavailable", message: "fileSource requires a root — the TUI always sends one" };
      }
      return guard(input, async (handle): Promise<FileSourcePayload> => {
        const file = stringField(input, "file");
        // path-escape belt FIRST — a caller-supplied path is never even looked
        // at in the index before it is proven to stay inside the root
        const rootAbs = resolvePath(root);
        const abs = resolvePath(root, file);
        if (abs !== rootAbs && !abs.startsWith(rootAbs + "/")) {
          return { error: "unavailable", message: `source outside root: ${file}` };
        }
        if (handle.store.getNode(`File:${file}`) === undefined) {
          const needle = file.split("/").pop() ?? file;
          const suggestions = handle.store
            .allNodes()
            .filter((n) => n.kind === "File" && n.filePath.includes(needle))
            .map((n) => n.qualifiedName)
            .sort()
            .slice(0, 5);
          return { ...provenance(handle), error: "not-found", ambiguous: false, suggestions };
        }
        let span: SourceSpan | undefined;
        let signature: string | undefined;
        let refEcho: string | undefined;
        const refInput = optionalStringField(input, "ref");
        if (refInput !== undefined) {
          const resolution = resolveRef(handle, refInput);
          const node = resolution.node;
          if (node !== undefined && node.filePath === file) {
            span = { startLine: node.span.start.line, endLine: node.span.end.line };
            signature = node.signature;
            refEcho = node.qualifiedName;
          }
        }
        try {
          const content = await readFile(abs, "utf8");
          const all = content.split("\n");
          // a trailing newline is a terminator, not an extra empty line — editors
          // number it that way, and the window/footer count must match the render
          if (all.length > 0 && all[all.length - 1] === "") all.pop();
          const totalLines = all.length;
          const firstLine = span === undefined ? 1 : Math.max(1, span.startLine - 25);
          const lines = all.slice(firstLine - 1, firstLine - 1 + FILE_SOURCE_LINES);
          return {
            ...provenance(handle),
            file,
            lines,
            firstLine,
            totalLines,
            ...(lines.length < totalLines ? { truncated: true as const } : {}),
            ...(span !== undefined ? { span } : {}),
            ...(signature !== undefined ? { signature } : {}),
            ...(refEcho !== undefined ? { ref: refEcho } : {}),
          };
        } catch {
          return { error: "unavailable", message: `source unreadable: ${file}` };
        }
      });
    },
  };
}
