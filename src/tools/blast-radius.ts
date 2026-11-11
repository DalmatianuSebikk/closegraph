import type { Info } from "@opencode/plugin/promise/tool";
import { createGraphService, GraphUnavailableError, type GraphService, type GraphHandle } from "./graph-service.js";
import { renderMatches, resolveRef } from "./resolve-ref.js";
import { capLines, clampDepth, graphMeta, stalenessNoteLines } from "./render-utils.js";

const DEFAULT_DEPTH = 3;
const MAX_DEPTH = 5;
const MAX_LINES = 200;

export interface BlastRadiusInput {
  ref: string;
  direction?: "callers" | "callees" | "both";
  depth?: number;
}

/**
 * Affected node ids by direction.
 * - callers: full transitive closure via store.transitiveCallers (already excludes the seed);
 *   depth never bounds this side — a caller at any distance breaks when the symbol changes.
 * - callees: subgraph BFS following call edges out, bounded by depth, seed excluded.
 * - both: the plan's union — transitive callers ∪ depth-bounded callees, seed excluded.
 */
function affectedIds(handle: GraphHandle, seedId: string, direction: "callers" | "callees" | "both", depth: number): string[] {
  const callers = () => [...handle.store.transitiveCallers([seedId])];
  const callees = () =>
    handle.store
      .subgraph([seedId], { depth, direction: "callees" })
      .nodes.filter((n) => n.id !== seedId)
      .map((n) => n.id);
  if (direction === "callers") return callers();
  if (direction === "callees") return callees();
  return [...new Set([...callers(), ...callees()])];
}

/** closegraph_blast_radius: transitive impact of one symbol — everything that can break when it changes. */
export function createBlastRadiusTool(service: GraphService): Info {
  return {
    name: "closegraph_blast_radius",
    description:
      "Compute the blast radius of one symbol: every caller transitively affected by a change (direction callers, " +
      "the default), everything it calls within a depth budget (callees), or both (transitive callers plus " +
      "depth-bounded callees). Use it before editing to gauge impact size; pair with closegraph_subgraph to see the surrounding graph. " +
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
          description:
            "callers = who breaks when the symbol changes (fully transitive); callees = what it calls, depth-bounded; " +
            "both = transitive callers plus depth-bounded callees",
        },
        depth: {
          type: "number",
          default: DEFAULT_DEPTH,
          minimum: 1,
          maximum: MAX_DEPTH,
          multipleOf: 1,
          description: `BFS depth for the callees side (default ${DEFAULT_DEPTH}, max ${MAX_DEPTH}); callers are always fully transitive`,
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
      const graph = graphMeta(handle);
      const note = stalenessNoteLines(handle);
      if (node === undefined) {
        if (candidates.length > 0) {
          const heading = ambiguous ? "multiple matches" : "not found — did you mean";
          return {
            content: [renderMatches(input.ref, candidates, heading), ...note].join("\n"),
            metadata: { suggestion, graph },
          };
        }
        return {
          content: [`not found: ${input.ref} (no similar symbols in the graph)`, ...note].join("\n"),
          metadata: { graph },
        };
      }

      const direction = input.direction ?? "callers";
      const depth = clampDepth(input.depth, DEFAULT_DEPTH, MAX_DEPTH);
      const seedId = node.id;
      const affected = affectedIds(handle, seedId, direction, depth)
        .map((id) => handle.store.getNode(id)?.qualifiedName ?? id)
        .sort((a, b) => a.localeCompare(b));

      // depth cannot shrink the transitive-caller side, so the callers-mode header omits it
      const scope = direction === "callers" ? "direction callers" : `direction ${direction}, depth ${depth}`;
      const header = `blast radius: ${node.qualifiedName} (${scope}) — ${affected.length} affected`;
      // ...and its truncation notice offers the bounded-view tool instead of a no-op depth narrowing
      const notice =
        direction === "callers"
          ? (omitted: number) => `(truncated, ${omitted} more — use closegraph_subgraph for a bounded view)`
          : (omitted: number) => `(truncated, ${omitted} more — narrow depth or use closegraph_subgraph)`;
      const { lines } = capLines([header, ...note, ...affected], MAX_LINES, notice);

      return {
        content: lines.join("\n"),
        metadata: { direction, depth, seeds: [node.qualifiedName], affected, graph },
      };
    },
  };
}

/** Ready-made instance over the process working directory; plugin setup rebuilds it with ctx.storage. */
export const blastRadiusTool: Info = createBlastRadiusTool(createGraphService(process.cwd()));
