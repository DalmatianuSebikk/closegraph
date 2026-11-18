# AGENTS-CLOSEGRAPH.md — steering for coding agents

When the closegraph plugin is installed in an OpenCode session, the `closegraph_*`
tools answer structural questions deterministically (parsed with ts-morph's type
checker, not guessed). Copy the block below into the repo's `AGENTS.md` so agents
prefer the graph over grep and whole-file reads.

---

## closegraph plugin — query the code graph before grepping or reading files

This repo's OpenCode session has the `closegraph_*` tools over a code graph
(files, functions, classes, call edges). Use them instead of grep or reading
whole files to understand structure or impact.

| Tool | Use it for |
|---|---|
| `closegraph_report` | Orientation: file/function/class/edge counts, call-resolution rate, top fan-in hubs with risk buckets, entry points. Call it first in a fresh session. |
| `closegraph_query` | Facts for 1–10 symbols per call: kind, file, signature, exported flag, direct callers and callees. Batch the refs you care about. |
| `closegraph_blast_radius` | Impact: everything that can break when a symbol changes — transitive callers (`direction callers`, default), depth-bounded callees (`callees`), or both. |
| `closegraph_subgraph` | The bounded ego graph around 1–5 seeds: nodes grouped by file, edge list, `depth` and `limit` caps. |
| `closegraph_surface_ingest` | Black-box surface: store RAW observations (method, url, params, status, cookies) for one target — exactly as observed, tagged with source. Claims (functionalities, wiring) cite observation ids from this call or stored ones. |
| `closegraph_surface_query` | One surface node by ref: functionality `page-url :: name`, page url, endpoint `METHOD /path`, or bare path (disambiguates). Facts: provenance, params, cookies, auth evidence, calling functionalities. |
| `closegraph_surface_report` | Surface orientation: every target with counts, or one target's scope, freshness, method mix, auth-gated endpoints, out-of-scope discoveries, unmapped endpoints. |

**Ref format:** `src/lib/util.ts#formatName` (qualifiedName). Bare symbol names
(`formatName`, `Calculator.add`) and file paths (`src/lib/util.ts`) also resolve —
in that order. Any ref-taking tool accepts any of the three; `closegraph_report`
takes no input at all.

**Query before grep:** before grepping, tracing call sites, or opening a file to
understand who calls what, call the matching `closegraph_*` tool. Fall back to
grep only when the graph says `not found` or a result needs line-level context
the graph does not carry.

**Freshness:** the graph is built once per project and reused across calls. If an
output carries a freshness note (`graph freshness unknown (no git HEAD)`), numbers
may lag recent edits — re-verify critical facts by reading the named file. Long
lists are capped on purpose (`… +N more`): narrow the query, or raise `limit`
(max 200) on `closegraph_blast_radius` / `closegraph_subgraph`.

## Black-box surface workflow (web targets)

The `closegraph_surface_*` tools map a running target's attack surface from raw
observations — no fetching by the plugin, the agent collects. Four steps:

1. **Collect** — puppeteer: open the scope URLs, click through the target's
   functionalities (login, add-to-cart, settings…), note every XHR/fetch it
   fires. Or burp: `get_proxy_http_history` / `get_proxy_websocket_history` /
   `get_organizer_items`. Record method, full url, params (with location),
   response status, Set-Cookie names, and the page url you were on for
   document-driven requests.
2. **Ingest** — `closegraph_surface_ingest` with the RAW observations, each
   tagged `source` (`puppeteer`, `burp-proxy`, `openapi`…). Then attach
   semantics as claims: functionalities (`name`, `pageUrl`, `description`,
   `evidence` citing the observation ids just ingested) and wiring
   (`from`/`to` functionality names). `scope` (url-prefix rules) REPLACES the
   target's scope and is echoed back — set it from the user's words only.
3. **Orient** — `closegraph_surface_report` (no target lists all targets; with
   target: scope, freshness, method mix, auth-gated endpoints, out-of-scope
   discoveries, unmapped endpoints). Drill with `closegraph_surface_query`.
4. **Verify** — burp `send_http1_request` / `send_http2_request` to confirm a
   hypothesis about an endpoint; hand interesting requests to the user via
   `create_repeater_tab` / `send_to_intruder`. Scope is the user's — never
   widen it silently; out-of-scope discoveries stay flagged, not merged.

Observations are the ground truth: record what you saw, not what you assume.
Ids are stable across sessions (stored, deduped by signature) — later claims
may cite earlier evidence.

## CLI: export a committable graph.json + post-commit freshness

The repo-root CLI works without OpenCode:

```sh
bun run src/cli.ts <repo> --export graph.json   # snapshot JSON, every edge tagged
                                               # provenance: resolved|unresolved|external
bun run src/cli.ts <repo> hook install          # post-commit hook re-indexes and refreshes
bun run src/cli.ts <repo> hook uninstall        # removes only closegraph's own hook
```

`graph.json` uses the same snapshot format the plugin restores, so it round-trips
through the CLI: `bun run src/cli.ts <repo> --snapshot graph.json` reuses it
instead of re-indexing. A stale graph.json is re-indexed and rewritten in place —
expect and commit the diff, or keep graph.json uncommitted. The CLI is
graph.json's consumer — the plugin's own tools read their cached snapshot from
plugin storage, never from repo files. `hook install` refuses to overwrite an
existing post-commit hook; when the target repo does not already ignore
`closegraph.snapshot.json`, install adds it to `.git/info/exclude` itself (local
only — the worktree stays clean) and says so, warning instead when that is not
possible. The hook refreshes the snapshot in the background right after every
commit (the first index of a large repo takes seconds — it never blocks the
commit itself), keeping staleness detectable on the next CLI run.

