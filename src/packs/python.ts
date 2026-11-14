/**
 * Python pack — the Wave-1 reference transcription of the pack contract.
 *
 * Extraction semantics (pinned by tests/packs/python.test.ts; php/bash and
 * Wave 2 mirror these decisions):
 *   nodes      module-level `def` → Function; `class` → Class + methods →
 *              `Class.method` (`__init__` keeps its name); `foo = lambda …` →
 *              Function named `foo`; nested defs produce NO node — their calls
 *              attribute to the enclosing extracted symbol.
 *   exported   module-level names: no leading underscore AND (no `__all__` OR
 *              name ∈ `__all__`). METHODS inherit their class's exported flag —
 *              a naive leading-underscore rule would wrongly privatize
 *              `__init__`, so dunders keep the class's flag while a single
 *              leading underscore stays private.
 *   imports    `import a.b` and `from a.b import x` → candidates `a/b.py` +
 *              `a/b/__init__.py`; relative `from .m` / `from ..p` resolve
 *              against the file's directory. Import-bound names/aliases ride on
 *              externalRefs (moduleAlias) for the pipeline's cross-file pass.
 *   calls      same-file calls (`helper()`, `self.m()`, `cls.m()`,
 *              `SameFileClass.m()`) resolve with inferred: true; everything
 *              else leaves as an externalRef — NEVER dropped.
 *   sinks      the table below; `only` qualifiers filter per call site
 *              (shell=True must be present; Loader= must be absent).
 */
import type { Node } from "web-tree-sitter";
import type { GraphEdge, GraphNode } from "../graph/types.js";
import { makeNodeId, makeQualifiedName } from "../graph/types.js";
import type { ExternalCallRef, LanguagePack, PackExtraction, SinkSite, SinkSpec } from "./types.js";
import { spanFromNode, truncateSignature } from "./emit.js";

export const pythonSinks: readonly SinkSpec[] = [
  { callee: "eval", why: "executes arbitrary Python expressions" },
  { callee: "exec", why: "executes arbitrary Python code" },
  { callee: "pickle.loads", why: "deserializes attacker-controlled byte streams" },
  { callee: "subprocess.run", why: "runs a shell command when shell=True", only: "kwarg-shell-true" },
  { callee: "subprocess.Popen", why: "spawns a shell when shell=True", only: "kwarg-shell-true" },
  { callee: "subprocess.check_output", why: "runs a shell command when shell=True", only: "kwarg-shell-true" },
  { callee: "os.system", why: "runs a command through the system shell" },
  { callee: "yaml.load", why: "yaml loading without an explicit Loader can instantiate arbitrary objects", only: "no-kwarg-loader" },
];

export const pythonPack: LanguagePack = {
  id: "python",
  displayName: "Python",
  grammarName: "python",
  extensions: [".py"],
  resolution: { moduleAliases: true, classIndex: true, includeClosure: false },
  sinks: pythonSinks,
  extract,
};

function extract(root: Node, relPath: string, source: string): PackExtraction {
  return new Extractor(root, relPath, textSlicer(source)).run();
}

/** web-tree-sitter@0.25.10 under Bun reports startIndex/endIndex as UTF-16
 *  code-unit indices, NOT byte offsets (verified empirically: a fixture with a
 *  multi-byte "→" misaligns Buffer byte-slicing by exactly the width delta;
 *  string.slice is exact). The wave-1 spike's "byte offsets" note held for
 *  0.27.x — do not re-introduce Buffer slicing on this pin. */
function textSlicer(source: string): (n: Node) => string {
  return (n) => source.slice(n.startIndex, n.endIndex);
}

/** True when the subtree contains an ERROR/MISSING node. Walks ALL children —
 *  MISSING recovery nodes are unnamed, so namedChildren alone misses them
 *  (verified: `def broken(:` recovers with (MISSING ")")). */
