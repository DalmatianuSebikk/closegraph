/**
 * Detail-panel view model (plan 3 Task 5): renders the nodeDetail rpc payload as
 * plain lines. No OpenTUI imports — headless-testable.
 *
 * Wording contracts (single voice across surfaces):
 * - risk line renders the payload's risk.because strings joined with ", " — produced by
 *   src/view/risk.ts riskExplain, never re-worded here.
 * - unresolved-count line is Ruling 3's exact text, flagged muted so the render layer
 *   grays it.
 * - not-found lines reuse the tools' renderMatches builder (src/tools/resolve-ref.ts)
 *   so "did you mean" wording cannot fork between TUI and tools.
 * - askAgent() is the single pinned prompt template (design decision 4).
 */
import type { GraphNode } from "../graph/types.js";
import { renderMatches } from "../tools/resolve-ref.js";
import type { NodeDetailPayload } from "../../rpc/index.js";
import { bannerNone, bannerUnavailable, bannerUnknownFreshness, type Banner } from "./banner.js";

export interface DetailLine {
  text: string;
  /** true ⇒ render dimmed/gray (Ruling 3 unresolved-count line). */
  muted?: boolean;
}

export interface DetailState {
  title: string;
  banner: Banner;
  lines: DetailLine[];
}

/** Rendered actions footer — pinned text; the bracket tokens mirror DETAIL_KEYMAP. */
export const ACTIONS_LINE = "[a] ask agent  [b] blast radius  [esc] back";

export const DETAIL_ACTIONS = ["askAgent", "blastRadius", "back"] as const;
export type DetailAction = (typeof DETAIL_ACTIONS)[number];
export const DETAIL_KEYMAP: Record<DetailAction, readonly string[]> = {
  askAgent: ["a"],
  blastRadius: ["b"],
  back: ["escape", "esc"],
};

/** Lists cap at 10 names; the remainder collapses into a "+N more" line. */
const LIST_CAP = 10;

function listLines(label: string, refs: string[]): DetailLine[] {
  const capped = refs.slice(0, LIST_CAP);
  const lines: DetailLine[] = [{ text: `${label} (${refs.length}): ${capped.join(", ")}` }];
  if (refs.length > LIST_CAP) lines.push({ text: `+${refs.length - LIST_CAP} more`, muted: true });
  return lines;
}

/** The not-found branch renders the tools' candidate wording — imported, not mirrored. */
function missLines(ref: string, suggestions: string[]): DetailLine[] {
  if (suggestions.length === 0) {
    return [{ text: `not found: ${ref} (no similar symbols in the graph)` }];
  }
  return renderMatches(
    ref,
    suggestions.map((qualifiedName) => ({ qualifiedName }) as GraphNode),
    "not found — did you mean",
  )
    .split("\n")
    .map((text) => ({ text }));
}

export function createDetailModel(deps: {
  ref: string;
  nodeDetail: (ref: string) => Promise<NodeDetailPayload>;
}) {
  let banner: Banner = bannerNone();
  let lines: DetailLine[] = [{ text: ACTIONS_LINE }];
  let title = deps.ref;
  let loadSeq = 0;

  function applyFailure(message: string): void {
    banner = bannerUnavailable(message);
    lines = [{ text: ACTIONS_LINE }];
    title = deps.ref;
  }

  return {
    /** Loads the node detail; never rejects — errors land in the unavailable banner (R4). */
    async load(): Promise<void> {
      const seq = ++loadSeq;
      try {
        const payload = await deps.nodeDetail(deps.ref);
        if (seq !== loadSeq) return; // a newer load/refresh already won (R5)
        if ("error" in payload) {
          if (payload.error === "unavailable") {
            applyFailure(payload.message);
            return;
          }
          // not-found still carries Provenance (Ruling 13): surface staleness here too.
          banner = payload.staleness === "unknown" ? bannerUnknownFreshness() : bannerNone();
          lines = [...missLines(deps.ref, payload.suggestions), { text: ACTIONS_LINE }];
          return;
        }
        banner = payload.staleness === "unknown" ? bannerUnknownFreshness() : bannerNone();
        title = deps.ref + (payload.source === "snapshot" ? " (snapshot)" : "");
        const rendered: DetailLine[] = [
          { text: `kind: ${payload.node.kind}` },
          ...(payload.signature !== undefined && payload.signature !== ""
            ? [{ text: `signature: ${payload.signature}` }]
            : []),
          { text: `risk: ${payload.risk.bucket} — ${payload.risk.because.join(", ")}` },
          ...listLines("callers", payload.callers),
          ...listLines("callees", payload.callees),
          ...(payload.unresolvedCount > 0
            ? [
                {
                  text: `unresolved calls: ${payload.unresolvedCount} (see closegraph_query for suggestions)`,
                  muted: true,
                },
              ]
            : []),
          { text: ACTIONS_LINE },
        ];
        lines = rendered;
      } catch (err) {
        if (seq !== loadSeq) return;
        applyFailure(err instanceof Error ? err.message : String(err));
      }
    },

    /** Manual refresh (Ruling 4): re-fetch through the same rpc path. */
    async refresh(): Promise<void> {
      await this.load();
    },

    /** The pinned ask-agent prompt (single template; execution lives in the render layer). */
    askAgent(): string {
      return `Explain ${deps.ref} in this codebase: summarize what it does, who calls it (callers listed), what it calls, and any risks visible from its callers/callees.`;
    },

    /** The ref whose blast radius the [b] action targets (view lands with the rules plan). */
    blastRadius(): string {
      return deps.ref;
    },

    state(): DetailState {
      return { title, banner, lines };
    },
  };
}
