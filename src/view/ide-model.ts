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
 * - Depth expands to MAX_DEPTH=2 (Task 5): depthUp fetches every shown ring-1
 *   neighbor's ego graph in parallel and builds far-side ring-2 columns under a
 *   NODE_BUDGET of 40 total real cards; the skipped remainder is disclosed per
 *   column (`+N more (depth budget)` placeholder) and in the stats hidden count.
 *   Each consulted neighbor's OWN far-side hub cap (the rpc's per-side limit —
 *   exact totals ride the payload) folds into the same disclosure: a
 *   `+N more (hub cap)` placeholder per ring-2 column plus the stats hidden count.
 *   When EVERY neighbor fetch fails, the note `ring 2 unavailable — neighbor
 *   fetches failed` pins — an empty ring 2 is never silent. depthUp past MAX
 *   pins the disclosed note `depth capped at 2 — node budget`; any payload swap
 *   (re-center / refresh / history pop) resets depth to 1.
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
import { buildChatContextPrefix, CHAT_TURN_CAP, type ChatTurn, type DescribeInput } from "./ide-agent.js";
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
/** The route's D4 panel separator (a │ character column) — a drawn panel costs
 *  its width PLUS this column, so the model's viewport equals the rendered canvas. */
export const SEPARATOR_W = 1;
export const HEADER_ROWS = 3;
export const COMMAND_ROWS = 3;

export type IdeAction =
  | "left" | "right" | "up" | "down" | "open" | "collapse" | "cyclePanel" | "search"
  | "depthUp" | "depthDown" | "fit" | "center" | "toggleInspector" | "toggleMinimap" | "toggleSidebar"
  | "help" | "back" | "backCenter" | "refresh"
  | "command1" | "command2" | "command3" | "command4" | "command5" | "command6"
  | "explain" | "chat";

export const IDE_ACTIONS: readonly IdeAction[] = [
  "left", "right", "up", "down", "open", "collapse", "cyclePanel", "search",
  "depthUp", "depthDown", "fit", "center", "toggleInspector", "toggleMinimap", "toggleSidebar",
  "help", "back", "backCenter", "refresh",
  "command1", "command2", "command3", "command4", "command5", "command6",
  "explain", "chat",
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
  depthDown: ["d", "-"], // Task-5 ruling: d = mnemonic (verified free); "-" keeps the [+/-] pair
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
  command6: ["6"],
  /** command6 ≡ explain — the same handler; [6] lights in the command bar. */
  explain: ["e"],
  /** Task 4: t toggles the chat sidebar (talk). While open the route captures
   *  keys palette-style; t with an EMPTY draft (or esc) closes it again. */
  chat: ["t"],
};

export interface InspectorSection {
  title: string;
  lines: { text: string; fg?: string; ref?: string }[];
}