export function subtreeIsBroken(node: Node): boolean {
  if (node.type === "ERROR" || node.isError || node.isMissing) return true;
  for (const child of node.children) {
    if (child !== null && subtreeIsBroken(child)) return true;
  }
  return false;
}

class Extractor {
  private readonly nodes: GraphNode[] = [];
  private readonly edges: GraphEdge[] = [];
  private readonly importTargets = new Set<string>();
  private readonly externalRefs: ExternalCallRef[] = [];
  private readonly sinks: SinkSite[] = [];
  private readonly metrics = { callSites: 0, resolved: 0, unresolved: 0, external: 0, unparseable: 0 };

  /** computed lazily — class field initializers run BEFORE parameter properties are assigned */
  private get fileId(): string {
    return makeNodeId("File", this.relPath);
  }
  /** emitted symbol paths keyed by CST node — drives enclosing-symbol attribution */
  private readonly symbolOfNode = new Map<number, string>();
  /** same-file resolution tables */
  private readonly moduleFns = new Map<string, string>(); // name → Function id
  private readonly classes = new Map<string, { id: string; methods: Map<string, string> }>();
  /** names bound by imports (external-metric hint) and alias→module for refs */
  private readonly importBound = new Set<string>();
  private readonly aliasToModule = new Map<string, string>();
  private readonly edgeKeys = new Set<string>();

  constructor(
    private readonly root: Node,
    private readonly relPath: string,
    private readonly slice: (n: Node) => string,
  ) {}

  run(): PackExtraction {
    this.pushFileNode();
    const dunderAll = this.collectDunderAll();
    this.emitModuleSymbols(dunderAll);
    this.collectImports();
    this.walkCalls();
    return {
      nodes: this.nodes,
      edges: this.edges,
      importTargets: [...this.importTargets],
      externalRefs: this.externalRefs,
      sinks: this.sinks,
      metrics: this.metrics,
    };
  }

  private pushFileNode(): void {
    this.nodes.push({
      id: this.fileId,
      kind: "File",
      name: this.relPath.split("/").pop() ?? this.relPath,
      qualifiedName: this.relPath,
      filePath: this.relPath,
      span: spanFromNode(this.root),
      exported: true,
      language: "python",
    });
  }

  /** `__all__ = ["a", "b"]` at module level (collected first wherever it sits). */
  private collectDunderAll(): Set<string> | undefined {
    let all: Set<string> | undefined;
    for (const stmt of this.named(this.root.namedChildren)) {
      if (stmt.type !== "assignment") continue;
      const [target, value] = this.named(stmt.namedChildren);
      if (target?.type !== "identifier" || this.slice(target) !== "__all__") continue;
      if (value?.type !== "list") continue;
      all = new Set(
        this.named(value.namedChildren)
          .filter((c) => c.type === "string")
          .map((c) => c.namedChildren.find((p) => p !== null && p.type === "string_content"))
          .filter((c): c is Node => c !== undefined && c !== null)
          .map((c) => this.slice(c)),
      );
    }
    return all;
  }

  private named(children: (Node | null)[]): Node[] {
    return children.filter((c): c is Node => c !== null);
  }

  /** decorated_definition → the function/class it wraps. */
  private unwrapDecorated(node: Node): Node {
    if (node.type !== "decorated_definition") return node;
    return (
      this.named(node.namedChildren).find((c) => c.type === "function_definition" || c.type === "class_definition") ?? node
    );
  }

  private emitModuleSymbols(dunderAll: Set<string> | undefined): void {
    const moduleExported = (name: string): boolean =>
      !name.startsWith("_") && (dunderAll === undefined || dunderAll.has(name));

    for (const raw of this.named(this.root.namedChildren)) {
      const stmt = this.unwrapDecorated(raw);
      if (stmt.type === "function_definition") {
        const name = this.nameOf(stmt);
        if (name !== undefined) this.addFunction(name, name, stmt, moduleExported(name), "function");
      } else if (stmt.type === "class_definition") {
        this.emitClass(stmt, moduleExported);
      } else if (stmt.type === "assignment") {
        // `foo = lambda …: …` → a Function named after the variable
        const [target, value] = this.named(stmt.namedChildren);
        if (target?.type === "identifier" && value?.type === "lambda") {
          this.addFunction(target.text, this.slice(target), stmt, moduleExported(this.slice(target)), "lambda");
        }
      }
    }
  }

