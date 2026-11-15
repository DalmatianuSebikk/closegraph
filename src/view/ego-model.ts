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
import type { EgoGraphData, EgoGraphPayload, EgoNeighbor, EgoSourcePayload } from "../../rpc/index.js";
import type { GraphNode } from "../graph/types.js";
import { renderMatches } from "../tools/resolve-ref.js";
import { egoLayout, egoMinWidth, EGO_PAD, BOX_MID_ROW, type EgoBox, type EgoCanvas } from "./ego-layout.js";
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
  /** the `i` source-preview overlay — present ONLY while open (the route renders it) */
  preview?: EgoPreviewState;
}

/** Lazy source preview (the `i` overlay): loaded on OPEN, never on selection. */
export interface EgoPreviewState {
  ref: string;
  status: "loading" | "ready" | "error";
  signature?: string;
  file?: string;
  startLine?: number;
  lines: string[];
  message?: string;
}

export const EGO_ACTIONS = ["up", "down", "left", "right", "open", "backCenter", "refresh", "preview"] as const;
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
  /** source preview overlay (enrichment iteration) — lazy, per open */
  preview: ["i"],
};

export const HISTORY_CAP = 50;

/** Rendered actions footer — pinned text. ≤ 78 chars so the [esc] exit hint survives
 *  stock 80-col terminals; bracket tokens mirror EGO_KEYMAP (esc rides Task 5's route). */
export const EGO_ACTIONS_LINE = "[hjkl] [i] preview [enter] recenter [u] prev center [r] refresh [esc] back";

/** List-view names per side — MUST mirror the rpc's EGO_CAP (src/rpc-methods.ts); pinned
 *  equal by test so drift breaks the build's test, not users. */
export const LIST_CAP = 15;

const DEFAULT_DIMS: Dims = { width: 80, height: 24 };

/** title + banner + footer chrome reserved out of the visible row budget. */
const RESERVED_ROWS = 4;

/** Narrowest TERMINAL width at which the graph draws: min canvas + the route's side padding. */
function graphMinWidth(): number {
  return egoMinWidth() + EGO_PAD;
}

/** Elide a too-long title from the LEFT: the qualified name's head is the disposable
 *  part (the symbol-name TAIL is what identifies the node) and the counts/snapshot
 *  suffix always survives. Last resort (suffix alone ≥ width): elide the whole line. */
function elideTitle(t: string, width: number): string {
  if (t.length <= width) return t;
  const prefix = "Ego — ";
  const dash = t.indexOf(" — ", prefix.length);
  if (dash === -1) return "…" + t.slice(t.length - width + 1);
  const suffix = t.slice(dash);
  const ref = t.slice(prefix.length, dash);
  const keep = width - prefix.length - suffix.length - 1; // −1 for the leading …
  if (keep <= 0) return "…" + t.slice(t.length - width + 1);
  return prefix + "…" + ref.slice(ref.length - keep) + suffix;
}

/** One history entry: the center we left AND the payload we were showing — pops never re-fetch. */
interface HistoryEntry {
  ref: string;
  payload: EgoGraphData;
}

