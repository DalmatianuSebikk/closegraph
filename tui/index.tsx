import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createSignal, onMount } from "solid-js"
import { createFileMapModel, RISK_SHADING, type FileMapState } from "../src/view/file-map-model.js"
import { createSymbolViewModel, SYMBOL_VIEW_KEYMAP, type SymbolViewState } from "../src/view/symbol-view-model.js"
import { createDetailModel, DETAIL_KEYMAP, type DetailState } from "../src/view/detail-model.js"
import { createEgoModel, EGO_KEYMAP, type EgoState } from "../src/view/ego-model.js"
import { createPaletteModel, PALETTE_KEYMAP, type PaletteState } from "../src/view/palette-model.js"
import type {
  FilesPayload,
  FileSymbolsPayload,
  NodeDetailPayload,
  PaletteSearchPayload,
  EgoGraphPayload,
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

const BANNER_FG: Record<"none" | "unknown-freshness" | "unavailable", string | undefined> = {
  none: undefined,
  "unknown-freshness": "yellow",
  unavailable: "red",
}

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
    const model = createEgoModel({ ref, egoGraph: egoGraphViaRpc(context.client, sessionRoot) })
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
  // Task 4): palette (when open) → top screen → file map. Every branch dispatches
  // through actionFor() over the KEYMAP constants above/beside the models — the
  // constants ARE the dispatch, so they cannot drift (review minor b). Consumed
  // keys preventDefault so the host keymap does not double-act on them.
  useKeyboard((key) => {
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

  const bannerLine = (banner: { kind: "none" | "unknown-freshness" | "unavailable"; text: string }) => (
    <text width="100%" height={1} flexShrink={0} fg={BANNER_FG[banner.kind]}>
      {banner.kind === "none" ? " " : banner.text}
    </text>
  )

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
        if (s.kind === "ego") return <EgoView screen={s} />
        return <DetailView screen={s} />
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
      ],
    }))

    return () => {
      unregisterRoute()
    }
  },
})