  private emitClass(classNode: Node, moduleExported: (name: string) => boolean): void {
    const name = this.nameOf(classNode);
    if (name === undefined) return;
    if (subtreeIsBroken(classNode)) {
      this.metrics.unparseable++; // a broken class drops with all its methods
      return;
    }
    const qualified = makeQualifiedName(this.relPath, name);
    const id = makeNodeId("Class", qualified);
    const classExported = moduleExported(name);
    this.pushSymbol({
      id,
      kind: "Class",
      name,
      qualifiedName: qualified,
      span: spanFromNode(classNode),
      exported: classExported,
    });
    this.symbolOfNode.set(classNode.id, name);
    const methods = new Map<string, string>();
    const body = this.named(classNode.namedChildren).find((c) => c.type === "block");
    if (body !== undefined) {
      for (const rawMember of this.named(body.namedChildren)) {
        const member = this.unwrapDecorated(rawMember);
        if (member.type !== "function_definition") continue;
        const methodName = this.nameOf(member);
        if (methodName === undefined) continue;
        const symbolPath = `${name}.${methodName}`;
        const methodId = this.addFunction(symbolPath, methodName, member, this.methodExported(methodName, classExported), "function");
        if (methodId !== undefined) methods.set(methodName, methodId);
      }
    }
    this.classes.set(name, { id, methods });
  }

  /** Dunders (`__init__`) keep the class's flag; a single leading underscore stays private. */
  private methodExported(methodName: string, classExported: boolean): boolean {
    return classExported && (/^__\w+__$/.test(methodName) || !methodName.startsWith("_"));
  }

  private nameOf(def: Node): string | undefined {
    const name = def.childForFieldName("name");
    return name === null ? undefined : this.slice(name);
  }

  /** Emits a Function node; undefined when dropped as broken. */
  private addFunction(
    symbolPath: string,
    shortName: string,
    node: Node,
    exported: boolean,
    flavor: "function" | "lambda",
  ): string | undefined {
    if (subtreeIsBroken(node)) {
      this.metrics.unparseable++;
      return undefined;
    }
    const qualified = makeQualifiedName(this.relPath, symbolPath);
    const id = makeNodeId("Function", qualified);
    this.pushSymbol({
      id,
      kind: "Function",
      name: shortName,
      qualifiedName: qualified,
      span: spanFromNode(node),
      exported,
      signature: this.signatureOf(node, flavor),
    });
    this.symbolOfNode.set(node.id, symbolPath);
    if (!symbolPath.includes(".")) this.moduleFns.set(shortName, id);
    return id;
  }

  private pushSymbol(node: Omit<GraphNode, "filePath" | "language">): void {
    this.nodes.push({ ...node, filePath: this.relPath, language: "python" });
    this.edges.push({ kind: "contains", from: this.fileId, to: node.id });
  }

  private signatureOf(node: Node, flavor: "function" | "lambda"): string {
    if (flavor === "lambda") return truncateSignature(this.slice(node));
    const params = node.childForFieldName("parameters");
    let paramsText = params === null ? "()" : this.slice(params);
    paramsText = paramsText
      .replace(/^\((.*)\)$/s, "$1")
      .replace(/^\s*(?:self|cls)\s*,\s*/, "")
      .replace(/^\s*(?:self|cls)\s*$/, "");
    const returnType = node.childForFieldName("type");
    return truncateSignature(`(${paramsText})${returnType !== null ? ` -> ${this.slice(returnType)}` : ""}`);
  }

