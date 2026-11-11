/**
 * Staleness/unavailable banner text builders (plan 3 Task 4). Pure: the route renders
 * whatever these produce; the unknown-freshness text is DERIVED from the tools' staleness
 * note (src/tools/render-utils.ts stalenessNoteLines) so TUI and tool output read as one
 * product and can never drift (Ruling 13: never silently omit the freshness state).
 */
import { stalenessNoteLines } from "../tools/render-utils.js";
import type { GraphHandle } from "../tools/graph-service.js";

export type BannerKind = "none" | "unknown-freshness" | "unavailable";

export interface Banner {
  kind: BannerKind;
  text: string;
}

export function bannerNone(): Banner {
  return { kind: "none", text: "" };
}

/** Exact wording of the tools' staleness note — one voice across surfaces.
 *  stalenessNoteLines reads only handle.staleness, so a minimal handle suffices here. */
const UNKNOWN_FRESHNESS_HANDLE = { staleness: "unknown" } as GraphHandle;

export function bannerUnknownFreshness(): Banner {
  return { kind: "unknown-freshness", text: stalenessNoteLines(UNKNOWN_FRESHNESS_HANDLE).join("\n") };
}

/** The GraphUnavailableError message from the rpc payload is the banner text as-is. */
export function bannerUnavailable(message: string): Banner {
  return { kind: "unavailable", text: message };
}
