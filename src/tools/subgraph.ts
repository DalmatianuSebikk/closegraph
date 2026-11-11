import type { Info } from "@opencode/plugin/promise/tool";
import { createGraphService, GraphUnavailableError, type GraphService, type GraphHandle } from "./graph-service.js";
import { resolveRef, type Resolution } from "./resolve-ref.js";
import { capLines, clampDepth, graphMeta, stalenessNoteLines } from "./render-utils.js";

const DEFAULT_DEPTH = 1;
const MAX_DEPTH = 3;
const MIN_REFS = 1;
const MAX_REFS = 5;
const MAX_LINES = 200;

export interface SubgraphInput {
  refs: string[];
  depth?: number;
  direction?: "out" | "in" | "any";
}

/** One line per ref that failed to resolve, so the caller can fix every seed in one round trip. */
function renderRefMiss(ref: string, res: Resolution): string {
  if (res.ambiguous) {
    return `ambiguous ref ${ref} — matches: ${res.candidates.map((n) => n.qualifiedName).join(", ")}`;
  }
  if (res.candidates.length > 1) {
    return `not found: ${ref} (did you mean one of: ${res.candidates.map((n) => n.qualifiedName).join(", ")}?)`;
  }
  if (res.suggestion !== undefined) return `not found: ${ref} (did you mean ${res.suggestion}?)`;
  return `not found: ${ref} (no similar symbols in the graph)`;
}

/** Tool direction vocabulary → store direction vocabulary. */
const STORE_DIRECTION = { out: "callees", in: "callers", any: "both" } as const;

/** closegraph_subgraph: bounded ego graph around 1–5 seed symbols. */
export function createSubgraphTool(service: GraphService): Info {
  return {
    name: "closegraph_subgraph",
    description:
      "Extract a bounded ego graph around 1 to 5 symbols: every node within `depth` hops (default 1, max 3) along " +
      "call edges, with the edges between them. Direction out follows calls made, in follows callers, any does both. " +
      "Use it to see local structure around a hotspot; use closegraph_blast_radius for pure impact. " +
      "Each ref accepts a qualifiedName (src/lib/util.ts#formatName), a bare symbol name, or a file path.",
    input: {
      type: "object",
      properties: {
        refs: {
          type: "array",
          minItems: MIN_REFS,
          maxItems: MAX_REFS,
          items: { type: "string", minLength: 1 },
          description: "1 to 5 seed symbols (qualifiedName, bare name, or file path)",
        },
        depth: {
          type: "number",
          default: DEFAULT_DEPTH,
          minimum: 1,
          maximum: MAX_DEPTH,
          multipleOf: 1,
          description: `BFS hops from the seeds (default ${DEFAULT_DEPTH}, max ${MAX_DEPTH})`,
        },
        direction: {
          type: "string",
          enum: ["out", "in", "any"],
          default: "any",
          description: "out = calls made, in = callers, any = both (default any)",
        },
      },
      required: ["refs"],
    },
    async execute(input: SubgraphInput, ctx) {
      const refs = input.refs;
      if (!Array.isArray(refs) || refs.length < MIN_REFS || refs.length > MAX_REFS) {
        return {
          content: `invalid input: refs must list between ${MIN_REFS} and ${MAX_REFS} symbols (got ${Array.isArray(refs) ? refs.length : "none"})`,
        };
      }

      let handle: GraphHandle;
      try {
        handle = await service.get((msg) => void ctx.progress({ message: msg }));
      } catch (error) {
        if (error instanceof GraphUnavailableError) {
          return { content: `graph unavailable: ${error.message}` };
        }
        throw error;
      }

      // resolve every seed up front and fail fast, naming each ref that missed
      const graph = graphMeta(handle);
      const note = stalenessNoteLines(handle);
      const misses: string[] = [];
      const seedIds: string[] = [];
      for (const ref of refs) {
        const res = resolveRef(handle, ref);
        if (res.node !== undefined) seedIds.push(res.node.id);
        else misses.push(renderRefMiss(ref, res));
      }
      if (misses.length > 0) {
        return {
          content: [
            `could not resolve ${misses.length} of ${refs.length} refs:`,
            ...misses.map((line) => `  ${line}`),
            ...note,
          ].join("\n"),
          metadata: { graph },
        };
      }

      const depth = clampDepth(input.depth, DEFAULT_DEPTH, MAX_DEPTH);
      const direction = input.direction ?? "any";
      const view = handle.store.subgraph(seedIds, { depth, direction: STORE_DIRECTION[direction] });

      const qualified = (id: string): string => handle.store.getNode(id)?.qualifiedName ?? id;
      const nodes = view.nodes.map((n) => n.qualifiedName).sort((a, b) => a.localeCompare(b));
      const edges = view.edges
        .filter((e) => e.kind === "calls")
        .map((e) => [qualified(e.from), qualified(e.to)] as [string, string])
        .sort((a, b) => `${a[0]} -> ${a[1]}`.localeCompare(`${b[0]} -> ${b[1]}`));

      const allLines = [
        `subgraph (direction ${direction}, depth ${depth}): ${nodes.length} nodes, ${edges.length} edges`,
        ...note,
        `nodes (${nodes.length}):`,
        ...nodes,
        `edges (${edges.length}):`,
        ...edges.map(([from, to]) => `${from} -> ${to}`),
      ];
      const { lines, truncated } = capLines(allLines, MAX_LINES, (omitted) => `(truncated, ${omitted} more — narrow depth or use fewer refs)`);

      return {
        content: lines.join("\n"),
        metadata: { nodes, edges, truncated, graph },
      };
    },
  };
}

/** Ready-made instance over the process working directory; plugin setup rebuilds it with ctx.storage. */
export const subgraphTool: Info = createSubgraphTool(createGraphService(process.cwd()));
