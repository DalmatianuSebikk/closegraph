/**
 * Symbol-list view model (plan 3 Task 5): pure reducer from the fileSymbols rpc payload
 * to renderable rows/selection/state for one file's symbols. No OpenTUI imports.
 *
 * Row order flows through the Task 3 symbolLayout (all symbols sit in the single
 * depth-0 layer, so its within-layer sort IS the row order) — ordering logic stays in
 * one module, mirroring how file-map-model consumes fileMapLayout. Windowing follows
 * the same cursor-visible rule as the file map; `openSymbol()` feeds the detail push.
 */
import type { FileSymbolsPayload, SymbolSummary } from "../../rpc/index.js";
import { symbolLayout } from "./layout.js";
import { RISK_SHADING, type Dims } from "./file-map-model.js";
import { bannerNone, bannerUnavailable, bannerUnknownFreshness, type Banner } from "./banner.js";

export interface SymbolRow {
  ref: string;
  label: string;
  marker: string;
  kind: "Function" | "Class";
  callers: number;
  callees: number;
  selected: boolean;
}

export interface SymbolViewState {
  title: string;
  banner: Banner;
  rows: SymbolRow[];
  cursor: number;
}

/** Keyboard parity (Review Focus 5): every action has ≥1 key; the render layer dispatches these. */
export const SYMBOL_VIEW_ACTIONS = ["up", "down", "open", "back", "refresh"] as const;
export type SymbolViewAction = (typeof SYMBOL_VIEW_ACTIONS)[number];
export const SYMBOL_VIEW_KEYMAP: Record<SymbolViewAction, readonly string[]> = {
  up: ["up", "k"],
  down: ["down", "j"],
  open: ["enter", "return"],
  back: ["escape", "esc"],
  refresh: ["r"],
};

const DEFAULT_DIMS: Dims = { width: 80, height: 24 };

/** title + banner + footer chrome reserved out of the visible row budget. */
const RESERVED_ROWS = 4;

/** Stable row order from the Task 3 layout (single depth-0 layer ⇒ its sorted order). */
function orderedRefs(symbols: SymbolSummary[], dims: Dims): string[] {
  return [
    ...symbolLayout(
      symbols.map((s) => ({ ref: s.ref, depthFromSeed: 0 })),
      dims,
    ).keys(),
  ];
}

export function createSymbolViewModel(deps: {
  fileRef: string;
  fileSymbols: (file: string) => Promise<FileSymbolsPayload>;
}) {
  let dims: Dims = { ...DEFAULT_DIMS };
  let symbols: SymbolSummary[] = [];
  let refs: string[] = [];
  let banner: Banner = bannerNone();
  let title = `Symbols — ${deps.fileRef}`;
  let cursor = 0;
  let scroll = 0;
  let loadSeq = 0;

  function maxRows(): number {
    return Math.max(1, dims.height - RESERVED_ROWS);
  }

  function clampScroll(): void {
    const max = maxRows();
    scroll = Math.max(0, Math.min(scroll, cursor));
    scroll = Math.max(scroll, cursor - max + 1);
  }

  function reOrder(): void {
    refs = orderedRefs(symbols, dims);
    cursor = Math.max(0, Math.min(cursor, Math.max(0, refs.length - 1)));
    clampScroll();
  }

  function applyFailure(message: string): void {
    banner = bannerUnavailable(message);
    symbols = [];
    refs = [];
    title = `Symbols — ${deps.fileRef}`;
    cursor = 0;
    scroll = 0;
  }

  return {
    /** Loads the file's symbols; never rejects — errors land in the unavailable banner (R4). */
    async load(): Promise<void> {
      const seq = ++loadSeq;
      try {
        const payload = await deps.fileSymbols(deps.fileRef);
        if (seq !== loadSeq) return; // a newer load/refresh already won (R5)
        if ("error" in payload) {
          applyFailure(payload.message);
          return;
        }
        banner = payload.staleness === "unknown" ? bannerUnknownFreshness() : bannerNone();
        symbols = payload.symbols;
        reOrder();
        title =
          `Symbols — ${deps.fileRef} (${symbols.length} symbols)` +
          (payload.source === "snapshot" ? " (snapshot)" : "");
      } catch (err) {
        if (seq !== loadSeq) return;
        applyFailure(err instanceof Error ? err.message : String(err));
      }
    },

    /** Dims change re-windows without a refetch; selection survives by position+ref. */
    resize(next: Dims): void {
      if (next.width === dims.width && next.height === dims.height) return;
      const selectedRef = refs[cursor];
      dims = { ...next };
      reOrder();
      const at = selectedRef === undefined ? -1 : refs.indexOf(selectedRef);
      if (at >= 0) cursor = at;
      clampScroll();
    },

    /** Cursor movement clamps at both ends (deterministic; no wrap). */
    move(delta: number): void {
      if (refs.length === 0) return;
      cursor = Math.max(0, Math.min(cursor + delta, refs.length - 1));
      clampScroll();
    },

    /** The selected symbol ref for the detail push. */
    openSymbol(): string | undefined {
      return refs[cursor];
    },

    /** Manual refresh (Ruling 4): re-fetch through the same rpc path. */
    async refresh(): Promise<void> {
      await this.load();
    },

    state(): SymbolViewState {
      const max = maxRows();
      const start = Math.min(scroll, Math.max(0, refs.length - max));
      const byRef = new Map(symbols.map((s) => [s.ref, s] as const));
      const rows: SymbolRow[] = [];
      for (let i = start; i < Math.min(start + max, refs.length); i++) {
        const s = byRef.get(refs[i]);
        if (s === undefined) continue;
        rows.push({
          ref: s.ref,
          label: s.ref,
          marker: RISK_SHADING[s.riskBucket].marker,
          kind: s.kind,
          callers: s.callers,
          callees: s.callees,
          selected: i === cursor,
        });
      }
      return { title, banner, rows, cursor };
    },
  };
}
