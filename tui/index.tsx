import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createSignal, onMount } from "solid-js"
import { createFileMapModel, RISK_SHADING, type FileMapState } from "../src/view/file-map-model.js"
import type { FilesPayload } from "../rpc/index.js"

/**
 * CodeGraph file map route (plan 3 Task 4) — the opening view. Thin by design: all logic
 * lives in the pure model (src/view/file-map-model.ts); this layer only subscribes state,
 * renders rows with the spike-verified primitives, and wires keys/mouse to model calls.
 *
 * Spike deltas applied (docs/superpowers/spikes/tui-render.md): D1 flexbox + no scrollbox
 * needed (rows are pre-windowed by the model), D4 selection/risk shading via backgroundColor
 * + text markers only (never border* props on unselected rows), D5 fixed-height text rows,
 * D6 enter matches "enter"|"return".
 *
 * The host (opencode ≥2.2.x) registers @opentui/solid's bun-plugin transform and rewrites
 * solid-js/@opencode/plugin imports to its own runtime modules before loading this file —
 * do NOT register ensureSolidTransformPlugin() here (D2/D3 verified in-host; see Task 4 report).
 */

/** Adapter: the plugin rpc bridge → the model's files() source. */
function filesViaRpc(client: ReturnType<typeof usePlugin>["client"]): () => Promise<FilesPayload> {
  return async () => {
    try {
      const result = await client.rpc.call({ rpcID: "closegraph", method: "files", input: {} })
      return result.output as FilesPayload
    } catch (err) {
      return { error: "unavailable", message: err instanceof Error ? err.message : String(err) }
    }
  }
}

const BANNER_FG: Record<FileMapState["banner"]["kind"], string | undefined> = {
  none: undefined,
  "unknown-freshness": "yellow",
  unavailable: "red",
}

function CodeGraphRoute() {
  const context = usePlugin()
  const model = createFileMapModel({ files: filesViaRpc(context.client) })
  const [state, setState] = createSignal<FileMapState>(model.state())
  const dims = useTerminalDimensions()

  const sync = () => setState(model.state())

  onMount(() => {
    void model.load().then(sync, sync)
  })

  // terminal resize re-layouts without a refetch (Review Focus 2)
  createEffect(() => {
    const d = dims()
    model.resize({ width: d.width, height: d.height })
    sync()
  })

  // keyboard (mouse-free parity, Review Focus 5): arrows/j/k move, enter opens, r refreshes.
  // D6: enter arrives as "enter" (also accept "return"). Consumed keys preventDefault so the
  // host keymap does not double-act on them.
  useKeyboard((key) => {
    switch (key.name) {
      case "up":
      case "k":
        key.preventDefault()
        model.move(-1)
        sync()
        break
      case "down":
      case "j":
        key.preventDefault()
        model.move(1)
        sync()
        break
      case "enter":
      case "return":
        key.preventDefault()
        // TODO(Task 5): push the symbol view for the opened file (view stack in tui/index.tsx).
        console.log(`[closegraph] open file: ${model.openFile() ?? "(none)"}`)
        break
      case "r":
        key.preventDefault()
        void model.refresh().then(sync, sync)
        break
      default:
        break
    }
  })

  // click selects (row hit-test): clicking visible row k moves the cursor by k - selectedRow
  const selectRow = (index: number) => {
    const s = model.state()
    const selectedAt = s.rows.findIndex((r) => r.selected)
    if (selectedAt >= 0 && index !== selectedAt) {
      model.move(index - selectedAt)
      sync()
    }
  }

  return (
    <box flexDirection="column" width="100%" height="100%" paddingTop={0} paddingLeft={1} paddingRight={1}>
      <text width="100%" height={1} flexShrink={0} fg="cyan">
        {state().title}
      </text>
      <text width="100%" height={1} flexShrink={0} fg={BANNER_FG[state().banner.kind]}>
        {state().banner.kind === "none" ? " " : state().banner.text}
      </text>
      <box flexDirection="column" paddingTop={0} flexGrow={1}>
        {...state().rows.map((row, i) => (
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
        {"↑/↓ or j/k move · enter open · r refresh"}
      </text>
    </box>
  )
}

/** marker string → bucket (inverse of RISK_SHADING for render-time bg lookup). */
function markerBucket(marker: string): keyof typeof RISK_SHADING {
  if (marker === "!!!") return "high"
  if (marker === "!") return "medium"
  return "low"
}

export default Plugin.define({
  id: "closegraph.tui",
  setup(context) {
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
