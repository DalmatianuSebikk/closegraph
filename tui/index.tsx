import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createSignal, onMount } from "solid-js"
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
  type IdeState,
} from "../src/view/ide-model.js"
import { IDE_THEME } from "../src/view/ide-theme.js"
import { toSegments, type IdeSegment } from "../src/view/ide-layout.js"
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
    })

  const [model, setModel] = createSignal(makeModel(props.initialRef ?? ""))
  const [ideState, setIdeState] = createSignal<IdeState>(model().state())
  const sync = () => setIdeState(model().state())
  const syncPalette = () => setPaletteState(palette.state())

  onMount(() => {
    const d = dims()
    model().resize({ width: d.width, height: d.height })
    loadIde(model())
  })

  // terminal resize re-windows the model without refetches (Review Focus 2 pattern)
  createEffect(() => {
    const d = dims()
    model().resize({ width: d.width, height: d.height })
    sync()
  })

  /** Palette pick / inspector caller-callee click: re-center on ANY graph ref. The
   *  Task-3 model exports no recenter() and selectByRef only hits drawn cards, so a
   *  fresh model over the picked ref is the route-level re-center path (center
   *  history resets — the same shape as opening the route with a ref argument). */
  function recenterIde(ref: string): void {
    const next = makeModel(ref)
    const d = dims()
    next.resize({ width: d.width, height: d.height })
    setModel(() => next)
    sync()
    loadIde(next)
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

  /** Model-contract detail settle (the ide-model.ts header ruling): detailDirty()
   *  → loadDetail() — which DEDUPES onto the fetch apply() already started — then
   *  a repaint when it lands. Deterministic (no timer guess), so a load path that
   *  arms this can never rest on the inspector's "loading…" line. */
  const settleDetail = (m: ReturnType<typeof createIdeModel>) => {
    if (m.detailDirty()) void m.loadDetail().then(sync, sync)
  }

  /** Load path (onMount + recenterIde): load() resolving means apply() ran, but
   *  the nodeDetail fetch it fired is still in flight — sync() alone paints the
   *  inspector's "loading…" line and RESTS on it (at rest no keystroke follows,
   *  and unbound keys hit `case undefined` and don't sync either — review
   *  Important 1). Repaint, then arm the deterministic settle. */
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

    // IDE model dispatch: IDE_KEYMAP IS the dispatch table (actionFor parity)
    const action = actionFor(IDE_KEYMAP, key)
    switch (action) {
      case undefined:
        break
      case "back":
        key.preventDefault()
        // esc quits the SCREEN (the model's back action is a deliberate no-op):
        // newest root session in this project, else the home route
        context.ui.router.navigate(quitDestination(context.data.session.list(), context.location?.directory))
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
        settleIde() // re-centers/selection changes load async — repaint when they land
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

  /** One canvas/minimap row: width-pinned height-1 segments (E7 verbatim; E3: the
   *  layout pads/truncates so a segment's text length IS its width). Mouse handlers
   *  only on segments carrying a ref. */
  const SegmentRow = (rowProps: { row: IdeSegment[] }) => (
    <box flexDirection="row" height={1} flexShrink={0}>
      {...rowProps.row.map((seg) => (
        <text
          width={seg.text.length}
          height={1}
          fg={seg.fg}
          bg={seg.bg}
          attributes={segmentAttributes(seg)}
          onMouseDown={seg.ref !== undefined ? () => clickSegment(seg.ref!) : undefined}
        >
          {seg.text}
        </text>
      ))}
    </box>
  )

  /** D4: panel separators are CHARACTER columns (│), never border* props. Each
   *  costs SEPARATOR_W — the model's vw budgets it (Task-6 render delta). */
  const Separator = () => (
    <box flexDirection="column" width={SEPARATOR_W} flexShrink={0}>
      {...Array.from({ length: Math.max(1, dims().height - HEADER_ROWS - COMMAND_ROWS) }, () => (
        <text width={1} height={1} flexShrink={0} fg={IDE_THEME.borderSubtle}>
          │
        </text>
      ))}
    </box>
  )

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

  const IdeHelpOverlay = (helpProps: { lines: string[] }) => (
    <box flexDirection="column" width="100%" height="100%" paddingLeft={1} paddingRight={1}>
      <text width="100%" height={1} flexShrink={0} fg="cyan">
        {helpProps.lines[0] ?? "help"}
      </text>
      <box flexDirection="column" paddingTop={0} flexGrow={1}>
        {...helpProps.lines.slice(1).map((line) => (
          <text width="100%" height={1} flexShrink={0}>
            {line === "" ? " " : line}
          </text>
        ))}
      </box>
      <text width="100%" height={1} flexShrink={0} fg="gray">
        {"? or esc close"}
      </text>
    </box>
  )

  const HeaderView = (headerProps: { s: IdeState }) => (
    <box flexDirection="column" height={HEADER_ROWS} flexShrink={0} backgroundColor={IDE_THEME.panel}>
      <box flexDirection="row" height={1} flexShrink={0}>
        <text height={1} attributes={TextAttributes.BOLD} fg={IDE_THEME.cyan}>
          {` ${headerProps.s.header.breadcrumb}`}
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
    <box flexDirection="column" width={SIDEBAR_W} flexShrink={0} backgroundColor={IDE_THEME.panel}>
      {/* lines + minimap share the body height: the minimap keeps its rows and the
          lines take the rest (D1 model windowing — no scrollbox) */}
      {(() => {
        const minimapRows = toSegments(sideProps.sidebar.minimap, sideProps.sidebar.minimap[0]?.length ?? 0)
        const budget = Math.max(0, Math.max(1, dims().height - HEADER_ROWS - COMMAND_ROWS) - minimapRows.length)
        return [
          ...sideProps.sidebar.lines.slice(0, budget).map((line) => (
            <text width="100%" height={1} flexShrink={0} fg={line.fg}>
              {line.text === "" ? " " : line.text}
            </text>
          )),
          ...minimapRows.map((row) => <SegmentRow row={row} />),
        ]
      })()}
    </box>
  )

  const InspectorView = (inspProps: { inspector: NonNullable<IdeState["inspector"]>; overlay: boolean }) => (
    <box
      flexDirection="column"
      width={inspProps.overlay ? undefined : INSPECTOR_W}
      flexGrow={inspProps.overlay ? 1 : undefined}
      flexShrink={0}
      backgroundColor={IDE_THEME.panel}
    >
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
    </box>
  )

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
        {" h/l columns · j/k move · enter recenter · space collapse · / search · ? help · esc back"}
      </text>
    </box>
  )

  // Signals are read INSIDE JSX expressions so every branch re-renders (D2/D3); the
  // view choice is ONE opaque IIFE — the transform decomposes bare nested ternaries.
  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={IDE_THEME.background}>
      {(() => {
        if (paletteState().open) return <IdePaletteOverlay />
        const s = ideState()
        if (s.help !== undefined) return <IdeHelpOverlay lines={s.help} />
        // compact/no-panels inspector overlay ⇒ the inspector REPLACES the canvas
        // (the model's panelLayout doc ruling) instead of splitting a <40-col viewport
        const overlayInspector = s.inspector !== undefined && (s.mode === "no-panels" || s.mode === "compact")
        return (
          <>
            <HeaderView s={s} />
            <box flexDirection="row" flexGrow={1}>
              {s.sidebar !== undefined ? (
                <>
                  <SidebarView sidebar={s.sidebar} />
                  <Separator />
                </>
              ) : (
                []
              )}
              {overlayInspector ? (
                <InspectorView inspector={s.inspector!} overlay={true} />
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
              {!overlayInspector && s.inspector !== undefined ? (
                <>
                  <Separator />
                  <InspectorView inspector={s.inspector} overlay={false} />
                </>
              ) : (
                []
              )}
            </box>
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
    // center (`/codegraph src/a.ts#f`).
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
          slash: { name: "closegraph" },
          run: () => context.ui.router.navigate({ type: "plugin", name: "graph" }),
        },
        {
          id: "codegraph.open",
          title: "Open CodeGraph IDE",
          group: "CodeGraph",
          palette: true,
          slash: { name: "codegraph", arguments: true },
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
