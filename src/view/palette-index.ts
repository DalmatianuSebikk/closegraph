/**
 * Jump-to-symbol palette index (plan 3 Task 3): refs sorted once, prefix range
 * located by hand-rolled binary search — no linear scans (spec decision 9).
 */

export interface PaletteIndex {
  search(prefix: string, limit: number): { ref: string }[];
}

export function buildPaletteIndex(refs: string[]): PaletteIndex {
  const sorted = [...refs].sort();

  /** Index of the first element >= prefix (lower bound). */
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

  return {
    search(prefix: string, limit: number): { ref: string }[] {
      const matches: { ref: string }[] = [];
      for (let i = lowerBound(prefix); i < sorted.length && matches.length < limit; i++) {
        if (!sorted[i].startsWith(prefix)) break;
        matches.push({ ref: sorted[i] });
      }
      return matches;
    },
  };
}