  /** importTargets (repo-relative candidates) + import-bound names/aliases. */
  private collectImports(): void {
    const addCandidates = (segments: string[], baseDir?: string): void => {
      const base = baseDir === undefined ? [] : baseDir.split("/").filter(Boolean);
      const dir = [...base, ...segments].join("/");
      if (dir === "") return;
      this.importTargets.add(`${dir}.py`);
      this.importTargets.add(`${dir}/__init__.py`);
    };

    for (const stmt of this.named(this.root.namedChildren)) {
      if (stmt.type === "import_statement") {
        for (const child of this.named(stmt.namedChildren)) {
          if (child.type === "aliased_import") {
            const dotted = this.dottedSegments(this.named(child.namedChildren).find((c) => c.type === "dotted_name") ?? null);
            const alias = this.named(child.namedChildren).find((c) => c.type === "identifier");
            if (dotted !== undefined) {
              addCandidates(dotted);
              this.importBound.add(dotted[0]);
              if (alias !== undefined) this.aliasToModule.set(this.slice(alias), dotted.join("."));
            }
          } else if (child.type === "dotted_name") {
            const dotted = this.dottedSegments(child);
            if (dotted !== undefined) {
              addCandidates(dotted);
              this.importBound.add(dotted[0]);
            }
          }
        }
      } else if (stmt.type === "import_from_statement") {
        const children = this.named(stmt.namedChildren);
        const relative = children.find((c) => c.type === "relative_import");
        const module = children.find((c) => c.type === "dotted_name");
        const dotted = this.dottedSegments(module ?? null);
        if (relative !== null && relative !== undefined) {
          // `from .m import x` / `from ..p import x` — relative to THIS file's dir
          const dots = this.slice(relative).replace(/[^.]/g, "").length;
          const fileDir = this.relPath.split("/").slice(0, -1);
          const baseDir = fileDir.slice(0, -(dots - 1));
          if (dotted !== undefined) addCandidates(dotted, baseDir.join("/"));
        } else if (dotted !== undefined) {
          addCandidates(dotted);
        }
        if (dotted !== undefined) this.importBound.add(dotted[0]);
        for (const child of children) {
          if (child !== module && child.type === "dotted_name") {
            this.importBound.add(this.slice(child)); // `from x import name` binds name
          } else if (child.type === "aliased_import") {
            const alias = this.named(child.namedChildren).find((c) => c.type === "identifier");
            if (alias !== undefined) {
              const name = this.named(child.namedChildren).find((c) => c.type === "dotted_name");
              this.importBound.add(this.slice(alias));
              if (name !== undefined) this.aliasToModule.set(this.slice(alias), this.slice(name));
            }
          }
        }
      }
    }
  }

  private dottedSegments(node: Node | null): string[] | undefined {
    if (node === null || node.type !== "dotted_name") return undefined;
    return this.named(node.namedChildren)
      .filter((c) => c.type === "identifier")
      .map((c) => this.slice(c));
  }

