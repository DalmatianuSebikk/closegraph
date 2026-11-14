/**
 * bash pack — shebang-sniffing shell support.
 *
 * PINNED POLICY — the graph models PROJECT FUNCTION FLOW, not the Unix
 * toolchain: plain external commands (`ls`, `grep`, `bun`, …) are NOT call
 * sites. They are counted in metrics.external and produce no edge and no ref.
 * The known-commands list below is the documented heuristic that makes this
 * decision possible single-file; an unlisted unknown command becomes an
 * externalRef (an honest unresolved candidate), never silently dropped.
 *
 * Extraction semantics (pinned by tests/packs/bash.test.ts):
 *   nodes      `name() { }` and `function name { }` → Function, exported ALWAYS
 *              true (any sourced-able function is an entry point). No classes.
 *              Signatures are undefined by policy.
 *   imports    `source path` / `. path` with a string-literal path →
 *              importTarget (file-dir-relative, then repo root). A variable or
 *              command-substitution path → NO edge + a variable-path sink.
 *   calls      same-file function commands resolve with inferred: true.
 *              Cross-file commands (resolved later through the source closure —
 *              same file + transitively sourced walked files, cycle-safe) and
 *              `$`-expansions in command position leave as externalRefs named
 *              by the exact expression text — NEVER dropped. Top-level body
 *              calls attribute to the FILE node (pinned bash entry semantics).
 *   sinks      the table below; eval is unconditional, source/. qualify only
 *              on a variable path, and the command-expansion sink fires
 *              structurally whenever an expansion sits in command position.
 *
 * Degradation note: tree-sitter-bash recovery folds malformed constructs into
 * statement-level ERROR nodes that yield no function candidate — good functions
 * after the error region survive; the index never crashes.
 */
import type { Node } from "web-tree-sitter";
import type { GraphEdge, GraphNode } from "../graph/types.js";
import { makeNodeId, makeQualifiedName } from "../graph/types.js";
import type { ExternalCallRef, LanguagePack, PackExtraction, SinkSite, SinkSpec } from "./types.js";
import { spanFromNode } from "./emit.js";

export const bashSinks: readonly SinkSpec[] = [
  { callee: "eval", why: "executes dynamically-constructed shell code" },
  { callee: "source", why: "sources a file chosen by a variable", only: "variable-path" },
  { callee: ".", why: "sources a file chosen by a variable", only: "variable-path" },
  { callee: "$…", why: "a parameter/variable expansion in command position — the executed command is data", only: "command-expansion" },
];

/**
 * Commands that are part of the Unix/bun ecosystem rather than project flow.
 * Deliberately a blocklist (not an allowlist): an unlisted command stays a
 * candidate externalRef so cross-file bash functions keep resolving.
 */
const KNOWN_EXTERNAL_COMMANDS = new Set([
  // POSIX / shell builtins
  ":", ".", "[", "alias", "bg", "break", "cd", "command", "continue", "echo", "eval", "exec", "exit",
  "export", "false", "fg", "getopts", "hash", "jobs", "kill", "let", "local", "logout", "popd",
  "printf", "pushd", "pwd", "read", "readonly", "return", "set", "shift", "shopt", "test", "times",
  "trap", "true", "type", "ulimit", "umask", "unalias", "unset", "wait",
  // coreutils / common tooling
  "awk", "basename", "bun", "bunx", "cat", "chmod", "chown", "cp", "curl", "cut", "date", "dirname",
  "docker", "du", "env", "find", "gcc", "git", "grep", "gunzip", "gzip", "head", "install", "jq",
  "ln", "ls", "make", "mkdir", "mv", "node", "npm", "npx", "ping", "pnpm", "python", "python3",
  "pip", "realpath", "rm", "rmdir", "sed", "sleep", "sort", "stat", "tail", "tar", "tee", "touch",
  "tr", "uname", "unzip", "wc", "wget", "which", "xargs", "yarn", "yq", "zip",
]);

export const bashPack: LanguagePack = {
  id: "bash",
  displayName: "bash",
  grammarName: "bash",
  extensions: [".sh", ".bash"],
  shebang: /^#!\s*\/(?:[^\s/]+\/)*(?:env\s+(?:-S\s+)?)?(?:ba)?sh(?:[\s;#]|$)/,
  resolution: { moduleAliases: false, classIndex: false, includeClosure: true },
  sinks: bashSinks,
  extract,
};

