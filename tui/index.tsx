import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createSignal, onMount, type JSX } from "solid-js"
import { createFileMapModel, RISK_SHADING, type FileMapState } from "../src/view/file-map-model.js"
import { createSymbolViewModel, SYMBOL_VIEW_KEYMAP, type SymbolViewState } from "../src/view/symbol-view-model.js"
import { createDetailModel, DETAIL_KEYMAP, type DetailState } from "../src/view/detail-model.js"
import { createEgoModel, EGO_KEYMAP, type EgoState } from "../src/view/ego-model.js"
import { createPaletteModel, PALETTE_KEYMAP, type PaletteState } from "../src/view/palette-model.js"
import {
  createIdeModel,
  IDE_KEYMAP,
  SIDEBAR_W,
  INSPECTOR_W,
  SEPARATOR_W,
  HEADER_ROWS,
  COMMAND_ROWS,
  ASK_ROWS,
  type IdeState,
} from "../src/view/ide-model.js"
import { IDE_THEME, categoryOf, riskColor } from "../src/view/ide-theme.js"
import {
  buildExplainPrompt,
  extractChatTurns,
  replyAfter,
  type AgentMessageLike,
  type DescribeInput,
  type OpId,
} from "../src/view/ide-agent.js"
import { ideLayout, toSegments, type IdeCard, type IdeColumn, type IdeSegment } from "../src/view/ide-layout.js"
import type { EntryFileViewState, EntryRow, FileListState } from "../src/view/ide-entry-model.js"
import type {
  FilesPayload,
  FileSymbolsPayload,
  NodeDetailPayload,
  PaletteSearchPayload,
  EgoGraphPayload,
  EgoSourcePayload,
  UnavailablePayload,
} from "../rpc/index.js"

/**
 * CodeGraph graph route (plan 3 Tasks 4+5; ego-graph-view plan Task 5). Thin by
 * design: all logic lives in the pure models (src/view/*-model.ts); this layer owns
 * the view stack (file map ⇄ symbol list ⇄ detail ⇄ ego graph), the jump-to-symbol
 * palette overlay, and the ask-agent execution adapter.
 *
 * Spike deltas applied (docs/superpowers/spikes/tui-render.md + ego-edges.md):
 * D1 flexbox + no scrollbox (models pre-window rows), D4 selection/risk shading via
 * bg + text markers only (never border* props), D5 fixed-height text rows, D6 enter
 * matches "enter"|"return" and escape matches "escape"|"esc", E7 ego canvas rows are
 * height-1 flex rows of width-pinned <text> segments (bg — NOT backgroundColor — on
 * <text>, per E4).
 *
 * The host (opencode ≥2.2.x) applies the Solid transform to this file (Task 4 verified
 * in-host) — do NOT register ensureSolidTransformPlugin() here.
 *
 * codegraph-ide-screen plan Task 4: the `codegraph` route (CodegraphIdeRoute) renders
 * the pixel-accurate IDE screen from src/view/ide-model.ts — header/sidebar/canvas/
 * inspector/command bar — as an INDEPENDENT full-screen route (it does not join the
 * Screen union above). Additive: the `graph` route + `closegraph.open` command are
 * untouched. Bold/underline segments ride the `attributes` bitmask prop (TextOptions
 * has no bold/underline boolean props in @opentui/solid 0.8.x).
 */

/** One rpc bridge helper: thrown bridge errors become the typed unavailable payload.
 *  Every call carries THIS TUI's directory as `root` — a shared service cannot know
 *  it otherwise (RpcCallContext = {signal, error}; the payload is the only channel);
 *  the server resolves one graph per root from it. */
function unavailable(err: unknown): UnavailablePayload {
  return { error: "unavailable", message: err instanceof Error ? err.message : String(err) }
}

type Client = ReturnType<typeof usePlugin>["client"]

function filesViaRpc(client: Client, root: string): () => Promise<FilesPayload> {
  return async () => {
    try {
      const result = await client.rpc.call({ rpcID: "closegraph", method: "files", input: { root } })
      return result.output as FilesPayload
    } catch (err) {
      return unavailable(err)
    }
  }
}

function fileSymbolsViaRpc(client: Client, root: string): (file: string) => Promise<FileSymbolsPayload> {
  return async (file: string) => {
    try {
      const result = await client.rpc.call({ rpcID: "closegraph", method: "fileSymbols", input: { file, root } })
      return result.output as FileSymbolsPayload
    } catch (err) {
      return unavailable(err)
    }
  }
}

function nodeDetailViaRpc(client: Client, root: string): (ref: string) => Promise<NodeDetailPayload> {
  return async (ref: string) => {
    try {
      const result = await client.rpc.call({ rpcID: "closegraph", method: "nodeDetail", input: { ref, root } })
      return result.output as NodeDetailPayload
    } catch (err) {
      return unavailable(err)
    }
  }
}

function paletteSearchViaRpc(client: Client, root: string): (prefix: string, limit: number) => Promise<PaletteSearchPayload> {
  return async (prefix: string, limit: number) => {
    try {
      const result = await client.rpc.call({ rpcID: "closegraph", method: "paletteSearch", input: { prefix, limit, root } })
      return result.output as PaletteSearchPayload
    } catch (err) {
      return unavailable(err)
    }
  }
}

function egoGraphViaRpc(client: Client, root: string): (ref: string) => Promise<EgoGraphPayload> {
  return async (ref: string) => {
    try {
      const result = await client.rpc.call({ rpcID: "closegraph", method: "egoGraph", input: { ref, root } })
      return result.output as EgoGraphPayload
    } catch (err) {
      return unavailable(err)
    }
  }
}

function egoSourceViaRpc(client: Client, root: string): (ref: string) => Promise<EgoSourcePayload> {
  return async (ref: string) => {
    try {
      const result = await client.rpc.call({ rpcID: "closegraph", method: "egoSource", input: { ref, root } })
      return result.output as EgoSourcePayload
    } catch (err) {
      return unavailable(err)
    }
  }
}

const BANNER_FG: Record<"none" | "unknown-freshness" | "unavailable", string | undefined> = {
  none: undefined,
  "unknown-freshness": "yellow",
  unavailable: "red",
}

/** Shared banner row (both routes): blank when kind is none, colored text otherwise. */
const bannerLine = (banner: { kind: "none" | "unknown-freshness" | "unavailable"; text: string }) => (
  <text width="100%" height={1} flexShrink={0} fg={BANNER_FG[banner.kind]}>
    {banner.kind === "none" ? " " : banner.text}
  </text>
)

/** marker string → bucket: the EXACT inverse of RISK_SHADING. An unmapped marker
 *  (e.g. a future "!!") renders unmarked with a ONE-TIME dev warning — never a render crash. */
let warnedMarkers: Set<string> | undefined
export function markerBucket(marker: string): keyof typeof RISK_SHADING {
  switch (marker) {
    case RISK_SHADING.high.marker: // "!!!"
      return "high"
    case RISK_SHADING.medium.marker: // "!"
      return "medium"
    case RISK_SHADING.low.marker: // ""
      return "low"
    default:
      if (warnedMarkers === undefined) warnedMarkers = new Set()
      if (!warnedMarkers.has(marker)) {
        warnedMarkers.add(marker)
        console.warn(`[closegraph] unknown risk marker ${JSON.stringify(marker)} — rendering unmarked`)
      }
      return "low" // low has no marker and no bg: renders unmarked
  }
}

/** True for a bare printable keystroke the palette filter should consume. */
function printable(key: { sequence?: string; ctrl: boolean; meta: boolean }): string | undefined {
  if (key.ctrl || key.meta) return undefined
  const seq = key.sequence ?? ""
  return seq.length === 1 && seq >= " " ? seq : undefined
}

export interface RouteKey {
  name: string
  sequence?: string
  ctrl: boolean
  meta: boolean
  preventDefault: () => void
}

/** One keymap binding → key event. Plain names require NO modifiers; the escape
 *  family ignores modifiers (bare ESC can parse with meta set — e.g. "\x1b\x1b" —
 *  and alt/ctrl+escape is still escape); the special "ctrl-c" binding matches
 *  ctrl+c (a plain "c" stays a printable). */
export function bindingMatches(binding: string, key: RouteKey): boolean {
  if (binding === "escape" || binding === "esc") return key.name === "escape" || key.name === "esc"
  if (binding === "ctrl-c") return key.ctrl && !key.meta && key.name === "c"
  return !key.ctrl && !key.meta && key.name === binding
}

/** Keymap record → the action a key event resolves to (undefined = not bound). The route's
 *  dispatch flows through THIS helper over the models' KEYMAP constants, so the constants
 *  and the dispatch cannot drift (review minor b). */
export function actionFor<K extends Record<string, readonly string[]>>(keymap: K, key: RouteKey): (keyof K & string) | undefined {
  for (const [action, bindings] of Object.entries(keymap) as [keyof K & string, readonly string[]][]) {
    if (bindings.some((binding) => bindingMatches(binding, key))) return action
  }
  return undefined
}

/** Route-local keymaps: view chrome the pure models don't own. The symbols/detail records
 *  SPREAD the model KEYMAP exports (single source for model actions) and add route-only
 *  actions (palette opener, detail refresh). The file map has no model keymap export
 *  (frozen file), so its record lives here. */
export const MAP_KEYMAP = {
  up: ["up", "k"],
  down: ["down", "j"],
  open: ["enter", "return"],
  refresh: ["r"],
  palette: ["p"],
  cycleLanguage: ["l"],
  /** q quits FROM THE TOP LEVEL; escape joins it here because the screens'
   *  own keymaps pop first (this map is only consulted when no screen is
   *  stacked and the palette is closed — so q still types into the filter). */
  quit: ["q", "escape"],
} as const

const SYMBOLS_KEYMAP = { ...SYMBOL_VIEW_KEYMAP, palette: ["p"] } as const
const DETAIL_SCREEN_KEYMAP = { ...DETAIL_KEYMAP, refresh: ["r"], palette: ["p"] } as const
/** Ego screen chrome: the model keymap spread (columns/rows/re-center/history/refresh)
 *  + route-only actions. `back` is route-owned on purpose — EGO_KEYMAP has NO escape
 *  binding (the model words u vs esc apart); `palette` matches the sibling screens.
 *  Exported for the route-bits keymap tests (MAP_KEYMAP precedent). */
