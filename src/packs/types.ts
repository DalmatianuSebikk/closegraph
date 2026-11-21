/**
 * Language-pack contract — THE Wave-2 lock.
 *
 * Wave 2 (Go/C++/Rust) and Wave 1's remaining packs (Tasks 5–7) transcribe
 * against this file: a new pack supplies (1) pure config data, (2) one
 * `extract()` for that language's tree-sitter CST, (3) fixtures + tests
 * mirroring Tasks 5–7's pins, and (4) one registration line in
 * `src/packs/index.ts`. Runtime, discovery, registry, and the merged pipeline
 * (Task 8) are CLOSED — packs must not touch them.
 */
import type { GraphEdge, GraphNode } from "../graph/types.js";
// web-tree-sitter@0.25.10 (the OpenTUI-compatible pin — see task-3-4 report)
// exports the syntax-node class as `Node`; 0.27+ renamed it to `SyntaxNode`.
// The contract semantic is "a tree-sitter syntax node" either way.
import type { Node as SyntaxNode } from "web-tree-sitter";

export type LanguageId = "python" | "php" | "bash" | "go"; // Wave 2 adds "cpp" | "rust"

export interface SinkSpec {
  readonly callee: string; // match + display text, e.g. "pickle.loads", "include $path"
  readonly why: string; // one-line note (node-detail output, later rules plan)
  readonly only?: "kwarg-shell-true" | "no-kwarg-loader" | "variable-path" |
                  "e-modifier" | "command-expansion";
}

export interface SinkSite {
  readonly symbolPath: string; // "" = file-level body
  readonly spec: SinkSpec;
}

export interface PackMetrics {
  callSites: number;
  resolved: number;
  unresolved: number;
  external: number;
  unparseable: number; // symbol candidates dropped because their subtree contains an ERROR node
}

/**
 * A call the pack could NOT resolve same-file. The pipeline (Task 8) resolves
 * each ref over the full walked set (moduleAliases / classIndex / includeClosure
 * per the pack's resolution flags) or emits an unresolved edge NAMED BY
 * `expressionText` — externalRefs are NEVER dropped.
 */
export interface ExternalCallRef {
  readonly fromSymbolPath: string; // "" = file-level body (bash top level → File node is the caller)
  readonly moduleAlias?: string; // alias bound by an import (python `import a.b as c`)
  readonly className?: string; // ClassName::method() — resolved via the pack's class index
  readonly functionName: string; // bare name the pipeline tries against include/source closures
  readonly expressionText: string; // EXACT expression text — becomes the unresolved edge's targetName
  // go pass 2: the receiver var was assigned from this constructor call in the
  // same file (`x := New(...)`, `x := pkg.New(...)`) — the resolver joins it to
  // the constructor's declared result type via functionResults, then resolves
  // the method on THAT type. Absent everywhere else (wave-1 packs unchanged).
  // (Named constructedBy — `constructor` would collide with the inherited
  // Object.prototype.constructor on every plain ref object.)
  readonly constructedBy?: { readonly name: string; readonly pkg?: string };
}

export interface PackExtraction {
  nodes: GraphNode[]; // 1 File node (language = pack id) + symbol nodes (language = pack id)
  edges: GraphEdge[]; // contains edges + SAME-FILE resolved call edges (inferred: true)
  importTargets: string[]; // repo-relative candidate paths → File→File imports edges (pipeline closes over walked set)
  externalRefs: ExternalCallRef[]; // every unresolved-here call — pipeline resolves or emits an unresolved edge
  sinks: SinkSite[];
  metrics: PackMetrics;
  // package-level imports (go: import paths) — consumed by the pack's own
  // resolver hook, never by the pipeline's flag machinery (design D1)
  readonly packageImports?: readonly PackageImport[];
  // go pass 2: top-level function name → declared result type text (single
  // result only, e.g. "*Assertions") — the resolver joins constructor-assigned
  // receiver vars to these to type them. Absent in wave-1 packs.
  readonly functionResults?: ReadonlyMap<string, string>;
}

/** A package-level import the pack extracted (go: `import "github.com/x/y/pkg"`). */
export interface PackageImport {
  readonly alias: string; // local alias (go: explicit name, else the path's last segment)
  readonly path: string; // the raw import path as written
}

/**
 * Whole-repo context handed to a pack's resolver hook (design D1). Built once
 * per pack from that pack's READABLE walked files; `readFile` reads any repo-
 * relative path (cached; undefined when unreadable or outside the root) so
 * resolvers can consult manifest files (go.mod) the walker never indexed.
 */
export interface PackResolveCtx {
  readonly root: string;
  readonly files: readonly string[]; // this pack's readable walked relPaths
  readonly extractions: ReadonlyMap<string, PackExtraction>;
  readFile(relPath: string): string | undefined;
}

/**
 * Optional per-pack phase-2 resolver (design D1, the ruled Wave-2 opening).
 * `resolveRef` returns a node id the pipeline GUARDS against the store —
 * fabricated ids fall through exactly like an unresolved ref. `isExternalPackage`
 * classifies a ref as known-external (metrics.external, NO edge, not unresolved).
 * `fileImports` contributes File→File imports edges (inferred, deduped, sorted).
 */
export interface PackRefResolver {
  resolveRef(ref: ExternalCallRef, fromRelPath: string): string | undefined;
  isExternalPackage?(ref: ExternalCallRef, fromRelPath: string): boolean;
  fileImports?(): readonly { fromRelPath: string; targetRelPath: string }[];
}

export interface LanguagePack {
  readonly id: LanguageId;
  readonly displayName: string; // "Python" | "PHP" | "bash"
  readonly grammarName: string; // wasm file stem in vendor/grammars: "python" | "php_only" | "bash"
  readonly extensions: readonly string[]; // [".py"] | [".php"] | [".sh", ".bash"]
  readonly shebang?: RegExp; // extensionless capture; bash only in Wave 1
  readonly resolution: { moduleAliases: boolean; classIndex: boolean; includeClosure: boolean };
  readonly sinks: readonly SinkSpec[]; // the pack's dangerous-function table (data)
  extract(root: SyntaxNode, relPath: string, source: string): PackExtraction;
  /** Wave-2 opening (design D1): optional whole-repo resolver, tried BEFORE the
   *  flag machinery. Undefined (wave-1 packs) keeps the pipeline bit-identical. */
  readonly createResolver?: (ctx: PackResolveCtx) => PackRefResolver | undefined;
}