function extract(root: Node, relPath: string, source: string): PackExtraction {
  return new Extractor(root, relPath, source).run();
}

/** Same degradation rule as the python pack (see python.ts) — duplicated so
 *  every pack stays a self-contained transcription. */
function subtreeIsBroken(node: Node): boolean {
  if (node.type === "ERROR" || node.isError || node.isMissing) return true;
  for (const child of node.children) {
    if (child !== null && subtreeIsBroken(child)) return true;
  }
  return false;
}

const LITERAL_ARGUMENT_TYPES = new Set(["word", "string", "raw_string", "concatenation"]);

class Extractor {
  private readonly nodes: GraphNode[] = [];
  private readonly edges: GraphEdge[] = [];
  private readonly importTargets = new Set<string>();
  private readonly externalRefs: ExternalCallRef[] = [];
  private readonly sinks: SinkSite[] = [];
  private readonly metrics = { callSites: 0, resolved: 0, unresolved: 0, external: 0, unparseable: 0 };

  private readonly functions = new Map<string, string>(); // name → Function id
  private readonly symbolOfNode = new Map<number, string>();
  private readonly edgeKeys = new Set<string>();

  constructor(
    private readonly root: Node,
    private readonly relPath: string,
    private readonly source: string,
  ) {}

  private get fileId(): string {
    return makeNodeId("File", this.relPath);
  }

  private text(node: Node): string {
    return this.source.slice(node.startIndex, node.endIndex);
  }

  private named(children: (Node | null)[]): Node[] {
    return children.filter((c): c is Node => c !== null);
  }

  run(): PackExtraction {
    this.nodes.push({
      id: this.fileId,
      kind: "File",
      name: this.relPath.split("/").pop() ?? this.relPath,
      qualifiedName: this.relPath,
      filePath: this.relPath,
      span: spanFromNode(this.root),
      exported: true,
      language: "bash",
    });

    this.emitFunctions(this.root);
    this.classifyCommands();
    return {
      nodes: this.nodes,
      edges: this.edges,
      importTargets: [...this.importTargets],
      externalRefs: this.externalRefs,
      sinks: this.sinks,
      metrics: this.metrics,
    };
  }

  /** Functions at any nesting depth count (bash has no classes to scope them). */
  private emitFunctions(node: Node): void {
    if (node.type === "function_definition") {
      const name = node.childForFieldName("name");
      if (name !== null) {
        const fnName = this.text(name);
        if (subtreeIsBroken(node)) {
          this.metrics.unparseable++;
        } else {
          const qualified = makeQualifiedName(this.relPath, fnName);
          const id = makeNodeId("Function", qualified);
          this.nodes.push({
            id,
            kind: "Function",
            name: fnName,
            qualifiedName: qualified,
            filePath: this.relPath,
            span: spanFromNode(node),
            exported: true, // pinned: any sourced-able function is an entry point
            language: "bash",
            // signature stays undefined by policy
          });
          this.edges.push({ kind: "contains", from: this.fileId, to: id });
          this.symbolOfNode.set(node.id, fnName);
          this.functions.set(fnName, id);
        }
      }
    }
    for (const child of this.named(node.namedChildren)) this.emitFunctions(child);
  }

  private classifyCommands(): void {
    const visit = (node: Node): void => {
      if (node.type === "command") this.classifyCommand(node);
      for (const child of this.named(node.namedChildren)) visit(child);
    };
    visit(this.root);
  }