export const EGO_SCREEN_KEYMAP = { ...EGO_KEYMAP, back: ["escape", "esc"], palette: ["p"] } as const

/** The ego source-preview overlay's keys: esc (and `i` again) close; everything else is
 *  swallowed while open so printables never leak into navigation (palette pattern). */
const EGO_PREVIEW_KEYMAP = { close: ["escape", "esc", "i"] } as const

/** Ego re-centers (enter / click-on-highlighted) start a fire-and-forget load inside
 *  the Task-4 contract (open(): void; the model's loadSeq guard makes stale loads
 *  harmless), so the new payload applies with no route-visible handle. Re-sync on a
 *  short settle timer (E5's ~50 ms family) repaints when it lands; any later
 *  keypress's screen.sync() is the backstop if an rpc ever outruns the timer. */
const EGO_SETTLE_MS = 80

interface SymbolsScreen {
  kind: "symbols"
  fileRef: string
  model: ReturnType<typeof createSymbolViewModel>
  state: () => SymbolViewState
  sync: () => void
}

interface DetailScreen {
  kind: "detail"
  ref: string
  model: ReturnType<typeof createDetailModel>
  state: () => DetailState
  sync: () => void
}

interface EgoScreen {
  kind: "ego"
  ref: string
  model: ReturnType<typeof createEgoModel>
  state: () => EgoState
  sync: () => void
}

type Screen = SymbolsScreen | DetailScreen | EgoScreen

/** The picking-relevant slice of SessionInfo (id, parentID?, time.updated, location.directory)
 *  — structurally satisfied by the client type in 2.2.5 and 2.2.7 alike. */
export interface AskAgentSession {
  id: string
  parentID?: string
  time: { updated: number }
  location?: { directory: string }
}

/**
 * Ask-agent session choice, project-scoped (review Important 4). Pinned from the d.ts of
 * BOTH @opencode/plugin 2.2.5 (running host) and 2.2.7 (pinned types): LocationRef carries
 * only { directory, workspaceID? } (2.2.5 types.d.ts:949, 2.2.7 :961 — NO projectID), and
 * SessionInfo.location is LocationPublicRef { directory } (2.2.5 :560, 2.2.7 :564), so the
 * only reliable same-project key BOTH versions share is directory equality. Rules:
 *  - newest-updated ROOT session (parentID undefined — subagent children never picked)
 *    whose location.directory matches the current directory (trailing-slash tolerant);
 *  - currentDirectory undefined (context.location absent) or zero matches → undefined ⇒
 *    the documented degrade path — a foreign project's session is NEVER guessed.
 */
export function pickAskAgentSession(sessions: AskAgentSession[], currentDirectory: string | undefined): string | undefined {
  if (currentDirectory === undefined) return undefined
  const normalize = (dir: string) => (dir.length > 1 && dir.endsWith("/") ? dir.slice(0, -1) : dir)
  const here = normalize(currentDirectory)
  const roots = sessions.filter(
    (s) => s.parentID === undefined && s.location !== undefined && normalize(s.location.directory) === here,
  )
  return roots.sort((a, b) => b.time.updated - a.time.updated).at(0)?.id
}

/** Where the quit key navigates (live hotfix): back to the newest root session in
 *  this project — the same session-picking rules as ask-agent — and to the pinned
 *  `{ type: "home" }` route when no same-project session exists (never a guess).
 *  Both Destination shapes come straight from the installed tui context d.ts
 *  (Route = {type:"home"} | {type:"session",sessionID} | {type:"plugin",…}). */
export function quitDestination(
  sessions: AskAgentSession[],
  currentDirectory: string | undefined,
): { type: "session"; sessionID: string } | { type: "home" } {
  const sessionID = pickAskAgentSession(sessions, currentDirectory)
  return sessionID !== undefined ? { type: "session", sessionID } : { type: "home" }
}

/**
 * Ask-agent execution (plan decision 4: inject + navigate). API verified against BOTH
 * @opencode/plugin 2.2.5 (the running host) and 2.2.7 (pinned types):
 * `client.session.prompt({ sessionID, text })` + `router.navigate({ type: "session", sessionID })`.
 * Neither version exposes a plugin-reachable clipboard API, so the degrade path is
 * dialog + toast (delta recorded in docs/superpowers/spikes/tui-render.md).
 */
