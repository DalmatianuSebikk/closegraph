/**
 * IDE screen model (codegraph-ide-screen plan Task 3): the state machine over the
 * egoGraph / nodeDetail / egoSource rpc payloads — responsive width modes, panel
 * visibility, column/row selection with viewport windowing, re-center history
 * with a cached pop (HISTORY_CAP semantics shared with the ego model), lazy
 * inspector detail with a route-driven settle, and the command bar. No OpenTUI
 * imports — headless-testable like the sibling ego/file-map/symbol models.
 *
 * Honesty rulings pinned here:
 * - Hub caps are NEVER hidden: a truncated side gains a dashed `+N more`
 *   placeholder card and the header stats carry the exact hidden count.
 * - Missing values render as `—` (signature, guards, sinks); unresolved calls
 *   are a count line, never drawn as edges.
 * - Depth is 1 in this task: depthUp past MAX pins the disclosed note
 *   `depth 2 lands with ring expansion` (Task 5 replaces this with real rings).
 * - The graph viewport is NEVER < 40 cols: panels are suppressed first and the
 *   command-bar note discloses it (compact-mode inspector overlay ⇒ the route
 *   replaces the canvas instead of splitting).
 * - Inspector nodeDetail is lazy: selection marks it stale, dispatch never
 *   waits on it, state() renders a "loading…" line until the fetch lands. The
 *   route drives the 80 ms settle via detailDirty()/loadDetail(); the model
 *   also calls loadDetail() itself from load()/open()/backCenter() so
 *   keyboard-only flows stay correct.
 */
import type {
  EgoGraphData,
  EgoGraphPayload,
  EgoNeighbor,
  EgoSourcePayload,
  NodeDetail,
  NodeDetailPayload,
} from "../../rpc/index.js";
import type { GraphNode } from "../graph/types.js";
import { renderMatches } from "../tools/resolve-ref.js";
import { bannerNone, bannerUnavailable, bannerUnknownFreshness, type Banner } from "./banner.js";
import type { Dims } from "./file-map-model.js";
import { HISTORY_CAP, LIST_CAP } from "./ego-model.js";
import { IDE_THEME, categoryColor, categoryOf } from "./ide-theme.js";
import {
  CARD_MID_ROW,
  ideLayout,
  minimapCells,
  toSegments,
  type Cell,
  type IdeCanvas,
  type IdeCard,
  type IdeColumn,
  type IdeSegment,
} from "./ide-layout.js";

export type IdeMode = "full" | "no-sidebar" | "no-panels" | "compact" | "list";
export type PanelFocus = "sidebar" | "graph" | "inspector";
export const SIDEBAR_W = 30;
export const INSPECTOR_W = 39;
export const HEADER_ROWS = 3;
export const COMMAND_ROWS = 3;

export type IdeAction =
  | "left" | "right" | "up" | "down" | "open" | "collapse" | "cyclePanel" | "search"
  | "depthUp" | "depthDown" | "fit" | "center" | "toggleInspector" | "toggleMinimap" | "toggleSidebar"
  | "help" | "back" | "backCenter" | "refresh"
  | "command1" | "command2" | "command3" | "command4" | "command5";

export const IDE_ACTIONS: readonly IdeAction[] = [
  "left", "right", "up", "down", "open", "collapse", "cyclePanel", "search",
  "depthUp", "depthDown", "fit", "center", "toggleInspector", "toggleMinimap", "toggleSidebar",
  "help", "back", "backCenter", "refresh",
  "command1", "command2", "command3", "command4", "command5",
];

export const IDE_KEYMAP: Record<IdeAction, readonly string[]> = {
  left: ["left", "h"],
  right: ["right", "l"],
  up: ["up", "k"],
  down: ["down", "j"],
  open: ["enter", "return"],
  collapse: ["space"],
  cyclePanel: ["tab"],
  search: ["/"],
  depthUp: ["+"],
  depthDown: ["-"],
  fit: ["f"],
  center: ["c"],
  toggleInspector: ["i"],
  toggleMinimap: ["m"],
  toggleSidebar: ["b"],
  help: ["?"],
  back: ["escape", "esc"],
  /** center history — DISTINCT from the screen-stack esc pop (the route owns back) */
  backCenter: ["u", "backspace"],
  refresh: ["r"],
  command1: ["1"],
  command2: ["2"],
  command3: ["3"],
  command4: ["4"],
  command5: ["5"],
};

export interface InspectorSection {
  title: string;
  lines: { text: string; fg?: string; ref?: string }[];
}

