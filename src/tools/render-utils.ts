import type { GraphHandle } from "./graph-service.js";

/** Clamp an optional depth argument to [1, max], defaulting when absent. */
export function clampDepth(depth: number | undefined, fallback: number, max: number): number {
  return Math.min(max, Math.max(1, depth ?? fallback));
}

/** Keep content ≤ maxLines lines, including the truncation notice itself. */
export function capLines(
  lines: string[],
  maxLines: number,
  notice: (omitted: number) => string,
): { lines: string[]; truncated: boolean } {
  if (lines.length <= maxLines) return { lines, truncated: false };
  const kept = lines.slice(0, maxLines - 1);
  return { lines: [...kept, notice(lines.length - kept.length)], truncated: true };
}

/** Cap a name list: keep the first `max`, count the rest for the caller's pointer line. */
export function capList(items: string[], max: number): { shown: string[]; hidden: number } {
  if (items.length <= max) return { shown: items, hidden: 0 };
  return { shown: items.slice(0, max), hidden: items.length - max };
}

/** Provenance of the graph behind a tool result (Ruling 13: staleness must reach the output). */
export function graphMeta(handle: GraphHandle): { source: GraphHandle["source"]; staleness: GraphHandle["staleness"] } {
  return { source: handle.source, staleness: handle.staleness };
}

/**
 * Staleness disclosure for content — Result.metadata is not guaranteed model-visible,
 * so unknown freshness must also SAY so in the content itself.
 */
export function stalenessNoteLines(handle: GraphHandle): string[] {
  return handle.staleness === "unknown" ? ["note: graph freshness unknown (no git HEAD) — may be stale"] : [];
}
