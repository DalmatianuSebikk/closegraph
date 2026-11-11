import type { Info } from "@opencode/plugin/promise/tool";
import type { GraphNode } from "../graph/types.js";
import { createGraphService, GraphUnavailableError, type GraphService, type GraphHandle } from "./graph-service.js";

const MAX_MATCHES = 5;

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

/** Resolution stage 1: a qualifiedName is exact — try each kind-prefixed node id. */
function exactNode(handle: GraphHandle, ref: string): GraphNode | undefined {
  for (const kind of ["File", "Function", "Class"] as const) {
    const node = handle.store.getNode(`${kind}:${ref}`);
    if (node !== undefined) return node;
  }
  return undefined;
}

interface Resolution {
  readonly node?: GraphNode;
  readonly candidates: GraphNode[];
  readonly suggestion?: string;
  /** true when the ref matched several nodes; false when nothing matched and these are only look-alikes */
  readonly ambiguous: boolean;
}

/** qualifiedName → symbolPath suffix → file path prefix → not found with suggestions. */
function resolveRef(handle: GraphHandle, ref: string): Resolution {
  const exact = exactNode(handle, ref);
  if (exact !== undefined) return { node: exact, candidates: [], ambiguous: false };

  const all = handle.store.allNodes();

  const suffixMatches = all
    .filter((n) => n.qualifiedName.endsWith(ref))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (suffixMatches.length === 1) return { node: suffixMatches[0], candidates: [], ambiguous: false };
  if (suffixMatches.length > 1) {
    return { candidates: suffixMatches.slice(0, MAX_MATCHES), suggestion: suffixMatches[0].qualifiedName, ambiguous: true };
  }

  const fileMatches = all
    .filter((n) => n.kind === "File" && n.filePath.startsWith(ref))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (fileMatches.length === 1) return { node: fileMatches[0], candidates: [], ambiguous: false };
  if (fileMatches.length > 1) {
    return { candidates: fileMatches.slice(0, MAX_MATCHES), suggestion: fileMatches[0].filePath, ambiguous: true };
  }

  const needle = ref.toLowerCase();
  const suggestions = all
    .filter((n) => n.qualifiedName.toLowerCase().includes(needle))
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, MAX_MATCHES);
  return { candidates: suggestions, suggestion: suggestions[0]?.qualifiedName, ambiguous: false };
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

function renderMatches(ref: string, candidates: GraphNode[], heading: string): string {
  return [`${heading} (${candidates.length}) for ${ref}:`, ...candidates.map((n) => `  - ${n.qualifiedName}`)].join("\n");
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
