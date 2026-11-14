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

/** The file map's language column (Task 10); unknown languages render their raw id. */
export function languageShort(language: string): string {
  const shorts: Record<string, string> = { typescript: "ts", javascript: "js", python: "py", php: "php", bash: "sh" };
  return shorts[language] ?? language;
}

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
  language: string;
}

/** Stable render order from the layout, with Ruling 12 collision skipping applied. */
function orderedEntries(files: { ref: string; riskBucket: RiskBucket; language: string }[], dims: Dims): Entry[] {
  const layout = fileMapLayout(
    files.map((f) => ({ ref: f.ref, dir: dirname(f.ref) })),
    dims,
  );
  const byRef = new Map(files.map((f) => [f.ref, f] as const));
  const taken = new Set<string>();
  const entries: Entry[] = [];
  for (const [ref, pos] of layout) {
    const cell = `${pos.x},${pos.y}`;
    if (taken.has(cell)) continue; // first stable-order node wins the cell
    taken.add(cell);
    const file = byRef.get(ref);
    entries.push({ ref, bucket: file?.riskBucket ?? "low", language: file?.language ?? "typescript" });
  }
  return entries;
}

export function createFileMapModel(deps: { files: () => Promise<FilesPayload> }) {
  let dims: Dims = { ...DEFAULT_DIMS };
  let lastFiles: { ref: string; riskBucket: RiskBucket; language: string }[] | undefined;
  let entries: Entry[] = [];
  let banner: Banner = bannerNone();
  let title = "CodeGraph file map";
  let notShown = 0; // files dropped by the Ruling-12 collision skip — disclosed, never silent (I3)
  let filterLang = "all"; // "all" | a language id present in the payload (Task 10)
  let cursor = 0;
  let scroll = 0;
  let loadSeq = 0;

  function maxRows(): number {
    return Math.max(1, dims.height - RESERVED_ROWS);
  }

  /** Distinct languages present, sorted by SHORT label (the cycle's deterministic order). */
  function languagesPresent(): string[] {
    if (lastFiles === undefined) return [];
    const ids = new Set(lastFiles.map((f) => f.language));
    return [...ids].sort((a, b) => {
      const sa = languageShort(a);
      const sb = languageShort(b);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
  }

  /** The payload filtered to the active language — BEFORE layout, so the filtered
   *  set lays out smaller (fewer collisions) and the count recomputes over it. */
  function filteredFiles(): { ref: string; riskBucket: RiskBucket; language: string }[] | undefined {
    if (lastFiles === undefined) return undefined;
    return filterLang === "all" ? lastFiles : lastFiles.filter((f) => f.language === filterLang);
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

  /** Selection survives layout changes by ref (resize AND the language filter). */
  function relayoutPreservingSelection(): void {
    const selectedRef = entries[cursor]?.ref;
    const files = filteredFiles();
    entries = files === undefined ? [] : orderedEntries(files, dims);
    notShown = collisionsOf(files, entries);
    const at = selectedRef === undefined ? -1 : entries.findIndex((e) => e.ref === selectedRef);
    cursor = at >= 0 ? at : Math.min(cursor, Math.max(0, entries.length - 1));
    clampScroll();
  }

  function reLayout(nextDims: Dims): void {
    dims = { ...nextDims };
    relayoutPreservingSelection();
  }

  function applyFailure(message: string): void {
    banner = bannerUnavailable(message);
    lastFiles = undefined;
    entries = [];
    notShown = 0;
    filterLang = "all";
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
        lastFiles = payload.files.map((f) => ({
          ref: f.ref,
          riskBucket: f.riskBucket,
          language: f.language ?? "typescript",
        }));
        if (filterLang !== "all" && !languagesPresent().includes(filterLang)) filterLang = "all";
        const files = filteredFiles();
        entries = files === undefined ? [] : orderedEntries(files, dims);
        notShown = collisionsOf(files, entries);
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

    /** Cycles the language filter: all → each distinct language present (sorted
     *  by short label) → all. Filtering happens before layout; the cursor
     *  survives by ref (same as resize). */
    cycleLanguageFilter(): void {
      const cycle = ["all", ...languagesPresent()];
      const at = cycle.indexOf(filterLang);
      filterLang = cycle[(at + 1) % cycle.length] ?? "all";
      relayoutPreservingSelection();
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
          label: `${languageShort(e.language).padEnd(4)} ${e.ref}`,
          marker: RISK_SHADING[e.bucket].marker,
          selected: i === cursor,
        });
      }
      // I3: collision-skip losers are disclosed in the title, never silently dropped while
      // the count still claims them. The language filter suffix rides last (Task 10).
      const notShownSuffix = notShown > 0 ? ` (${notShown} not shown — narrow layout collisions)` : "";
      const langSuffix = ` · lang: ${filterLang === "all" ? "all" : languageShort(filterLang)}`;
      return { title: title + notShownSuffix + langSuffix, banner, rows, cursor };
    },
  };
}
