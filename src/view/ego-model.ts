/**
 * Ego screen model (ego-graph-view plan Task 4): navigation state machine over the
 * egoGraph rpc payload — column/row cursor movement, re-center history with a
 * cached pop, hub-cap disclosure, narrow-terminal collapse to a list view, and
 * canvas windowing. No OpenTUI imports — headless-testable like the sibling
 * models (file-map-model / symbol-view-model / detail-model).
 *
 * Honesty rulings pinned here:
 * - The payload's 15-neighbor cap is NEVER hidden: totals ride the title, the
 *   hidden count names closegraph_blast_radius, unresolved outgoing calls and
 *   unroutable edges render as muted lines (never silently missing).
 * - `u`/backspace pops the CENTER history in-model (cached payload — never an
 *   rpc call); `esc` pops the SCREEN and stays in Task 5's route — the footer
 *   words the two apart, and EGO_KEYMAP deliberately has no escape binding.
 * - Windowing follows the selection (RESERVED_ROWS chrome, same constant family
 *   as the other models); selection survives resizes by ref.
 */
import type { EgoGraphData, EgoGraphPayload, EgoNeighbor } from "../../rpc/index.js";
import type { GraphNode } from "../graph/types.js";
import { renderMatches } from "../tools/resolve-ref.js";
import { egoLayout, egoMinWidth, type EgoBox, type EgoCanvas } from "./ego-layout.js";
import { RISK_SHADING, type Dims } from "./file-map-model.js";
import { bannerNone, bannerUnavailable, bannerUnknownFreshness, type Banner } from "./banner.js";

export interface EgoLine {
  text: string;
  muted?: boolean;
}

export interface EgoState {
  title: string;
  banner: Banner;
  /** graph = canvas; list = narrow collapse; miss = not-found/unavailable */
  mode: "graph" | "list" | "miss";
  /** mode "graph" only */
  canvas?: EgoCanvas;
  /** summary lines (graph mode) / list+miss bodies */
  lines: EgoLine[];
  /** highlighted node (center or neighbor) */
  cursorRef?: string;
  /** centers behind the current one */
  historyDepth: number;
  /** pinned text incl. the u/esc distinction */
  footer: string;
}

export const EGO_ACTIONS = ["up", "down", "left", "right", "open", "backCenter", "refresh"] as const;
export type EgoAction = (typeof EGO_ACTIONS)[number];
export const EGO_KEYMAP: Record<EgoAction, readonly string[]> = {
  up: ["up", "k"],
  down: ["down", "j"],
  left: ["left", "h"],
  right: ["right", "l"],
  open: ["enter", "return"],
  /** center history — DISTINCT from the screen-stack esc pop (Task 5) */
  backCenter: ["u", "backspace"],
  refresh: ["r"],
};

export const HISTORY_CAP = 50;

/** Rendered actions footer — pinned text; bracket tokens mirror EGO_KEYMAP (esc rides Task 5's route). */
export const EGO_ACTIONS_LINE = "[h/l] columns  [j/k] rows  [enter] re-center  [u] back a center  [r] refresh  [esc] back a screen";

/** List-view names per side — mirrors the rpc's EGO_CAP (15); payload is already capped, this is the belt. */
const LIST_CAP = 15;

const DEFAULT_DIMS: Dims = { width: 80, height: 24 };

/** title + banner + footer chrome reserved out of the visible row budget. */
const RESERVED_ROWS = 4;

/** One history entry: the center we left AND the payload we were showing — pops never re-fetch. */
interface HistoryEntry {
  ref: string;
  payload: EgoGraphData;
}

function toBox(n: EgoNeighbor): EgoBox {
  const hash = n.ref.lastIndexOf("#");
  const file = hash === -1 ? n.ref : n.ref.slice(0, hash);
  const label = hash === -1 ? file.slice(file.lastIndexOf("/") + 1) : n.ref.slice(hash + 1);
  return {
    ref: n.ref,
    label,
    detail: `${file} c:${n.callers} e:${n.callees}`,
    marker: RISK_SHADING[n.riskBucket].marker,
    bucket: n.riskBucket,
  };
}

function titleFor(ref: string, p: EgoGraphData): string {
  const hidden = p.totalCallers - p.callers.length + (p.totalCallees - p.callees.length);
  return (
    `Ego — ${ref} — ${p.totalCallers} callers, ${p.totalCallees} callees` +
    (hidden > 0 ? ` +${hidden} more — closegraph_blast_radius` : "") +
    (p.source === "snapshot" ? " (snapshot)" : "")
  );
}

