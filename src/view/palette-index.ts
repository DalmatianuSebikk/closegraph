/**
 * Jump-to-symbol palette index (plan 3 Task 3): refs sorted once, prefix ranges
 * located by hand-rolled binary search — no linear scans (spec decision 9).
 *
 * C1 (final review): the prefix matches BOTH the full ref (path-qualified, e.g.
 * "src/lib/util.ts#form…") AND the bare symbol-name segment after "#" (e.g. "format"
 * → …util.ts#formatName) — the plan's pinned acceptance case. Two sorted arrays,
 * same hand-rolled search; path-prefix matches come first, then name-suffix matches,
 * capped at the limit. Still deterministic (ties in the name view break by ref).
 */

export interface PaletteIndex {
  search(prefix: string, limit: number): { ref: string }[];
}

interface NameEntry {
  /** the symbol-name segment after "#" (bare, no prefix char — the query and the key
   *  must share one coordinate system for the binary search to bound correctly). */
  key: string;
  ref: string;
}

export function buildPaletteIndex(refs: string[]): PaletteIndex {
  const sorted = [...refs].sort();
  const byName: NameEntry[] = refs
    .filter((ref) => ref.includes("#"))
    .map((ref) => ({ key: ref.slice(ref.indexOf("#") + 1), ref }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.ref < b.ref ? -1 : 1));

  /** Index of the first element >= prefix (lower bound) over the full-ref array. */
  function lowerBound(prefix: string): number {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[mid] < prefix) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Lower bound over the name-view keys (same hand-rolled search, second array). */
  function lowerBoundNames(prefix: string): number {
    let lo = 0;
    let hi = byName.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (byName[mid].key < prefix) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  return {
    search(prefix: string, limit: number): { ref: string }[] {
      const matches: { ref: string }[] = [];
      const seen = new Set<string>();
      // 1) path-prefix matches (full ref starts with the prefix), in sorted order
      for (let i = lowerBound(prefix); i < sorted.length && matches.length < limit; i++) {
        if (!sorted[i].startsWith(prefix)) break;
        matches.push({ ref: sorted[i] });
        seen.add(sorted[i]);
      }
      // 2) bare-name matches (segment after "#" starts with the prefix), sorted by name
      if (matches.length < limit) {
        for (let i = lowerBoundNames(prefix); i < byName.length && matches.length < limit; i++) {
          if (!byName[i].key.startsWith(prefix)) break;
          if (seen.has(byName[i].ref)) continue; // matched both ways — keep once
          seen.add(byName[i].ref);
          matches.push({ ref: byName[i].ref });
        }
      }
      return matches;
    },
  };
}
