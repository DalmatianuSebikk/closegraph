# Grammar wasm provenance

Committed binaries loaded by `src/packs/runtime.ts` (`grammarWasmPath`:
`vendor/grammars/tree-sitter-<grammarName>.wasm`). Committing them keeps the
pack runtime working from a fresh clone; everything else under `vendor/`
stays gitignored. All grammars are **MIT** licensed (verified per
`docs/superpowers/spikes/wave1-grammar-spike.md` §Licenses and the
tree-sitter-go LICENSE file at the pinned commit).

| File | Source repo | Pinned commit | License |
|---|---|---|---|
| `tree-sitter-python.wasm` | https://github.com/tree-sitter/tree-sitter-python | `26855eabccb19c6abf499fbc5b8dc7cc9ab8bc64` (master) | MIT |
| `tree-sitter-php_only.wasm` | https://github.com/tree-sitter/tree-sitter-php | `58d5643086ae60e93a3746cca648363ee97c8761` (v0.25.1) | MIT |
| `tree-sitter-bash.wasm` | https://github.com/tree-sitter/tree-sitter-bash | `a06c2e4415e9bc0346c6b86d401879ffb44058f7` (v0.25.1) | MIT |
| `tree-sitter-go.wasm` | https://github.com/tree-sitter/tree-sitter-go | `2346a3ab1bb3857b48b29d779a1ef9799a248cd7` | MIT |

`tree-sitter-php_only.wasm` is the pure-PHP (`php_only`) dialect of
tree-sitter-php — the mono-repo grammar without the HTML wrapper (spike
recommendation).

## Rebuild

Built with tree-sitter CLI 0.27.2 + emscripten (`tree-sitter build --wasm`)
on macOS/arm64. The runtime pin `web-tree-sitter@0.25.10` requires the
dylink.0 grammar format that CLI 0.27.2 emits (see the runtime header note
before changing either side). To rebuild from a clone of the repo above at
the pinned commit:

```sh
git clone <repo> && cd <repo> && git checkout <pinned-commit>
tree-sitter build --wasm   # emits the wasm next to the clone
```
