/**
 * File-map view model (plan 3 Task 4): pure reducer from rpc payloads + key/dims events
 * to renderable rows/selection/state. No OpenTUI imports — headless-testable.
 *
 * Ordering + collisions come from the Task 3 layout (src/view/layout.ts): entries render
 * in the layout Map's insertion order (stable layout order) and any node whose (x, y)
 * cell is already occupied is SKIPPED — first stable-order node wins (ledger Ruling 12;
 * pinned by tests/view/layout.test.ts). Rows are windowed around the cursor so a 500+
 * file repo never produces more than height-bounded rows.
 */
import type { FilesPayload } from "../../rpc/index.js";
import { fileMapLayout } from "./layout.js";
import type { RiskBucket } from "./risk.js";
import { bannerNone, bannerUnavailable, bannerUnknownFreshness, type Banner } from "./banner.js";

/** Risk shading (terminal-agnostic): text marker ALWAYS renders; bg is optional color on top. */
export const RISK_SHADING: Record<RiskBucket, { bg?: string; marker: "" | "!" | "!!" | "!!!" }> = {
  low: { marker: "" },
  medium: { bg: "gray", marker: "!" },
  high: { bg: "red", marker: "!!!" },
};

export interface FileRow {
  ref: string;
  label: string;
  marker: string;
  selected: boolean;
}

export interface FileMapState {
  title: string;
  banner: Banner;
  rows: FileRow[];
  cursor: number;
}

export interface Dims {
  width: number;
  height: number;
}

const DEFAULT_DIMS: Dims = { width: 80, height: 24 };

/** title + banner + footer chrome reserved out of the visible row budget. */
const RESERVED_ROWS = 4;

function dirname(ref: string): string {
  const slash = ref.lastIndexOf("/");
  return slash === -1 ? "" : ref.slice(0, slash);
}

interface Entry {
  ref: string;
  bucket: RiskBucket;
}

/** Stable render order from the layout, with Ruling 12 collision skipping applied. */
function orderedEntries(files: { ref: string; riskBucket: RiskBucket }[], dims: Dims): Entry[] {
  const layout = fileMapLayout(
    files.map((f) => ({ ref: f.ref, dir: dirname(f.ref) })),
    dims,
  );
  const byRef = new Map(files.map((f) => [f.ref, f.riskBucket] as const));
  const taken = new Set<string>();
  const entries: Entry[] = [];
  for (const [ref, pos] of layout) {
    const cell = `${pos.x},${pos.y}`;
    if (taken.has(cell)) continue; // first stable-order node wins the cell
    taken.add(cell);
    entries.push({ ref, bucket: byRef.get(ref) ?? "low" });
  }
  return entries;
}

export function createFileMapModel(deps: { files: () => Promise<FilesPayload> }) {
  let dims: Dims = { ...DEFAULT_DIMS };
  let lastFiles: { ref: string; riskBucket: RiskBucket }[] | undefined;
  let entries: Entry[] = [];
  let banner: Banner = bannerNone();
  let title = "CodeGraph file map";
  let notShown = 0; // files dropped by the Ruling-12 collision skip — disclosed, never silent (I3)
  let cursor = 0;
  let scroll = 0;
  let loadSeq = 0;

  function maxRows(): number {
    return Math.max(1, dims.height - RESERVED_ROWS);
  }

  /** Keep the cursor row inside the window (windowing, Review Focus 1). */
  function clampScroll(): void {
    const max = maxRows();
    scroll = Math.max(0, Math.min(scroll, cursor));
    scroll = Math.max(scroll, cursor - max + 1);
  }

  /** Count of payload files the current layout cannot place (collision losers). */
  function collisionsOf(files: { ref: string }[] | undefined, laidOut: Entry[]): number {
    return files === undefined ? 0 : files.length - laidOut.length;
  }

  function reLayout(nextDims: Dims): void {
    const selectedRef = entries[cursor]?.ref;
    dims = { ...nextDims };
    entries = lastFiles === undefined ? [] : orderedEntries(lastFiles, dims);
    notShown = collisionsOf(lastFiles, entries);
    const at = selectedRef === undefined ? -1 : entries.findIndex((e) => e.ref === selectedRef);
    cursor = at >= 0 ? at : Math.min(cursor, Math.max(0, entries.length - 1));
    clampScroll();
  }

  function applyFailure(message: string): void {
    banner = bannerUnavailable(message);
    lastFiles = undefined;
    entries = [];
    notShown = 0;
    title = "CodeGraph file map";
    cursor = 0;
    scroll = 0;
  }

  return {
    /** Loads the file map; never rejects — every failure lands in the unavailable
     *  banner instead of a silent blank view (R4). */
    async load(): Promise<void> {
      const seq = ++loadSeq;
      try {
        const payload = await deps.files();
        if (seq !== loadSeq) return; // a newer load/refresh already won (R5)
        if ("error" in payload) {
          applyFailure(payload.message);
          return;
        }
        banner = payload.staleness === "unknown" ? bannerUnknownFreshness() : bannerNone();
        lastFiles = payload.files.map((f) => ({ ref: f.ref, riskBucket: f.riskBucket }));
        entries = orderedEntries(lastFiles, dims);
        notShown = collisionsOf(lastFiles, entries);
        title =
          `CodeGraph file map — ${payload.files.length} ${payload.files.length === 1 ? "file" : "files"}` +
          (payload.source === "snapshot" ? " (snapshot)" : "");
        cursor = Math.max(0, Math.min(cursor, Math.max(0, entries.length - 1)));
        clampScroll();
      } catch (err) {
        if (seq !== loadSeq) return;
        applyFailure(err instanceof Error ? err.message : String(err));
      }
    },

    /** Dims change re-layouts without a refetch; selection survives by ref (Review Focus 2). */
    resize(next: Dims): void {
      if (next.width === dims.width && next.height === dims.height) return;
      reLayout(next);
    },

    /** Cursor movement clamps at both ends (deterministic; no wrap). */
    move(delta: number): void {
      if (entries.length === 0) return;
      cursor = Math.max(0, Math.min(cursor + delta, entries.length - 1));
      clampScroll();
    },

    /** The selected file ref for Task 5's drill-down push. */
    openFile(): string | undefined {
      return entries[cursor]?.ref;
    },

    /** Manual refresh (Ruling 4): re-fetch through the same rpc path. */
    async refresh(): Promise<void> {
      await this.load();
    },

    state(): FileMapState {
      const max = maxRows();
      const start = Math.min(scroll, Math.max(0, entries.length - max));
      const rows: FileRow[] = [];
      for (let i = start; i < Math.min(start + max, entries.length); i++) {
        const e = entries[i];
        rows.push({
          ref: e.ref,
          label: e.ref,
          marker: RISK_SHADING[e.bucket].marker,
          selected: i === cursor,
        });
      }
      // I3: collision-skip losers are disclosed in the title, never silently dropped while
      // the count still claims them.
      const notShownSuffix = notShown > 0 ? ` (${notShown} not shown — narrow layout collisions)` : "";
      return { title: title + notShownSuffix, banner, rows, cursor };
    },
  };
}
