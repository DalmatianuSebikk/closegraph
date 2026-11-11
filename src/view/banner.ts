/**
 * Staleness/unavailable banner text builders (plan 3 Task 4). Pure: the route renders
 * whatever these produce; the unknown-freshness text deliberately matches the tools'
 * staleness note wording family (src/tools/render-utils.ts) so TUI and tool output
 * read as one product (Ruling 13: never silently omit the freshness state).
 */

export type BannerKind = "none" | "unknown-freshness" | "unavailable";

export interface Banner {
  kind: BannerKind;
  text: string;
}

export function bannerNone(): Banner {
  return { kind: "none", text: "" };
}

/** Exact wording of the tools' staleness note — one voice across surfaces. */
export function bannerUnknownFreshness(): Banner {
  return { kind: "unknown-freshness", text: "note: graph freshness unknown (no git HEAD) — may be stale" };
}

/** The GraphUnavailableError message from the rpc payload is the banner text as-is. */
export function bannerUnavailable(message: string): Banner {
  return { kind: "unavailable", text: message };
}
