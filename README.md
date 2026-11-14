# closegraph

**Your codebase as a graph — inside OpenCode. Both for you *and* your AI.**

An [OpenCode](https://opencode.ai) plugin that indexes a TypeScript repo into a
property graph: files, functions, classes, who calls who. Then it gives you a
**TUI map** to explore it and your **agent four tools** to query it.

Built for security review: find what a function touches, what breaks if you
change it, and where the risky spots are — without hallucinated answers.

---

## What you get

| Surface | What it does |
|---|---|
| `/closegraph` route (TUI) | Full-screen **file map** with risk shading → click/`Enter` drills into symbols → **detail panel** (callers, callees, signature, risk) |
| `p` in the TUI | **Jump palette** — fuzzy-ish prefix search, arrows to move, type to filter |
| Ask-agent | One keypress **injects a prompt about the node** into your session and jumps to chat |
| `closegraph_query` (tool) | Node facts + direct callers/callees for 1–10 symbols per call |
| `closegraph_blast_radius` (tool) | *What breaks if I change this?* — transitive callers, bounded output |
| `closegraph_subgraph` (tool) | Ego graph around 1–5 seeds, hard line cap so hubs can't flood context |
| `closegraph_report` (tool) | One-call overview: counts, resolution rate, top fan-in hubs, entry points |

Everything the graph says is **deterministic** — parsed with ts-morph's type
checker, not guessed by a model. Stale graph? It tells you.

## Install (local plugin)

```jsonc
// ~/.config/opencode/opencode.jsonc
{ "plugins": ["/absolute/path/to/closegraph"] }
```

Absolute path required. Then open any TS repo → `/closegraph`.

Steer your agent to the graph too: copy the instructions block from
[`AGENTS-CLOSEGRAPH.md`](./AGENTS-CLOSEGRAPH.md) into the repo's `AGENTS.md` —
it carries the tool table, the ref format, and the query-before-grep rule.

## Try it from chat

```
> what breaks if I change formatName?
(model calls closegraph_blast_radius → real callers, zero guessing)

> show me the subgraph around UserService
```

## CLI (no OpenCode needed)

```sh
bun run src/cli.ts <repo>                     # index + stats
bun run src/cli.ts <repo> --callers src/a.ts#fn
bun run src/cli.ts <repo> --snapshot out.json
bun run src/cli.ts <repo> --export graph.json # committable graph.json (per-edge provenance)
bun run src/cli.ts <repo> hook install        # post-commit hook refreshes the snapshot in the background
bun run src/cli.ts <repo> hook uninstall
```

## Numbers

- **81.2%** of intra-project call sites resolved on a real repo (excalidraw) — measured, not vibes
- **283/283** tests green · snapshot reuse + staleness detection · single-flight indexing

## Risk colors (v1 — structural, honest)

`!!!` high · `!` medium · unmarked low. Based on **entry-point reach** and
fan-in — explainable in one line, no ML. Real vulnerability *rules* (dangerous
sinks, `eval`, SQL concat, missing await…) are **Plan 4** — the schema already
has Finding nodes waiting.

## Status

- ✅ Plan 1 — graph engine + snapshot + CLI
- ✅ Plan 2 — agent tools
- ✅ Plan 3 — TUI graph view
- ✅ Plan 4 — agent experience (batch query, report tool, steering, export + hook)
- 🔜 Plan 5 — deterministic rules layer (Finding nodes + reachability)
- 🔮 Later — black-box attack-surface mode (endpoints/params as graph nodes)

MIT. Bun + pure-JS deps only (ts-morph, OpenTUI, solid-js).