  /** Nearest enclosing emitted symbol; "" = module top level (File node caller). */
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
    if (symbolPath === "") return this.fileId;
    const cls = this.classes.get(symbolPath);
    if (cls !== undefined) return cls.id;
    return makeNodeId("Function", makeQualifiedName(this.relPath, symbolPath));
  }

  private walkCalls(): void {
    const visit = (node: Node): void => {
      if (node.type === "call") this.classifyCall(node);
      for (const child of this.named(node.namedChildren)) visit(child);
    };
    visit(this.root);
  }

  private classifyCall(call: Node): void {
    const from = this.enclosingSymbol(call);
    const callee = call.childForFieldName("function");
    const expressionText = this.slice(call);
    this.metrics.callSites++;
    this.classifySinks(call, callee, from);

    const resolved = this.resolveCallee(callee, from);
    if (resolved !== undefined) {
      this.metrics.resolved++;
      const fromId = this.callerId(from);
      const key = `${fromId}->${resolved}`;
      if (!this.edgeKeys.has(key)) {
        this.edgeKeys.add(key);
        this.edges.push({ kind: "calls", from: fromId, to: resolved, inferred: true });
      }
      return;
    }

    // unresolved HERE → externalRef (never dropped); import-bound → external metric
    const base = this.baseIdentifier(callee);
    if (base !== undefined && this.importBound.has(base)) this.metrics.external++;
    else this.metrics.unresolved++;
    const alias = base !== undefined ? this.aliasToModule.get(base) : undefined;
    this.externalRefs.push({
      fromSymbolPath: from,
      ...(alias !== undefined ? { moduleAlias: base } : {}),
      functionName: this.refFunctionName(callee),
      expressionText,
    });
  }

  /** Same-file resolution: bare module fn; self/cls → enclosing class method; same-file Class.method. */
  private resolveCallee(callee: Node | null, from: string): string | undefined {
    if (callee === null) return undefined;
    if (callee.type === "identifier") {
      return this.moduleFns.get(this.slice(callee));
    }
    if (callee.type === "attribute") {
      const object = callee.childForFieldName("object");
      const attr = callee.childForFieldName("attribute");
      if (object === null || attr === null) return undefined;
      const receiver = this.slice(object);
      const method = this.slice(attr);
      if (receiver === "self" || receiver === "cls") {
        const className = from.includes(".") ? from.split(".")[0] : undefined;
        return className !== undefined ? this.classes.get(className)?.methods.get(method) : undefined;
      }
      return this.classes.get(receiver)?.methods.get(method);
    }
    return undefined; // dynamic (`f()()`, `get(x)()`) — the pipeline's business
  }

  /** Leftmost identifier of a callee expression, descending attribute/call chains. */
  private baseIdentifier(callee: Node | null): string | undefined {
    let current = callee;
    for (let hop = 0; current !== null && hop < 10; hop++) {
      if (current.type === "identifier") return this.slice(current);
      if (current.type === "attribute") {
        current = current.childForFieldName("object");
        continue;
      }
      if (current.type === "call") {
        current = current.childForFieldName("function");
        continue;
      }
      return undefined;
    }
    return undefined;
  }

  /** Bare name the pipeline can try; the attribute name for receiver calls. */
  private refFunctionName(callee: Node | null): string {
    if (callee === null) return "";
    if (callee.type === "identifier") return this.slice(callee);
    if (callee.type === "attribute") {
      const attr = callee.childForFieldName("attribute");
      return attr !== null ? this.slice(attr) : this.baseIdentifier(callee) ?? "";
    }
    return this.baseIdentifier(callee) ?? ""; // dynamic: innermost callee name
  }

  private classifySinks(call: Node, callee: Node | null, from: string): void {
    if (callee === null) return;
    if (callee.type !== "identifier" && callee.type !== "attribute") return;
    const spec = pythonSinks.find((s) => s.callee === this.slice(callee));
    if (spec === undefined) return;
    if (!this.sinkQualifies(spec, call)) return;
    this.sinks.push({ symbolPath: from, spec });
  }

  /** `only` qualifiers: shell=True must be present; Loader= must be absent. */
  private sinkQualifies(spec: SinkSpec, call: Node): boolean {
    if (spec.only === undefined) return true;
    const args = call.childForFieldName("arguments");
    const keywords = args === null ? [] : this.named(args.namedChildren).filter((c) => c.type === "keyword_argument");
    if (spec.only === "kwarg-shell-true") {
      return keywords.some((kw) => {
        const name = kw.childForFieldName("name");
        const value = kw.childForFieldName("value");
        return name !== null && this.slice(name) === "shell" && value !== null && this.slice(value) === "True";
      });
    }
    if (spec.only === "no-kwarg-loader") {
      return !keywords.some((kw) => kw.childForFieldName("name")?.text === "Loader");
    }
    return true;
  }
}
