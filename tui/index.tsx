import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createSignal, onMount } from "solid-js"
import { createFileMapModel, RISK_SHADING, type FileMapState } from "../src/view/file-map-model.js"
import { createSymbolViewModel, type SymbolViewState } from "../src/view/symbol-view-model.js"
import { createDetailModel, type DetailState } from "../src/view/detail-model.js"
import { createPaletteModel, type PaletteState } from "../src/view/palette-model.js"
import type {
  FilesPayload,
  FileSymbolsPayload,
  NodeDetailPayload,
  PaletteSearchPayload,
  UnavailablePayload,
} from "../rpc/index.js"

/**
 * CodeGraph graph route (plan 3 Tasks 4+5). Thin by design: all logic lives in the pure
 * models (src/view/*-model.ts); this layer owns the view stack (file map ⇄ symbol list
 * ⇄ detail), the jump-to-symbol palette overlay, and the ask-agent execution adapter.
 *
 * Spike deltas applied (docs/superpowers/spikes/tui-render.md): D1 flexbox + no scrollbox
 * (models pre-window rows), D4 selection/risk shading via backgroundColor + text markers
 * only (never border* props), D5 fixed-height text rows, D6 enter matches "enter"|"return"
 * and escape matches "escape"|"esc".
 *
 * The host (opencode ≥2.2.x) applies the Solid transform to this file (Task 4 verified
 * in-host) — do NOT register ensureSolidTransformPlugin() here.
 */

/** One rpc bridge helper: thrown bridge errors become the typed unavailable payload. */
function unavailable(err: unknown): UnavailablePayload {
  return { error: "unavailable", message: err instanceof Error ? err.message : String(err) }
}

type Client = ReturnType<typeof usePlugin>["client"]

function filesViaRpc(client: Client): () => Promise<FilesPayload> {
  return async () => {
    try {
      const result = await client.rpc.call({ rpcID: "closegraph", method: "files", input: {} })
      return result.output as FilesPayload
    } catch (err) {
      return unavailable(err)
    }
  }
}

function fileSymbolsViaRpc(client: Client): (file: string) => Promise<FileSymbolsPayload> {
  return async (file: string) => {
    try {
      const result = await client.rpc.call({ rpcID: "closegraph", method: "fileSymbols", input: { file } })
      return result.output as FileSymbolsPayload
    } catch (err) {
      return unavailable(err)
    }
  }
}

function nodeDetailViaRpc(client: Client): (ref: string) => Promise<NodeDetailPayload> {
  return async (ref: string) => {
    try {
      const result = await client.rpc.call({ rpcID: "closegraph", method: "nodeDetail", input: { ref } })
      return result.output as NodeDetailPayload
    } catch (err) {
      return unavailable(err)
    }
  }
}

