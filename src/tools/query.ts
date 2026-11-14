import type { Info } from "@opencode/plugin/promise/tool";
import type { GraphNode } from "../graph/types.js";
import { createGraphService, GraphUnavailableError, type GraphService, type GraphHandle } from "./graph-service.js";
import { renderMatches, resolveRef } from "./resolve-ref.js";
import { capList, graphMeta, stalenessNoteLines } from "./render-utils.js";

/** Lists up to this size stay on one comma-joined line; longer ones switch to one per line, capped. */
const INLINE_LIST_MAX = 24;
/** Items kept when a long list is capped (pointer line reports the rest). */
const LIST_SHOWN_MAX = 20;
/** Batch refs bounds: at least one, at most ten cards per call. */
const MIN_REFS = 1;
const MAX_REFS = 10;

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

/** Long lists cost predictable tokens: LIST_SHOWN_MAX lines plus a pointer to the full-set tool. */
function cappedListLines(label: string, nodes: GraphNode[], pointerTool?: string): string[] {
  if (nodes.length <= INLINE_LIST_MAX) return [listLine(label, nodes)];
  const { shown, hidden } = capList(nodes.map((n) => n.qualifiedName), LIST_SHOWN_MAX);
  const pointer =
    pointerTool === undefined ? `… +${hidden} more` : `… +${hidden} more — use ${pointerTool} for the full set`;
  return [`${label} (${nodes.length}):`, ...shown.map((name) => `  ${name}`), pointer];
}

function renderNode(handle: GraphHandle, node: GraphNode): string {
  const lines: string[] = [node.id];
  const facts = [`exported: ${node.exported}`, `file: ${node.filePath}`];
  if (node.signature !== undefined) facts.push(`signature: ${renderSignature(node)}`);
  lines.push(facts.join("  "));
  if (node.kind === "File") {
    lines.push(...cappedListLines("contains", handle.store.nodesOfFile(node.id)));
  }
  lines.push(...cappedListLines("direct callers", handle.store.callers(node.id), "closegraph_blast_radius"));
  lines.push(...cappedListLines("direct callees", handle.store.callees(node.id), "closegraph_blast_radius"));
  return lines.join("\n");
}

/** One ref's card body (no staleness note — that is appended once per result). */
interface RefCard {
  readonly body: string;
  readonly resolved: boolean;
  readonly meta: Record<string, unknown>;
}

/** Resolve and render one ref: node facts on hit, the existing miss block otherwise. */
function renderRefCard(handle: GraphHandle, ref: string): RefCard {
  const { node, candidates, suggestion, ambiguous } = resolveRef(handle, ref);
  if (node !== undefined) {
    const callers = handle.store.callers(node.id);
    const callees = handle.store.callees(node.id);
    return {
      body: renderNode(handle, node),
      resolved: true,
      // metadata is not model-visible (verified from @opencode/schema + @opencode/ai):
      // content renders both lists, so metadata carries counts only
      meta: { node, callerCount: callers.length, calleeCount: callees.length },
    };
  }
  if (candidates.length > 0) {
    const heading = ambiguous ? "multiple matches" : "not found — did you mean";
    return { body: renderMatches(ref, candidates, heading), resolved: false, meta: { suggestion } };
  }
  return { body: `not found: ${ref} (no similar symbols in the graph)`, resolved: false, meta: {} };
}

/** closegraph_query: facts for 1–10 symbols, resolved by qualifiedName, bare name, or file path. */
export function createQueryTool(service: GraphService): Info {
  return {
    name: "closegraph_query",
    description:
      "Look up facts about 1 to 10 code-graph symbols in one call: kind, file, signature, exported flag, direct callers and callees. " +
      "Call it before editing a symbol to see its usage surface. " +
      "Each ref accepts a qualifiedName (src/lib/util.ts#formatName), a bare symbol name (formatName, Calculator.add), or a file path (src/lib/util.ts); resolved in that order. " +
      "One card per ref in input order, then a resolved-count summary.",
    input: {
      type: "object",
      properties: {
        refs: {
          type: "array",
          minItems: MIN_REFS,
          maxItems: MAX_REFS,
          items: { type: "string", minLength: 1 },
          description: "1 to 10 symbols (qualifiedName, bare symbol name, or file path)",
        },
        ref: {
          type: "string",
          minLength: 1,
          description: "legacy single-symbol form — normalized to refs: [ref]",
        },
      },
      anyOf: [{ required: ["refs"] }, { required: ["ref"] }],
    },
    async execute(input: { ref?: string; refs?: string[] }, ctx) {
      // legacy single-ref shape stays accepted: ref → refs: [ref]
      const refs = input.refs ?? (input.ref !== undefined ? [input.ref] : undefined);
      if (
        !Array.isArray(refs) ||
        refs.length < MIN_REFS ||
        refs.length > MAX_REFS ||
        !refs.every((ref) => typeof ref === "string" && ref.length > 0)
      ) {
        return {
          content: `invalid input: refs must list between ${MIN_REFS} and ${MAX_REFS} symbols (got ${
            Array.isArray(refs) ? refs.length : "none"
          })`,
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

      const graph = graphMeta(handle);
      const note = stalenessNoteLines(handle);
      if (refs.length === 1) {
        // single ref: exactly the pre-batch output — no headers, no summary
        const card = renderRefCard(handle, refs[0]);
        return {
          content: [card.body, ...note].join("\n"),
          metadata: { ...card.meta, graph },
        };
      }

      const cards = refs.map((ref, i) => ({ header: `[${i + 1}/${refs.length}] ${ref}`, ...renderRefCard(handle, ref) }));
      const resolvedCount = cards.filter((card) => card.resolved).length;
      return {
        content: [
          ...cards.map((card) => [card.header, card.body].join("\n")),
          `${resolvedCount}/${refs.length} resolved`,
          ...note,
        ].join("\n\n"),
        metadata: { resolvedCount, refCount: refs.length, graph },
      };
    },
  };
}

/**
 * Ready-made instance over the process working directory; plugin setup rebuilds it with ctx.storage.
 * @internal test convenience only — the rpc handlers and TUI must build their own service
 * bound to the plugin context root (Ruling 6).
 */
export const queryTool: Info = createQueryTool(createGraphService(process.cwd()));
