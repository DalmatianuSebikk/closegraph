import type { Info } from "@opencode/plugin/promise/tool";
import type { GraphNode } from "../graph/types.js";
import { createGraphService, GraphUnavailableError, type GraphService, type GraphHandle } from "./graph-service.js";
import { renderMatches, resolveRef } from "./resolve-ref.js";

/** ts-morph stores signatures arrow-style; render them in the friendlier method form. */
function renderSignature(node: GraphNode): string {
  const match = /^\((.*)\) => (.+)$/s.exec(node.signature ?? "");
  if (match === null) return node.signature ?? "";
  return `${node.name}(${match[1]}): ${match[2]}`;
}

function listLine(label: string, nodes: GraphNode[]): string {
  if (nodes.length === 0) return `${label} (0)`;
  return `${label} (${nodes.length}): ${nodes.map((n) => n.qualifiedName).join(", ")}`;
}

function renderNode(handle: GraphHandle, node: GraphNode): string {
  const lines: string[] = [node.id];
  const facts = [`exported: ${node.exported}`, `file: ${node.filePath}`];
  if (node.signature !== undefined) facts.push(`signature: ${renderSignature(node)}`);
  lines.push(facts.join("  "));
  if (node.kind === "File") {
    lines.push(listLine("contains", handle.store.nodesOfFile(node.id)));
  }
  lines.push(listLine("direct callers", handle.store.callers(node.id)));
  lines.push(listLine("direct callees", handle.store.callees(node.id)));
  return lines.join("\n");
}

/** closegraph_query: node facts for one symbol, resolved by qualifiedName, bare name, or file path. */
export function createQueryTool(service: GraphService): Info {
  return {
    name: "closegraph_query",
    description:
      "Look up facts about one symbol in the code graph: kind, file, signature, exported flag, direct callers and callees. " +
      "Call it before editing a symbol to see its usage surface. " +
      "ref accepts a qualifiedName (src/lib/util.ts#formatName), a bare symbol name (formatName, Calculator.add), or a file path (src/lib/util.ts); resolved in that order.",
    input: {
      type: "object",
      properties: {
        ref: {
          type: "string",
          minLength: 1,
          description: "qualifiedName (file.ts#Symbol.path), bare symbol name, or file path",
        },
      },
      required: ["ref"],
    },
    async execute(input: { ref: string }, ctx) {
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
      if (node !== undefined) {
        const callers = handle.store.callers(node.id);
        const callees = handle.store.callees(node.id);
        return {
          content: renderNode(handle, node),
          metadata: { node, callers, callees },
        };
      }
      if (candidates.length > 0) {
        const heading = ambiguous ? "multiple matches" : "not found — did you mean";
        return {
          content: renderMatches(input.ref, candidates, heading),
          metadata: { suggestion },
        };
      }
      return { content: `not found: ${input.ref} (no similar symbols in the graph)` };
    },
  };
}

/** Ready-made instance over the process working directory; plugin setup rebuilds it with ctx.storage. */
export const queryTool: Info = createQueryTool(createGraphService(process.cwd()));