export interface IdeState {
  mode: IdeMode;
  banner: Banner;
  screen: "graph" | "miss";
  header: {
    breadcrumb: string;
    repoLabel: string;
    status: string;
    tabs: { label: string; active: boolean }[];
    stats: string;
  };
  sidebar?: { lines: { text: string; fg?: string }[]; minimap: (Cell | undefined)[][] };
  canvas?: { rows: IdeSegment[][]; width: number }; // viewport-clipped
  inspector?: { title: string; sections: InspectorSection[]; scroll: number; height: number };
  commandBar: { actions: { key: string; label: string; active: boolean }[]; note?: string };
  help?: string[];
  miss?: { lines: { text: string; muted?: boolean }[] };
  selectedRef?: string;
  focusRef: string;
  depth: number;
  historyDepth: number;
}

/** The graph viewport is NEVER narrower than this — panels are suppressed first. */
const MIN_VIEWPORT_W = 40;
/** Narrowest width with any graph at all (below: the ego-family list wording). */
const LIST_MIN_W = 68;
const MINIMAP_W = SIDEBAR_W - 4;
const MINIMAP_H = 8;
const SOURCE_EXCERPT_LINES = 8;

const DEFAULT_DIMS: Dims = { width: 80, height: 24 };

/** Pinned note for depthUp past MAX=1 (Task 5 replaces this with real depth 2). */
const DEPTH_NOTE = "depth 2 lands with ring expansion";

const COMMAND_BAR: readonly { key: string; label: string }[] = [
  { key: "1", label: "Trace callers" },
  { key: "2", label: "Source" },
  { key: "3", label: "Ask agent" },
  { key: "4", label: "Depth+" },
  { key: "5", label: "Expand" },
];

const HELP_LINES: readonly string[] = [
  "IDE keys",
  "[h/l] switch column  [j/k] move within column",
  "[enter] recenter  [space] collapse/expand sides  [u] prev center",
  "[f] fit origin  [c] center selection  [tab] cycle panel focus",
  "[b] sidebar  [i] inspector  [m] minimap  [+] depth  [/] search",
  "[1] trace callers  [2] source  [3] ask agent  [4] depth+  [5] expand",
  "[r] refresh  [esc] back  [?] close help",
];

/** Width → mode; boundaries are exact and inclusive (full ≥160 … list <68). */
function modeFor(width: number): IdeMode {
  if (width >= 160) return "full";
  if (width >= 100) return "no-sidebar";
  if (width >= 80) return "no-panels";
  if (width >= LIST_MIN_W) return "compact";
  return "list";
}

/** Symbol tail of a qualifiedName (the ref's identifying part). */
function shortName(ref: string): string {
  const hash = ref.lastIndexOf("#");
  if (hash === -1) {
    const slash = ref.lastIndexOf("/");
    return slash === -1 ? ref : ref.slice(slash + 1);
  }
  return ref.slice(hash + 1);
}

function toCard(n: EgoNeighbor): IdeCard {
  return {
    ref: n.ref,
    name: shortName(n.ref),
    category: categoryOf(n.file),
    file: n.file,
    startLine: n.startLine,
    ...(n.signature !== undefined ? { signature: n.signature } : {}),
    risk: n.riskBucket,
    fanIn: n.callers,
    fanOut: n.callees,
  };
}

/** Dashed collapsed-summary card (hub caps / space-collapse). Synthetic `+…` ref. */
function placeholderCard(ref: string, n: number): IdeCard {
  const text = `+${n} more`;
  return { ref, name: text, category: "", file: "", startLine: 0, risk: "low", fanIn: 0, fanOut: 0, placeholder: text };
}

const isSynthetic = (ref: string): boolean => ref.startsWith("+");

