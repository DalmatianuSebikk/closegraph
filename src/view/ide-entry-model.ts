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
 *
 * Task 3 — file view: one card per symbol in left-to-right call-depth layers over the
 * intra-file wire graph (in-file sources leftmost, tie-broken by name; cycles broken
 * deterministically by name past the reached depths). Each card's `parentRef` is its
 * lexically-first in-file callee one column deeper — the only wire shape the existing
 * adjacent-column gutter router can draw; every other wire is disclosed via the
 * accounting triple `wires.drawn + wires.undrawn + wires.truncated === wires.total`
 * (never silently dropped). Cards cap at 30 with `moreSymbols` disclosing the rest.
 */
import type { FilesPayload, FileSymbolsPayload, SymbolSummary, WirePair } from "../../rpc/index.js";
import type { RiskBucket } from "./risk.js";
import { RISK_SHADING, type Dims } from "./file-map-model.js";
import { bannerNone, bannerUnavailable, bannerUnknownFreshness, type Banner } from "./banner.js";

const DEFAULT_DIMS: Dims = { width: 80, height: 24 };

/** Entry-phase chrome reserved out of the visible row budget (header, banner, footer/command). */
export const ENTRY_RESERVED_ROWS = 4;

/** Max cards rendered in the file view; the remainder is disclosed via `moreSymbols`. */
const ENTRY_CARDS_CAP = 30;

/** Honest empty-state note when a file renders zero symbols (design: no invented error). */
const EMPTY_FILE_NOTE = "no symbols indexed in this file — esc back to the list";

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

export interface EntryCard {
  ref: string;
  kind: "Function" | "Class";
  marker: "" | "!" | "!!" | "!!!";
  callers: number;
  callees: number;
  /** BFS call-depth layer — the left-to-right column. */
  column: number;
  /** Lexically-first in-file callee at column+1 — the one wire the gutter router draws. */
  parentRef?: string;
}

export interface EntryFileViewState {
  screen: "file-view";
  file: string;
  header: string;
  cards: EntryCard[];
  /** drawn + undrawn + truncated === total (the reconcile invariant, exact everywhere). */
  wires: { drawn: number; undrawn: number; truncated: number; total: number };
  moreSymbols: number;
  cursor: number;
  banner: Banner;
  note: string | null;
}

export type EntryState = FileListState | EntryFileViewState;

/** Deterministic call-depth layers: BFS from in-file sources (zero in-file wires in),
 *  tie-broken by ref; symbols unreachable from any source (pure cycles) land one past
 *  the deepest reached layer, ordered by ref — terminates, same input ⇒ same output. */
function computeDepths(refs: string[], wires: WirePair[]): Map<string, number> {
  const inDeg = new Map<string, number>(refs.map((r) => [r, 0]));
  const adj = new Map<string, string[]>(refs.map((r) => [r, [] as string[]]));
  for (const w of wires) {
    if (!inDeg.has(w.from) || !inDeg.has(w.to)) continue;
    inDeg.set(w.to, (inDeg.get(w.to) ?? 0) + 1);
    adj.get(w.from)!.push(w.to);
  }
  for (const list of adj.values()) list.sort();
  const depths = new Map<string, number>();
  const queue = refs.filter((r) => inDeg.get(r) === 0).sort();
  for (const r of queue) depths.set(r, 0);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const d = depths.get(cur) ?? 0;
    for (const next of adj.get(cur) ?? []) {
      if (!depths.has(next)) {
        depths.set(next, d + 1);
        queue.push(next);
      }
    }
  }
  let maxReached = -1;
  for (const d of depths.values()) maxReached = Math.max(maxReached, d);
  for (const r of refs) if (!depths.has(r)) depths.set(r, maxReached + 1);
  return depths;
}

