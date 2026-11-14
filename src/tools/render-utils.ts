import type { GraphHandle } from "./graph-service.js";

/** Clamp an optional numeric argument (depth, limit) to [1, max], defaulting when absent. */
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

/** Group qualified names by file, one line per file: `src/lib/util.ts: formatName, shout`.
 *  A File node's qualifiedName has no # — the file IS the name, so it never re-prints
 *  as a member of its own group; a file-only group renders as the bare path (review M1). */
export function groupByFile(qualifiedNames: string[]): string[] {
  const byFile = new Map<string, string[]>();
  for (const qualifiedName of qualifiedNames) {
    const hash = qualifiedName.indexOf("#");
    if (hash === -1) {
      if (!byFile.has(qualifiedName)) byFile.set(qualifiedName, []);
      continue;
    }
    const file = qualifiedName.slice(0, hash);
    const bare = qualifiedName.slice(hash + 1);
    const names = byFile.get(file);
    if (names === undefined) byFile.set(file, [bare]);
    else names.push(bare);
  }
  return [...byFile.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, names]) =>
      names.length === 0 ? file : `${file}: ${names.sort((a, b) => a.localeCompare(b)).join(", ")}`,
    );
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
