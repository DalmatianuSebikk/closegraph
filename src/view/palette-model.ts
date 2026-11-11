/**
 * Jump-to-symbol palette model (plan 3 Task 5): prefix filter over the paletteSearch
 * rpc, sync after each keystroke — no debounce (spec decision 9's binary-search range
 * makes each keystroke cheap). No OpenTUI imports.
 *
 * Matches intentionally include File nodes (Ruling 13/M4): file detail is a legit
 * jump target. Out-of-order responses are guarded by a sequence token (R5 pattern).
 */
import type { PaletteSearchPayload } from "../../rpc/index.js";
import { bannerNone, bannerUnavailable, type Banner } from "./banner.js";

export interface PaletteRow {
  ref: string;
  kind: string;
  selected: boolean;
}

export interface PaletteState {
  open: boolean;
  filter: string;
  banner: Banner;
  rows: PaletteRow[];
  cursor: number;
}

export const PALETTE_ACTIONS = ["up", "down", "select", "backspace", "close"] as const;
export type PaletteAction = (typeof PALETTE_ACTIONS)[number];
export const PALETTE_KEYMAP: Record<PaletteAction, readonly string[]> = {
  up: ["up", "k"],
  down: ["down", "j"],
  select: ["enter", "return"],
  backspace: ["backspace"],
  close: ["escape", "esc"],
};

/** Matches requested per search; the overlay renders at most this many rows. */
const MATCH_LIMIT = 20;

export function createPaletteModel(deps: {
  search: (prefix: string, limit: number) => Promise<PaletteSearchPayload>;
}) {
  let open = false;
  let filter = "";
  let banner: Banner = bannerNone();
  let matches: { ref: string; kind: string }[] = [];
  let cursor = 0;
  let searchSeq = 0;

  function applyFailure(message: string): void {
    banner = bannerUnavailable(message);
    matches = [];
    cursor = 0;
  }

  async function runSearch(): Promise<void> {
    const seq = ++searchSeq;
    try {
      const payload = await deps.search(filter, MATCH_LIMIT);
      if (seq !== searchSeq) return; // a newer keystroke already won (R5)
      if ("error" in payload) {
        applyFailure(payload.message);
        return;
      }
      banner = bannerNone();
      matches = payload.matches.map((m) => ({ ref: m.ref, kind: m.kind }));
      cursor = 0;
    } catch (err) {
      if (seq !== searchSeq) return;
      applyFailure(err instanceof Error ? err.message : String(err));
    }
  }

  return {
    /** Opens the overlay fresh: empty filter, empty-prefix search. */
    async open(): Promise<void> {
      open = true;
      filter = "";
      cursor = 0;
      await runSearch();
    },

    /** One printable keystroke: extend the filter and re-search synchronously after it. */
    async type(text: string): Promise<void> {
      if (!open || text.length === 0) return;
      filter += text;
      await runSearch();
    },

    /** Remove the last filter character; a no-op at empty filter (no re-search). */
    async backspace(): Promise<void> {
      if (!open || filter.length === 0) return;
      filter = filter.slice(0, -1);
      await runSearch();
    },

    /** Cursor movement clamps at both ends (deterministic; no wrap). */
    move(delta: number): void {
      if (matches.length === 0) return;
      cursor = Math.max(0, Math.min(cursor + delta, matches.length - 1));
    },

    /** Enter: the highlighted ref (and close), or undefined when nothing matched. */
    select(): string | undefined {
      const picked = open ? matches[cursor]?.ref : undefined;
      if (picked !== undefined) open = false;
      return picked;
    },

    /** Esc: close without choosing. */
    close(): void {
      open = false;
    },

    state(): PaletteState {
      return {
        open,
        filter,
        banner,
        rows: matches.map((m, i) => ({ ...m, selected: i === cursor })),
        cursor,
      };
    },
  };
}