function paletteSearchViaRpc(client: Client): (prefix: string, limit: number) => Promise<PaletteSearchPayload> {
  return async (prefix: string, limit: number) => {
    try {
      const result = await client.rpc.call({ rpcID: "closegraph", method: "paletteSearch", input: { prefix, limit } })
      return result.output as PaletteSearchPayload
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
 *  (e.g. a future "!!") throws instead of silently rendering as low (review R2). */
function markerBucket(marker: string): keyof typeof RISK_SHADING {
  switch (marker) {
    case RISK_SHADING.high.marker: // "!!!"
      return "high"
    case RISK_SHADING.medium.marker: // "!"
      return "medium"
    case RISK_SHADING.low.marker: // ""
      return "low"
    default:
      throw new Error(`[closegraph] no risk bucket for marker ${JSON.stringify(marker)}`)
  }
}

/** True for a bare printable keystroke the palette filter should consume. */
function printable(key: { sequence?: string; ctrl: boolean; meta: boolean }): string | undefined {
  if (key.ctrl || key.meta) return undefined
  const seq = key.sequence ?? ""
  return seq.length === 1 && seq >= " " ? seq : undefined
}

type KeyHandler = (key: { name: string; sequence?: string; ctrl: boolean; meta: boolean; preventDefault: () => void }) => void

interface SymbolsScreen {
  kind: "symbols"
  fileRef: string
  model: ReturnType<typeof createSymbolViewModel>
  state: () => SymbolViewState
  setState: (s: SymbolViewState) => void
}

interface DetailScreen {
  kind: "detail"
  ref: string
  model: ReturnType<typeof createDetailModel>
  state: () => DetailState
  setState: (s: DetailState) => void
}

type Screen = SymbolsScreen | DetailScreen

/**
 * Ask-agent execution (plan decision 4: inject + navigate). API verified against BOTH
 * @opencode/plugin 2.2.5 (the running host) and 2.2.7 (pinned types):
 * `client.session.prompt({ sessionID, text })` + `router.navigate({ type: "session", sessionID })`.
 * Neither version exposes a plugin-reachable clipboard API, so the degrade path is
 * dialog + toast (delta recorded in docs/superpowers/spikes/tui-render.md).
 */
async function runAskAgent(context: ReturnType<typeof usePlugin>, prompt: string): Promise<void> {
  const route = context.ui.router.current()
  let sessionID = route.type === "session" ? route.sessionID : undefined
  if (sessionID === undefined) {
    // on the plugin route: the most recently updated root session is "the chat I came from"
    const roots = context.data.session.list().filter((s) => s.parentID === undefined)
    const latest = roots.sort((a, b) => b.time.updated - a.time.updated).at(0)
    sessionID = latest?.id
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
  context.ui.toast.show({ message: "ask-agent: no session available — prompt shown in dialog", variant: "warning" })
}

function CodeGraphRoute() {
  const context = usePlugin()
  const fileMap = createFileMapModel({ files: filesViaRpc(context.client) })
  const palette = createPaletteModel({ search: paletteSearchViaRpc(context.client) })
  const [mapState, setMapState] = createSignal<FileMapState>(fileMap.state())
  const [paletteState, setPaletteState] = createSignal<PaletteState>(palette.state())
  const [screens, setScreens] = createSignal<Screen[]>([])
  const dims = useTerminalDimensions()

  const syncMap = () => setMapState(fileMap.state())
  const syncPalette = () => setPaletteState(palette.state())
  const syncScreen = (screen: Screen) => {
    if (screen.kind === "symbols") screen.setState(screen.model.state())
    else screen.setState(screen.model.state())
  }
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
      if (screen.kind === "symbols") screen.model.resize(next)
      syncScreen(screen)
    }
  })

  function pushSymbols(fileRef: string): void {
    const model = createSymbolViewModel({ fileRef, fileSymbols: fileSymbolsViaRpc(context.client) })
    const [state, setState] = createSignal<SymbolViewState>(model.state())
    setScreens([...screens(), { kind: "symbols", fileRef, model, state, setState }])
    void model.load().then(() => setState(model.state()))
  }

  function pushDetail(ref: string): void {
    const model = createDetailModel({ ref, nodeDetail: nodeDetailViaRpc(context.client) })
    const [state, setState] = createSignal<DetailState>(model.state())
    setScreens([...screens(), { kind: "detail", ref, model, state, setState }])
    void model.load().then(() => setState(model.state()))
  }

  const pop = () => setScreens(screens().slice(0, -1))

  function openPalette(): void {
    void palette.open().then(syncPalette, syncPalette)
  }

  // One route-global keyboard handler with EXPLICIT precedence (review caution from
  // Task 4): palette (when open) → top screen → file map. Consumed keys preventDefault
  // so the host keymap does not double-act on them.
  useKeyboard((key) => {
    if (palette.state().open) {
      switch (key.name) {
        case "up":
        case "k":
          key.preventDefault()
          palette.move(-1)
          syncPalette()
          break
        case "down":
        case "j":
          key.preventDefault()
          palette.move(1)
          syncPalette()
          break
        case "enter":
        case "return": {
          key.preventDefault()
          const picked = palette.select()
          syncPalette()
          if (picked !== undefined) pushDetail(picked)
          break
        }
        case "escape":
        case "esc":
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
      switch (key.name) {
        case "up":
        case "k":
          key.preventDefault()
          fileMap.move(-1)
          syncMap()
          break
        case "down":
        case "j":
          key.preventDefault()
          fileMap.move(1)
          syncMap()
          break
        case "enter":
        case "return": {
          key.preventDefault()
          const fileRef = fileMap.openFile()
          if (fileRef !== undefined) pushSymbols(fileRef)
          break
        }
        case "r":
          key.preventDefault()
          void fileMap.refresh().then(syncMap, syncMap)
          break
        case "p":
          key.preventDefault()
          openPalette()
          break
        default:
          break
      }
      return
    }

    if (screen.kind === "symbols") {
      switch (key.name) {
        case "up":
        case "k":
          key.preventDefault()
          screen.model.move(-1)
          syncScreen(screen)
          break
        case "down":
        case "j":
          key.preventDefault()
          screen.model.move(1)
          syncScreen(screen)
          break
        case "enter":
        case "return": {
          key.preventDefault()
          const ref = screen.model.openSymbol()
          if (ref !== undefined) pushDetail(ref)
          break
        }
        case "escape":
        case "esc":
          key.preventDefault()
          pop()
          break
        case "r":
          key.preventDefault()
          void screen.model.refresh().then(() => syncScreen(screen))
          break
        case "p":
          key.preventDefault()
          openPalette()
          break
        default:
          break
      }
      return
    }

    // detail panel: [a] ask agent · [b] blast radius (TODO rules plan) · esc back
    switch (key.name) {
      case "a":
        key.preventDefault()
        void runAskAgent(context, screen.model.askAgent())
        break
      case "b":
        key.preventDefault()
        // TODO(Plan 4): blast-radius view over transitive callers — the nodeDetail rpc
        // payload carries direct lists only, so the traversal needs its own method first.
        console.log(`[closegraph] blast radius for ${screen.model.blastRadius()} — view lands with the rules plan (Plan 4)`)
        break
      case "escape":
      case "esc":
        key.preventDefault()
        pop()
        break
      case "r":
        key.preventDefault()
        void screen.model.refresh().then(() => syncScreen(screen))
        break
      case "p":
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
        {"↑/↓ or j/k move · enter open · r refresh · p jump to symbol"}
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
        {"↑/↓ or j/k move · enter open · esc back · r refresh · p jump to symbol"}
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
    </box>
  )

  const PaletteOverlay = () => (
    <box flexDirection="column" width="100%" height="100%" paddingLeft={1} paddingRight={1}>
      <text width="100%" height={1} flexShrink={0} fg="cyan">
        {`jump to symbol: ${paletteState().filter}`}
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
        {"type to filter · ↑/↓ or j/k move · enter jump · esc close"}
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
        return s.kind === "symbols" ? <SymbolsView screen={s} /> : <DetailView screen={s} />
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
