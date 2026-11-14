/**
 * PHP pack (php_only dialect — the mono-repo's pure-PHP grammar; documented
 * limitation: template files with leading HTML parse via error recovery).
 *
 * Extraction semantics (pinned by tests/packs/php.test.ts):
 *   nodes      top-level `function foo()` → Function; `class` → Class +
 *              methods → `Class.method`; interfaces/traits/enums/anonymous
 *              `new class` produce no node (noted limitation).
 *   exported   top-level functions: no leading underscore. Methods: public
 *              (visibility keyword absent = public) AND no underscore;
 *              private/protected → false.
 *   imports    include/require(+`_once`) with a string literal → importTarget
 *              (file-dir-relative, then repo root). With a variable → NO edge
 *              + a variable-path sink. `use NS\Name;` binds NO imports edge —
 *              aliases surface only through externalRef className.
 *   calls      same-file plain-name calls resolve with inferred: true;
 *              `$obj->m()`, `$cb($x)`, `NS::m()`, untyped chains leave as
 *              externalRefs with exact expressionText — NEVER dropped. PHP has
 *              no static import-name binding, so every ref stays "unresolved"
 *              here (metrics.external is always 0) and the pipeline's include
 *              closure decides.
 *   sinks      the table below (bare callee names); include/require sinks are
 *              detected structurally on the include expressions, and
 *              preg_replace qualifies only with the /e modifier.
 */
import type { Node } from "web-tree-sitter";
import type { GraphEdge, GraphNode } from "../graph/types.js";
import { makeNodeId, makeQualifiedName } from "../graph/types.js";
import type { ExternalCallRef, LanguagePack, PackExtraction, SinkSite, SinkSpec } from "./types.js";
import { spanFromNode, truncateSignature } from "./emit.js";

export const phpSinks: readonly SinkSpec[] = [
  { callee: "eval", why: "executes arbitrary PHP code" },
  { callee: "system", why: "runs a shell command and prints its output" },
  { callee: "exec", why: "runs a shell command" },
  { callee: "shell_exec", why: "runs a shell command through backticks" },
  { callee: "passthru", why: "runs a shell command and streams its output" },
  { callee: "proc_open", why: "spawns a process with full control" },
  { callee: "popen", why: "opens a process pipe" },
  { callee: "unserialize", why: "deserializes attacker-controlled byte streams with object instantiation" },
  { callee: "include", why: "includes a file chosen by a variable", only: "variable-path" },
  { callee: "require", why: "requires a file chosen by a variable", only: "variable-path" },
  { callee: "preg_replace", why: "the /e modifier evaluates the replacement as PHP code", only: "e-modifier" },
];

export const phpPack: LanguagePack = {
  id: "php",
  displayName: "PHP",
  grammarName: "php_only",
  extensions: [".php"],
  resolution: { moduleAliases: false, classIndex: true, includeClosure: true },
  sinks: phpSinks,
  extract,
};

function extract(root: Node, relPath: string, source: string): PackExtraction {
  return new Extractor(root, relPath, source).run();
}

/** Same degradation rule as the python pack (see python.ts for the MISSING-node
 *  rationale) — duplicated so every pack stays a self-contained transcription. */
function subtreeIsBroken(node: Node): boolean {
  if (node.type === "ERROR" || node.isError || node.isMissing) return true;
  for (const child of node.children) {
    if (child !== null && subtreeIsBroken(child)) return true;
  }
  return false;
}

const INCLUDE_TYPES = new Set(["include_expression", "include_once_expression"]);
const REQUIRE_TYPES = new Set(["require_expression", "require_once_expression"]);
const STRING_TYPES = new Set(["string", "encapsed_string", "string_value"]);

class Extractor {
  private readonly nodes: GraphNode[] = [];
  private readonly edges: GraphEdge[] = [];
  private readonly importTargets = new Set<string>();
  private readonly externalRefs: ExternalCallRef[] = [];
  private readonly sinks: SinkSite[] = [];
  private readonly metrics = { callSites: 0, resolved: 0, unresolved: 0, external: 0, unparseable: 0 };

