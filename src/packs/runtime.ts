/**
 * tree-sitter WASM runtime — shared by every language pack, written once.
 *
 * Encodes the Wave-1 spike recipe (docs/superpowers/spikes/wave1-grammar-spike.md)
 * for web-tree-sitter under Bun:
 *   1. one bare `Parser.init()` up front (Language.load before init() throws);
 *   2. `Language` is a NAMED export (`Parser.Language` is undefined);
 *   3. grammar wasm bytes go in as Uint8Array — a raw ArrayBuffer is misread as
 *      a path (ERR_INVALID_ARG_VALUE);
 *   4. `parse()` never throws on broken input; `hasError`/`isError`/`isMissing`
 *      are getters.
 *
 * Runtime pin: web-tree-sitter@0.25.10 — the OpenTUI-compatible version
 * (0.27.2 breaks @opentui/core's syntax highlighting: OpenTUI resolves the
 * runtime wasm via the `web-tree-sitter/tree-sitter.wasm` subpath, which 0.27.2
 * no longer exports). 0.25.10 still requires the dylink.0 grammar format, so
 * the vendor/grammars/ wasms built with tree-sitter CLI 0.27.2 load unchanged.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Parser, Language } from "web-tree-sitter";
import type { Node as SyntaxNode } from "web-tree-sitter";

/** Raised when a grammar is unavailable (missing wasm or failed load/probe) — the
 *  pipeline catches it and skips that pack with a logged note, never a crashed index. */
export class GrammarMissingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GrammarMissingError";
  }
}

export type ParseFn = (source: string) => SyntaxNode;

/** Wasms live uncommitted in gitignored vendor/grammars/ (spike decision; CI-build
 *  vs vendored-with-provenance is decided when the packs land). */
const GRAMMAR_DIR = join(dirname(import.meta.path), "..", "..", "vendor", "grammars");

/** Absolute path of a grammar's wasm: vendor/grammars/tree-sitter-<grammarName>.wasm. */
export function grammarWasmPath(grammarName: string): string {
  return join(GRAMMAR_DIR, `tree-sitter-${grammarName}.wasm`);
}

const parserCache = new Map<string, ParseFn>();
const inflight = new Map<string, Promise<ParseFn>>();
let runtimeInit: Promise<void> | undefined;

function ensureRuntime(): Promise<void> {
  if (runtimeInit === undefined) {
    // a failed init must not poison later attempts (e.g. a transient FS hiccup)
    runtimeInit = Parser.init().catch((error: unknown) => {
      runtimeInit = undefined;
      throw error;
    });
  }
  return runtimeInit;
}

/**
 * Loads (once per grammar, then cached) a parse function for that grammar.
 * Lazy by construction: nothing loads until a repo actually contains the
 * pack's files (wave-2 research rec — C++'s 5.3 MB never loads for a Go repo).
 * Each load runs a trivial startup probe (wave-2 research rec: the incompatible
 * -wasm failure mode is an opaque empty Error; probing here turns it into a
 * clean GrammarMissingError at the pack boundary instead of a mid-index crash).
 */
export async function loadParser(grammarName: string): Promise<ParseFn> {
  const cached = parserCache.get(grammarName);
  if (cached !== undefined) return cached;

  let pending = inflight.get(grammarName);
  if (pending !== undefined) return pending;

  pending = (async (): Promise<ParseFn> => {
    const wasmPath = grammarWasmPath(grammarName);
    if (!existsSync(wasmPath)) {
      throw new GrammarMissingError(
        `grammar "${grammarName}" is not available: ${wasmPath} does not exist — build it per docs/superpowers/spikes/wave1-grammar-spike.md`,
      );
    }
    await ensureRuntime(); // Language.load BEFORE init() throws "C.loadWebAssemblyModule is undefined"
    let language: Language;
    try {
      language = await Language.load(new Uint8Array(await Bun.file(wasmPath).arrayBuffer()));
    } catch (cause) {
      throw new GrammarMissingError(`grammar "${grammarName}" failed to load from ${wasmPath}`, { cause });
    }
    const parser = new Parser();
    parser.setLanguage(language);
    const parse: ParseFn = (source: string) => parser.parse(source)!.rootNode;
    try {
      parse("\n\n\n"); // startup probe: parse never throws on broken input, only on a broken wasm
    } catch (cause) {
      throw new GrammarMissingError(`grammar "${grammarName}" loaded but failed its startup probe`, { cause });
    }
    parserCache.set(grammarName, parse);
    return parse;
  })();

  inflight.set(grammarName, pending);
  try {
    return await pending;
  } finally {
    inflight.delete(grammarName);
  }
}