function toBox(n: EgoNeighbor): EgoBox {
  const hash = n.ref.lastIndexOf("#");
  const label = hash === -1 ? n.file.slice(n.file.lastIndexOf("/") + 1) : n.ref.slice(hash + 1);
  const badges = n.sinks.map((s) => (s.count > 1 ? `${s.name} ×${s.count}` : s.name)).join(", ");
  return {
    ref: n.ref,
    file: n.file,
    label,
    kind: n.kind === "Function" ? "Fn" : n.kind === "Class" ? "Cl" : "File",
    ...(n.signature !== undefined ? { signature: n.signature } : {}),
    startLine: n.startLine,
    riskReason: n.riskReason,
    // capped sink list discloses the remainder ("eval ×2, exec ×1 +2")
    sinks: n.sinksTotal > n.sinks.length ? `${badges} +${n.sinksTotal - n.sinks.length}` : badges,
    fanIn: n.callers,
    fanOut: n.callees,
    exported: n.exported,
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
  /** lazy source preview; optional so graph-only callers keep working (no-op then) */
  egoSource?: (ref: string) => Promise<EgoSourcePayload>;
}) {
  let dims: Dims = { ...DEFAULT_DIMS };
  let currentRef = deps.ref;
  let data: EgoGraphData | undefined;
  /** Per-payload boxes kept from apply() (never re-parsed) — repaints re-run egoLayout
   *  over these with the CURRENT selectedRef (~1 ms per spike E8 — fine per keystroke). */
  let boxes: { center: EgoBox; callers: EgoBox[]; callees: EgoBox[] } | undefined;
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
  /** the `i` overlay: state exists only while open — absent from state() when closed */
  let preview: { open: boolean; state?: EgoPreviewState } = { open: false };
  let previewSeq = 0;

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
        { text: `terminal too narrow — list view (resize ≥ ${graphMinWidth()} cols for the graph)`, muted: true },
        { text: `callers (${data.totalCallers}): ${data.callers.slice(0, LIST_CAP).map((n) => n.ref).join(", ")}` },
        { text: `callees (${data.totalCallees}): ${data.callees.slice(0, LIST_CAP).map((n) => n.ref).join(", ")}` },
      ];
      return;
    }
    const out: EgoLine[] = [];
    const cur = cursorRef();
    if (cur !== undefined) {
      // full-name visibility: the selected box's ENTIRE qualified name rides directly
      // under the title (unmuted), whatever the box width does to the label.
      out.push({ text: cur });
    }
    if (data.unresolvedOut > 0) {
      out.push({ text: `unresolved calls: ${data.unresolvedOut} (not drawn — see closegraph_query)`, muted: true });
    }
    if (fullCanvas !== undefined && fullCanvas.undrawnEdges > 0) {
      out.push({ text: `${fullCanvas.undrawnEdges} edge(s) not drawn — narrow layout`, muted: true });
    }
    lines = out;
  }

  /** Rebuild the canvas with the CURRENT cursor painted as the selection (Critical 1:
   *  without this, h/j/k/l/clicks move an invisible cursor — the route renders seg
   *  styles verbatim and never consumes cursorRef). Cheap: fixed geometry, ~1 ms.
   *  Also refreshes the chrome lines — the selected-ref line tracks the cursor, and
   *  the windowing budget (state) counts lines.length. */
  function repaint(): void {
    if (boxes === undefined) {
      fullCanvas = undefined;
      return;
    }
    fullCanvas = egoLayout({ ...boxes, selectedRef: cursorRef(), width: dims.width });
    rebuildLines();
  }

  function apply(payload: EgoGraphPayload, askedRef: string): void {
    preview = { open: false }; // a payload swap invalidates any open preview (stale ref)
    if ("error" in payload) {
      if (payload.error === "unavailable") {
        banner = bannerUnavailable(payload.message);
        data = undefined;
        boxes = undefined;
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
      boxes = undefined;
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
    boxes = {
      center: toBox(payload.center),
      callers: payload.callers.map(toBox),
      callees: payload.callees.map(toBox),
    };
    title = titleFor(currentRef, payload);
    mode = dims.width < graphMinWidth() ? "list" : "graph";
    resetCursor(); // cursor lands on the center BEFORE the first paint (it starts selected)
    repaint(); // paints + rebuilds the chrome lines (selected-ref line included)
  }

  /** Row (in the full canvas) of the box's mid line for `ref` — windowing anchor. */
  function selectedRowOf(ref: string | undefined): number {
    const target = ref ?? data?.center.ref;
    if (fullCanvas === undefined || target === undefined) return 0;
    for (let r = 0; r < fullCanvas.rows.length; r++) {
      if (fullCanvas.rows[r].some((seg) => seg.ref === target)) return r + BOX_MID_ROW; // first row = box top
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
        mode = dims.width < graphMinWidth() ? "list" : "graph";
        repaint(); // re-derive the ADAPTIVE box width + rebuild the chrome lines
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
      repaint(); // paint the moved selection (Critical 1)
    },

    /** Within-column movement: clamps at both ends, no wrap (deterministic). */
    moveRow(delta: number): void {
      const len = columns()[cursor.col].length;
      if (len === 0) return;
      cursor.row = Math.max(0, Math.min(cursor.row + delta, len - 1));
      columnRows[cursor.col] = cursor.row;
      repaint(); // paint the moved selection (Critical 1)
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
          repaint(); // paint the moved selection (Critical 1)
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

    /** u/backspace: restore the previous center from cache — NO rpc call. No-op at depth 0.
     *  Bumping loadSeq FIRST kills any in-flight load (an open's re-fetch or a refresh):
     *  without it, a pending load would resolve AFTER the pop and apply() over the
     *  restored center — destroying the history entry the user just asked for. */
    backCenter(): void {
      loadSeq++;
      const entry = history.pop();
      if (entry === undefined) return;
      currentRef = entry.ref;
      apply(entry.payload, entry.ref);
    },

    /** `i`: open the source-preview overlay on the SELECTED box and load it LAZILY —
     *  selection never fetches; open does (one egoSource call per open). No-op without
     *  an egoSource dep (graph-only callers). */
    openPreview(): void {
      const ref = cursorRef();
      if (ref === undefined || deps.egoSource === undefined) return;
      const seq = ++previewSeq;
      preview = { open: true, state: { ref, status: "loading", lines: [] } };
      void deps.egoSource(ref).then((payload) => {
        // stale guard: closed, superseded by another open, or invalidated by a payload swap
        if (!preview.open || seq !== previewSeq) return;
        if ("error" in payload) {
          const message =
            payload.error === "unavailable"
              ? payload.message
              : payload.suggestions.length > 0
                ? `not found — did you mean (${payload.suggestions.length}) for ${ref}`
                : `not found: ${ref}`;
          preview.state = { ref, status: "error", lines: [], message };
          return;
        }
        preview.state = {
          ref: payload.ref,
          status: "ready",
          ...(payload.signature !== undefined ? { signature: payload.signature } : {}),
          file: payload.file,
          startLine: payload.startLine,
          lines: payload.lines,
        };
      });
    },

    /** esc/i close the overlay (route-owned keys; the model just clears the state). */
    closePreview(): void {
      previewSeq++; // any in-flight load lands dead
      preview = { open: false };
    },

    state(): EgoState {
      const cur = cursorRef();
      let canvas: EgoCanvas | undefined;
      if (mode === "graph" && fullCanvas !== undefined) {
        const mid = selectedRowOf(cur);
        // dynamic row budget (M2/Minor 4): title + banner + footer chrome (RESERVED_ROWS)
        // PLUS however many disclosure lines this payload renders (unresolvedOut /
        // undrawnEdges live ABOVE the canvas) — a static 4 under-counts by a row when
        // both lines show and clips the last canvas row.
        const max = Math.max(1, dims.height - RESERVED_ROWS - lines.length);
        // top clamp to mid - BOX_MID_ROW = the box's TOP row: the selected box never
        // renders half-clipped when the cursor moves up; the bottom clamp still
        // guarantees the mid row stays visible in tiny windows.
        scroll = Math.max(0, Math.min(scroll, mid - BOX_MID_ROW));
        scroll = Math.max(scroll, mid - max + 1);
        const rows = fullCanvas.rows.slice(scroll, scroll + max);
        canvas = { rows, width: fullCanvas.width, height: rows.length, undrawnEdges: fullCanvas.undrawnEdges };
      }
      return {
        title: elideTitle(title, dims.width - EGO_PAD),
        banner,
        mode,
        ...(canvas !== undefined ? { canvas } : {}),
        lines,
        ...(cur !== undefined ? { cursorRef: cur } : {}),
        historyDepth: history.length,
        footer: EGO_ACTIONS_LINE,
        ...(preview.open && preview.state !== undefined ? { preview: preview.state } : {}),
      };
    },
  };
}