/** Miss rendering in the detail model's exact voice (renderMatches + M3 branch headings). */
function missLines(ref: string, suggestions: string[], ambiguous: boolean): EgoLine[] {
  if (suggestions.length === 0) {
    return [{ text: `not found: ${ref} (no similar symbols in the graph)` }];
  }
  return renderMatches(
    ref,
    suggestions.map((qualifiedName) => ({ qualifiedName }) as GraphNode),
    ambiguous ? "multiple matches — did you mean" : "not found — did you mean",
  )
    .split("\n")
    .map((text) => ({ text }));
}

export function createEgoModel(deps: {
  ref: string;
  egoGraph: (ref: string) => Promise<EgoGraphPayload>;
}) {
  let dims: Dims = { ...DEFAULT_DIMS };
  let currentRef = deps.ref;
  let data: EgoGraphData | undefined;
  let fullCanvas: EgoCanvas | undefined;
  let banner: Banner = bannerNone();
  let mode: "graph" | "list" | "miss" = "graph";
  let title = `Ego — ${deps.ref}`;
  let lines: EgoLine[] = [];
  /** cursor.col: 0 = callers, 1 = center, 2 = callees; cursor.row indexes that column. */
  let cursor = { col: 1, row: 0 };
  /** per-column remembered row — moveColumn lands on the LAST-shown node of a column. */
  let columnRows: Record<number, number> = { 1: 0 };
  let history: HistoryEntry[] = [];
  let scroll = 0;
  let loadSeq = 0;

  /** The three navigation columns as neighbor lists (center column = the center alone). */
  function columns(): EgoNeighbor[][] {
    return data === undefined ? [[], [], []] : [data.callers, [data.center], data.callees];
  }

  function cursorRef(): string | undefined {
    return columns()[cursor.col][cursor.row]?.ref;
  }

  function resetCursor(): void {
    cursor = { col: 1, row: 0 };
    columnRows = { 1: 0 };
    scroll = 0;
  }

  function rebuildLines(): void {
    if (data === undefined) {
      if (mode !== "miss") lines = [];
      return;
    }
    if (mode === "list") {
      lines = [
        { text: `terminal too narrow — list view (resize ≥ ${egoMinWidth()} cols for the graph)`, muted: true },
        { text: `callers (${data.totalCallers}): ${data.callers.slice(0, LIST_CAP).map((n) => n.ref).join(", ")}` },
        { text: `callees (${data.totalCallees}): ${data.callees.slice(0, LIST_CAP).map((n) => n.ref).join(", ")}` },
      ];
      return;
    }
    const out: EgoLine[] = [];
    if (data.unresolvedOut > 0) {
      out.push({ text: `unresolved calls: ${data.unresolvedOut} (not drawn — see closegraph_query)`, muted: true });
    }
    if (fullCanvas !== undefined && fullCanvas.undrawnEdges > 0) {
      out.push({ text: `${fullCanvas.undrawnEdges} edge(s) not drawn — narrow layout`, muted: true });
    }
    lines = out;
  }

  function apply(payload: EgoGraphPayload, askedRef: string): void {
    if ("error" in payload) {
      if (payload.error === "unavailable") {
        banner = bannerUnavailable(payload.message);
        data = undefined;
        fullCanvas = undefined;
        mode = "miss";
        lines = [];
        title = `Ego — ${askedRef}`;
        resetCursor();
        return;
      }
      // not-found still carries Provenance (Ruling 13) — surface staleness here too.
      banner = payload.staleness === "unknown" ? bannerUnknownFreshness() : bannerNone();
      data = undefined;
      fullCanvas = undefined;
      mode = "miss";
      lines = missLines(askedRef, payload.suggestions, payload.ambiguous);
      title = `Ego — ${askedRef}`;
      resetCursor();
      return;
    }
    banner = payload.staleness === "unknown" ? bannerUnknownFreshness() : bannerNone();
    data = payload;
    currentRef = payload.center.ref; // canonical resolved name — refreshes re-fetch this
    fullCanvas = egoLayout({
      center: toBox(payload.center),
      callers: payload.callers.map(toBox),
      callees: payload.callees.map(toBox),
    });
    title = titleFor(currentRef, payload);
    mode = dims.width < egoMinWidth() ? "list" : "graph";
    resetCursor();
    rebuildLines();
  }

  /** Row (in the full canvas) of the box's mid line for `ref` — windowing anchor. */
  function selectedRowOf(ref: string | undefined): number {
    const target = ref ?? data?.center.ref;
    if (fullCanvas === undefined || target === undefined) return 0;
    for (let r = 0; r < fullCanvas.rows.length; r++) {
      if (fullCanvas.rows[r].some((seg) => seg.ref === target)) return r + 2; // first row = box top; +2 = mid
    }
    return 0;
  }

  /** Re-center on `ref`: push the current center + payload, then reload. */
  function recenter(ref: string): void {
    if (data !== undefined) {
      history.push({ ref: currentRef, payload: data });
      if (history.length > HISTORY_CAP) history.shift(); // at cap, the oldest center falls off
    }
    currentRef = ref;
    void load();
  }

  async function load(): Promise<void> {
    const seq = ++loadSeq;
    try {
      const payload = await deps.egoGraph(currentRef);
      if (seq !== loadSeq) return; // a newer load/refresh already won (R5)
      apply(payload, currentRef);
    } catch (err) {
      if (seq !== loadSeq) return;
      apply({ error: "unavailable", message: err instanceof Error ? err.message : String(err) }, currentRef);
    }
  }

  return {
    /** Loads the center's ego graph; never rejects — failures land in miss mode / the banner (R4). */
    load,

    /** Manual refresh (Ruling 4): load() over the CURRENT center. */
    async refresh(): Promise<void> {
      await load();
    },

    /** Dims change re-windows without a refetch; the cursor survives by ref, graph ⇄ list per width. */
    resize(next: Dims): void {
      if (next.width === dims.width && next.height === dims.height) return;
      dims = { ...next };
      if (data !== undefined) {
        mode = dims.width < egoMinWidth() ? "list" : "graph";
        rebuildLines();
      }
    },

    /** Callers col ⇄ center ⇄ callees col; empty target column = no-op. Lands on the
     *  column's LAST-shown row (first visit: the index nearest the previous row, clamped). */
    moveColumn(delta: 1 | -1): void {
      const cols = columns();
      const target = cursor.col + delta;
      if (target < 0 || target > 2) return;
      if (cols[target].length === 0) return;
      const remembered = columnRows[target];
      const row = Math.min(remembered === undefined ? cursor.row : remembered, cols[target].length - 1);
      columnRows[cursor.col] = cursor.row;
      cursor = { col: target, row };
      columnRows[target] = row;
    },

    /** Within-column movement: clamps at both ends, no wrap (deterministic). */
    moveRow(delta: number): void {
      const len = columns()[cursor.col].length;
      if (len === 0) return;
      cursor.row = Math.max(0, Math.min(cursor.row + delta, len - 1));
      columnRows[cursor.col] = cursor.row;
    },

    /** Click parity: select `ref`; if it is ALREADY highlighted (and not the center) → re-center. */
    selectByRef(ref: string): void {
      if (ref === cursorRef() && ref !== currentRef) {
        recenter(ref);
        return;
      }
      const cols = columns();
      for (let c = 0; c < 3; c++) {
        const at = cols[c].findIndex((n) => n.ref === ref);
        if (at >= 0) {
          columnRows[cursor.col] = cursor.row;
          cursor = { col: c, row: at };
          columnRows[c] = at;
          return;
        }
      }
      // unknown ref: no-op
    },

    /** Enter: on a neighbor → re-center (push history); on the center → refresh (no push). */
    open(): void {
      const target = cursorRef();
      if (target === undefined || target === currentRef) {
        void load();
        return;
      }
      recenter(target);
    },

    /** u/backspace: restore the previous center from cache — NO rpc call. No-op at depth 0. */
    backCenter(): void {
      const entry = history.pop();
      if (entry === undefined) return;
      currentRef = entry.ref;
      apply(entry.payload, entry.ref);
    },

    state(): EgoState {
      const cur = cursorRef();
      let canvas: EgoCanvas | undefined;
      if (mode === "graph" && fullCanvas !== undefined) {
        const mid = selectedRowOf(cur);
        const max = Math.max(1, dims.height - RESERVED_ROWS);
        scroll = Math.max(0, Math.min(scroll, mid));
        scroll = Math.max(scroll, mid - max + 1);
        const rows = fullCanvas.rows.slice(scroll, scroll + max);
        canvas = { rows, width: fullCanvas.width, height: rows.length, undrawnEdges: fullCanvas.undrawnEdges };
      }
      return {
        title,
        banner,
        mode,
        ...(canvas !== undefined ? { canvas } : {}),
        lines,
        ...(cur !== undefined ? { cursorRef: cur } : {}),
        historyDepth: history.length,
        footer: EGO_ACTIONS_LINE,
      };
    },
  };
}