/** Miss rendering in the ego model's exact voice (renderMatches + the M3 branches). */
function missLines(ref: string, suggestions: string[], ambiguous: boolean): { text: string; muted?: boolean }[] {
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

/** One history entry: the center we left AND the payload we were showing — pops never re-fetch. */
interface HistoryEntry {
  ref: string;
  payload: EgoGraphData;
}

interface DetailState {
  ref: string;
  payload?: NodeDetail;
  error?: string;
}

interface SourceState {
  ref: string;
  status: "loading" | "ready" | "error";
  lines: string[];
  message?: string;
}

export function createIdeModel(deps: {
  ref: string;
  egoGraph: (ref: string) => Promise<EgoGraphPayload>;
  nodeDetail: (ref: string) => Promise<NodeDetailPayload>;
  egoSource?: (ref: string) => Promise<EgoSourcePayload>;
}) {
  let dims: Dims = { ...DEFAULT_DIMS };
  let focusRef = deps.ref;
  let data: EgoGraphData | undefined;
  let banner: Banner = bannerNone();
  let screen: "graph" | "miss" = "graph";
  let miss: IdeState["miss"];
  let columns: IdeColumn[] = [];
  let fullCanvas: IdeCanvas | undefined;
  /** cursor.col: 0 = callers, 1 = center, 2 = callees; cursor.row indexes that column. */
  let cursor = { col: 1, row: 0 };
  /** per-column remembered row — cross-column moves land on the LAST-shown node. */
  let columnRows: Record<number, number> = { 1: 0 };
  let history: HistoryEntry[] = [];
  let scrollX = 0;
  let scrollY = 0;
  let loadSeq = 0;
  let collapsed = false;
  let sidebarOff = false;
  let inspectorOff = false;
  let inspectorOverlay = false;
  let minimapOff = false;
  let panelFocus: PanelFocus = "graph";
  let helpOpen = false;
  let actionNote: string | undefined;
  let lastCommand: number | undefined;
  let inspScroll = 0;
  let detail: DetailState | undefined;
  let detailSeq = 0;
  let detailInFlight: { ref: string; seq: number; promise: Promise<void> } | undefined;
  let sourceRequested = false;
  let source: SourceState | undefined;
  let sourceSeq = 0;

  function viewportHeight(): number {
    return Math.max(1, dims.height - HEADER_ROWS - COMMAND_ROWS);
  }

  /** Panel availability/visibility + the resulting viewport width. The viewport is
   *  NEVER < MIN_VIEWPORT_W: the sidebar is suppressed first, then the inspector
   *  panel; a compact-mode inspector overlay falls back to replacing the canvas. */
  function panelLayout(): {
    mode: IdeMode;
    showSidebar: boolean;
    showInspector: boolean;
    overlay: boolean;
    vw: number;
    suppressedNote?: string;
  } {
    const mode = modeFor(dims.width);
    let showSidebar = mode === "full" && !sidebarOff;
    let showInspector = (mode === "full" || mode === "no-sidebar") && !inspectorOff;
    const overlay = (mode === "no-panels" || mode === "compact") && inspectorOverlay;
    let vw = dims.width - (showSidebar ? SIDEBAR_W : 0) - (showInspector ? INSPECTOR_W : 0);
    let suppressedNote: string | undefined;
    if (vw < MIN_VIEWPORT_W && showSidebar) {
      showSidebar = false;
      vw += SIDEBAR_W;
      suppressedNote = `panels suppressed — viewport < ${MIN_VIEWPORT_W} cols`;
    }
    if (vw < MIN_VIEWPORT_W && showInspector) {
      showInspector = false;
      vw += INSPECTOR_W;
      suppressedNote = `panels suppressed — viewport < ${MIN_VIEWPORT_W} cols`;
    }
    if (overlay) {
      if (dims.width - INSPECTOR_W >= MIN_VIEWPORT_W) {
        vw = dims.width - INSPECTOR_W;
      } else {
        suppressedNote = `inspector replaces canvas — viewport < ${MIN_VIEWPORT_W} cols`;
      }
    }
    return { mode, showSidebar, showInspector, overlay, vw, ...(suppressedNote !== undefined ? { suppressedNote } : {}) };
  }

  function selectedRef(): string | undefined {
    return columns[cursor.col]?.cards[cursor.row]?.ref;
  }

  function hiddenCount(): number {
    if (data === undefined) return 0;
    return data.totalCallers - data.callers.length + (data.totalCallees - data.callees.length);
  }

  /** Build the three layout columns (callers / center / callees) from the payload,
   *  honouring hub-cap placeholders and the space-collapse side summary. */
  function buildColumns(): void {
    if (data === undefined) {
      columns = [];
      return;
    }
    const side = (refs: EgoNeighbor[], total: number, synthetic: string): IdeCard[] => {
      if (collapsed) {
        // both sides collapse to a single `+N more` summary card (N = real cards hidden)
        return refs.length === 0 ? [] : [placeholderCard(`+collapsed:${synthetic}`, refs.length)];
      }
      const cards = refs.map(toCard);
      if (total > refs.length) cards.push(placeholderCard(`+more:${synthetic}`, total - refs.length));
      return cards;
    };
    columns = [
      { side: "left", ring: 1, cards: side(data.callers, data.totalCallers, "callers") },
      { side: "center", ring: 0, cards: [toCard(data.center)] },
      { side: "right", ring: 1, cards: side(data.callees, data.totalCallees, "callees") },
    ];
  }

  function repaint(): void {
    if (data === undefined) {
      fullCanvas = undefined;
      return;
    }
    fullCanvas = ideLayout({
      columns,
      ...(selectedRef() !== undefined ? { selectedRef: selectedRef() } : {}),
      compact: modeFor(dims.width) === "compact",
    });
  }

  function clampScroll(vw: number, vh: number): void {
    const w = fullCanvas?.width ?? 0;
    const h = fullCanvas?.height ?? 0;
    scrollX = Math.max(0, Math.min(scrollX, Math.max(0, w - vw)));
    scrollY = Math.max(0, Math.min(scrollY, Math.max(0, h - vh)));
  }

  /** Minimal-delta scroll so the selected card's rect is FULLY visible. */
  function scrollIntoView(): void {
    const ref = selectedRef();
    const rect = ref === undefined ? undefined : fullCanvas?.cardRects.get(ref);
    if (rect === undefined) return;
    const lay = panelLayout();
    const vw = lay.vw;
    const vh = viewportHeight();
    if (rect.x < scrollX) scrollX = rect.x;
    if (rect.x + rect.w > scrollX + vw) scrollX = rect.x + rect.w - vw;
    if (rect.y < scrollY) scrollY = rect.y;
    if (rect.y + rect.h > scrollY + vh) scrollY = rect.y + rect.h - vh;
    clampScroll(vw, vh);
  }

  /** Selection changed: clear the action note, reset the inspector scroll, repaint
   *  with the new selection chrome and scroll the viewport to it. The nodeDetail is
   *  stale from here (derived) — the route drives the settle via loadDetail(). */
  function afterSelectionChange(): void {
    actionNote = undefined;
    inspScroll = 0;
    repaint();
    scrollIntoView();
  }

  function resetNavigation(): void {
    cursor = { col: 1, row: 0 };
    columnRows = { 1: 0 };
    scrollX = 0;
    scrollY = 0;
    inspScroll = 0;
    collapsed = false;
  }

  function apply(payload: EgoGraphPayload): void {
    actionNote = undefined;
    sourceSeq++; // a payload swap invalidates any in-flight source excerpt (stale ref)
    source = undefined;
    sourceRequested = false;
    detail = undefined;
    if ("error" in payload) {
      data = undefined;
      columns = [];
      fullCanvas = undefined;
      screen = "miss";
      resetNavigation();
      if (payload.error === "unavailable") {
        banner = bannerUnavailable(payload.message);
        miss = { lines: [{ text: payload.message, muted: true }] };
      } else {
        // not-found still carries Provenance (Ruling 13) — surface staleness here too.
        banner = payload.staleness === "unknown" ? bannerUnknownFreshness() : bannerNone();
        miss = { lines: missLines(focusRef, payload.suggestions, payload.ambiguous) };
      }
      return;
    }
    banner = payload.staleness === "unknown" ? bannerUnknownFreshness() : bannerNone();
    screen = "graph";
    miss = undefined;
    data = payload;
    focusRef = payload.center.ref; // canonical resolved name — refreshes re-fetch this
    resetNavigation();
    buildColumns();
    repaint();
    scrollIntoView();
    void loadDetail(); // keyboard-only correctness: the center's inspector settles itself
  }

  async function load(): Promise<void> {
    const seq = ++loadSeq;
    try {
      const payload = await deps.egoGraph(focusRef);
      if (seq !== loadSeq) return; // a newer load/refresh already won (R5)
      apply(payload);
    } catch (err) {
      if (seq !== loadSeq) return;
      apply({ error: "unavailable", message: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Re-center on `ref`: push the current center + payload, then reload. */
  function recenter(ref: string): void {
    if (data !== undefined) {
      history.push({ ref: focusRef, payload: data });
      if (history.length > HISTORY_CAP) history.shift(); // at cap, the oldest center falls off
    }
    focusRef = ref;
    void load();
  }

  function open(): void {
    const target = selectedRef();
    if (target === undefined || isSynthetic(target)) return; // placeholders never re-center
    if (target === focusRef) {
      void load(); // open on the center = refresh (ego parity)
      return;
    }
    recenter(target);
  }

  /** u/backspace: restore the previous center from cache — NO egoGraph rpc. No-op at
   *  depth 0. Bumping loadSeq FIRST kills any in-flight load (ego parity). */
  function backCenter(): void {
    loadSeq++;
    const entry = history.pop();
    if (entry === undefined) return;
    focusRef = entry.ref;
    apply(entry.payload);
  }

  function moveColumn(delta: 1 | -1): void {
    const target = cursor.col + delta;
    if (target < 0 || target > 2) return;
    const col = columns[target];
    if (col === undefined || col.cards.length === 0) return;
    const remembered = columnRows[target];
    const row = Math.min(remembered === undefined ? cursor.row : remembered, col.cards.length - 1);
    columnRows[cursor.col] = cursor.row;
    cursor = { col: target, row };
    columnRows[target] = row;
    afterSelectionChange();
  }

  function moveRow(delta: number): void {
    const len = columns[cursor.col]?.cards.length ?? 0;
    if (len === 0) return;
    cursor.row = Math.max(0, Math.min(cursor.row + delta, len - 1));
    columnRows[cursor.col] = cursor.row;
    afterSelectionChange();
  }

  function collapse(): void {
    const ref = selectedRef();
    if (ref === undefined) return;
    if (ref !== focusRef) {
      open(); // space on a neighbor ≡ open (placeholders no-op inside open)
      return;
    }
    collapsed = !collapsed;
    buildColumns();
    // the cursor stays on the center; column rows may need clamping after the swap
    for (const [col, row] of Object.entries(columnRows)) {
      columnRows[Number(col)] = Math.min(row, Math.max(0, (columns[Number(col)]?.cards.length ?? 1) - 1));
    }
    repaint();
    scrollIntoView();
  }

  function cyclePanel(): void {
    const lay = panelLayout();
    const available: PanelFocus[] = [];
    if (lay.showSidebar) available.push("sidebar");
    available.push("graph");
    if (lay.showInspector || lay.overlay) available.push("inspector");
    const at = available.indexOf(panelFocus);
    panelFocus = available[(at + 1) % available.length] ?? "graph";
  }

  function fitView(): void {
    scrollX = 0;
    scrollY = 0;
    if (fullCanvas !== undefined) {
      const lay = panelLayout();
      const vh = viewportHeight();
      if (fullCanvas.width > lay.vw || fullCanvas.height > vh) {
        actionNote = `canvas ${fullCanvas.width}×${fullCanvas.height} exceeds viewport ${lay.vw}×${vh} — no scaling; [c] centers selection`;
      }
    }
  }

  function centerView(): void {
    const ref = selectedRef();
    const rect = ref === undefined ? undefined : fullCanvas?.cardRects.get(ref);
    if (rect === undefined) return;
    const lay = panelLayout();
    const vh = viewportHeight();
    scrollX = Math.floor(rect.x + rect.w / 2 - lay.vw / 2);
    scrollY = Math.floor(rect.y + rect.h / 2 - vh / 2);
    clampScroll(lay.vw, vh);
  }

  function toggleInspector(): void {
    const mode = modeFor(dims.width);
    if (mode === "full" || mode === "no-sidebar") inspectorOff = !inspectorOff;
    else if (mode === "no-panels" || mode === "compact") inspectorOverlay = !inspectorOverlay;
    // list mode: no panels exist to toggle
  }

  function toggleSidebar(): void {
    if (modeFor(dims.width) === "full") sidebarOff = !sidebarOff;
  }

  function toggleMinimap(): void {
    if (modeFor(dims.width) === "full") minimapOff = !minimapOff;
  }

  /** 1 Trace callers: jump to the geometrically nearest caller card; already on a
   *  caller ⇒ open/recenter (the cursor column IS the callers column). */
  function traceCallers(): void {
    lastCommand = 1;
    if (data === undefined || fullCanvas === undefined) return;
    if (cursor.col === 0) {
      open();
      return;
    }
    const callersCol = columns[0];
    if (callersCol === undefined || callersCol.cards.length === 0) return;
    const centerRect = fullCanvas.cardRects.get(focusRef);
    const centerMid = centerRect === undefined ? 0 : centerRect.y + CARD_MID_ROW;
    let best = 0;
    let bestDist = Infinity;
    callersCol.cards.forEach((card, i) => {
      const rect = fullCanvas?.cardRects.get(card.ref);
      if (rect === undefined) return;
      const dist = Math.abs(rect.y + CARD_MID_ROW - centerMid);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    columnRows[cursor.col] = cursor.row;
    cursor = { col: 0, row: best };
    columnRows[0] = best;
    afterSelectionChange();
  }

  /** 2 Source: lazy egoSource excerpt for the SELECTED node (seq-guarded). */
  function sourceCommand(): void {
    lastCommand = 2;
    const ref = selectedRef();
    if (deps.egoSource === undefined || ref === undefined || isSynthetic(ref)) {
      actionNote = "source unavailable";
      return;
    }
    sourceRequested = true;
    if (source?.ref === ref && source.status !== "error") return; // already loading/ready
    const seq = ++sourceSeq;
    source = { ref, status: "loading", lines: [] };
    const egoSource = deps.egoSource;
    void egoSource(ref).then((payload) => {
      if (seq !== sourceSeq) return; // superseded or invalidated by a payload swap
      if ("error" in payload) {
        source = {
          ref,
          status: "error",
          lines: [],
          message: payload.error === "unavailable" ? payload.message : `not found: ${ref}`,
        };
        return;
      }
      source = { ref, status: "ready", lines: payload.lines };
    });
  }

  /** Lazy inspector detail: selection marks it stale (derived); dispatch never waits.
   *  Dedupes onto an in-flight fetch for the same ref; seq-guarded against races. */
  function loadDetail(): Promise<void> {
    const ref = selectedRef();
    if (ref === undefined || isSynthetic(ref)) return Promise.resolve();
    if (detail?.ref === ref) return Promise.resolve();
    if (detailInFlight?.ref === ref) return detailInFlight.promise;
    const seq = ++detailSeq;
    const promise = deps
      .nodeDetail(ref)
      .then((payload) => {
        if (seq !== detailSeq) return;
        if (detailInFlight?.seq === seq) detailInFlight = undefined;
        if ("error" in payload) {
          detail = {
            ref,
            error: payload.error === "unavailable" ? payload.message : `not found: ${ref}`,
          };
          return;
        }
        detail = { ref, payload };
      })
      .catch((err: unknown) => {
        if (seq !== detailSeq) return;
        if (detailInFlight?.seq === seq) detailInFlight = undefined;
        detail = { ref, error: err instanceof Error ? err.message : String(err) };
      });
    detailInFlight = { ref, seq, promise };
    return promise;
  }

  function inspectorSections(ref: string | undefined): InspectorSection[] {
    if (ref === undefined) return [];
    if (isSynthetic(ref)) {
      const label = ref.includes(":") ? ref.slice(ref.indexOf(":") + 1) : ref;
      const count = label === "callers" ? (data?.callers.length ?? 0) : (data?.callees.length ?? 0);
      const text = ref.startsWith("+collapsed:")
        ? `+${count} more (collapsed — space restores)`
        : (columns.flatMap((c) => c.cards).find((card) => card.ref === ref)?.placeholder ?? ref);
      return [{ title: "GENERAL", lines: [{ text, fg: IDE_THEME.textMuted }] }];
    }
    if (detail?.ref !== ref) {
      return [{ title: "GENERAL", lines: [{ text: "loading…", fg: IDE_THEME.textMuted }] }];
    }
    if (detail.payload === undefined) {
      return [{ title: "GENERAL", lines: [{ text: detail.error ?? "unavailable", fg: IDE_THEME.textMuted }] }];
    }
    const d = detail.payload;
    const muted = IDE_THEME.textMuted;
    const general: InspectorSection = {
      title: "GENERAL",
      lines: [
        { text: d.node.name },
        { text: d.node.filePath },
        { text: `line ${d.node.span.start.line}` },
        { text: `signature: ${d.signature ?? "—"}` },
      ],
    };
    const relations: InspectorSection = { title: "CALL RELATIONS", lines: [] };
    relations.lines.push({ text: `${d.callers.length} direct callers` });
    for (const caller of d.callers.slice(0, LIST_CAP)) relations.lines.push({ text: caller, ref: caller });
    if (d.callers.length > LIST_CAP) relations.lines.push({ text: `+${d.callers.length - LIST_CAP} more`, fg: muted });
    relations.lines.push({ text: `${d.callees.length} direct callees` });
    for (const callee of d.callees.slice(0, LIST_CAP)) relations.lines.push({ text: callee, ref: callee });
    if (d.callees.length > LIST_CAP) relations.lines.push({ text: `+${d.callees.length - LIST_CAP} more`, fg: muted });
    const analysis: InspectorSection = {
      title: "FUNCTION ANALYSIS",
      lines: [{ text: `signature: ${d.signature ?? "—"}` }],
    };
    if (sourceRequested && source?.ref === ref) {
      if (source.status === "loading") {
        analysis.lines.push({ text: "source: loading…", fg: muted });
      } else if (source.status === "error") {
        analysis.lines.push({ text: `source: ${source.message ?? "unavailable"}`, fg: muted });
      } else {
        analysis.lines.push({ text: "source:" });
        for (const line of source.lines.slice(0, SOURCE_EXCERPT_LINES)) {
          analysis.lines.push({ text: line === "" ? " " : line, fg: muted });
        }
      }
    }
    const security: InspectorSection = { title: "SECURITY ANALYSIS", lines: [] };
    if (d.risk.because.length === 0) security.lines.push({ text: "—", fg: muted });
    else for (const line of d.risk.because) security.lines.push({ text: line });
    const sinks = d.dangerousCalls ?? [];
    if (sinks.length === 0) security.lines.push({ text: "sinks: —", fg: muted });
    else for (const sink of sinks) security.lines.push({ text: `${sink.name} ×${sink.count}` });
    security.lines.push({ text: `unresolved outbound calls: ${d.unresolvedCount}` });
    security.lines.push({ text: "guards: —", fg: muted });
    security.lines.push({ text: "confidence: static — ts-morph resolved" });
    const why: InspectorSection = {
      title: "WHY IT MATTERS",
      lines: [
        { text: d.risk.because[0] ?? "—" },
        {
          text: `${d.node.name} has ${d.callers.length} direct caller${d.callers.length === 1 ? "" : "s"} — a flaw here ripples outward to every caller.`,
        },
      ],
    };
    return [general, relations, analysis, security, why];
  }

  function sidebarLines(showMinimap: boolean): { text: string; fg?: string }[] {
    const lines: { text: string; fg?: string }[] = [
      { text: "Graph Controls" },
      { text: "[enter] recenter [u] prev center", fg: IDE_THEME.textMuted },
      { text: "[space] collapse [f] fit [c] center", fg: IDE_THEME.textMuted },
      { text: "[h/l] columns [j/k] move [?] help", fg: IDE_THEME.textMuted },
      { text: "" },
      { text: "Categories" },
    ];
    const seen = new Set<string>();
    for (const col of columns) {
      for (const card of col.cards) {
        if (card.placeholder !== undefined || seen.has(card.category)) continue;
        seen.add(card.category);
        lines.push({ text: `◆ ${card.category}`, fg: categoryColor(card.category) });
      }
    }
    if (showMinimap) lines.push({ text: "" }, { text: "Minimap" });
    return lines;
  }

  function commandBarState(note: string | undefined): IdeState["commandBar"] {
    return {
      actions: COMMAND_BAR.map((c, i) => ({ key: c.key, label: c.label, active: lastCommand === i + 1 })),
      ...(note !== undefined ? { note } : {}),
    };
  }

  function state(): IdeState {
    const lay = panelLayout();
    const vh = viewportHeight();
    const note = actionNote ?? lay.suppressedNote;
    const selected = selectedRef();
    const base = {
      mode: lay.mode,
      banner,
      commandBar: commandBarState(note),
      ...(helpOpen ? { help: [...HELP_LINES] } : {}),
      focusRef,
      depth: 1,
      historyDepth: history.length,
    };

    if (screen === "miss" || data === undefined) {
      return {
        ...base,
        screen: "miss",
        header: {
          breadcrumb: `codegraph › ${shortName(focusRef)}`,
          repoLabel: "",
          status: `focus: ${panelFocus}`,
          tabs: tabsState(),
          stats: "",
        },
        ...(miss !== undefined ? { miss } : {}),
      };
    }

    // list mode: the ego-family narrow collapse — no panels, wording pinned
    if (lay.mode === "list") {
      const listRows: IdeSegment[][] = [
        [{ text: `terminal too narrow — list view (resize ≥ ${LIST_MIN_W} cols for the graph)`, fg: IDE_THEME.textMuted }],
        [{ text: `callers (${data.totalCallers}): ${data.callers.slice(0, LIST_CAP).map((n) => n.ref).join(", ")}` }],
        [{ text: `callees (${data.totalCallees}): ${data.callees.slice(0, LIST_CAP).map((n) => n.ref).join(", ")}` }],
      ];
      return {
        ...base,
        screen: "graph",
        header: headerState(),
        canvas: { rows: listRows, width: dims.width },
        ...(selected !== undefined && !isSynthetic(selected) ? { selectedRef: selected } : {}),
      };
    }

    clampScroll(lay.vw, vh);
    // viewport clip: exactly vh rows of exactly vw cells (undefined = background)
    const clipped: (Cell | undefined)[][] = Array.from({ length: vh }, (_, r) =>
      Array.from({ length: lay.vw }, (_, c) => fullCanvas?.cells[scrollY + r]?.[scrollX + c]),
    );
    const canvas = { rows: toSegments(clipped, lay.vw), width: lay.vw };

    let sidebar: IdeState["sidebar"];
    if (lay.showSidebar) {
      const showMinimap = !minimapOff && fullCanvas !== undefined;
      let minimap: (Cell | undefined)[][] = [];
      if (showMinimap && fullCanvas !== undefined) {
        const categoryByRef = new Map<string, string>();
        for (const col of columns) {
          for (const card of col.cards) {
            if (card.placeholder === undefined) categoryByRef.set(card.ref, card.category);
          }
        }
        const rects = [...fullCanvas.cardRects].map(([ref, rect]) => ({ ...rect, ref }));
        minimap = minimapCells(
          rects,
          fullCanvas.width,
          fullCanvas.height,
          MINIMAP_W,
          MINIMAP_H,
          { x: scrollX, y: scrollY, w: Math.min(lay.vw, fullCanvas.width), h: Math.min(vh, fullCanvas.height) },
          (ref) => {
            const category = categoryByRef.get(ref);
            return category === undefined ? undefined : categoryColor(category);
          },
        );
      }
      sidebar = { lines: sidebarLines(showMinimap), minimap };
    }

    let inspector: IdeState["inspector"];
    if (lay.showInspector || lay.overlay) {
      const sections = inspectorSections(selected);
      const total = sections.reduce((n, sec) => n + 1 + sec.lines.length, 0);
      inspScroll = Math.max(0, Math.min(inspScroll, Math.max(0, total - vh)));
      inspector = {
        title: selected === undefined ? "Inspector" : `Inspector — ${isSynthetic(selected) ? "summary" : shortName(selected)}`,
        sections,
        scroll: inspScroll,
        height: vh,
      };
    }

    return {
      ...base,
      screen: "graph",
      header: headerState(),
      ...(sidebar !== undefined ? { sidebar } : {}),
      canvas,
      ...(inspector !== undefined ? { inspector } : {}),
      ...(selected !== undefined ? { selectedRef: selected } : {}),
    };
  }

  /** Tabs are display + mouse-click targets only in v1 (keyboard uses dedicated keys). */
  function tabsState(): IdeState["header"]["tabs"] {
    return [
      { label: "Code Graph", active: true },
      { label: "Call Tree", active: false },
      { label: "Code", active: false },
      { label: "References", active: false },
    ];
  }

  function headerState(): IdeState["header"] {
    const drawnNodes = columns.reduce((n, col) => n + col.cards.filter((card) => card.placeholder === undefined).length, 0);
    const nonCenterCards = (columns[0]?.cards.length ?? 0) + (columns[2]?.cards.length ?? 0);
    const drawnEdges = nonCenterCards - (fullCanvas?.undrawnEdges ?? 0);
    return {
      breadcrumb: `codegraph › ${shortName(focusRef)}`,
      repoLabel: data?.source ?? "",
      status: `focus: ${panelFocus}`,
      tabs: tabsState(),
      stats: `${shortName(focusRef)} — ${drawnNodes} nodes, ${drawnEdges} edges, ${hiddenCount()} hidden, depth 1`,
    };
  }

  return {
    /** Loads the focus's ego graph; never rejects — failures land in the miss screen. */
    load,

    /** Manual refresh (Ruling 4): load() over the CURRENT focus. */
    async refresh(): Promise<void> {
      await load();
    },

    /** Dims change re-windows without a refetch; the selection survives by ref. */
    resize(next: Dims): void {
      if (next.width === dims.width && next.height === dims.height) return;
      dims = { ...next };
      if (data !== undefined) {
        for (const [col, row] of Object.entries(columnRows)) {
          columnRows[Number(col)] = Math.min(row, Math.max(0, (columns[Number(col)]?.cards.length ?? 1) - 1));
        }
        cursor.row = Math.min(cursor.row, Math.max(0, (columns[cursor.col]?.cards.length ?? 1) - 1));
        repaint(); // compact flag + canvas geometry follow the width mode
      }
    },

    dispatch(action: IdeAction): void {
      switch (action) {
        case "left":
          moveColumn(-1);
          break;
        case "right":
          moveColumn(1);
          break;
        case "up":
          moveRow(-1);
          break;
        case "down":
          moveRow(1);
          break;
        case "open":
          open();
          break;
        case "collapse":
          collapse();
          break;
        case "cyclePanel":
          cyclePanel();
          break;
        case "search":
          break; // the route opens the existing palette; a pick re-centers
        case "depthUp":
          actionNote = DEPTH_NOTE; // depth stays 1 in this task — Task 5 replaces this
          break;
        case "depthDown":
          break; // depth is 1 — no-op
        case "fit":
          fitView();
          break;
        case "center":
          centerView();
          break;
        case "toggleInspector":
          toggleInspector();
          break;
        case "toggleMinimap":
          toggleMinimap();
          break;
        case "toggleSidebar":
          toggleSidebar();
          break;
        case "help":
          helpOpen = !helpOpen;
          break;
        case "back":
          break; // esc pops the SCREEN — the route owns it
        case "backCenter":
          backCenter();
          break;
        case "refresh":
          void load();
          break;
        case "command1":
          traceCallers();
          break;
        case "command2":
          sourceCommand();
          break;
        case "command3":
          lastCommand = 3; // the route pulls askAgentPrompt() and injects it
          break;
        case "command4":
          lastCommand = 4;
          actionNote = DEPTH_NOTE;
          break;
        case "command5":
          lastCommand = 5;
          open();
          break;
      }
    },

    /** Click parity: select `ref`; if it is ALREADY selected (and not the center) ⇒ open(). */
    selectByRef(ref: string): void {
      if (ref === selectedRef() && ref !== focusRef) {
        open();
        return;
      }
      for (let c = 0; c < columns.length; c++) {
        const at = columns[c].cards.findIndex((card) => card.ref === ref);
        if (at >= 0) {
          if (ref === selectedRef()) return; // already-selected center: no-op
          columnRows[cursor.col] = cursor.row;
          cursor = { col: c, row: at };
          columnRows[c] = at;
          afterSelectionChange();
          return;
        }
      }
      // unknown ref: no-op
    },

    /** Independent inspector scroll (mouse wheel later), clamped in state(). */
    inspectorScroll(delta: number): void {
      inspScroll = Math.max(0, inspScroll + delta);
    },

    state,

    /** command3 payload for the route to inject via the existing ask-agent path. */
    askAgentPrompt(): string | undefined {
      if (data === undefined) return undefined;
      const center = data.center;
      const sinks = center.sinks.map((s) => (s.count > 1 ? `${s.name} ×${s.count}` : s.name)).join(", ");
      return [
        `Review ${focusRef} for security issues.`,
        `Risk: ${center.riskReason === "" ? "—" : center.riskReason}`,
        `Dangerous calls: ${sinks === "" ? "none" : sinks}.`,
        `Trace its callers and callees, then recommend concrete mitigations.`,
      ].join("\n");
    },

    /** True when the selected node's detail is missing/stale — the route drives the
     *  80 ms settle with this + loadDetail(). */
    detailDirty(): boolean {
      const ref = selectedRef();
      return ref !== undefined && !isSynthetic(ref) && detail?.ref !== ref;
    },

    loadDetail,
  };
}