/** `?` overlay section: a cyan title row over plain body lines (pinned wording). */
export interface IdeHelpSection {
  title: string;
  lines: string[];
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
  /** Task 4 chat sidebar: present while open. `turns` is the capped tail
   *  (CHAT_TURN_CAP) of local echoes merged BEFORE session turns; `earlier`
   *  discloses the hidden older count; `scroll` is lines scrolled up from the
   *  bottom (0 = pinned to latest). Closing the panel NEVER clears it — only
   *  the model's lifetime ends the transcript. */
  chat?: { turns: ChatTurn[]; earlier: number; input: string; scroll: number; status: "idle" | "sending" };
  help?: IdeHelpSection[];
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

/** Pinned note for depthUp at MAX_DEPTH — the node budget is the ceiling, no ring 3. */
const DEPTH_CAP_NOTE = "depth capped at 2 — node budget";

/** Pinned note when EVERY ring-1 neighbor fetch fails at depthUp — an empty ring 2
 *  is a fetch failure, not an honest empty graph; never silent. */
const RING2_FAIL_NOTE = "ring 2 unavailable — neighbor fetches failed";

/** Pinned miss line for the empty-ref entry (bare /closegraph): the route opens the
 *  symbol picker over this hint. Guarding BEFORE the rpc is also the fix for the
 *  garbled `multiple matches — did you mean (5) for :` wording — an empty ref never
 *  reaches missLines. */
const EMPTY_REF_MISS = "pick a symbol — press / to search";

/** Explain-this (Task 3) pinned wording: the WHAT IT DOES (llm) section states. */
const DESCRIBE_GENERATED_NOTE = "generated by the agent · may be stale";
const DESCRIBE_LOADING_LINE = "explaining…";
const DESCRIBE_FAILED_NOTE = "explain failed";
const AGENT_UNAVAILABLE_NOTE = "agent unavailable";
/** Ready text soft-wraps to the inspector's inner width (INSPECTOR_W - 4 = 35). */
const DESCRIBE_WRAP_W = INSPECTOR_W - 4;

/** Task 4 chat pinned wording: the narrow-mode disclosure (the inspector-replaces-
 *  canvas family) and the honest local notes (never session content). */
const CHAT_REPLACES_CANVAS_NOTE = `chat replaces canvas — viewport < ${MIN_VIEWPORT_W} cols`;
const CHAT_NO_CONTEXT_NOTE = "no graph context";

/** One cached explain entry per ref; survives payload swaps (keyed by ref). The
 *  error entry keeps the rejection's message so the section can disclose the
 *  honest reason (`no session in this project`, `explain timed out`, …). */
type DescribeEntry = { status: "loading" } | { status: "ready"; text: string } | { status: "error"; message?: string };

const COMMAND_BAR: readonly { key: string; label: string }[] = [
  { key: "1", label: "Trace callers" },
  { key: "2", label: "Source" },
  { key: "3", label: "Ask agent" },
  { key: "4", label: "Depth+" },
  { key: "5", label: "Expand" },
  { key: "6", label: "Explain" },
];

const HELP_KEYS_LINES: readonly string[] = [
  "IDE keys",
  "[h/l] switch column  [j/k] move within column",
  "[enter] recenter  [space] collapse/expand sides  [u] prev center",
  "[f] fit origin  [c] center selection  [tab] cycle panel focus",
  "[b] sidebar  [i] inspector  [m] minimap  [+/-] depth  [/] search",
  "[1] trace callers  [2] source  [3] ask agent  [4] depth+  [5] expand",
  "[r] refresh  [esc] back  [?] close help",
];

/** `?` overlay sections — wording pinned (Task 2). Legend uses theme color NAMES
 *  (CATEGORY_ORDER purple→amber, risk green/amber/coral), never hex values. */
const HELP_SECTIONS: readonly { title: string; lines: readonly string[] }[] = [
  { title: "KEYS", lines: HELP_KEYS_LINES },
  {
    title: "LEGEND",
    lines: [
      "card border color = category (purple coral green cyan amber · first path segment)",
      "Risk: LOW green · MED amber · HIGH coral    → callers (muted) · → callees (cyan)",
      "selected = coral border · ┄ dashed card = hidden-count placeholder",
    ],
  },
  {
    title: "HOW IT WORKS",
    lines: [
      "callers left · focus center · callees right  ([+]/[d] rings 1–2)",
      "graph source: built | snapshot (staleness note when unknown)",
      "+N more / hidden = real counts capped by budget or rpc cap — never silent",
      "unresolved calls are a count line, never an edge",
    ],
  },
];

/** Width → mode; boundaries are exact and inclusive (full ≥160 … list <68). */
function modeFor(width: number): IdeMode {
  if (width >= 160) return "full";
  if (width >= 100) return "no-sidebar";
  if (width >= 80) return "no-panels";
  if (width >= LIST_MIN_W) return "compact";
  return "list";
}

/** Ring distance the model can expand to (Task 5): center=0, ring 1, ring 2. */
export const MAX_DEPTH = 2;
/** Total REAL (non-placeholder) cards across ALL columns at depth 2 (center + ring 1 + ring 2). */
export const NODE_BUDGET = 40;

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
function placeholderCard(ref: string, n: number, parentRef?: string): IdeCard {
  const text = `+${n} more`;
  return {
    ref,
    name: text,
    category: "",
    file: "",
    startLine: 0,
    risk: "low",
    fanIn: 0,
    fanOut: 0,
    placeholder: text,
    ...(parentRef !== undefined ? { parentRef } : {}),
  };
}

/** `+N more (depth budget)` disclosure for a ring-2 column the node budget cut short;
 *  `parentRef` keeps its dashed edge routed to the ring-1 parent of the first skip. */
function budgetCard(side: "left" | "right", n: number, parentRef: string): IdeCard {
  const text = `+${n} more (depth budget)`;
  return { ref: `+budget:${side}`, name: text, category: "", file: "", startLine: 0, risk: "low", fanIn: 0, fanOut: 0, placeholder: text, parentRef };
}

/** `+N more (hub cap)` disclosure for far-side nodes the rpc's per-side cap dropped
 *  before the model ever saw them — counted from the neighbor payload's exact
 *  `totalCallers`/`totalCallees`; `parentRef` routes its dashed edge to the first
 *  truncated parent. Distinct from the budget card: hub caps bite even when the
 *  budget never does. */
function hubCard(side: "left" | "right", n: number, parentRef: string): IdeCard {
  const text = `+${n} more (hub cap)`;
  return { ref: `+hubcap:${side}`, name: text, category: "", file: "", startLine: 0, risk: "low", fanIn: 0, fanOut: 0, placeholder: text, parentRef };
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
  /** Route-wired agent bridge (Task 3): sends the explain prompt to the project
   *  session and resolves with the reply text; rejects on no-session/timeout. */
  describe?: (input: DescribeInput) => Promise<string>;
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
  /** Current ring distance shown: 1 (callers/center/callees) or 2 (+ far-side rings). */
  let depth = 1;
  /** Depth-2 expansion state: far-side cards per ring-2 column + budget-skipped and
   *  hub-cap-hidden counts (per side) for the stats disclosure. */
  let ring2: { left: IdeCard[]; right: IdeCard[]; skippedLeft: number; skippedRight: number; hubHiddenLeft: number; hubHiddenRight: number } | undefined;
  /** Per-ref cache of ring-1 neighbor payloads (success shapes only — errors never
   *   cache) — depthDown → depthUp re-fetches nothing. Cleared on every payload swap
   *  (re-center) along with the depth reset. */
  const ring2Cache = new Map<string, EgoGraphData>();
  /** Per-ref explain cache (Task 3): survives payload swaps, cleared NEVER — one
   *  shot per ref per session (a cached error is not auto-retried). */
  const describeCache = new Map<string, DescribeEntry>();
  let describeSeq = 0;
  /** Task 4 chat sidebar. The transcript is chat-only: apply() (re-center /
   *  refresh / history pop) NEVER touches it — only the model's lifetime ends
   *  it. localEchoes (focus-command echoes + muted degrade notes) live only
   *  client-side and merge BEFORE the session turns (pinned). */
  let chatOpen = false;
  let chatInput = "";
  let chatScrollPos = 0; // lines scrolled up from the bottom (0 = pinned to latest)
  let chatStatus: "idle" | "sending" = "idle";
  let sessionTurns: ChatTurn[] = [];
  let localEchoes: ChatTurn[] = [];
  let chatTurns: ChatTurn[] = [];
  let chatEarlier = 0;

  function viewportHeight(): number {
    return Math.max(1, dims.height - HEADER_ROWS - COMMAND_ROWS);
  }

  /** Panel availability/visibility + the resulting viewport width. The viewport is
   *  NEVER < MIN_VIEWPORT_W: the sidebar is suppressed first, then the inspector
   *  panel; a compact-mode inspector overlay falls back to replacing the canvas.
   *  Each drawn panel also costs its SEPARATOR_W │ column (Task-6 render delta:
   *  the route's flex row gives the canvas exactly width − panels − separators,
   *  and the model's scroll/window math must match that rendered width). */
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
    // Task 4: an open chat rides the SAME overlay path as the inspector in the
    // narrow modes (the route swaps the canvas for it, never squeezes < 40 cols)
    const overlay = (mode === "no-panels" || mode === "compact") && (inspectorOverlay || chatOpen);
    let vw =
      dims.width - (showSidebar ? SIDEBAR_W + SEPARATOR_W : 0) - (showInspector ? INSPECTOR_W + SEPARATOR_W : 0);
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
        // chat wins the wording when both overlays are somehow open — it is the
        // one the route actually renders
        suppressedNote = chatOpen ? CHAT_REPLACES_CANVAS_NOTE : `inspector replaces canvas — viewport < ${MIN_VIEWPORT_W} cols`;
      }
    }
    return { mode, showSidebar, showInspector, overlay, vw, ...(suppressedNote !== undefined ? { suppressedNote } : {}) };
  }

  function selectedRef(): string | undefined {
    return columns[cursor.col]?.cards[cursor.row]?.ref;
  }

  function hiddenCount(): number {
    if (data === undefined) return 0;
    return (
      data.totalCallers -
        data.callers.length +
        (data.totalCallees - data.callees.length) +
        (ring2?.skippedLeft ?? 0) +
        (ring2?.skippedRight ?? 0) +
        (ring2?.hubHiddenLeft ?? 0) +
        (ring2?.hubHiddenRight ?? 0)
    );
  }

  /** Build the layout columns from the payload + expansion state (callers / center /
   *  callees at depth 1; ring-2 far-side columns inserted at depth 2 in the order
   *  [left ring2, left ring1, center, right ring1, right ring2]), honouring hub-cap
   *  placeholders and the space-collapse side summary. */
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
    const center: IdeColumn = { side: "center", ring: 0, cards: [toCard(data.center)] };
    const leftRing1: IdeColumn = { side: "left", ring: 1, cards: side(data.callers, data.totalCallers, "callers") };
    const rightRing1: IdeColumn = { side: "right", ring: 1, cards: side(data.callees, data.totalCallees, "callees") };
    if (depth === 1 || ring2 === undefined) {
      columns = [leftRing1, center, rightRing1];
      return;
    }
    // a ring-2 column renders only when it has cards; under collapse it becomes one
    // summary card (parentRef keeps its dashed edge routed to the ring-1 parent)
    const ring2Col = (sideName: "left" | "right", cards: IdeCard[]): IdeColumn | undefined => {
      if (cards.length === 0) return undefined;
      if (!collapsed) return { side: sideName, ring: 2, cards };
      const real = cards.filter((card) => card.placeholder === undefined);
      if (real.length === 0) return undefined; // disclosure-only column: stats carry the count
      return { side: sideName, ring: 2, cards: [placeholderCard(`+collapsed:${sideName}2`, real.length, real[0]?.parentRef)] };
    };
    const l2 = ring2Col("left", ring2.left);
    const r2 = ring2Col("right", ring2.right);
    columns = [...(l2 !== undefined ? [l2] : []), leftRing1, center, rightRing1, ...(r2 !== undefined ? [r2] : [])];
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
    depth = 1; // any payload swap (re-center / refresh / history pop) resets depth…
    ring2 = undefined; // …dropping the ring-2 columns…
    ring2Cache.clear(); // …and the per-ref neighbor cache with them
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

  /** Empty-ref guard (load + refresh both funnel here): resolve immediately to the
   *  picker hint — screen miss, banner none — and NEVER touch deps.egoGraph. */
  function applyEmptyRef(): void {
    loadSeq++; // kill any in-flight load (same semantics as backCenter)
    banner = bannerNone();
    screen = "miss";
    miss = { lines: [{ text: EMPTY_REF_MISS, muted: true }] };
  }

  async function load(): Promise<void> {
    if (focusRef === "") {
      applyEmptyRef();
      return;
    }
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

  /** Depth change rebuilds the columns under NEW indices — re-point the cursor at the
   *  first surviving ref (the selection, then a dropped ring-2 card's parent, then
   *  the center). Remembered rows stay index-keyed; moveColumn clamps them on use. */
  function restoreSelection(fallbacks: (string | undefined)[]): void {
    for (const ref of fallbacks) {
      if (ref === undefined) continue;
      for (let c = 0; c < columns.length; c++) {
        const at = columns[c].cards.findIndex((card) => card.ref === ref);
        if (at >= 0) {
          columnRows[cursor.col] = cursor.row;
          cursor = { col: c, row: at };
          columnRows[c] = at;
          return;
        }
      }
    }
    const ci = columns.findIndex((c) => c.ring === 0);
    columnRows[cursor.col] = cursor.row;
    cursor = { col: ci, row: 0 };
    columnRows[ci] = 0;
  }

  /** Pure build of the depth-2 ring columns from the neighbor payloads: each ring-2
   *  card carries its ring-1 `parentRef`; refs already present in ANY column dedupe
   *  (first-seen wins); the NODE_BUDGET stop skips the remainder and returns the
   *  per-column counts + placeholder parents for disclosure. A consulted neighbor's
   *  OWN far-side hub cap (rpc per-side limit — the payload's exact totals exceed the
   *  list it carries) accumulates into per-side hub-hidden counts, disclosed the same
   *  way. Cards group by parent index (then code-unit ref) so children of the same
   *  parent stay contiguous. */
  function buildRing2(
    d: EgoGraphData,
    neighbors: { ref: string; far: "callers" | "callees" }[],
    payloads: (EgoGraphData | undefined)[],
  ): { left: IdeCard[]; right: IdeCard[]; skippedLeft: number; skippedRight: number; hubHiddenLeft: number; hubHiddenRight: number } {
    const seen = new Set<string>([d.center.ref]);
    for (const n of d.callers) seen.add(n.ref);
    for (const n of d.callees) seen.add(n.ref);
    let real = 1 + d.callers.length + d.callees.length; // real depth-1 cards already drawn
    const left: IdeCard[] = [];
    const right: IdeCard[] = [];
    let skippedLeft = 0;
    let skippedRight = 0;
    let budgetParentLeft: string | undefined; // parent of the first skipped candidate
    let budgetParentRight: string | undefined;
    let hubHiddenLeft = 0; // far-side nodes the rpc's per-side cap dropped pre-model
    let hubHiddenRight = 0;
    let hubParentLeft: string | undefined; // parent of the first truncated far side
    let hubParentRight: string | undefined;
    for (let i = 0; i < neighbors.length; i++) {
      const nb = neighbors[i];
      if (nb === undefined) continue;
      const payload = payloads[i];
      if (payload === undefined) continue; // failed neighbor fetch: no far side to draw
      const far = nb.far === "callers" ? payload.callers : payload.callees;
      const hidden = (nb.far === "callers" ? payload.totalCallers : payload.totalCallees) - far.length;
      if (hidden > 0) {
        if (nb.far === "callers") {
          hubHiddenLeft += hidden;
          hubParentLeft ??= nb.ref;
        } else {
          hubHiddenRight += hidden;
          hubParentRight ??= nb.ref;
        }
      }
      for (const n of far) {
        if (seen.has(n.ref)) continue; // already present in any column — first-seen wins
        if (real >= NODE_BUDGET) {
          if (nb.far === "callers") {
            skippedLeft++;
            budgetParentLeft ??= nb.ref;
          } else {
            skippedRight++;
            budgetParentRight ??= nb.ref;
          }
          continue;
        }
        seen.add(n.ref);
        real++;
        (nb.far === "callers" ? left : right).push({ ...toCard(n), parentRef: nb.ref });
      }
    }
    const groupByParent = (cards: IdeCard[], parents: EgoNeighbor[]): IdeCard[] => {
      const parentIndex = new Map(parents.map((p, i) => [p.ref, i]));
      return [...cards].sort((a, b) => {
        const pa = parentIndex.get(a.parentRef ?? "") ?? 0;
        const pb = parentIndex.get(b.parentRef ?? "") ?? 0;
        return pa !== pb ? pa - pb : a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0;
      });
    };
    const groupedLeft = groupByParent(left, d.callers);
    const groupedRight = groupByParent(right, d.callees);
    if (skippedLeft > 0 && budgetParentLeft !== undefined) groupedLeft.push(budgetCard("left", skippedLeft, budgetParentLeft));
    if (skippedRight > 0 && budgetParentRight !== undefined) groupedRight.push(budgetCard("right", skippedRight, budgetParentRight));
    if (hubHiddenLeft > 0 && hubParentLeft !== undefined) groupedLeft.push(hubCard("left", hubHiddenLeft, hubParentLeft));
    if (hubHiddenRight > 0 && hubParentRight !== undefined) groupedRight.push(hubCard("right", hubHiddenRight, hubParentRight));
    return { left: groupedLeft, right: groupedRight, skippedLeft, skippedRight, hubHiddenLeft, hubHiddenRight };
  }

  /** depthUp: 1 → 2. Fetches every shown ring-1 neighbor's ego graph in parallel
   *  (code-unit order, per-ref cache) and builds ring-2 columns from each neighbor's
   *  FAR side (callers of callers / callees of callees). loadSeq-guarded like load();
   *  at MAX_DEPTH it only pins the cap note — never a third ring. When EVERY
   *  neighbor fetch fails, the ring-2 failure note pins instead of passing silently
   *  as an empty ring 2. */
  async function expandDepth(): Promise<void> {
    if (data === undefined) return;
    if (depth >= MAX_DEPTH) {
      actionNote = DEPTH_CAP_NOTE;
      return;
    }
    const d = data;
    const seq = ++loadSeq;
    const neighbors = [
      ...d.callers.map((n) => ({ ref: n.ref, far: "callers" as const })),
      ...d.callees.map((n) => ({ ref: n.ref, far: "callees" as const })),
    ];
    const payloads = await Promise.all(
      neighbors.map(({ ref }) => {
        const cached = ring2Cache.get(ref);
        if (cached !== undefined) return Promise.resolve(cached);
        return deps
          .egoGraph(ref)
          .then((payload): EgoGraphData | undefined => {
            if ("error" in payload) return undefined; // miss/unavailable: no far side
            ring2Cache.set(ref, payload);
            return payload;
          })
          .catch(() => undefined);
      }),
    );
    if (seq !== loadSeq) return; // a newer load/refresh/re-center already won
    const prevSelected = selectedRef();
    const prevParent = columns.flatMap((c) => c.cards).find((card) => card.ref === prevSelected)?.parentRef;
    ring2 = buildRing2(d, neighbors, payloads);
    depth = MAX_DEPTH;
    // neighbors existed but NONE answered: an empty ring 2 would read as honest
    // emptiness — disclose the failure instead
    actionNote = neighbors.length > 0 && payloads.every((p) => p === undefined) ? RING2_FAIL_NOTE : undefined;
    buildColumns();
    restoreSelection([prevSelected, prevParent]);
    repaint();
    scrollIntoView();
  }

  /** depthDown: 2 → 1 — ring-2 columns drop (their payloads stay cached, so a repeat
   *  depthUp re-fetches nothing). No-op at depth 1. */
  function contractDepth(): void {
    if (depth === 1 || data === undefined) return;
    depth = 1;
    const prevSelected = selectedRef();
    const prevParent = columns.flatMap((c) => c.cards).find((card) => card.ref === prevSelected)?.parentRef;
    ring2 = undefined;
    actionNote = undefined;
    buildColumns();
    restoreSelection([prevSelected, prevParent]);
    repaint();
    scrollIntoView();
  }

  function moveColumn(delta: 1 | -1): void {
    const target = cursor.col + delta;
    if (target < 0 || target >= columns.length) return; // 3 columns at depth 1, up to 5 at depth 2
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
    const callersIdx = columns.findIndex((c) => c.side === "left" && c.ring === 1);
    if (callersIdx === -1) return;
    if (cursor.col === callersIdx) {
      open();
      return;
    }
    const callersCol = columns[callersIdx];
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
    cursor = { col: callersIdx, row: best };
    columnRows[callersIdx] = best;
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

  /** Center risk facts in the exact shape askAgentPrompt() collects them (focus
   *  ref + risk + sinks) — the explain path reuses this instead of duplicating. */
  function centerRiskContext(): { riskReason?: string; sinks?: { name: string; count: number }[] } {
    if (data === undefined) return {};
    const center = data.center;
    return {
      ...(center.riskReason !== "" ? { riskReason: center.riskReason } : {}),
      ...(center.sinks.length > 0 ? { sinks: center.sinks.map((s) => ({ name: s.name, count: s.count })) } : {}),
    };
  }

  /** Everything the explain prompt can honestly carry RIGHT NOW: the focus ref,
   *  the signature only once nodeDetail settled for THIS ref, the source excerpt
   *  only once egoSource resolved for THIS ref (capped), plus center risk/sinks. */
  function describeInput(): DescribeInput {
    const signature = detail?.ref === focusRef ? detail.payload?.signature : undefined;
    const excerpt =
      source?.ref === focusRef && source.status === "ready"
        ? source.lines.slice(0, SOURCE_EXCERPT_LINES)
        : undefined;
    return {
      ref: focusRef,
      ...(signature !== undefined ? { signature } : {}),
      ...(excerpt !== undefined ? { source: excerpt } : {}),
      ...centerRiskContext(),
    };
  }

  /** 6/e Explain (Task 3): one shot per focus ref. Synthetic/empty focus ⇒ no-op
   *  (synthetic refs never reach the LLM); no dep ⇒ the honest unavailable note.
   *  The resolution is describeSeq-guarded like the load/detail family; a
   *  superseded resolution drops its loading marker so the ref stays retryable
   *  instead of resting on a stuck "explaining…". */
  function explain(): void {
    lastCommand = 6;
    if (focusRef === "" || isSynthetic(focusRef)) return;
    if (deps.describe === undefined) {
      actionNote = AGENT_UNAVAILABLE_NOTE;
      return;
    }
    if (describeCache.has(focusRef)) return; // cached (loading/ready/error) — never a second call
    const ref = focusRef;
    const seq = ++describeSeq;
    describeCache.set(ref, { status: "loading" });
    actionNote = undefined;
    const describe = deps.describe;
    void describe(describeInput()).then(
      (text) => {
        if (seq !== describeSeq) {
          if (describeCache.get(ref)?.status === "loading") describeCache.delete(ref);
          return;
        }
        describeCache.set(ref, { status: "ready", text });
      },
      (err: unknown) => {
        if (seq !== describeSeq) {
          if (describeCache.get(ref)?.status === "loading") describeCache.delete(ref);
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        describeCache.set(ref, { status: "error", ...(message !== "" ? { message } : {}) });
        actionNote = DESCRIBE_FAILED_NOTE;
      },
    );
  }

  /** Word-wrap to `width` columns; a word wider than the column hard-splits. */
  function wrapText(text: string, width: number): string[] {
    const out: string[] = [];
    let line = "";
    for (let word of text.split(/\s+/)) {
      if (word === "") continue;
      while (word.length > width) {
        if (line !== "") {
          out.push(line);
          line = "";
        }
        out.push(word.slice(0, width));
        word = word.slice(width);
      }
      if (line === "") line = word;
      else if (line.length + 1 + word.length <= width) line = `${line} ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line !== "") out.push(line);
    return out;
  }

  /** Task 3: the explain section, inserted directly after GENERAL. Keyed by the
   *  INSPECTED ref — a neighbor's inspector honestly shows `—` (explain only ever
   *  describes the focus); ready text is labeled as generated and soft-wrapped. */
  function describeSection(ref: string): InspectorSection {
    const muted = IDE_THEME.textMuted;
    const entry = describeCache.get(ref);
    const lines: InspectorSection["lines"] =
      entry === undefined
        ? [{ text: "—", fg: muted }]
        : entry.status === "loading"
          ? [{ text: DESCRIBE_LOADING_LINE, fg: muted }]
          : entry.status === "error"
            ? [{ text: entry.message !== undefined ? `${DESCRIBE_FAILED_NOTE} — ${entry.message}` : DESCRIBE_FAILED_NOTE, fg: muted }]
            : [
                { text: DESCRIBE_GENERATED_NOTE, fg: muted },
                ...wrapText(entry.text, DESCRIBE_WRAP_W).map((text) => ({ text })),
              ];
    return { title: "WHAT IT DOES (llm)", lines };
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

  /** Real card count a `+collapsed:*` summary stands for (ring-1 side or ring-2 column). */
  function collapsedHidden(ref: string): number {
    if (ring2 !== undefined && ref === "+collapsed:left2") return ring2.left.filter((c) => c.placeholder === undefined).length;
    if (ring2 !== undefined && ref === "+collapsed:right2") return ring2.right.filter((c) => c.placeholder === undefined).length;
    return ref.endsWith("callers") ? (data?.callers.length ?? 0) : (data?.callees.length ?? 0);
  }

  function inspectorSections(ref: string | undefined): InspectorSection[] {
    if (ref === undefined) return [];
    if (isSynthetic(ref)) {
      const card = columns.flatMap((c) => c.cards).find((c) => c.ref === ref);
      const text = ref.startsWith("+collapsed:")
        ? `+${collapsedHidden(ref)} more (collapsed — space restores)`
        : (card?.placeholder ?? ref);
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
    return [general, describeSection(ref), relations, analysis, security, why];
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

  // --- Task 4: chat sidebar (all pure; the route owns session wiring) ---------

  /** Merged transcript = local echoes BEFORE session turns (pinned), capped to
   *  the CHAT_TURN_CAP tail with the hidden count disclosed in `earlier`. */
  function rebuildChatTurns(): void {
    const merged = [...localEchoes, ...sessionTurns];
    chatEarlier = Math.max(0, merged.length - CHAT_TURN_CAP);
    chatTurns = merged.slice(chatEarlier);
  }

  /** Route-driven session sync (reactive message.list effect + send settle).
   *  `sending` drops only once the LATEST session turn is the assistant's — a
   *  landed user echo means the reply is still in flight. */
  function syncChat(turns: ChatTurn[]): void {
    sessionTurns = turns;
    rebuildChatTurns();
    if (chatStatus === "sending" && sessionTurns.at(-1)?.role === "assistant") chatStatus = "idle";
  }

  function chatType(ch: string): void {
    chatInput += ch;
  }

  function chatBackspace(): void {
    chatInput = chatInput.slice(0, -1);
  }

  function chatScroll(delta: number): void {
    chatScrollPos = Math.max(0, chatScrollPos + delta); // the top clamp lives in state()
  }

  /** Enter. Three kinds: empty draft ⇒ undefined (the draft is kept); a
   *  `focus <ref>` line ⇒ a client-side echo + a re-center result for the
   *  route; anything else ⇒ a send result carrying the context-prefixed text.
   *  Synthetic/empty focus NEVER prefixes (synthetic refs never reach the LLM)
   *  — the raw text goes out with the honest `no graph context` note. */
  function chatSubmit(): { kind: "focus"; ref: string } | { kind: "send"; text: string } | undefined {
    const input = chatInput.trim();
    if (input === "") return undefined;
    chatInput = "";
    if (input === "focus" || input.startsWith("focus ")) {
      const ref = input.slice("focus".length).trim();
      if (ref === "") return undefined; // `focus` with no ref: nothing to center on
      localEchoes.push({ role: "user", text: input }); // focus echoes live only client-side
      rebuildChatTurns();
      return { kind: "focus", ref };
    }
    if (focusRef === "" || isSynthetic(focusRef)) {
      localEchoes.push({ role: "assistant", text: CHAT_NO_CONTEXT_NOTE, muted: true });
      rebuildChatTurns();
      chatStatus = "sending";
      return { kind: "send", text: input };
    }
    const signature = detail?.ref === focusRef ? detail.payload?.signature : undefined;
    const text =
      buildChatContextPrefix({ ref: focusRef, ...(signature !== undefined ? { signature } : {}) }) + input;
    chatStatus = "sending";
    return { kind: "send", text };
  }

  /** The route's degrade paths (no session, send failure): a muted local
   *  assistant-style note + status back to idle — a chat send NEVER hangs. */
  function chatNote(text: string): void {
    localEchoes.push({ role: "assistant", text, muted: true });
    chatStatus = "idle";
    rebuildChatTurns();
  }

  function chatClose(): void {
    chatOpen = false; // the transcript survives — closing never clears it
  }

  function chatState(): NonNullable<IdeState["chat"]> {
    // clamp the scroll against the flattened transcript height: one row per
    // newline-split line + the `+N earlier` disclosure; body rows = viewport
    // minus the chat header and the input line
    const lines = chatTurns.reduce((n, t) => n + t.text.split("\n").length, 0) + (chatEarlier > 0 ? 1 : 0);
    const body = Math.max(1, viewportHeight() - 2);
    chatScrollPos = Math.min(chatScrollPos, Math.max(0, lines - body));
    return {
      turns: chatTurns.map((t) => ({ ...t })),
      earlier: chatEarlier,
      input: chatInput,
      scroll: chatScrollPos,
      status: chatStatus,
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
      ...(helpOpen ? { help: HELP_SECTIONS.map((s) => ({ title: s.title, lines: [...s.lines] })) } : {}),
      ...(chatOpen ? { chat: chatState() } : {}),
      focusRef,
      depth,
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
    // every non-center card owns exactly one edge (ring 1 → center, ring 2 → parentRef)
    const centerCol = columns.findIndex((c) => c.ring === 0);
    const nonCenterCards = columns.reduce((n, col, i) => (i === centerCol ? n : n + col.cards.length), 0);
    const drawnEdges = nonCenterCards - (fullCanvas?.undrawnEdges ?? 0);
    return {
      breadcrumb: `codegraph › ${shortName(focusRef)}`,
      repoLabel: data?.source ?? "",
      status: `focus: ${panelFocus}`,
      tabs: tabsState(),
      stats: `${shortName(focusRef)} — ${drawnNodes} nodes, ${drawnEdges} edges, ${hiddenCount()} hidden, depth ${depth}`,
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
          void expandDepth();
          break;
        case "depthDown":
          contractDepth();
          break;
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
          void expandDepth();
          break;
        case "command5":
          lastCommand = 5;
          open();
          break;
        case "command6":
        case "explain":
          explain();
          break;
        case "chat":
          if (chatOpen) chatClose();
          else {
            chatOpen = true;
            chatScrollPos = 0; // reopen pinned to the latest turn
          }
          break;
      }
    },

    /** Re-center on any real graph ref (history push + load). Exported for the route
     *  (Task-4 review note): palette picks and inspector links may target refs that
     *  no drawn card carries — the route is not required to adopt it yet. */
    recenter,

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

    // Task 4 chat sidebar: the route drives every method from its key-capture
    // branch; the model stays pure (no OpenTUI, no session client).
    syncChat,
    chatType,
    chatBackspace,
    chatScroll,
    chatSubmit,
    chatNote,
    chatClose,

    state,

    /** command3 payload for the route to inject via the existing ask-agent path.
     *  Context collection is shared with the explain path (centerRiskContext). */
    askAgentPrompt(): string | undefined {
      if (data === undefined) return undefined;
      const ctx = centerRiskContext();
      const sinks = (ctx.sinks ?? []).map((s) => (s.count > 1 ? `${s.name} ×${s.count}` : s.name)).join(", ");
      return [
        `Review ${focusRef} for security issues.`,
        `Risk: ${ctx.riskReason ?? "—"}`,
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
