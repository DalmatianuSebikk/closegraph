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
| `/closegraph` (IDE screen) | Pixel-styled code-graph IDE: function cards wired **callers ← focus → callees** (depth 2, caps always disclosed), sidebar with category filters + minimap, inspector (facts, call relations, risk, sinks), 5-key command bar. Bare `/closegraph` opens the file list — files by risk → their functions as wired cards → focus view |
| In the IDE screen | `←` / `u` walks focus history · `?` legend + how-it-works · `[6]`/`e` **explain this function** (agent-written, labeled as generated, cached) · `t` **chat sidebar** — ask your agent with the focused card attached; `focus <ref>` recenters · `o` **operations menu** — refactor / tests / docs / harden (risk-gated), sent through chat |
| Classic graph screen | File map with risk shading → symbols → detail → ego graph — still there via the command palette ("Open CodeGraph") |
| `p` in the TUI | **Jump palette** — fuzzy-ish prefix search, arrows to move, type to filter |
| Ask-agent | One keypress **injects a prompt about the node** into your session and jumps to chat |
| `closegraph_query` (tool) | Node facts + direct callers/callees for 1–10 symbols per call |
| `closegraph_blast_radius` (tool) | *What breaks if I change this?* — transitive callers, bounded output |
| `closegraph_subgraph` (tool) | Ego graph around 1–5 seeds, hard line cap so hubs can't flood context |
| `closegraph_report` (tool) | One-call overview: counts, resolution rate, top fan-in hubs, entry points |
| `closegraph_surface_*` (tools) | **Black-box attack surface**: ingest RAW observations (puppeteer/burp) → pages, functionalities, endpoints, params, cookies, auth evidence — query + report over them, scope-aware |

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
- **745** tests green · five languages indexed — TypeScript unchanged, plus Python/PHP/bash/Go packs (Go: per-pack resolver hook, 77.9% call resolution measured on testify) · snapshot reuse + staleness detection · single-flight indexing

## Risk colors (v1 — structural, honest)

`!!!` high · `!` medium · unmarked low. Based on **entry-point reach** and
fan-in — explainable in one line, no ML. Real vulnerability *rules* (dangerous
sinks, `eval`, SQL concat, missing await…) are **Plan 6** — the schema already
has Finding nodes waiting.

## Status

- ✅ Plan 1 — graph engine + snapshot + CLI
- ✅ Plan 2 — agent tools
- ✅ Plan 3 — TUI graph view
- ✅ Plan 4 — agent experience (batch query, report tool, steering, export + hook)
- ✅ Plan 5 — language packs (Python, PHP, bash shipped)
- ✅ Wave 2 — Go pack (per-pack resolver hook: package scope, go.mod module map, external classification); C++/Rust next
- ✅ CodeGraph IDE screen — pixel-accurate graph IDE (cards, edges, inspector, honesty rules) + agent round: explain, chat sidebar, operations menu
- ✅ File-first IDE entry — bare `/closegraph` opens the file list: files by risk → wired symbol cards → focus view
- ✅ Black-box surface (Round A) — observation ingest + surface query/report tools; Round B TUI view next
- 🔜 Plan 6 — deterministic rules layer (Finding nodes + reachability)

MIT. Bun + pure-JS deps only (ts-morph, OpenTUI, solid-js).
