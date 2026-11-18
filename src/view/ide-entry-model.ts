/**
 * Entry model (file-entry plan Tasks 2-3): the /closegraph opening experience.
 * Pure reducer from rpc payloads + key/dims events to renderable state — no OpenTUI
 * imports, headless-testable. The ide-model consumes this module (Task 4); the route
 * renders its state (Task 5).
 *
 * Task 2 — file list: the whole repo's files, sorted risk-first (bucket desc, then
 * path), windowed around the absolute cursor. `total` + `windowOffset` + rows.length
 * are the honest disclosure triple — the route derives the "… +N more" line from them;
 * no sentinel row ever rides inside rows[] (ledger Ruling: sentinel-free rows).
 */
import type { FilesPayload } from "../../rpc/index.js";
import type { RiskBucket } from "./risk.js";
import { RISK_SHADING, type Dims } from "./file-map-model.js";
import { bannerNone, bannerUnavailable, bannerUnknownFreshness, type Banner } from "./banner.js";

const DEFAULT_DIMS: Dims = { width: 80, height: 24 };

/** Entry-phase chrome reserved out of the visible row budget (header, banner, footer/command). */
export const ENTRY_RESERVED_ROWS = 4;

/** Risk-first ordering: high → medium → low, then path ascending. */
const RISK_ORDER: Record<RiskBucket, number> = { high: 0, medium: 1, low: 2 };

export interface EntryRow {
  ref: string;
  language: string;
  symbols: number;
  marker: "" | "!" | "!!" | "!!!";
}

export interface FileListState {
  screen: "file-list";
  banner: Banner;
  rows: EntryRow[];
  /** absolute index into the sorted list (0-based) */
  cursor: number;
  /** absolute index of rows[0] — the window scroll position */
  windowOffset: number;
  /** exact sorted-file count (never the windowed count) */
  total: number;
  loading: boolean;
}

export function createEntryModel(deps: { files: () => Promise<FilesPayload> }) {
  let dims: Dims = { ...DEFAULT_DIMS };
  let sorted: { ref: string; language: string; symbols: number; bucket: RiskBucket }[] = [];
  let banner: Banner = bannerNone();
  let cursor = 0;
  let windowOffset = 0;
  let loading = false;
  let loadSeq = 0;

  function maxRows(): number {
    return Math.max(1, dims.height - ENTRY_RESERVED_ROWS);
  }

  function clampWindow(): void {
    const max = maxRows();
    windowOffset = Math.max(0, Math.min(windowOffset, cursor));
    windowOffset = Math.max(windowOffset, cursor - max + 1);
    if (sorted.length > 0) windowOffset = Math.min(windowOffset, Math.max(0, sorted.length - max));
  }

  function applyFailure(message: string): void {
    banner = bannerUnavailable(message);
    sorted = [];
    cursor = 0;
    windowOffset = 0;
  }

  return {
    /** Loads the file list; never rejects — every failure lands in the banner (R4).
     *  Seq-guarded: a newer load/refresh always wins over a slower older one (R5). */
    async load(): Promise<void> {
      const seq = ++loadSeq;
      loading = true;
      try {
        const payload = await deps.files();
        if (seq !== loadSeq) return;
        loading = false;
        if ("error" in payload) {
          applyFailure(payload.message);
          return;
        }
        banner = payload.staleness === "unknown" ? bannerUnknownFreshness() : bannerNone();
        sorted = [...payload.files]
          .map((f) => ({ ref: f.ref, language: f.language, symbols: f.symbols, bucket: f.riskBucket }))
          .sort((a, b) => {
            const byRisk = RISK_ORDER[a.bucket] - RISK_ORDER[b.bucket];
            if (byRisk !== 0) return byRisk;
            return a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0;
          });
        cursor = Math.max(0, Math.min(cursor, Math.max(0, sorted.length - 1)));
        clampWindow();
      } catch (err) {
        if (seq !== loadSeq) return;
        loading = false;
        applyFailure(err instanceof Error ? err.message : String(err));
      }
    },

    /** Dims change re-windows without a refetch; the cursor keeps its absolute slot. */
    resize(next: Dims): void {
      if (next.width === dims.width && next.height === dims.height) return;
      dims = { ...next };
      clampWindow();
    },

    /** Cursor movement clamps at both ends; the window follows (deterministic, no wrap). */
    move(delta: number): void {
      if (sorted.length === 0) return;
      cursor = Math.max(0, Math.min(cursor + delta, sorted.length - 1));
      clampWindow();
    },

    /** Manual refresh: re-fetch through the same rpc path. */
    async refresh(): Promise<void> {
      await this.load();
    },

    /** The file under the cursor (absolute — survives resize). */
    selectedFile(): string | undefined {
      return sorted[cursor]?.ref;
    },

    /** Exact file count of the last successful load. */
    fileCount(): number {
      return sorted.length;
    },

    state(): FileListState {
      const max = maxRows();
      const start = Math.min(windowOffset, Math.max(0, sorted.length - max));
      const rows: EntryRow[] = [];
      for (let i = start; i < Math.min(start + max, sorted.length); i++) {
        const e = sorted[i];
        rows.push({ ref: e.ref, language: e.language, symbols: e.symbols, marker: RISK_SHADING[e.bucket].marker });
      }
      return { screen: "file-list", banner, rows, cursor, windowOffset: start, total: sorted.length, loading };
    },
  };
}
