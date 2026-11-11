import { Plugin, usePlugin } from "@opencode/plugin/tui"

function CodeGraphRoute() {
  const context = usePlugin()
  return <text fg={context.theme.text.base}>CodeGraph</text>
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