  private readonly moduleFns = new Map<string, string>(); // top-level name → Function id
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
      language: "php",
    });

    for (const stmt of this.named(this.root.namedChildren)) {
      if (stmt.type === "function_definition") this.addTopLevelFunction(stmt);
      else if (stmt.type === "class_declaration") this.emitClass(stmt);
      else if (INCLUDE_TYPES.has(stmt.type) || REQUIRE_TYPES.has(stmt.type)) this.classifyInclude(stmt);
    }
    // includes can sit at any statement depth (inside functions too)
    this.visitAll(this.root, (node) => {
      if (node !== this.root && (INCLUDE_TYPES.has(node.type) || REQUIRE_TYPES.has(node.type))) this.classifyInclude(node);
    });
    this.visitAll(this.root, (node) => {
      if (this.isCallNode(node)) this.classifyCall(node);
    });

    return {
      nodes: this.nodes,
      edges: this.edges,
      importTargets: [...this.importTargets],
      externalRefs: this.externalRefs,
      sinks: this.sinks,
      metrics: this.metrics,
    };
  }

  private isCallNode(node: Node): boolean {
    return (
      node.type === "function_call_expression" ||
      node.type === "scoped_call_expression" ||
      node.type === "member_call_expression" ||
      node.type === "nullsafe_member_call_expression"
    );
  }

  private addTopLevelFunction(stmt: Node): void {
    const name = stmt.childForFieldName("name");
    if (name === null) return;
    const short = this.text(name);
    this.pushFunction(short, short, stmt, !short.startsWith("_"));
  }

  private emitClass(classNode: Node): void {
    const nameNode = classNode.childForFieldName("name");
    if (nameNode === null) return;
    if (subtreeIsBroken(classNode)) {
      this.metrics.unparseable++;
      return;
    }
    const name = this.text(nameNode);
    const qualified = makeQualifiedName(this.relPath, name);
    const id = makeNodeId("Class", qualified);
    this.pushSymbol({ id, kind: "Class", name, qualifiedName: qualified, span: spanFromNode(classNode), exported: true });
    this.symbolOfNode.set(classNode.id, name);
    const declarationList = this.named(classNode.namedChildren).find((c) => c.type === "declaration_list");
    if (declarationList === undefined) return;
    for (const member of this.named(declarationList.namedChildren)) {
      if (member.type !== "method_declaration") continue;
      const methodNode = member.childForFieldName("name");
      if (methodNode === null) continue;
      const methodName = this.text(methodNode);
      const visibility = this.named(member.namedChildren).find((c) => c.type === "visibility_modifier");
      const visibilityText = visibility === undefined ? "public" : this.text(visibility); // absent = public
      const exported = (visibilityText === "public") && !methodName.startsWith("_");
      this.pushFunction(`${name}.${methodName}`, methodName, member, exported);
    }
  }

  private pushFunction(symbolPath: string, shortName: string, node: Node, exported: boolean): void {
    if (subtreeIsBroken(node)) {
      this.metrics.unparseable++;
      return;
    }
    const qualified = makeQualifiedName(this.relPath, symbolPath);
    const id = makeNodeId("Function", qualified);
    const params = node.childForFieldName("formal_parameters");
    this.pushSymbol({
      id,
      kind: "Function",
      name: shortName,
      qualifiedName: qualified,
      span: spanFromNode(node),
      exported,
      signature: truncateSignature(params === null ? "()" : this.text(params)),
    });
    this.symbolOfNode.set(node.id, symbolPath);
    if (!symbolPath.includes(".")) this.moduleFns.set(shortName, id);
  }

  private pushSymbol(node: Omit<GraphNode, "filePath" | "language">): void {
    this.nodes.push({ ...node, filePath: this.relPath, language: "php" });
    this.edges.push({ kind: "contains", from: this.fileId, to: node.id });
  }

  /** Literal includes → importTargets; anything else → variable-path sink, never an edge. */
  private classifyInclude(node: Node): void {
    const value = this.named(node.namedChildren)[0];
    const isLiteral = value !== undefined && STRING_TYPES.has(value.type);
    if (isLiteral) {
      const spec = this.dequote(this.text(value!));
      for (const candidate of this.candidatePaths(spec)) this.importTargets.add(candidate);
      return;
    }
    const callee = REQUIRE_TYPES.has(node.type) ? "require" : "include";
    const spec = phpSinks.find((s) => s.callee === callee);
    if (spec !== undefined) this.sinks.push({ symbolPath: this.enclosingSymbol(node), spec });
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

  private enclosingSymbol(node: Node): string {
    let current = node.parent;
    while (current !== null && current.id !== this.root.id) {
      const symbol = this.symbolOfNode.get(current.id);
      if (symbol !== undefined) return symbol;
      current = current.parent;
    }
    return ""; // file-level body — the File node is the caller (pipeline)
  }

  private callerId(symbolPath: string): string {
    return symbolPath === "" ? this.fileId : makeNodeId("Function", makeQualifiedName(this.relPath, symbolPath));
  }

  private visitAll(node: Node, visit: (n: Node) => void): void {
    visit(node);
    for (const child of this.named(node.namedChildren)) this.visitAll(child, visit);
  }

  private classifyCall(call: Node): void {
    const from = this.enclosingSymbol(call);
    this.metrics.callSites++;
    const expressionText = this.text(call);

    // scoped_call: NS::method() → className ref (the `use` alias registry's surface)
    if (call.type === "scoped_call_expression") {
      const scope = call.childForFieldName("scope");
      const name = call.childForFieldName("name");
      this.metrics.unresolved++;
      this.externalRefs.push({
        fromSymbolPath: from,
        ...(scope !== null ? { className: this.text(scope) } : {}),
        functionName: name !== null ? this.text(name) : "",
        expressionText,
      });
      return;
    }

    // member calls ($obj->m(), $obj?->m(), get_svc()->m()): this grammar exposes
    // object/name fields — there is NO `function` field — and receivers are
    // untyped, so every member form leaves as an externalRef (never dropped)
    if (call.type === "member_call_expression" || call.type === "nullsafe_member_call_expression") {
      const name = call.childForFieldName("name");
      this.metrics.unresolved++;
      this.externalRefs.push({
        fromSymbolPath: from,
        functionName: name !== null ? this.text(name) : "",
        expressionText,
      });
      return;
    }

    const callee = call.childForFieldName("function");
    if (callee === null) return;

    if (callee.type === "name") {
      const name = this.text(callee);
      this.checkSinks(name, call, from);
      const target = this.moduleFns.get(name);
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
      // PHP has no static import binding — the include closure decides (pipeline)
      this.metrics.unresolved++;
      this.externalRefs.push({ fromSymbolPath: from, functionName: name, expressionText });
      return;
    }

    // variable ($cb($x)) callees and any other untyped callee shape: dynamic, never dropped
    this.metrics.unresolved++;
    this.externalRefs.push({
      fromSymbolPath: from,
      functionName: this.text(callee),
      expressionText,
    });
  }

  private checkSinks(name: string, call: Node, from: string): void {
    const spec = phpSinks.find((s) => s.callee === name);
    if (spec === undefined) return;
    if (spec.only === "e-modifier" && !this.hasEModifier(call)) return;
    this.sinks.push({ symbolPath: from, spec });
  }

  /** preg_replace("/…/e", …): the first argument's pattern carries the e modifier. */
  private hasEModifier(call: Node): boolean {
    const args = call.childForFieldName("arguments");
    const argument = args === null ? undefined : this.named(args.namedChildren)[0];
    if (argument === undefined) return false;
    // arguments wrap values in `argument` nodes — descend to the value
    const value = this.named(argument.namedChildren)[0] ?? argument;
    if (!STRING_TYPES.has(value.type)) return false;
    const pattern = this.dequote(this.text(value));
    const match = /\/([a-zA-Z]*)$/.exec(pattern);
    return match !== null && match[1].includes("e");
  }
}
