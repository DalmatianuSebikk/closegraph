import type { Info } from "@opencode/plugin/promise/tool";
import { createGraphService, GraphUnavailableError, type GraphService, type GraphHandle } from "./graph-service.js";
import { renderMatches, resolveRef } from "./resolve-ref.js";

const DEFAULT_DEPTH = 3;
const MAX_DEPTH = 5;
const MAX_LINES = 200;

export interface BlastRadiusInput {
  ref: string;
  direction?: "callers" | "callees" | "both";
  depth?: number;
}

function clampDepth(depth: number | undefined): number {
  return Math.min(MAX_DEPTH, Math.max(1, depth ?? DEFAULT_DEPTH));
}

/** Content stays ≤ MAX_LINES including the header and the truncation notice itself. */
function capLines(lines: string[], notice: (omitted: number) => string): { lines: string[]; truncated: boolean } {
  if (lines.length <= MAX_LINES) return { lines, truncated: false };
  const kept = lines.slice(0, MAX_LINES - 1);
  return { lines: [...kept, notice(lines.length - kept.length)], truncated: true };
}

/**
 * Affected node ids by direction.
 * - callers: full transitive closure via store.transitiveCallers (already excludes the seed);
 *   depth does not bound this side — a caller at any distance breaks when the symbol changes.
 * - callees: subgraph BFS following call edges out, bounded by depth, seed excluded.
 * - both: subgraph BFS in both directions bounded by depth (the union of the two sides at
 *   ≤ depth), seed excluded.
 */
function affectedIds(handle: GraphHandle, seedId: string, direction: "callers" | "callees" | "both", depth: number): string[] {
  if (direction === "callers") return [...handle.store.transitiveCallers([seedId])];

  const storeDirection = direction; // store vocabulary: "callees" | "both"
  const view = handle.store.subgraph([seedId], { depth, direction: storeDirection });
  return view.nodes.filter((n) => n.id !== seedId).map((n) => n.id);
}

/** closegraph_blast_radius: transitive impact of one symbol — everything that can break when it changes. */
export function createBlastRadiusTool(service: GraphService): Info {
  return {
    name: "closegraph_blast_radius",
    description:
      "Compute the blast radius of one symbol: every caller transitively affected by a change (direction callers, " +
      "the default), everything it calls within a depth budget (callees), or both. " +
      "Use it before editing to gauge impact size; pair with closegraph_subgraph to see the surrounding graph. " +
      "ref accepts a qualifiedName (src/lib/util.ts#formatName), a bare symbol name, or a file path.",
    input: {
      type: "object",
      properties: {
        ref: {
          type: "string",
          minLength: 1,
          description: "qualifiedName (file.ts#Symbol.path), bare symbol name, or file path",
        },
        direction: {
          type: "string",
          enum: ["callers", "callees", "both"],
          default: "callers",
          description: "callers = who breaks when the symbol changes (transitive); callees = what it calls, depth-bounded; both = union, depth-bounded",
        },
        depth: {
          type: "number",
          default: DEFAULT_DEPTH,
          minimum: 1,
          maximum: MAX_DEPTH,
          description: `BFS depth for the callees/both sides (default ${DEFAULT_DEPTH}, max ${MAX_DEPTH}); callers are always fully transitive`,
        },
      },
      required: ["ref"],
    },
    async execute(input: BlastRadiusInput, ctx) {
      let handle: GraphHandle;
      try {
        handle = await service.get((msg) => void ctx.progress({ message: msg }));
      } catch (error) {
        if (error instanceof GraphUnavailableError) {
          return { content: `graph unavailable: ${error.message}` };
        }
        throw error;
      }

      const { node, candidates, suggestion, ambiguous } = resolveRef(handle, input.ref);
      if (node === undefined) {
        if (candidates.length > 0) {
          const heading = ambiguous ? "multiple matches" : "not found — did you mean";
          return {
            content: renderMatches(input.ref, candidates, heading),
            metadata: { suggestion },
          };
        }
        return { content: `not found: ${input.ref} (no similar symbols in the graph)` };
      }

      const direction = input.direction ?? "callers";
      const depth = clampDepth(input.depth);
      const seedId = node.id;
      const affected = affectedIds(handle, seedId, direction, depth)
        .map((id) => handle.store.getNode(id)?.qualifiedName ?? id)
        .sort((a, b) => a.localeCompare(b));

      const header = `blast radius: ${node.qualifiedName} (direction ${direction}, depth ${depth}) — ${affected.length} affected`;
      const { lines } = capLines([header, ...affected], (omitted) => `(truncated, ${omitted} more — narrow depth or use closegraph_subgraph)`);

      return {
        content: lines.join("\n"),
        metadata: { direction, depth, seeds: [node.qualifiedName], affected },
      };
    },
  };
}

/** Ready-made instance over the process working directory; plugin setup rebuilds it with ctx.storage. */
export const blastRadiusTool: Info = createBlastRadiusTool(createGraphService(process.cwd()));