  private classifyCommand(command: Node): void {
    const commandName = command.childForFieldName("name");
    if (commandName === null || commandName.type !== "command_name") return;
    const inner = this.named(commandName.namedChildren)[0];
    if (inner === undefined) return;

    // `$cmd` in command position: dynamic execution — sink + unresolved ref
    if (inner.type !== "word") {
      const expressionText = this.text(commandName);
      const from = this.enclosingSymbol(command);
      this.metrics.callSites++;
      this.metrics.unresolved++;
      this.externalRefs.push({ fromSymbolPath: from, functionName: this.expansionName(inner), expressionText });
      const spec = bashSinks.find((s) => s.only === "command-expansion");
      if (spec !== undefined) this.sinks.push({ symbolPath: from, spec });
      return;
    }

    const name = this.text(inner);
    const from = this.enclosingSymbol(command);

    if (name === "source" || name === ".") {
      this.classifySource(command, name, from);
      return; // an import (or its sink), never a call site
    }
    if (name === "eval") {
      this.metrics.callSites++;
      this.metrics.external++; // a builtin, not project flow — its danger rides on the sink
      const spec = bashSinks.find((s) => s.callee === "eval");
      if (spec !== undefined) this.sinks.push({ symbolPath: from, spec });
      return;
    }

    this.metrics.callSites++;
    const target = this.functions.get(name);
    if (target !== undefined) {
      this.metrics.resolved++;
      const fromId = this.callerId(from);
      const key = `${fromId}->${target}`;
      if (!this.edgeKeys.has(key)) {
        this.edgeKeys.add(key);
        this.edges.push({ kind: "calls", from: fromId, to: target, inferred: true });
      }
      return;
    }
    if (KNOWN_EXTERNAL_COMMANDS.has(name)) {
      this.metrics.external++; // toolchain command — no edge, no ref (pinned policy)
      return;
    }
    // a function-shaped name this file cannot see — the source closure decides
    this.metrics.unresolved++;
    this.externalRefs.push({ fromSymbolPath: from, functionName: name, expressionText: this.text(command) });
  }

  /** Variable name inside an expansion (best-effort closure key). */
  private expansionName(expansion: Node): string {
    const variable = this.named(expansion.namedChildren).find((c) => c.type === "variable_name");
    return variable !== undefined ? this.text(variable) : this.text(expansion);
  }

  /** `source path` / `. path`: literal → importTarget candidates; anything else → variable-path sink. */
  private classifySource(command: Node, name: string, from: string): void {
    const argument = this.named(command.namedChildren).find((c) => c.type !== "command_name" && c.type !== "comment");
    if (argument !== undefined && LITERAL_ARGUMENT_TYPES.has(argument.type) && !this.containsExpansion(argument)) {
      const spec = this.dequote(this.text(argument));
      for (const candidate of this.candidatePaths(spec)) this.importTargets.add(candidate);
      return;
    }
    const spec = bashSinks.find((s) => s.callee === name && s.only === "variable-path");
    if (spec !== undefined) this.sinks.push({ symbolPath: from, spec });
  }

  private containsExpansion(node: Node): boolean {
    if (node.type.endsWith("expansion") || node.type === "command_substitution") return true;
    return this.named(node.namedChildren).some((child) => this.containsExpansion(child));
  }

  private dequote(text: string): string {
    return text.replace(/^['"]/, "").replace(/['"]$/, "");
  }

  /** File-dir-relative first, then repo-root-relative (both normalized; escapes skipped). */
  private candidatePaths(spec: string): string[] {
    const resolve = (base: string[]): string[] | undefined => {
      const out: string[] = [];
      for (const seg of [...base, ...spec.split(/[\\/]/)]) {
        if (seg === "..") {
          if (out.length === 0) return undefined; // escapes the repo
          out.pop();
        } else if (seg !== "." && seg !== "") out.push(seg);
      }
      return out;
    };
    const dirRelative = resolve(this.relPath.split("/").slice(0, -1));
    const rootRelative = resolve([]);
    const out: string[] = [];
    if (dirRelative !== undefined) out.push(dirRelative.join("/"));
    if (rootRelative !== undefined && rootRelative.join("/") !== dirRelative?.join("/")) out.push(rootRelative.join("/"));
    return out;
  }

  /** Enclosing function symbol; "" = top-level body → the FILE node is the caller. */
  private enclosingSymbol(node: Node): string {
    let current = node.parent;
    while (current !== null && current.id !== this.root.id) {
      const symbol = this.symbolOfNode.get(current.id);
      if (symbol !== undefined) return symbol;
      current = current.parent;
    }
    return "";
  }

  private callerId(symbolPath: string): string {
    return symbolPath === "" ? this.fileId : makeNodeId("Function", makeQualifiedName(this.relPath, symbolPath));
  }
}