async function runAskAgent(context: ReturnType<typeof usePlugin>, prompt: string): Promise<void> {
  const route = context.ui.router.current()
  // the session visibly open in THIS tui is same-project by construction
  let sessionID = route.type === "session" ? route.sessionID : undefined
  if (sessionID === undefined) {
    sessionID = pickAskAgentSession(context.data.session.list(), context.location?.directory)
  }
  if (sessionID !== undefined) {
    try {
      await context.client.session.prompt({ sessionID, text: prompt })
      context.ui.router.navigate({ type: "session", sessionID })
      return
    } catch (err) {
      console.log(`[closegraph] ask-agent prompt injection failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  context.ui.dialog.alert({ title: "Ask agent", message: `Paste this prompt in chat:\n\n${prompt}` })
  context.ui.toast.show({ message: "ask-agent: no session in this project — prompt shown in dialog", variant: "warning" })
}

/** Explain poll cadence/cap (Task 3): 500 ms ticks, 60 ticks = 30 s, then the
 *  honest timeout rejection (surfaces as the model's error state, never a hang). */
const DESCRIBE_POLL_MS = 500
const DESCRIBE_POLL_MAX = 60

/**
 * Map the solid Data session messages onto the pure agent-bridge rows:
 * user/assistant only, text parts joined, order preserved. Tolerant across host
 * shapes — the 2.2.7 client types discriminate on `type` (user text rides
 * `.text`, assistant text rides `.content[]`); older hosts carry
 * `{ info: { role }, parts[] }`. An assistant row counts only once COMPLETED —
 * a streaming reply never renders half-written.
 */
export function agentMessageRows(list: readonly unknown[]): AgentMessageLike[] {
  const partsText = (parts: unknown): string =>
    Array.isArray(parts)
      ? parts
          .filter((p): p is { type?: unknown; text?: unknown } => typeof p === "object" && p !== null)
          .filter((p) => p.type === undefined || p.type === "text")
          .map((p) => (typeof p.text === "string" ? p.text : ""))
          .join("\n")
      : ""
  const rows: AgentMessageLike[] = []
  for (const raw of list) {
    if (typeof raw !== "object" || raw === null) continue
    const m = raw as {
      type?: unknown
      text?: unknown
      content?: unknown
      parts?: unknown
      info?: { role?: unknown }
      time?: { completed?: unknown }
    }
    const role = typeof m.type === "string" ? m.type : typeof m.info?.role === "string" ? m.info.role : undefined
    if (role === "user") {
      rows.push({ role: "user", text: typeof m.text === "string" ? m.text : partsText(m.content ?? m.parts) })
    } else if (role === "assistant") {
      if (m.time !== undefined && typeof m.time.completed !== "number") continue // still streaming
      rows.push({ role: "assistant", text: typeof m.text === "string" ? m.text : partsText(m.content ?? m.parts) })
    }
    // every other message kind (system/tool/skill/…) is filtered out
  }
  return rows
}

/**
 * Shared session ask (Task 3 explain + Task 4 chat): send `text` to the given
 * session, then poll the reactive message list for the reply matched to OUR
 * prompt — the last user row carrying exactly the text we sent, then the first
 * completed assistant row after it (Review Focus 4: never "last assistant
 * text", never pre-existing history). Rejects with `timeoutMessage` after
 * DESCRIBE_POLL_MAX ticks — a send never hangs.
 */
async function askSession(
  context: ReturnType<typeof usePlugin>,
  sessionID: string,
  text: string,
  timeoutMessage: string,
): Promise<string> {
  await context.client.session.prompt({ sessionID, text })
  for (let poll = 0; poll < DESCRIBE_POLL_MAX; poll++) {
    await new Promise((resolve) => setTimeout(resolve, DESCRIBE_POLL_MS))
    const rows = agentMessageRows(context.data.session.message.list(sessionID))
    let userIndex = -1
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]
      if (row !== undefined && row.role === "user" && row.text === text) {
        userIndex = i
        break
      }
    }
    if (userIndex === -1) continue // our user message hasn't landed in the store yet
    const reply = replyAfter(rows, userIndex)
    if (reply !== undefined) return reply
  }
  throw new Error(timeoutMessage)
}

/**
 * Explain-this execution (Task 3): resolve the project session with the SAME
 * rules as ask-agent (a foreign project's session is never guessed), then the
 * shared askSession poll. Rejections surface as the model's error state.
 */
async function describeViaSession(context: ReturnType<typeof usePlugin>, input: DescribeInput): Promise<string> {
  const sessionID = pickAskAgentSession(context.data.session.list(), context.location?.directory)
  if (sessionID === undefined) throw new Error("no session in this project")
  return askSession(context, sessionID, buildExplainPrompt(input), "explain timed out")
}

function CodeGraphRoute() {
  const context = usePlugin()
  // this TUI session's directory rides every rpc call as `root` (shared services
  // resolve one graph per root — the server cannot know it from its own context)
  const sessionRoot = context.location?.directory ?? ""
  const fileMap = createFileMapModel({ files: filesViaRpc(context.client, sessionRoot) })
  const palette = createPaletteModel({ search: paletteSearchViaRpc(context.client, sessionRoot) })
  const [mapState, setMapState] = createSignal<FileMapState>(fileMap.state())
  const [paletteState, setPaletteState] = createSignal<PaletteState>(palette.state())
  const [screens, setScreens] = createSignal<Screen[]>([])
  const dims = useTerminalDimensions()

  const syncMap = () => setMapState(fileMap.state())
  const syncPalette = () => setPaletteState(palette.state())
  const syncScreen = (screen: Screen) => screen.sync()
  const top = (): Screen | undefined => screens()[screens().length - 1]

  onMount(() => {
    void fileMap.load().then(syncMap, syncMap)
  })

  // terminal resize re-layouts every live model without refetches (Review Focus 2)
  createEffect(() => {
    const d = dims()
    const next = { width: d.width, height: d.height }
    fileMap.resize(next)
    syncMap()
    for (const screen of screens()) {
      if (screen.kind === "symbols" || screen.kind === "ego") screen.model.resize(next)
      syncScreen(screen)
    }
  })

  function pushSymbols(fileRef: string): void {
    const model = createSymbolViewModel({ fileRef, fileSymbols: fileSymbolsViaRpc(context.client, sessionRoot) })
    const [state, setState] = createSignal<SymbolViewState>(model.state())
    setScreens([...screens(), { kind: "symbols", fileRef, model, state, sync: () => setState(model.state()) }])
    void model.load().then(() => setState(model.state()))
  }

  function pushDetail(ref: string): void {
    const model = createDetailModel({ ref, nodeDetail: nodeDetailViaRpc(context.client, sessionRoot) })
    const [state, setState] = createSignal<DetailState>(model.state())
    setScreens([...screens(), { kind: "detail", ref, model, state, sync: () => setState(model.state()) }])
    void model.load().then(() => setState(model.state()))
  }

  function pushEgo(ref: string): void {
    const model = createEgoModel({
      ref,
      egoGraph: egoGraphViaRpc(context.client, sessionRoot),
      egoSource: egoSourceViaRpc(context.client, sessionRoot),
    })
    const [state, setState] = createSignal<EgoState>(model.state())
    setScreens([...screens(), { kind: "ego", ref, model, state, sync: () => setState(model.state()) }])
    void model.load().then(() => setState(model.state()))
  }

  /** Repaint an ego screen once a fire-and-forget re-center load has settled (see
   *  EGO_SETTLE_MS). Skipped if the screen was popped before the timer fires. */
  const settleEgo = (screen: EgoScreen) => {
    setTimeout(() => {
      if (screens().includes(screen)) screen.sync()
    }, EGO_SETTLE_MS)
  }

  const pop = () => setScreens(screens().slice(0, -1))

  function openPalette(): void {
    void palette.open().then(syncPalette, syncPalette)
  }

  // One route-global keyboard handler with EXPLICIT precedence (review caution from
  // Task 4): palette (when open) → ego preview overlay (when open) → top screen → file
  // map. Every branch dispatches through actionFor() over the KEYMAP constants above/
  // beside the models — the constants ARE the dispatch, so they cannot drift (review
  // minor b). Consumed keys preventDefault so the host keymap does not double-act on them.
  useKeyboard((key) => {
    // ego source-preview overlay (palette-style): while open, EVERY key is swallowed —
    // `i`'s printables must never leak into navigation — except the close keys.
    const topScreen = screens().at(-1)
    if (topScreen?.kind === "ego" && topScreen.model.state().preview !== undefined) {
      key.preventDefault()
      if (actionFor(EGO_PREVIEW_KEYMAP, key) === "close") {
        topScreen.model.closePreview()
        topScreen.sync()
      }
      return
    }
    if (palette.state().open) {
      // text-entry overlay: movement is arrows-only; EVERY unmodified printable —
      // including j and k — types into the filter (review Important 3). ctrl-c is the
      // D6 alternate close (bare ESC is invisible to mock keys).
      switch (actionFor(PALETTE_KEYMAP, key)) {
        case "up":
          key.preventDefault()
          palette.move(-1)
          syncPalette()
          break
        case "down":
          key.preventDefault()
          palette.move(1)
          syncPalette()
          break
        case "select": {
          key.preventDefault()
          const picked = palette.select()
          syncPalette()
          if (picked !== undefined) pushDetail(picked)
          break
        }
        case "close":
          key.preventDefault()
          palette.close()
          syncPalette()
          break
        case "backspace":
          key.preventDefault()
          void palette.backspace().then(syncPalette, syncPalette)
          break
        default: {
          const typed = printable(key)
          if (typed !== undefined) {
            key.preventDefault()
            void palette.type(typed).then(syncPalette, syncPalette)
          }
          break
        }
      }
      return
    }

    const screen = top()
    if (screen === undefined) {
      // file map (opening view)
      switch (actionFor(MAP_KEYMAP, key)) {
        case "up":
          key.preventDefault()
          fileMap.move(-1)
          syncMap()
          break
        case "down":
          key.preventDefault()
          fileMap.move(1)
          syncMap()
          break
        case "open": {
          key.preventDefault()
          const fileRef = fileMap.openFile()
          if (fileRef !== undefined) pushSymbols(fileRef)
          break
        }
        case "refresh":
          key.preventDefault()
          void fileMap.refresh().then(syncMap, syncMap)
          break
        case "palette":
          key.preventDefault()
          openPalette()
          break
        case "cycleLanguage":
          key.preventDefault()
          fileMap.cycleLanguageFilter()
          syncMap()
          break
        case "quit":
          key.preventDefault()
          // close the graph view and return to chat: newest root session in this
          // project, else the home route (quitDestination — same d.ts-pinned shapes
          // ask-agent navigates with)
          context.ui.router.navigate(quitDestination(context.data.session.list(), context.location?.directory))
          break
        default:
          break
      }
      return
    }

    if (screen.kind === "symbols") {
      switch (actionFor(SYMBOLS_KEYMAP, key)) {
        case "up":
          key.preventDefault()
          screen.model.move(-1)
          screen.sync()
          break
        case "down":
          key.preventDefault()
          screen.model.move(1)
          screen.sync()
          break
        case "open": {
          key.preventDefault()
          const ref = screen.model.openSymbol()
          if (ref !== undefined) pushDetail(ref)
          break
        }
        case "graph": {
          key.preventDefault()
          // Task 5 rider: [g] opens the selected symbol's ego graph (same cursor
          // the detail push consumes)
          const ref = screen.model.openSymbol()
          if (ref !== undefined) pushEgo(ref)
          break
        }
        case "back":
          key.preventDefault()
          pop()
          break
        case "refresh":
          key.preventDefault()
          void screen.model.refresh().then(() => screen.sync())
          break
        case "palette":
          key.preventDefault()
          openPalette()
          break
        default:
          break
      }
      return
    }

    // ego graph: three drawn columns, enter re-centers, u walks the center history
    // (EGO_SCREEN_KEYMAP = the model keymap + route-only back/palette)
    if (screen.kind === "ego") {
      switch (actionFor(EGO_SCREEN_KEYMAP, key)) {
        case "up":
          key.preventDefault()
          screen.model.moveRow(-1)
          screen.sync()
          break
        case "down":
          key.preventDefault()
          screen.model.moveRow(1)
          screen.sync()
          break
        case "left":
          key.preventDefault()
          screen.model.moveColumn(-1)
          screen.sync()
          break
        case "right":
          key.preventDefault()
          screen.model.moveColumn(1)
          screen.sync()
          break
        case "open":
          key.preventDefault()
          // neighbor → re-center (history push); center → refresh. The load applies
          // async (void per the Task-4 contract) — settleEgo repaints when it lands.
          screen.model.open()
          screen.sync()
          settleEgo(screen)
          break
        case "backCenter":
          key.preventDefault()
          screen.model.backCenter() // cached pop — synchronous state swap, no rpc
          screen.sync()
          break
        case "refresh":
          key.preventDefault()
          void screen.model.refresh().then(() => screen.sync())
          break
        case "palette":
          key.preventDefault()
          openPalette()
          break
        case "preview":
          key.preventDefault()
          // lazy: one egoSource fetch per open; settleEgo repaints when it lands
          screen.model.openPreview()
          screen.sync()
          settleEgo(screen)
          break
        case "back":
          key.preventDefault()
          pop() // esc pops the SCREEN (distinct from u's center history)
          break
        default:
          break
      }
      return
    }

    // detail panel: [a] ask agent · [b] ego graph · esc back
    switch (actionFor(DETAIL_SCREEN_KEYMAP, key)) {
      case "askAgent":
        key.preventDefault()
        void runAskAgent(context, screen.model.askAgent())
        break
      case "blastRadius":
        key.preventDefault()
        // Task 5 rider: open this node's ego graph (the drawn blast-radius one-hop
        // view — transitive callers stay closegraph_blast_radius's pointer text)
        pushEgo(screen.model.blastRadius())
        break
      case "back":
        key.preventDefault()
        pop()
        break
      case "refresh":
        key.preventDefault()
        void screen.model.refresh().then(() => screen.sync())
        break
      case "palette":
        key.preventDefault()
        openPalette()
        break
      default:
        break
    }
  })

  // click selects (row hit-test): clicking visible row k moves the cursor by k - selectedRow
  const selectRow = (index: number) => {
    const s = mapState()
    const selectedAt = s.rows.findIndex((r) => r.selected)
    if (selectedAt >= 0 && index !== selectedAt) {
      fileMap.move(index - selectedAt)
      syncMap()
    }
  }

  const selectSymbolRow = (screen: SymbolsScreen, index: number) => {
    const s = screen.state()
    const selectedAt = s.rows.findIndex((r) => r.selected)
    if (selectedAt >= 0 && index !== selectedAt) {
      screen.model.move(index - selectedAt)
      syncScreen(screen)
    }
  }

  // click parity on the ego canvas (ruling 6): click selects the node; a click on
  // the ALREADY-highlighted neighbor re-centers (≡ enter) — selectByRef owns both.
  // A click-triggered re-center loads async, so the settle timer repaints it.
  const selectEgoNode = (screen: EgoScreen, ref: string) => {
    screen.model.selectByRef(ref)
    screen.sync()
    settleEgo(screen)
  }

  const pickPaletteRow = (index: number) => {
    const s = paletteState()
    palette.move(index - s.cursor)
    const picked = palette.select()
    syncPalette()
    if (picked !== undefined) pushDetail(picked)
  }

  const MapView = () => (
    <box flexDirection="column" width="100%" height="100%" paddingTop={0} paddingLeft={1} paddingRight={1}>
      <text width="100%" height={1} flexShrink={0} fg="cyan">
        {mapState().title}
      </text>
      {bannerLine(mapState().banner)}
      <box flexDirection="column" paddingTop={0} flexGrow={1}>
        {...mapState().rows.map((row, i) => (
          <box
            flexDirection="row"
            height={1}
            flexShrink={0}
            backgroundColor={row.selected ? "gray" : RISK_SHADING[markerBucket(row.marker)].bg}
            onMouseDown={() => selectRow(i)}
          >
            <text width={4} height={1} flexShrink={0} fg={row.marker !== "" ? "red" : undefined}>
              {row.marker !== "" ? ` ${row.marker}` : "    "}
            </text>
            <text height={1} fg={row.selected ? "black" : undefined}>
              {`${row.selected ? "›" : " "}${row.label}`}
            </text>
          </box>
        ))}
      </box>
      <text width="100%" height={1} flexShrink={0} fg="gray">
        {"↑/↓ or j/k move · enter open · r refresh · l language · p jump to symbol · q quit"}
      </text>
    </box>
  )

  const SymbolsView = (props: { screen: SymbolsScreen }) => (
    <box flexDirection="column" width="100%" height="100%" paddingTop={0} paddingLeft={1} paddingRight={1}>
      <text width="100%" height={1} flexShrink={0} fg="cyan">
        {props.screen.state().title}
      </text>
      {bannerLine(props.screen.state().banner)}
      <box flexDirection="column" paddingTop={0} flexGrow={1}>
        {...props.screen.state().rows.map((row, i) => (
          <box
            flexDirection="row"
            height={1}
            flexShrink={0}
            backgroundColor={row.selected ? "gray" : RISK_SHADING[markerBucket(row.marker)].bg}
            onMouseDown={() => selectSymbolRow(props.screen, i)}
          >
            <text width={4} height={1} flexShrink={0} fg={row.marker !== "" ? "red" : undefined}>
              {row.marker !== "" ? ` ${row.marker}` : "    "}
            </text>
            <text height={1} flexShrink={0} fg={row.selected ? "black" : undefined}>
              {`${row.selected ? "›" : " "}${row.label} (${row.callers}↑ ${row.callees}↓)`}
            </text>
          </box>
        ))}
      </box>
      <text width="100%" height={1} flexShrink={0} fg="gray">
        {"↑/↓ or j/k move · enter open · esc back · r refresh · [g] ego · p jump to symbol"}
      </text>
    </box>
  )

  const DetailView = (props: { screen: DetailScreen }) => (
    <box flexDirection="column" width="100%" height="100%" paddingTop={0} paddingLeft={1} paddingRight={1}>
      <text width="100%" height={1} flexShrink={0} fg="cyan">
        {props.screen.state().title}
      </text>
      {bannerLine(props.screen.state().banner)}
      <box flexDirection="column" paddingTop={0} flexGrow={1}>
        {...props.screen.state().lines.map((line) => (
          <text width="100%" height={1} flexShrink={0} fg={line.muted ? "gray" : undefined}>
            {line.text}
          </text>
        ))}
      </box>
      <text width="100%" height={1} flexShrink={0} fg="gray">
        {"r refresh · p jump to symbol"}
      </text>
    </box>
  )

  const EgoView = (props: { screen: EgoScreen }) => (
    <box flexDirection="column" width="100%" height="100%" paddingTop={0} paddingLeft={1} paddingRight={1}>
      <text width="100%" height={1} flexShrink={0} fg="cyan">
        {props.screen.state().title}
      </text>
      {bannerLine(props.screen.state().banner)}
      <box flexDirection="column" paddingTop={0} flexGrow={1}>
        {...props.screen.state().lines.map((line) => (
          <text width="100%" height={1} flexShrink={0} fg={line.muted ? "gray" : undefined}>
            {line.text}
          </text>
        ))}
        {(() => {
          // graph mode paints the canvas: fixed-height flex rows of width-pinned
          // segments (E7 verbatim; E3: ego-layout pads/truncates so a segment's
          // text length IS its width). List/miss modes render lines only — the
          // summary lines above are shared by every mode (honesty rulings).
          const s = props.screen.state()
          if (s.mode !== "graph" || s.canvas === undefined) return []
          return s.canvas.rows.map((row) => (
            <box flexDirection="row" height={1} flexShrink={0}>
              {...row.map((seg) => (
                <text
                  width={seg.text.length}
                  height={1}
                  fg={seg.fg}
                  bg={seg.bg}
                  onMouseDown={seg.ref !== undefined ? () => selectEgoNode(props.screen, seg.ref!) : undefined}
                >
                  {seg.text}
                </text>
              ))}
            </box>
          ))
        })()}
      </box>
      <text width="100%" height={1} flexShrink={0} fg="gray">
        {props.screen.state().footer}
      </text>
    </box>
  )

  const PaletteOverlay = () => (
    <box flexDirection="column" width="100%" height="100%" paddingLeft={1} paddingRight={1}>
      <text width="100%" height={1} flexShrink={0} fg="cyan">
        {`jump to symbol: ${paletteState().filter}${paletteState().source === "snapshot" ? " (snapshot)" : ""}`}
      </text>
      {bannerLine(paletteState().banner)}
      <box flexDirection="column" paddingTop={0} flexGrow={1}>
        {...paletteState().rows.map((row, i) => (
          <box flexDirection="row" height={1} flexShrink={0} backgroundColor={row.selected ? "gray" : undefined} onMouseDown={() => pickPaletteRow(i)}>
            <text width={3} height={1} flexShrink={0} fg={row.selected ? "black" : undefined}>
              {row.selected ? "›" : " "}
            </text>
            <text height={1} flexShrink={0} fg={row.selected ? "black" : undefined}>
              {`${row.ref}  (${row.kind})`}
            </text>
          </box>
        ))}
      </box>
      <text width="100%" height={1} flexShrink={0} fg="gray">
        {"type to filter · ↑/↓ move · enter jump · esc or ctrl-c close"}
      </text>
    </box>
  )

  /** The `i` source preview (palette-style overlay): full name + signature + the first
   *  ~10 source lines, loaded lazily on open. Replaces the ego canvas while open —
   *  same overlay pattern as the palette, so the graph underneath is not competing. */
  const EgoPreviewOverlay = (props: { screen: EgoScreen }) => {
    const p = props.screen.state().preview
    if (p === undefined) return <EgoView screen={props.screen} />
    return (
      <box flexDirection="column" width="100%" height="100%" paddingLeft={1} paddingRight={1}>
        <text width="100%" height={1} flexShrink={0} fg="cyan">
          {p.ref}
        </text>
        <text width="100%" height={1} flexShrink={0} fg="gray">
          {p.status === "loading"
            ? "loading source…"
            : p.status === "error"
              ? (p.message ?? "preview unavailable")
              : `${p.signature ?? ""} — ${p.file}:${p.startLine}`}
        </text>
        <box flexDirection="column" paddingTop={0} flexGrow={1}>
          {...p.lines.map((line) => (
            <text width="100%" height={1} flexShrink={0}>
              {line === "" ? " " : line}
            </text>
          ))}
        </box>
        <text width="100%" height={1} flexShrink={0} fg="gray">
          {"esc or i close"}
        </text>
      </box>
    )
  }

  // Signals are read INSIDE JSX expressions so every branch re-renders (a body-level
  // `const s = state()` capture runs once and freezes — spike D2 family). The view
  // choice is one opaque expression: the screen is resolved ONCE per pass — the
  // transform decomposes bare nested ternaries and can re-read top() after a pop,
  // which crashed ESC-back (`top().kind` on undefined) in the PTY host.
  return (
    <box flexDirection="column" width="100%" height="100%">
      {(() => {
        if (paletteState().open) return <PaletteOverlay />
        const s = top()
        if (s === undefined) return <MapView />
        if (s.kind === "symbols") return <SymbolsView screen={s} />
        if (s.kind === "ego") return s.state().preview !== undefined ? <EgoPreviewOverlay screen={s} /> : <EgoView screen={s} />
        return <DetailView screen={s} />
      })()}
    </box>
  )
}

/** Basename of a directory path (trailing-slash tolerant); undefined stays undefined. */
function basenameOf(directory: string | undefined): string | undefined {
  if (directory === undefined) return undefined
  const trimmed = directory.length > 1 && directory.endsWith("/") ? directory.slice(0, -1) : directory
  return trimmed.slice(trimmed.lastIndexOf("/") + 1)
}

/** bold/underline segment flags → the attributes bitmask prop (TextOptions has no
 *  boolean bold/underline props); undefined when neither is set. */
function segmentAttributes(seg: IdeSegment): number | undefined {
  const bits = (seg.bold === true ? TextAttributes.BOLD : 0) | (seg.underline === true ? TextAttributes.UNDERLINE : 0)
  return bits === 0 ? undefined : bits
}

/**
 * The `codegraph` IDE route (codegraph-ide-screen plan Task 4). Independent of the
 * Screen union: it owns its own createIdeModel + signal + sync and its own single
 * useKeyboard (precedence: palette overlay → help overlay → IDE model dispatch).
 * `/` opens the existing palette overlay — a pick re-centers the IDE model;
 * esc ⇒ quitDestination (the same d.ts-pinned shapes the graph route quits with).
 * The model's selectedRef may be a synthetic `+more:*`/`+collapsed:*` placeholder —
 * those are NEVER passed to rpc or re-centered: canvas clicks go through
 * model.selectByRef (the model guards open()), and re-centers only ever carry
 * palette picks or inspector caller/callee refs (both real graph refs).
 */
function CodegraphIdeRoute(props: { initialRef?: string }) {
  const context = usePlugin()
  // same root rule as the graph route: this TUI's directory rides every rpc call
  const sessionRoot = context.location?.directory ?? ""
  const repoBase = basenameOf(context.location?.directory)
  const palette = createPaletteModel({ search: paletteSearchViaRpc(context.client, sessionRoot) })
  const [paletteState, setPaletteState] = createSignal<PaletteState>(palette.state())
  const dims = useTerminalDimensions()

  const makeModel = (ref: string) =>
    createIdeModel({
      ref,
      egoGraph: egoGraphViaRpc(context.client, sessionRoot),
      nodeDetail: nodeDetailViaRpc(context.client, sessionRoot),
      egoSource: egoSourceViaRpc(context.client, sessionRoot),
      // Task 3: the agent bridge dep. The repaint hops one macrotask past the
      // promise settlement so the MODEL's own resolution handler (a microtask
      // on this same promise) has stored the cache entry before sync() reads it.
      describe: (input: DescribeInput) => {
        const pending = describeViaSession(context, input)
        const repaint = () => setTimeout(sync, 0)
        void pending.then(repaint, repaint)
        return pending
      },
    })

  // Task-5 ruling 2: the ONLY model swap is this bare-mount one — re-centers
  // go through model().recenter, so the chat transcript and center history
  // live as long as the route does.
  const [model] = createSignal(makeModel(props.initialRef ?? ""))
  const [ideState, setIdeState] = createSignal<IdeState>(model().state())
  const sync = () => setIdeState(model().state())
  const syncPalette = () => setPaletteState(palette.state())
  // Task 4: route-level mirror of the model's chat-open state. The reactive
  // turn-sync effect below keys off THIS signal — reading ideState() inside
  // the effect AND writing it via sync() would re-trigger itself forever.
  const [chatOpen, setChatOpen] = createSignal(false)

  onMount(() => {
    const d = dims()
    model().resize({ width: d.width, height: d.height })
    // File-entry Task 5: bare /closegraph opens the model's file LIST — the
    // entry kick fired at construction (Task 4), so wait for it to settle and
    // paint; the palette no longer auto-opens (it stays on / and p). A real
    // <ref> takes the load path (apply + deterministic detail settle).
    if (props.initialRef !== undefined && props.initialRef.trim() !== "") {
      loadIde(model())
    } else {
      void model().whenEntrySettled().then(sync)
    }
  })

  // terminal resize re-windows the model without refetches (Review Focus 2 pattern)
  createEffect(() => {
    const d = dims()
    model().resize({ width: d.width, height: d.height })
    sync()
  })

  // Task 4: reactive chat turn sync. While the chat is open the solid session
  // store re-runs this effect as messages land (user row → completed assistant
  // row), so the transcript streams without a keystroke; syncChat drops the
  // model's `sending` status once the assistant turn is latest. On hosts where
  // Data is non-reactive it degrades to the settle-time sync in sendChat.
  createEffect(() => {
    if (!chatOpen()) return
    const sessionID = pickAskAgentSession(context.data.session.list(), context.location?.directory)
    if (sessionID === undefined) return
    model().syncChat(extractChatTurns(agentMessageRows(context.data.session.message.list(sessionID))))
    sync()
  })

  /** Pull the session transcript into the model once (open path + send settle). */
  const syncChatFromStore = () => {
    const sessionID = pickAskAgentSession(context.data.session.list(), context.location?.directory)
    if (sessionID === undefined) return
    model().syncChat(extractChatTurns(agentMessageRows(context.data.session.message.list(sessionID))))
  }

  /** Task 4 chat send: the model already prefixed the graph context (or noted
   *  its absence) — the route only needs the project session. No session ⇒
   *  the pinned muted note, status idle, NEVER a hang. The reply path is the
   *  shared askSession poll (Task 3's implementation, not a second one). */
  function sendChat(text: string): void {
    const m = model() // seq-guard family: a model swap mid-send drops the settle
    const sessionID = pickAskAgentSession(context.data.session.list(), context.location?.directory)
    if (sessionID === undefined) {
      m.chatNote("no session in this project")
      sync()
      return
    }
    void askSession(context, sessionID, text, "chat timed out").then(
      () => {
        if (model() !== m) return
        syncChatFromStore()
        sync()
      },
      (err: unknown) => {
        if (model() !== m) return
        syncChatFromStore() // our user row still landed — show it
        m.chatNote(err instanceof Error ? err.message : String(err))
        sync()
      },
    )
  }

  /** Ops-pick paths open the chat INSIDE the model (opsPick runs explain/custom/
   *  edit picks) — mirror that into the route's chatOpen signal and pull the
   *  existing session history, exactly like the t-key branch does, so the
   *  reactive turn-sync effect starts watching the transcript. */
  const chatOpenedViaModel = (m: ReturnType<typeof createIdeModel>): void => {
    if (m.state().chat === undefined) return
    setChatOpen(true)
    syncChatFromStore()
  }

  /** Task 5 ops pick (item key, enter, or row click): the model closes the
   *  overlay, runs explain / opens chat / hands back the context-prefixed
   *  prompt — the route only mirrors the chat-open and sends via the Task-4
   *  sendChat path (no third sender). No session ⇒ sendChat's pinned note. */
  const pickOp = (id: OpId) => {
    const m = model() // seq-guard family: a model swap mid-send drops the settle
    const text = m.opsPick(id)
    sync()
    chatOpenedViaModel(m)
    if (text !== undefined) sendChat(text)
  }

  /** Palette pick / inspector caller-callee click: re-center THROUGH the live
   *  model (Task-5 ruling 2) — no fresh model, so the chat transcript and the
   *  `u` center history survive the re-center (the same path the chat's
   *  `focus <ref>` command uses). The settle repaints when the async apply()
   *  lands; the bare-mount fresh model (makeModel) is the only model swap left. */
  function recenterIde(ref: string): void {
    model().recenter(ref)
    sync()
    settleIde()
  }

  /** EGO_SETTLE_MS family: fire-and-forget re-centers/detail loads land async; a
   *  short settle timer repaints, driving the model's lazy inspector detail via
   *  detailDirty() → loadDetail() (which dedupes onto any in-flight fetch). */
  const settleIde = () => {
    setTimeout(() => {
      const m = model()
      if (m.detailDirty()) void m.loadDetail().then(sync, sync)
      else sync()
    }, EGO_SETTLE_MS)
  }

  /** File-entry Task 5: entry data lands async (list kick, file open, refresh) —
   *  the model tracks the last entry op's promise; repaint when it settles. A
   *  card open re-centers through the graph path, so the ego settle stays armed
   *  too (the resolved-promise sync in the no-op case is one harmless microtask). */
  const settleEntry = () => {
    void model().whenEntrySettled().then(sync)
    settleIde()
  }

  /** Model-contract detail settle (the ide-model.ts header ruling): detailDirty()
   *  → loadDetail() — which DEDUPES onto the fetch apply() already started — then
   *  a repaint when it lands. Deterministic (no timer guess), so a load path that
   *  arms this can never rest on the inspector's "loading…" line. */
  const settleDetail = (m: ReturnType<typeof createIdeModel>) => {
    if (m.detailDirty()) void m.loadDetail().then(sync, sync)
  }

  /** Load path (onMount — the only remaining caller): load() resolving means
   *  apply() ran, but the nodeDetail fetch it fired is still in flight —
   *  sync() alone paints the inspector's "loading…" line and RESTS on it (at
   *  rest no keystroke follows, and unbound keys hit `case undefined` and
   *  don't sync either — review Important 1). Repaint, then arm the
   *  deterministic settle. */
  const loadIde = (m: ReturnType<typeof createIdeModel>): void => {
    void m.load().then(() => {
      sync()
      settleDetail(m)
    }, sync)
  }

  function openPalette(): void {
    void palette.open().then(syncPalette, syncPalette)
  }

  useKeyboard((key) => {
    // palette overlay first (same branch shape as the graph route; a pick re-centers
    // the IDE model instead of pushing a detail screen)
    if (palette.state().open) {
      switch (actionFor(PALETTE_KEYMAP, key)) {
        case "up":
          key.preventDefault()
          palette.move(-1)
          syncPalette()
          break
        case "down":
          key.preventDefault()
          palette.move(1)
          syncPalette()
          break
        case "select": {
          key.preventDefault()
          const picked = palette.select()
          syncPalette()
          if (picked !== undefined) recenterIde(picked)
          break
        }
        case "close":
          key.preventDefault()
          palette.close()
          syncPalette()
          break
        case "backspace":
          key.preventDefault()
          void palette.backspace().then(syncPalette, syncPalette)
          break
        default: {
          const typed = printable(key)
          if (typed !== undefined) {
            key.preventDefault()
            void palette.type(typed).then(syncPalette, syncPalette)
          }
          break
        }
      }
      return
    }

    // help overlay second: while open, every key is swallowed except ? / esc, which
    // close it (palette-pattern overlays never leak printables into navigation)
    if (ideState().help !== undefined) {
      key.preventDefault()
      const action = actionFor(IDE_KEYMAP, key)
      if (action === "help" || action === "back") {
        model().dispatch("help") // help toggles closed
        sync()
      }
      return
    }

    // ops overlay (Task 5): palette-style capture alongside the help branch —
    // while open, the item keys (r/t/d/h/e/c) pick, j/k and the arrows move the
    // cursor, enter picks the cursor item, esc closes; ALL other keys are
    // swallowed (those letters are dispatch actions otherwise — the overlay owns
    // them while it is up; nothing leaks into navigation)
    if (ideState().ops !== undefined) {
      key.preventDefault()
      const m = model()
      if (key.name === "escape" || key.name === "esc") {
        m.opsClose()
        sync()
        return
      }
      if (key.name === "up" || key.name === "k") {
        m.opsMove(-1)
        sync()
        return
      }
      if (key.name === "down" || key.name === "j") {
        m.opsMove(1)
        sync()
        return
      }
      if (key.name === "enter" || key.name === "return") {
        const st = m.state().ops
        const item = st === undefined ? undefined : st.items[st.cursor]
        if (item !== undefined) pickOp(item.id)
        return
      }
      const typed = printable(key)
      if (typed !== undefined) {
        const item = (m.state().ops?.items ?? []).find((i) => i.key === typed)
        if (item !== undefined) pickOp(item.id)
      }
      return
    }

    // ask bar capture: while focused, every key is swallowed (palette-style) —
    // printables/backspace edit the shared chat draft, enter submits (a send
    // result routes through sendChat; the transcript is already open beside
    // the bar), arrows scroll the transcript, esc blurs (the draft is kept).
    if (ideState().ask.focused) {
      key.preventDefault()
      const m = model()
      if (key.name === "escape" || key.name === "esc") {
        m.askBlur()
        sync()
        return
      }
      if (key.name === "up") {
        m.chatScroll(1)
        sync()
        return
      }
      if (key.name === "down") {
        m.chatScroll(-1)
        sync()
        return
      }
      if (key.name === "backspace") {
        m.chatBackspace()
        sync()
        return
      }
      if (key.name === "enter" || key.name === "return") {
        const result = m.chatSubmit()
        sync()
        if (result?.kind === "focus") {
          // model.recenter — the same live-model path recenterIde uses now
          // (Task-5 ruling 2): a re-center NEVER clears the transcript
          m.recenter(result.ref)
          sync()
          settleIde()
        } else if (result?.kind === "send") {
          sendChat(result.text)
        }
        return
      }
      const typed = printable(key)
      if (typed !== undefined) {
        m.chatType(typed)
        sync()
      }
      return
    }

    // IDE model dispatch: IDE_KEYMAP IS the dispatch table (actionFor parity)
    const action = actionFor(IDE_KEYMAP, key)
    switch (action) {
      case undefined:
        break
      case "back":
        key.preventDefault()
        // esc goes BACK first: pop the center history while it is non-empty
        // (same as the header [←] back button and [u]); then the entry chain —
        // focus → file-view → file-list (Task 4's entryBack handles it, state
        // kept); at the root — nothing earlier — it quits the SCREEN: newest
        // root session in this project, else the home route (the model's back
        // action stays a deliberate no-op)
        if (ideState().historyDepth > 0) {
          model().dispatch("backCenter")
          sync()
          settleIde()
        } else if (model().entryBack()) {
          sync()
          settleEntry()
        } else {
          context.ui.router.navigate(quitDestination(context.data.session.list(), context.location?.directory))
        }
        break
      case "search":
        key.preventDefault()
        openPalette() // the model's search action is a no-op — the route owns it
        break
      case "command3": {
        key.preventDefault()
        model().dispatch("command3") // lastCommand=3 → the command-bar chrome lights up
        sync()
        const prompt = model().askAgentPrompt()
        if (prompt !== undefined) void runAskAgent(context, prompt)
        break
      }
      case "chat": {
        key.preventDefault()
        const m = model()
        m.dispatch("chat") // toggles; opening resets the scroll to the latest turn
        const open = m.state().chat !== undefined
        setChatOpen(open)
        if (open) syncChatFromStore() // show existing session history immediately
        sync()
        break
      }
      case "refresh": {
        key.preventDefault()
        // the sibling ego route's pattern (refresh AWAITED, not settled — the
        // model's dispatch("refresh") hands back no promise): a real rpc
        // outrunning the 80 ms settle left the refresh — and the detail swap
        // apply() performs — unpainted until the next bound keystroke
        void model().refresh().then(() => {
          sync()
          settleDetail(model())
        })
        break
      }
      default: {
        key.preventDefault()
        const m = model()
        m.dispatch(action)
        sync()
        // entry opens/refreshes load async (whenEntrySettled); graph actions
        // keep the ego settle — settleEntry arms both (Task 5)
        settleEntry()
        break
      }
    }
  })

  // click parity on the canvas: selectByRef owns select + click-on-selected ⇒ open;
  // a click-triggered re-center loads async, so the settle timer repaints it
  const clickSegment = (ref: string) => {
    model().selectByRef(ref)
    sync()
    settleIde()
  }

  /** File-entry Task 5 click parity: an entry row/card click is the mouse
   *  equivalent of move+enter — the model jumps the cursor and opens; the open
   *  fetch lands async, so the entry settle repaints (a card open re-centers
   *  through the graph path — same settle family as clickSegment). */
  const clickEntry = (ref: string) => {
    model().entryClick(ref)
    sync()
    settleEntry()
  }

  /** One canvas/minimap row: width-pinned height-1 segments (E7 verbatim; E3: the
   * layout pads/truncates so a segment's text length IS its width). Mouse handlers
   * only on segments carrying a ref. File-entry Task 5: the file-view canvas
   * passes its own click handler (entry semantics) — default is the graph's. */
  const SegmentRow = (rowProps: { row: IdeSegment[]; onItemClick?: (ref: string) => void }) => (
    <box flexDirection="row" height={1} flexShrink={0}>
      {...rowProps.row.map((seg) => (
        <text
          width={seg.text.length}
          height={1}
          fg={seg.fg}
          bg={seg.bg}
          attributes={segmentAttributes(seg)}
          onMouseDown={seg.ref !== undefined ? () => (rowProps.onItemClick ?? clickSegment)(seg.ref!) : undefined}
        >
          {seg.text}
        </text>
      ))}
    </box>
  )

  /** Full borders + title around a right/sidebar panel (UX round: panels were
   *  not delimited enough). Character-drawn per D4 — never border* props. The
   *  content area is the panel width minus the two │ columns; the body rows
   *  are the viewport height minus the two border rows. */
  const PanelBox = (panelProps: { title: string; width?: number; flexGrow?: boolean; children: JSX.Element }) => {
    const w = panelProps.width ?? dims().width
    const title = ` ${panelProps.title} `
    const top = `╭${title}${"─".repeat(Math.max(0, w - 2 - title.length))}╮`
    const bottom = `╰${"─".repeat(Math.max(0, w - 2))}╯`
    const bodyRows = Math.max(1, dims().height - HEADER_ROWS - COMMAND_ROWS - ASK_ROWS - 2)
    return (
      <box
        flexDirection="column"
        width={panelProps.flexGrow === true ? undefined : w}
        flexGrow={panelProps.flexGrow === true ? 1 : undefined}
        flexShrink={0}
        backgroundColor={IDE_THEME.panel}
      >
        <text width={w} height={1} flexShrink={0} fg={IDE_THEME.border}>
          {top}
        </text>
        <box flexDirection="row" flexShrink={0}>
          <box flexDirection="column" width={1} flexShrink={0}>
            {...Array.from({ length: bodyRows }, () => (
              <text width={1} height={1} flexShrink={0} fg={IDE_THEME.border}>
                │
              </text>
            ))}
          </box>
          <box flexDirection="column" width={w - 2} flexShrink={0}>
            {panelProps.children}
          </box>
          <box flexDirection="column" width={1} flexShrink={0}>
            {...Array.from({ length: bodyRows }, () => (
              <text width={1} height={1} flexShrink={0} fg={IDE_THEME.border}>
                │
              </text>
            ))}
          </box>
        </box>
        <text width={w} height={1} flexShrink={0} fg={IDE_THEME.border}>
          {bottom}
        </text>
      </box>
    )
  }

  const headerRepoLabel = (s: IdeState): string => {
    if (repoBase === undefined) return s.header.repoLabel
    return s.header.repoLabel === "" ? repoBase : `${repoBase} · ${s.header.repoLabel}`
  }

  const IdePaletteOverlay = () => (
    <box flexDirection="column" width="100%" height="100%" paddingLeft={1} paddingRight={1}>
      <text width="100%" height={1} flexShrink={0} fg="cyan">
        {`jump to symbol: ${paletteState().filter}${paletteState().source === "snapshot" ? " (snapshot)" : ""}`}
      </text>
      {bannerLine(paletteState().banner)}
      <box flexDirection="column" paddingTop={0} flexGrow={1}>
        {...paletteState().rows.map((row, i) => (
          <box
            flexDirection="row"
            height={1}
            flexShrink={0}
            backgroundColor={row.selected ? "gray" : undefined}
            onMouseDown={() => {
              const s = paletteState()
              palette.move(i - s.cursor)
              const picked = palette.select()
              syncPalette()
              if (picked !== undefined) recenterIde(picked)
            }}
          >
            <text width={3} height={1} flexShrink={0} fg={row.selected ? "black" : undefined}>
              {row.selected ? "›" : " "}
            </text>
            <text height={1} flexShrink={0} fg={row.selected ? "black" : undefined}>
              {`${row.ref}  (${row.kind})`}
            </text>
          </box>
        ))}
      </box>
      <text width="100%" height={1} flexShrink={0} fg="gray">
        {"type to filter · ↑/↓ move · enter recenter · esc or ctrl-c close"}
      </text>
    </box>
  )

  const IdeHelpOverlay = (helpProps: { sections: { title: string; lines: string[] }[] }) => {
    // flat rows: section titles cyan, body lines default; no scroll — clip to the
    // viewport with a pinned "…" bottom line when the sections don't fit
    const flatRows = () => {
      const rows: { text: string; title: boolean }[] = []
      for (const sec of helpProps.sections) {
        rows.push({ text: sec.title, title: true })
        for (const line of sec.lines) rows.push({ text: line, title: false })
      }
      return rows
    }
    const rows = () => {
      const all = flatRows()
      const budget = dims().height - 1 // minus the "? or esc close" footer
      return all.length > budget ? [...all.slice(0, Math.max(0, budget - 1)), { text: "…", title: false }] : all
    }
    return (
      <box flexDirection="column" width="100%" height="100%" paddingLeft={1} paddingRight={1}>
        <box flexDirection="column" paddingTop={0} flexGrow={1}>
          {...rows().map((row) => (
            <text width="100%" height={1} flexShrink={0} fg={row.title ? "cyan" : undefined}>
              {row.text === "" ? " " : row.text}
            </text>
          ))}
        </box>
        <text width="100%" height={1} flexShrink={0} fg="gray">
          {"? or esc close"}
        </text>
      </box>
    )
  }

  /** Task 5 ops overlay: the focused function's operations menu — the palette
   *  idiom (› cursor row, gray highlight, click to pick), titled by the focus
   *  ref so the target is never ambiguous. Full-screen overlay like help; the
   *  harden row exists only when the focus has risk facts (the model's list).
   *  The prop is `focusRef`, NEVER `ref` — `ref` is a reserved Solid JSX prop
   *  (the compiler forwards a ref callback, so `opsProps.ref` renders as
   *  function source instead of the string; ux2 Task-6 harness defect). */
  const IdeOpsOverlay = (opsProps: { ops: NonNullable<IdeState["ops"]>; focusRef: string }) => (
    <box flexDirection="column" width="100%" height="100%" paddingLeft={1} paddingRight={1}>
      <text width="100%" height={1} flexShrink={0} fg="cyan">
        {`operations on ${opsProps.focusRef}`}
      </text>
      <box flexDirection="column" paddingTop={0} flexGrow={1}>
        {...opsProps.ops.items.map((item, i) => (
          <box
            flexDirection="row"
            height={1}
            flexShrink={0}
            backgroundColor={i === opsProps.ops.cursor ? "gray" : undefined}
            onMouseDown={() => pickOp(item.id)}
          >
            <text width={3} height={1} flexShrink={0} fg={i === opsProps.ops.cursor ? "black" : undefined}>
              {i === opsProps.ops.cursor ? "›" : " "}
            </text>
            <text height={1} flexShrink={0} fg={i === opsProps.ops.cursor ? "black" : undefined}>
              {`[${item.key}] ${item.label}`}
            </text>
          </box>
        ))}
      </box>
      <text width="100%" height={1} flexShrink={0} fg="gray">
        {"pick a key · j/k move · enter picks · esc close"}
      </text>
    </box>
  )

  const HeaderView = (headerProps: { s: IdeState }) => (
    <box flexDirection="column" height={HEADER_ROWS} flexShrink={0} backgroundColor={IDE_THEME.panel}>
      <box flexDirection="row" height={1} flexShrink={0}>
        {/* back BUTTON: walks the center history ONLY — a safe back that never
            closes the screen (esc/q keep the close role); dimmed when there is
            nothing earlier to return to */}
        <text
          height={1}
          fg={headerProps.s.historyDepth > 0 ? IDE_THEME.cyan : IDE_THEME.textMuted}
          onMouseDown={() => {
            if (headerProps.s.historyDepth === 0) return
            model().dispatch("backCenter")
            sync()
            settleIde()
          }}
        >
          {" [←] back "}
        </text>
        <text height={1} attributes={TextAttributes.BOLD} fg={IDE_THEME.cyan}>
          {headerProps.s.header.breadcrumb}
        </text>
        <text height={1} fg={IDE_THEME.textMuted}>
          {headerRepoLabel(headerProps.s) === "" ? "" : `  ${headerRepoLabel(headerProps.s)}`}
        </text>
        <box flexGrow={1} height={1} />
        {/* the banner folds into the header's status slot (bannerLine semantics:
            blank when none) — the model's row budget has no fourth header row */}
        <text height={1} fg={headerProps.s.banner.kind === "none" ? IDE_THEME.textMuted : BANNER_FG[headerProps.s.banner.kind]}>
          {headerProps.s.banner.kind === "none" ? `${headerProps.s.header.status} ` : `${headerProps.s.banner.text} `}
        </text>
      </box>
      <box flexDirection="row" height={1} flexShrink={0}>
        {...headerProps.s.header.tabs.map((tab) => (
          <text height={1} fg={tab.active ? "black" : IDE_THEME.textMuted} bg={tab.active ? IDE_THEME.cyan : undefined}>
            {` ${tab.label} `}
          </text>
        ))}
        <box flexGrow={1} height={1} />
        <text height={1} fg={IDE_THEME.textMuted}>
          {`${headerProps.s.header.stats} `}
        </text>
      </box>
      <text width="100%" height={1} flexShrink={0} fg={IDE_THEME.borderSubtle}>
        {"─".repeat(Math.max(1, dims().width))}
      </text>
    </box>
  )

  const SidebarView = (sideProps: { sidebar: NonNullable<IdeState["sidebar"]> }) => (
    <PanelBox title="Explorer" width={SIDEBAR_W}>
      {/* lines + minimap share the body height: the minimap keeps its rows and the
          lines take the rest (D1 model windowing — no scrollbox) */}
      {(() => {
        const minimapRows = toSegments(sideProps.sidebar.minimap, sideProps.sidebar.minimap[0]?.length ?? 0)
        const budget = Math.max(0, Math.max(1, dims().height - HEADER_ROWS - COMMAND_ROWS - ASK_ROWS - 2) - 2 - minimapRows.length)
        return [
          ...sideProps.sidebar.lines.slice(0, budget).map((line) => (
            <text width="100%" height={1} flexShrink={0} fg={line.fg}>
              {line.text === "" ? " " : line.text}
            </text>
          )),
          ...minimapRows.map((row) => <SegmentRow row={row} />),
        ]
      })()}
    </PanelBox>
  )

  const InspectorView = (inspProps: { inspector: NonNullable<IdeState["inspector"]>; overlay: boolean }) => (
    <PanelBox title={inspProps.inspector.title} width={inspProps.overlay ? undefined : INSPECTOR_W} flexGrow={inspProps.overlay}>
      {/* flattened sections (title fg cyan + lines), windowed by the model's scroll
          offset over its vh height — caller/callee lines carry refs and re-center */}
      {(() => {
        const rows: ({ title: true; text: string } | { title?: false; text: string; fg?: string; ref?: string })[] = []
        for (const sec of inspProps.inspector.sections) {
          rows.push({ title: true, text: sec.title })
          for (const line of sec.lines) rows.push(line)
        }
        return rows.slice(inspProps.inspector.scroll, inspProps.inspector.scroll + inspProps.inspector.height).map((line) => (
          <text
            width="100%"
            height={1}
            flexShrink={0}
            fg={line.title === true ? IDE_THEME.cyan : line.fg}
            onMouseDown={line.title !== true && line.ref !== undefined ? () => recenterIde(line.ref!) : undefined}
          >
            {line.text === "" ? " " : line.text}
          </text>
        ))
      })()}
    </PanelBox>
  )

  /** Task 4 chat sidebar (UX round: transcript only — typing lives in the
   *  persistent ask bar below the canvas). Pinned header hint, role-prefixed
   *  transcript windowed from the bottom (scroll = lines up from the latest;
   *  `+N earlier` discloses the capped tail). Assistant text is labeled by the
   *  `agent:` prefix (generated content); muted lines are the model's honest
   *  local notes (degrades, no context). */
  const ChatView = (chatProps: { chat: NonNullable<IdeState["chat"]>; overlay: boolean }) => {
    const visible = () => {
      const lines: { text: string; fg?: string }[] = []
      if (chatProps.chat.earlier > 0) lines.push({ text: `+${chatProps.chat.earlier} earlier`, fg: IDE_THEME.textMuted })
      for (const turn of chatProps.chat.turns) {
        const prefix = turn.role === "user" ? "you: " : "agent: "
        const fg = turn.muted === true ? IDE_THEME.textMuted : turn.role === "user" ? IDE_THEME.cyan : undefined
        turn.text.split("\n").forEach((part, i) => {
          lines.push({ text: (i === 0 ? prefix : " ".repeat(prefix.length)) + part, fg })
        })
      }
      const body = Math.max(1, dims().height - HEADER_ROWS - COMMAND_ROWS - ASK_ROWS - 4)
      const start = Math.max(0, lines.length - body - chatProps.chat.scroll)
      return lines.slice(start, start + body)
    }
    return (
      <PanelBox title="Chat" width={chatProps.overlay ? undefined : INSPECTOR_W} flexGrow={chatProps.overlay}>
        <box flexDirection="column" flexGrow={1}>
          {...visible().map((line) => (
            <text width="100%" height={1} flexShrink={0} fg={line.fg}>
              {line.text === "" ? " " : line.text}
            </text>
          ))}
        </box>
      </PanelBox>
    )
  }

  /** Persistent ask-AI bar (UX round): the single input row above the command
   *  bar. Focused (a): a block-cursor prompt typing into the shared chat draft
   *  — enter sends (transcript streams in the Chat panel), esc blurs. Unfocused
   *  with a draft: the draft still shows; otherwise a muted hint. */
  const AskBar = (askProps: { s: IdeState }) => {
    const a = askProps.s.ask
    const body =
      a.focused || a.input !== ""
        ? `${a.focused ? "▸ ask " : "  ask "}${a.input}${a.focused ? "█" : ""}${a.status === "sending" ? " …" : ""}`
        : "  a ask the agent · t transcript · enter sends · esc blurs"
    return (
      <box flexDirection="row" height={ASK_ROWS} flexShrink={0} backgroundColor={IDE_THEME.panelElevated}>
        <text width="100%" height={1} flexShrink={0} fg={a.focused ? IDE_THEME.cyan : IDE_THEME.textMuted}>
          {body}
        </text>
      </box>
    )
  }

  const CommandBar = (barProps: { s: IdeState }) => (
    <box flexDirection="column" height={COMMAND_ROWS} flexShrink={0} backgroundColor={IDE_THEME.panel}>
      <box flexDirection="row" height={1} flexShrink={0}>
        {...barProps.s.commandBar.actions.map((a) => (
          <text height={1} flexShrink={0} width={a.label.length + 5} fg={a.active ? "black" : IDE_THEME.text} bg={a.active ? IDE_THEME.cyan : undefined}>
            {`  ${a.key} ${a.label} `}
          </text>
        ))}
      </box>
      <text width="100%" height={1} flexShrink={0} fg={IDE_THEME.amber}>
        {barProps.s.commandBar.note ?? " "}
      </text>
      <text width="100%" height={1} flexShrink={0} fg={IDE_THEME.textMuted}>
        {" h/l columns · j/k move · enter recenter · a ask · t chat · / search · ? help · esc back"}
      </text>
    </box>
  )

  /** File-entry Task 5 — the file LIST: windowed rows (the model owns the
   *  window), risk marker + language + symbol count per row, › cursor + gray
   *  selection (palette idiom); click = move+open. Window edges disclose the
   *  exact hidden counts (chat/palette disclosure wording family). */
  const FileListView = (listProps: { es: FileListState }) => {
    const es = listProps.es
    const sel = (i: number): boolean => es.windowOffset + i === es.cursor
    const markerFg = (marker: EntryRow["marker"]): string =>
      marker === "!!!" ? riskColor("high") : marker !== "" ? riskColor("medium") : riskColor("low")
    return (
      <box flexDirection="column" flexGrow={1} paddingLeft={1}>
        {es.loading ? (
          <text width="100%" height={1} flexShrink={0} fg={IDE_THEME.textMuted}>
            loading…
          </text>
        ) : (
          []
        )}
        {...es.rows.map((row, i) => (
          <box
            flexDirection="row"
            height={1}
            flexShrink={0}
            backgroundColor={sel(i) ? "gray" : undefined}
            onMouseDown={() => clickEntry(row.ref)}
          >
            <text width={4} height={1} flexShrink={0} fg={sel(i) ? "black" : markerFg(row.marker)}>
              {sel(i) ? "› " : row.marker === "" ? "  " : `${row.marker} `}
            </text>
            <text height={1} flexShrink={0} fg={sel(i) ? "black" : undefined}>
              {row.ref}
            </text>
            <text height={1} flexShrink={0} fg={sel(i) ? "black" : IDE_THEME.textMuted}>
              {`  ${row.language} · ${row.symbols} symbols`}
            </text>
          </box>
        ))}
        {es.windowOffset > 0 ? (
          <text width="100%" height={1} flexShrink={0} fg={IDE_THEME.textMuted}>
            {`↑ ${es.windowOffset} earlier`}
          </text>
        ) : (
          []
        )}
        {es.windowOffset + es.rows.length < es.total ? (
          <text width="100%" height={1} flexShrink={0} fg={IDE_THEME.textMuted}>
            {`… +${es.total - es.windowOffset - es.rows.length} more`}
          </text>
        ) : (
          []
        )}
      </box>
    )
  }

  /** File-entry Task 5 — the file VIEW: the file's symbols as cards in the
   *  model's call-depth columns, composed through the SAME ideLayout gutter
   *  router the graph screen uses. The deepest layer is the layout's "center"
   *  column, so every other card routes via parentRef left→right (caller →
   *  callee); the ring-1 to-center rule never fires and no wire is invented —
   *  Task 3's drawn/undrawn/truncated accounting stays exact. Vertically
   *  windowed around the selected card (no file-view scroll surface in v1). */
  const FileViewCanvas = (viewProps: { es: EntryFileViewState }) => {
    const es = viewProps.es
    const compact = dims().width < 80
    const footerLines =
      (es.note !== null ? 1 : 0) + 1 /* wires line */ + (es.moreSymbols > 0 ? 1 : 0) + (es.wires.truncated > 0 ? 1 : 0)
    const body = Math.max(1, dims().height - HEADER_ROWS - COMMAND_ROWS - ASK_ROWS - footerLines)
    const selRef = es.cards[es.cursor]?.ref
    const byColumn = new Map<number, IdeCard[]>()
    for (const card of es.cards) {
      const list = byColumn.get(card.column) ?? []
      list.push({
        ref: card.ref,
        name: card.ref.slice(card.ref.lastIndexOf("#") + 1),
        category: categoryOf(es.file),
        kind: card.kind,
        file: es.file,
        startLine: 0,
        risk: card.marker === "!!!" ? "high" : card.marker !== "" ? "medium" : "low",
        fanIn: card.callers,
        fanOut: card.callees,
        ...(card.parentRef !== undefined ? { parentRef: card.parentRef } : {}),
      })
      byColumn.set(card.column, list)
    }
    const columns: IdeColumn[] = [...byColumn.keys()].sort((a, b) => a - b).map((column, i, all) => ({
      side: i === all.length - 1 ? "center" : "left",
      ring: i === all.length - 1 ? 0 : 2, // ring ≥ 2 ⇒ parentRef routing; never the ring-1 to-center rule
      cards: byColumn.get(column) ?? [],
    }))
    const canvas = ideLayout({ columns, ...(selRef !== undefined ? { selectedRef: selRef } : {}), compact })
    const rows = toSegments(canvas.cells, canvas.width)
    const selRect = selRef !== undefined ? canvas.cardRects.get(selRef) : undefined
    const anchor =
      canvas.height <= body
        ? 0
        : Math.max(0, Math.min((selRect?.y ?? 0) - 2, canvas.height - body))
    return (
      <box flexDirection="column" flexGrow={1} backgroundColor={IDE_THEME.background}>
        {...rows.slice(anchor, anchor + body).map((row) => (
          <SegmentRow row={row} onItemClick={clickEntry} />
        ))}
        {es.note !== null ? (
          <text width="100%" height={1} flexShrink={0} fg={IDE_THEME.textMuted}>
            {es.note}
          </text>
        ) : (
          []
        )}
        <text width="100%" height={1} flexShrink={0} fg={IDE_THEME.textMuted}>
          {`wires: ${es.wires.drawn} drawn · ${es.wires.undrawn} undrawn — enter a card to see all relations`}
        </text>
        {es.moreSymbols > 0 ? (
          <text width="100%" height={1} flexShrink={0} fg={IDE_THEME.textMuted}>
            {`… +${es.moreSymbols} more symbols`}
          </text>
        ) : (
          []
        )}
        {es.wires.truncated > 0 ? (
          <text width="100%" height={1} flexShrink={0} fg={IDE_THEME.textMuted}>
            {`… +${es.wires.truncated} wires truncated (of ${es.wires.total} total)`}
          </text>
        ) : (
          []
        )}
      </box>
    )
  }

  // Signals are read INSIDE JSX expressions so every branch re-renders (D2/D3); the
  // view choice is ONE opaque IIFE — the transform decomposes bare nested ternaries.
  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={IDE_THEME.background}>
      {(() => {
        if (paletteState().open) return <IdePaletteOverlay />
        const s = ideState()
        if (s.help !== undefined) return <IdeHelpOverlay sections={s.help} />
        // Task 5: the ops overlay is a full-screen overlay alongside help — it
        // swallows keys and screen while open (the route branch above)
        if (s.ops !== undefined) return <IdeOpsOverlay ops={s.ops} focusRef={s.focusRef} />
        // Task 4: an open chat rides the inspector-overlay path in the narrow
        // modes — it REPLACES the canvas (the model's `chat replaces canvas`
        // note family), never squeezes a <40-col viewport. In full/no-sidebar
        // it takes the right panel instead of the inspector.
        const chatOverlay =
          s.chat !== undefined && (s.mode === "no-panels" || s.mode === "compact" || s.mode === "list")
        // compact/no-panels inspector overlay ⇒ the inspector REPLACES the canvas
        // (the model's panelLayout doc ruling) instead of splitting a <40-col viewport
        const overlayInspector =
          !chatOverlay && s.inspector !== undefined && (s.mode === "no-panels" || s.mode === "compact")
        return (
          <>
            <HeaderView s={s} />
            <box flexDirection="row" flexGrow={1}>
              {s.sidebar !== undefined ? (
                <SidebarView sidebar={s.sidebar} />
              ) : (
                []
              )}
              {chatOverlay ? (
                <ChatView chat={s.chat!} overlay={true} />
              ) : overlayInspector ? (
                <InspectorView inspector={s.inspector!} overlay={true} />
              ) : s.entry !== undefined && s.entry.screen === "file-list" ? (
                <FileListView es={s.entry} />
              ) : s.entry !== undefined && s.entry.screen === "file-view" ? (
                <FileViewCanvas es={s.entry} />
              ) : s.screen === "miss" ? (
                <box flexDirection="column" flexGrow={1}>
                  {...(s.miss?.lines ?? []).map((line) => (
                    <text width="100%" height={1} flexShrink={0} fg={line.muted === true ? IDE_THEME.textMuted : undefined}>
                      {line.text === "" ? " " : line.text}
                    </text>
                  ))}
                </box>
              ) : (
                <box flexDirection="column" flexGrow={1} backgroundColor={IDE_THEME.background}>
                  {...(s.canvas?.rows ?? []).map((row) => <SegmentRow row={row} />)}
                </box>
              )}
              {!chatOverlay && !overlayInspector && s.chat !== undefined ? (
                <ChatView chat={s.chat} overlay={false} />
              ) : !chatOverlay && !overlayInspector && s.inspector !== undefined ? (
                <InspectorView inspector={s.inspector} overlay={false} />
              ) : (
                []
              )}
            </box>
            <AskBar s={s} />
            <CommandBar s={s} />
          </>
        )
      })()}
    </box>
  )
}

export default Plugin.define({
  id: "closegraph.tui",
  setup(context) {
    if (context.options.disable === true) {
      console.log("[closegraph] tui disabled via plugin options")
      return
    }
    const unregisterRoute = context.ui.router.register({
      name: "graph",
      render: () => <CodeGraphRoute />,
    })
    // codegraph-ide-screen plan Task 4: the IDE screen is an ADDITIVE sibling page —
    // the graph route above is untouched. An optional ref argument pre-selects the
    // center (`/closegraph src/a.ts#f`); a bare `/closegraph` opens the symbol picker.
    const unregisterIde = context.ui.router.register({
      name: "codegraph",
      render: (input) => <CodegraphIdeRoute initialRef={typeof input.data?.ref === "string" ? input.data.ref : undefined} />,
    })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "closegraph.open",
          title: "Open CodeGraph",
          group: "CodeGraph",
          palette: true,
          // no slash: /closegraph now opens the IDE (Task 1) — palette entry stays
          run: () => context.ui.router.navigate({ type: "plugin", name: "graph" }),
        },
        {
          id: "codegraph.open",
          title: "Open CodeGraph IDE",
          group: "CodeGraph",
          palette: true,
          slash: { name: "closegraph", arguments: true },
          run: (input) =>
            context.ui.router.navigate({ type: "plugin", name: "codegraph", data: input?.trim() ? { ref: input.trim() } : undefined }),
        },
      ],
    }))

    return () => {
      unregisterRoute()
      unregisterIde()
    }
  },
})