export function createEntryModel(deps: { files: () => Promise<FilesPayload>; fileSymbols: (file: string) => Promise<FileSymbolsPayload> }) {
  let dims: Dims = { ...DEFAULT_DIMS };
  let sorted: { ref: string; language: string; symbols: number; bucket: RiskBucket }[] = [];
  let banner: Banner = bannerNone();
  let cursor = 0;
  let windowOffset = 0;
  let loading = false;
  let loadSeq = 0;
  let screen: "file-list" | "file-view" = "file-list";
  let view: Omit<EntryFileViewState, "banner"> | undefined;
  let openSeq = 0;

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

  /** Builds the file-view state from a successful payload. Deterministic: same payload ⇒ same state. */
  function applyFileView(
    file: string,
    payload: { symbols: SymbolSummary[]; wires: WirePair[]; wiresTotal: number; wiresTruncated?: true },
  ): void {
    const depths = computeDepths(
      payload.symbols.map((s) => s.ref),
      payload.wires,
    );
    const ordered = [...payload.symbols].sort((a, b) => {
      const da = depths.get(a.ref) ?? 0;
      const db = depths.get(b.ref) ?? 0;
      if (da !== db) return da - db;
      return a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0;
    });
    const shown = ordered.slice(0, ENTRY_CARDS_CAP);
    const shownSet = new Set(shown.map((s) => s.ref));
    const cards: EntryCard[] = shown.map((s) => {
      const column = depths.get(s.ref) ?? 0;
      const card: EntryCard = {
        ref: s.ref,
        kind: s.kind,
        marker: RISK_SHADING[s.riskBucket].marker,
        callers: s.callers,
        callees: s.callees,
        column,
      };
      const candidates = payload.wires
        .filter((w) => w.from === s.ref && shownSet.has(w.to) && (depths.get(w.to) ?? 0) === column + 1)
        .map((w) => w.to)
        .sort();
      if (candidates.length > 0) card.parentRef = candidates[0];
      return card;
    });
    const byRef = new Map(cards.map((c) => [c.ref, c] as const));
    let drawn = 0;
    for (const w of payload.wires) {
      const from = byRef.get(w.from);
      if (from?.parentRef === w.to) drawn++;
    }
    const undrawn = payload.wires.length - drawn;
    const truncated = payload.wiresTotal - payload.wires.length;
    const worst = payload.symbols.reduce<RiskBucket>((acc, s) => (RISK_ORDER[s.riskBucket] < RISK_ORDER[acc] ? s.riskBucket : acc), "low");
    const worstMarker = RISK_SHADING[worst].marker;
    view = {
      screen: "file-view",
      file,
      header: `${file} · ${payload.symbols.length} symbols · ${payload.wiresTotal} wires · risk ${worstMarker === "" ? "low" : worstMarker}`,
      cards,
      wires: { drawn, undrawn, truncated, total: payload.wiresTotal },
      moreSymbols: Math.max(0, payload.symbols.length - shown.length),
      cursor: 0,
      note: payload.symbols.length === 0 ? EMPTY_FILE_NOTE : null,
    };
    screen = "file-view";
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

    /** Opens a file's symbol cards; seq-guarded, never rejects. A failed fetch keeps
     *  the current screen and lands in the banner — an unavailable graph never blanks
     *  a view the user already had (only successful payloads switch screens). */
    async openFile(ref: string): Promise<void> {
      const seq = ++openSeq;
      try {
        const payload = await deps.fileSymbols(ref);
        if (seq !== openSeq) return;
        if ("error" in payload) {
          banner = bannerUnavailable(payload.message);
          return;
        }
        banner = payload.staleness === "unknown" ? bannerUnknownFreshness() : bannerNone();
        applyFileView(ref, payload);
      } catch (err) {
        if (seq !== openSeq) return;
        banner = bannerUnavailable(err instanceof Error ? err.message : String(err));
      }
    },

    /** Back to the file list — the list state (cursor, window, rows) was kept intact. */
    back(): void {
      screen = "file-list";
    },

    /** Dims change re-windows without a refetch; the cursor keeps its absolute slot. */
    resize(next: Dims): void {
      if (next.width === dims.width && next.height === dims.height) return;
      dims = { ...next };
      clampWindow();
    },

    /** Cursor movement clamps at both ends; the window follows (deterministic, no wrap).
     *  In the file view it moves across the rendered cards (no wrap there either). */
    move(delta: number): void {
      if (screen === "file-view" && view) {
        if (view.cards.length === 0) return;
        view.cursor = Math.max(0, Math.min(view.cursor + delta, view.cards.length - 1));
        return;
      }
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

    /** The card under the file-view cursor. */
    selectedCard(): EntryCard | undefined {
      return view?.cards[view.cursor];
    },

    state(): EntryState {
      if (screen === "file-view" && view) return { ...view, banner };
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
