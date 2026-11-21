/**
 * Go pack — Wave 2, riding the per-pack resolver hook (design D1–D3).
 *
 * EXTRACTION semantics (this file, pinned by tests/packs/go.test.ts):
 *   nodes      `function_declaration` → Function; `method_declaration` →
 *              Function `Type.method` (receiver type text, leading `*`
 *              stripped); EVERY `type_spec` → Class (structs, interfaces,
 *              aliases like `type Name string` — the resolver needs alias
 *              Classes to classify in-repo type conversions as external);
 *              interface `method_elem` → Function `Iface.method`. Emission
 *              order: File, Classes (with their interface methods) in source
 *              order, then functions/methods in source order — deterministic,
 *              independent of declaration order.
 *   exported   Go visibility rule: capitalized first letter.
 *   imports    `import` specs → packageImports (alias = explicit name, else the
 *              path's last segment; dot and blank imports are SKIPPED). Go's
 *              importTargets = [] — cross-file wiring is the resolver's job,
 *              never the literal-path machinery. dir ≈ package approximation
 *              and the `foo_test` exclusion live in the resolver (D3).
 *   calls      same-file only: bare `fn()` (top-level functions; methods are
 *              unreachable bare) and `Type.Method` when Type is declared
 *              in-file → calls edges (inferred: true). Selector `x.y()` where
 *              x is an import alias → externalRef {moduleAlias}; where x is a
 *              var with a statically-bound type (receiver var, param `T`/`*T`/
 *              `pkg.T`, `var x T`, `x := T{}`/`&T{}`/`new(T)`/`pkg.T{}`,
 *              type assertion `x := y.(T)`) → externalRef through the BOUND
 *              type (pkg-bound forms carry moduleAlias+className; the resolver
 *              decides mapped vs external, never extract-time); other `x.y()`
 *              → externalRef {className} (receiver-as-type heuristic, honest
 *              on miss). Two-segment identifier.Method only — longer chains
 *              (a.b.c()) stay the heuristic. NEVER dropped.
 *   sinks      the table below; matched as exact callee text (aliasing a
 *              package to another name evades the match — accepted undercount,
 *              python.ts precedent).
 */
import type { Node } from "web-tree-sitter";
import type { GraphEdge, GraphNode } from "../graph/types.js";
import { makeNodeId, makeQualifiedName } from "../graph/types.js";
import type {
  ExternalCallRef,
  LanguagePack,
  PackageImport,
  PackExtraction,
  PackRefResolver,
  PackResolveCtx,
  SinkSite,
  SinkSpec,
} from "./types.js";
import { spanFromNode, truncateSignature } from "./emit.js";
import { subtreeIsBroken } from "./python.js";

export const goSinks: readonly SinkSpec[] = [
  { callee: "exec.Command", why: "runs an arbitrary external command" },
  { callee: "exec.CommandContext", why: "runs an arbitrary external command with a context" },
];

export const goPack: LanguagePack = {
  id: "go",
  displayName: "Go",
  grammarName: "go",
  extensions: [".go"],
  resolution: { moduleAliases: false, classIndex: false, includeClosure: false },
  sinks: goSinks,
  extract,
  createResolver: buildGoResolver,
};

function extract(root: Node, relPath: string, source: string): PackExtraction {
  return new Extractor(root, relPath, (n) => source.slice(n.startIndex, n.endIndex)).run();
}

// --- D3 resolver ---------------------------------------------------------------
//
// Scope model (documented approximations):
//   • directory ≈ package. The package CLAUSE is read per file (cached) and
//     cross-package matches inside one dir are rejected — `package foo` vs
//     `package foo_test` never see each other. Two same-named packages in one
//     dir (illegal Go) would merge; accepted approximation.
//   • module map: each walked dir maps to the module path of its NEAREST
//     ancestor go.mod. `replace` directives and go.work need no handling — a
//     replaced local module carries its own go.mod and is found by its
//     declared name. vendor/ is never walked (repo-wide skip list), so
//     vendored imports resolve as external packages — explicit non-goal (D4).
//   • policy A: imports mapping to no in-repo dir (stdlib/third-party) and the
//     predeclared/conversion builtins below are metrics.external with NO edge.
//     A repo that shadows a builtin with a real top-level fn still resolves —
//     the pipeline tries resolveRef BEFORE isExternalPackage.

/** Go predeclared functions (spec § predeclared identifiers, callable subset). */
const GO_PREDECLARED = new Set([
  "append", "cap", "clear", "close", "complex", "copy", "delete", "imag", "len", "make", "max", "min",
  "new", "panic", "print", "println", "real", "recover",
]);

/** Builtin type names usable as conversions: int(x), string(b), error(e), … */
const GO_CONVERSIONS = new Set([
  "int", "int8", "int16", "int32", "int64", "uint", "uint8", "uint16", "uint32", "uint64", "uintptr",
  "float32", "float64", "complex64", "complex128", "string", "byte", "rune", "bool", "error", "any", "comparable",
]);

function dirOf(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i === -1 ? "" : relPath.slice(0, i);
}

function buildGoResolver(ctx: PackResolveCtx): PackRefResolver {
  // -- indexes, built once per pipeline run over sorted inputs (deterministic)
  const filesByDir = new Map<string, string[]>(); // dir → sorted walked files
  const topLevel = new Map<string, string[]>(); // top-level fn name → declaring files
  const methods = new Map<string, string[]>(); // `Type.method` → declaring files
  const classNames = new Set<string>(); // repo-wide Class names (in-repo type conversions)
  const packageOf = new Map<string, string | undefined>(); // file → package clause

  const packageClause = (file: string): string | undefined => {
    if (!packageOf.has(file)) {
      const src = ctx.readFile(file);
      // line-anchored: `// module`-style comment lines cannot match (they start with /)
      packageOf.set(file, src?.match(/^[ \t]*package\s+([A-Za-z_][A-Za-z0-9_]*)/m)?.[1]);
    }
    return packageOf.get(file);
  };

  for (const file of [...ctx.files].sort()) {
    const dir = dirOf(file);
    const siblings = filesByDir.get(dir);
    if (siblings === undefined) filesByDir.set(dir, [file]);
    else siblings.push(file); // files iterate sorted → per-dir lists stay sorted
    for (const node of ctx.extractions.get(file)?.nodes ?? []) {
      if (node.kind === "Class") {
        classNames.add(node.name);
        continue;
      }
      if (node.kind !== "Function") continue;
      const symbolPath = node.qualifiedName.slice(node.qualifiedName.indexOf("#") + 1);
      const index = symbolPath.includes(".") ? methods : topLevel;
      const hits = index.get(symbolPath);
      if (hits === undefined) index.set(symbolPath, [file]);
      else if (hits[hits.length - 1] !== file) hits.push(file); // once per file
    }
  }

  // -- module map: full module path → dir (nearest go.mod wins per dir)
  const moduleDirOf = new Map<string, string>();
  const goModRoot = new Map<string, string | undefined>(); // dir → nearest go.mod dir
  const goModAt = (dir: string): boolean => ctx.readFile(dir === "" ? "go.mod" : `${dir}/go.mod`) !== undefined;
  const findGoModDir = (dir: string): string | undefined => {
    if (goModRoot.has(dir)) return goModRoot.get(dir);
    let found: string | undefined;
    let current: string | undefined = dir;
    while (current !== undefined) {
      if (goModAt(current)) {
        found = current;
        break;
      }
      current = current === "" ? undefined : current.includes("/") ? dirOf(current) : "";
    }
    goModRoot.set(dir, found);
    return found;
  };

  for (const dir of [...filesByDir.keys()].sort()) {
    const goModDir = findGoModDir(dir);
    if (goModDir === undefined) continue;
    const src = ctx.readFile(goModDir === "" ? "go.mod" : `${goModDir}/go.mod`);
    const moduleName = src?.match(/^[ \t]*module\s+(\S+)/m)?.[1];
    if (moduleName === undefined) continue;
    const rel = dir === goModDir ? "" : goModDir === "" ? dir : dir.slice(goModDir.length + 1);
    const full = rel === "" ? moduleName : `${moduleName}/${rel}`;
    if (!moduleDirOf.has(full)) moduleDirOf.set(full, dir); // first (sorted) wins
  }

  const idOf = (file: string, symbolPath: string): string => makeNodeId("Function", makeQualifiedName(file, symbolPath));

  // pass 2 — join a constructor-assigned receiver var (`x := New(...)`,
  // `x := pkg.New(...)`) to the constructor's declared result type via the
  // extractions' functionResults, then let the normal paths resolve the method
  // on THAT type. Unknown/untyped/overloaded constructors → undefined (honest).
  const constructorBinding = (
    ctor: { name: string; pkg?: string },
    fromRelPath: string,
  ): { className: string; moduleAlias?: string } | undefined => {
    let dir: string | undefined;
    let pkgName: string | undefined;
    let moduleAlias: string | undefined;
    if (ctor.pkg !== undefined) {
      const imp = (ctx.extractions.get(fromRelPath)?.packageImports ?? []).find((p) => p.alias === ctor.pkg);
      if (imp === undefined) return undefined;
      dir = moduleDirOf.get(imp.path);
      if (dir === undefined) return undefined; // constructor package not in repo
      const segs = imp.path.split("/").filter(Boolean);
      pkgName = segs.length > 0 ? segs[segs.length - 1]! : "";
      moduleAlias = ctor.pkg;
    } else {
      dir = dirOf(fromRelPath);
      pkgName = packageClause(fromRelPath);
    }
    const results: string[] = [];
    for (const f of filesByDir.get(dir) ?? []) {
      if (packageClause(f) !== pkgName) continue;
      const rt = ctx.extractions.get(f)?.functionResults?.get(ctor.name);
      if (rt !== undefined) results.push(rt);
    }
    if (results.length !== 1) return undefined; // unknown or ambiguous constructor
    const t = results[0]!.replace(/^\*/, "");
    if (!/^[A-Za-z_]\w*$/.test(t)) return undefined; // qualified/complex results stay untyped
    return moduleAlias !== undefined ? { className: t, moduleAlias } : { className: t };
  };

  const resolveRef = (ref: ExternalCallRef, fromRelPath: string): string | undefined => {
    // constructor-typed receiver var: join to the result type, then re-resolve
    if (ref.constructedBy !== undefined) {
      const typed = constructorBinding(ref.constructedBy, fromRelPath);
      if (typed === undefined) return undefined;
      const synthetic: ExternalCallRef = {
        fromSymbolPath: ref.fromSymbolPath,
        functionName: ref.functionName,
        expressionText: ref.expressionText,
        className: typed.className,
        ...(typed.moduleAlias !== undefined ? { moduleAlias: typed.moduleAlias } : {}),
      };
      return resolveRef(synthetic, fromRelPath);
    }
    // pkg.Fn() / pkg-bound receiver var (`c *http.Client` → c.Get) — through
    // the from-file's import table and the module map
    if (ref.moduleAlias !== undefined) {
      const imp = (ctx.extractions.get(fromRelPath)?.packageImports ?? []).find((p) => p.alias === ref.moduleAlias);
      if (imp === undefined) return undefined;
      const dir = moduleDirOf.get(imp.path);
      if (dir === undefined) return undefined; // stdlib/third-party — isExternalPackage answers
      const segs = imp.path.split("/").filter(Boolean);
      const pkgName = segs.length > 0 ? segs[segs.length - 1]! : "";
      const pkgFiles = (filesByDir.get(dir) ?? []).filter((f) => packageClause(f) === pkgName);
      // pkg.T.Method() — bound receiver var: method on the mapped package's type
      if (ref.className !== undefined) {
        const target = `${ref.className}.${ref.functionName}`;
        const hits = (methods.get(target) ?? []).filter((f) => pkgFiles.includes(f));
        return hits.length === 1 ? idOf(hits[0]!, target) : undefined;
      }
      const files = pkgFiles.filter((f) => (topLevel.get(ref.functionName) ?? []).includes(f));
      return files.length === 1 ? idOf(files[0]!, ref.functionName) : undefined;
    }
    // Type.Method() — same package first (method expressions + receiver-as-type), repo-wide unique second
    if (ref.className !== undefined) {
      const target = `${ref.className}.${ref.functionName}`;
      const hits = methods.get(target) ?? [];
      const fromDir = dirOf(fromRelPath);
      const fromPkg = packageClause(fromRelPath);
      const local = hits.filter((f) => dirOf(f) === fromDir && packageClause(f) === fromPkg);
      if (local.length > 0) return local.length === 1 ? idOf(local[0]!, target) : undefined;
      // repo-wide fallback: test doubles never shadow production types — when
      // production and _test.go files both declare the method, prefer production
      const prod = hits.filter((f) => !f.endsWith("_test.go"));
      const pool = prod.length > 0 ? prod : hits;
      return pool.length === 1 ? idOf(pool[0]!, target) : undefined;
    }
    // bare fn() — unique same-dir same-package top-level, self excluded (extractor owns same-file)
    const fromDir = dirOf(fromRelPath);
    const fromPkg = packageClause(fromRelPath);
    const hits = (topLevel.get(ref.functionName) ?? []).filter(
      (f) => f !== fromRelPath && dirOf(f) === fromDir && packageClause(f) === fromPkg,
    );
    return hits.length === 1 ? idOf(hits[0]!, ref.functionName) : undefined;
  };

  const isExternalPackage = (ref: ExternalCallRef, fromRelPath: string): boolean => {
    if (ref.moduleAlias !== undefined) {
      const imp = (ctx.extractions.get(fromRelPath)?.packageImports ?? []).find((p) => p.alias === ref.moduleAlias);
      if (imp === undefined) return false; // not import-bound — never ours to classify
      return !moduleDirOf.has(imp.path); // no in-repo dir → stdlib/third-party
    }
    if (ref.className === undefined && ref.functionName !== "") {
      // bare Name("x") where Name is a repo-declared type → conversion, not a
      // call — external metric, no edge (same treatment as builtin conversions)
      return GO_PREDECLARED.has(ref.functionName) || GO_CONVERSIONS.has(ref.functionName) || classNames.has(ref.functionName);
    }
    return false; // className misses and dynamic refs stay honest external: edges
  };

  // one edge per imported in-repo package dir (target = the dir's first walked
  // file, deterministic); imports mapping to no walked dir draw nothing (policy A)
  const fileImports = (): { fromRelPath: string; targetRelPath: string }[] => {
    const out: { fromRelPath: string; targetRelPath: string }[] = [];
    for (const file of [...ctx.files].sort()) {
      const dirs = new Set<string>();
      for (const imp of ctx.extractions.get(file)?.packageImports ?? []) {
        const dir = moduleDirOf.get(imp.path);
        const target = dir !== undefined ? filesByDir.get(dir)?.[0] : undefined;
        if (target === undefined || target === file) continue;
        dirs.add(dir!);
      }
      for (const dir of [...dirs].sort()) out.push({ fromRelPath: file, targetRelPath: filesByDir.get(dir)![0]! });
    }
    return out;
  };

  return { resolveRef, isExternalPackage, fileImports };
}

/** exported = capitalized (the Go visibility rule). */
function isExported(name: string): boolean {
  return /^[A-Z]/.test(name);
}

/** Receiver type text with the leading `*` stripped: `*Server` → `Server`. */
function receiverType(receiverList: Node | null, slice: (n: Node) => string): string | undefined {
  if (receiverList === null) return undefined;
  const param = receiverList.namedChildren.find((c) => c !== null && c.type === "parameter_declaration");
  if (param === undefined || param === null) return undefined;
  // parameter_declaration children: [identifier?, ...type nodes] — the type is
  // the last named child that is not the receiver name
  const kids = param.namedChildren.filter((c): c is Node => c !== null);
  const typeNode = kids[kids.length - 1];
  if (typeNode === undefined) return undefined;
  return slice(typeNode).replace(/^\*+/, "");
}

/** A var's statically-known type: bare `T` or import-qualified `pkg.T`. */
type VarBinding = {
  className?: string;
  moduleAlias?: string;
  /** `x := New(...)` / `x := pkg.New(...)` — typed later by the resolver's functionResults join (pass 2). */
  constructedBy?: { name: string; pkg?: string };
};

/** single unnamed result `T` / `*T` → text; named results, qualified or
 * generic types → undefined (the resolver regex-rejects those too — pass 2). */
function simpleResultText(resultNode: Node, slice: (n: Node) => string): string | undefined {
  let n: Node = resultNode;
  let ptr = false;
  if (n.type === "pointer_type") {
    const inner = n.namedChildren.find((c): c is Node => c !== null);
    if (inner === undefined) return undefined;
    n = inner;
    ptr = true;
  }
  if (n.type !== "type_identifier") return undefined;
  return `${ptr ? "*" : ""}${slice(n)}`;
}

/** type node (identifier / pointer / qualified) → binding, or undefined. */
function bindingOfType(typeNode: Node, slice: (n: Node) => string): VarBinding | undefined {  if (typeNode.type === "pointer_type") {
    const inner = typeNode.namedChildren.find((c): c is Node => c !== null);
    return inner === undefined ? undefined : bindingOfType(inner, slice);
  }
  if (typeNode.type === "type_identifier") return { className: slice(typeNode) };
  if (typeNode.type === "qualified_type") {
    const kids = typeNode.namedChildren.filter((c): c is Node => c !== null);
    const [pkg, t] = kids;
    if (pkg === undefined || t === undefined || t.type !== "type_identifier") return undefined;
    return { moduleAlias: slice(pkg), className: slice(t) };
  }
  return undefined;
}

/** initializer expression → binding: `new(T)`, `&T{}`, `T{}`, `pkg.T{}`, `y.(T)`,
 * `New(...)`, `pkg.New(...)` (constructor — typed by the resolver, pass 2). */
function bindingOfExpr(expr: Node, slice: (n: Node) => string): VarBinding | undefined {
  if (expr.type === "expression_list") {
    const first = expr.namedChildren.find((c): c is Node => c !== null);
    return first === undefined ? undefined : bindingOfExpr(first, slice);
  }
  if (expr.type === "call_expression") {
    const fn = expr.childForFieldName("function");
    if (fn === null) return undefined;
    if (fn.type === "identifier") {
      if (slice(fn) !== "new") return { constructedBy: { name: slice(fn) } };
      // `new(T)`'s argument may sit directly or inside an argument_list wrapper.
      const args =
        expr.childForFieldName("arguments") ??
        expr.namedChildren.find((c): c is Node => c !== null && c.id !== fn.id) ??
        null;
      const firstArg =
        args !== null && args.type === "argument_list"
          ? (args.namedChildren.find((c): c is Node => c !== null) ?? null)
          : args;
      return firstArg === null ? undefined : bindingOfType(firstArg, slice);
    }
    if (fn.type === "selector_expression") {
      // `pkg.New(...)` — pkg must be an import alias at join time; a var operand
      // (x.New) fails the resolver's import lookup and stays an honest miss
      const pkg = fn.childForFieldName("operand");
      const field = fn.childForFieldName("field");
      if (pkg !== null && pkg.type === "identifier" && field !== null && field.type === "field_identifier") {
        return { constructedBy: { name: slice(field), pkg: slice(pkg) } };
      }
    }
    return undefined;
  }
  if (expr.type === "unary_expression") {
    const operand = expr.namedChildren.find((c): c is Node => c !== null && c.type !== "operator");
    return operand === undefined ? undefined : bindingOfExpr(operand, slice);
  }
  if (expr.type === "composite_literal") {
    const typeNode = expr.childForFieldName("type");
    return typeNode === null ? undefined : bindingOfType(typeNode, slice);
  }
  if (expr.type === "type_assertion_expression") {
    const typeNode = expr.childForFieldName("type");
    return typeNode === null ? undefined : bindingOfType(typeNode, slice);
  }
  return undefined;
}

class Extractor {
  private readonly nodes: GraphNode[] = [];
  private readonly edges: GraphEdge[] = [];
  private readonly externalRefs: ExternalCallRef[] = [];
  private readonly packageImports: PackageImport[] = [];
  private readonly sinks: SinkSite[] = [];
  private readonly metrics = { callSites: 0, resolved: 0, unresolved: 0, external: 0, unparseable: 0 };

  private get fileId(): string {
    return makeNodeId("File", this.relPath);
  }
  private readonly symbolOfNode = new Map<number, string>();
  private readonly topFns = new Map<string, string>(); // name → Function id
  private readonly classes = new Map<string, { id: string; methods: Map<string, string> }>();
  private readonly importAliases = new Set<string>();
  private readonly edgeKeys = new Set<string>();
  /** scope (symbolPath, "" = package level) → var name → bound type */
  private readonly varBindings = new Map<string, Map<string, VarBinding>>();
  /** top-level function name → declared result type text (pass 2 constructor join). */
  private readonly functionResults = new Map<string, string>();

  constructor(
    private readonly root: Node,
    private readonly relPath: string,
    private readonly slice: (n: Node) => string,
  ) {}

  run(): PackExtraction {
    this.pushFileNode();
    const decls = this.root.namedChildren.filter((c): c is Node => c !== null);
    // declarations the parser could not recover into a named node (probe:
    // `func broken( {` → source_file holds a bare ERROR) still count as dropped
    for (const decl of decls) {
      if (decl.type === "ERROR" || decl.isError || decl.isMissing) this.metrics.unparseable++;
    }
    this.emitTypes(decls); // pass 1: Classes (+ interface methods)
    this.emitFunctions(decls); // pass 2: functions + methods, source order
    this.collectImports(decls);
    this.collectVarBindings(decls); // pass 3: receiver/param/var/type-assertion types (tuning)
    this.walkCalls();
    return {
      nodes: this.nodes,
      edges: this.edges,
      importTargets: [], // Go: module paths are the resolver's business (D2)
      externalRefs: this.externalRefs,
      ...(this.packageImports.length > 0 ? { packageImports: this.packageImports } : {}),
      ...(this.functionResults.size > 0 ? { functionResults: this.functionResults } : {}),
      sinks: this.sinks,
      metrics: this.metrics,
    };
  }

  private named(children: (Node | null)[]): Node[] {
    return children.filter((c): c is Node => c !== null);
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
      language: "go",
    });
  }

  /** pass 1 — type_declaration → type_spec over struct/interface → Class. */
  private emitTypes(decls: Node[]): void {
    for (const decl of decls) {
      if (decl.type !== "type_declaration") continue;
      for (const spec of this.named(decl.namedChildren)) {
        if (spec.type !== "type_spec") continue;
        const nameNode = spec.childForFieldName("name");
        const typeNode = spec.childForFieldName("type");
        if (nameNode === null || typeNode === null) continue;
        const name = this.slice(nameNode);
        if (subtreeIsBroken(spec)) {
          this.metrics.unparseable++;
          continue;
        }
        const qualified = makeQualifiedName(this.relPath, name);
        const id = makeNodeId("Class", qualified);
        const methods = new Map<string, string>();
        this.pushSymbol({
          id,
          kind: "Class",
          name,
          qualifiedName: qualified,
          span: spanFromNode(spec),
          exported: isExported(name),
        });
        this.symbolOfNode.set(spec.id, name);
        if (typeNode.type === "interface_type") this.emitInterfaceMethods(typeNode, name, methods);
        this.classes.set(name, { id, methods });
      }
    }
  }

  /** interface_type children — method_elem hangs DIRECTLY off interface_type
   * (no interface_body wrapper; probe-pinned) → Function `Iface.method`. */
  private emitInterfaceMethods(iface: Node, ifaceName: string, methods: Map<string, string>): void {
    for (const elem of this.named(iface.namedChildren)) {
      if (elem.type !== "method_elem") continue; // property_elem (embedded ifaces): no node
      const nameNode = elem.childForFieldName("name");
      if (nameNode === null) continue;
      const name = this.slice(nameNode);
      const symbolPath = `${ifaceName}.${name}`;
      const id = this.pushFunction(symbolPath, name, elem, isExported(name));
      if (id !== undefined) methods.set(name, id);
    }
  }

  /** pass 2 — function_declaration + method_declaration, source order. */
  private emitFunctions(decls: Node[]): void {
    for (const decl of decls) {
      if (decl.type === "function_declaration") {
        const nameNode = decl.childForFieldName("name");
        if (nameNode === null) continue;
        const name = this.slice(nameNode);
        const id = this.pushFunction(name, name, decl, isExported(name));
        if (id !== undefined) this.topFns.set(name, id);
        const resultNode = decl.childForFieldName("result");
        if (resultNode !== null) {
          const resultText = simpleResultText(resultNode, this.slice);
          if (resultText !== undefined) this.functionResults.set(name, resultText);
        }
      } else if (decl.type === "method_declaration") {
        const nameNode = decl.childForFieldName("name");
        if (nameNode === null) continue;
        const recv = receiverType(decl.childForFieldName("receiver"), this.slice);
        if (recv === undefined) continue;
        const name = this.slice(nameNode);
        const symbolPath = `${recv}.${name}`;
        const id = this.pushFunction(symbolPath, name, decl, isExported(name));
        // register into the in-file class entry when the type is declared here
        // (methods on types declared in a sibling file stay resolvable via D3)
        if (id !== undefined) this.classes.get(recv)?.methods.set(name, id);
      }
    }
  }

  /** Emits a Function node; undefined when dropped as broken. */
  private pushFunction(
    symbolPath: string,
    shortName: string,
    node: Node,
    exported: boolean,
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
      signature: this.signatureOf(node),
    });
    this.symbolOfNode.set(node.id, symbolPath);
    return id;
  }

  private pushSymbol(node: Omit<GraphNode, "filePath" | "language">): void {
    this.nodes.push({ ...node, filePath: this.relPath, language: "go" });
    this.edges.push({ kind: "contains", from: this.fileId, to: node.id });
  }

  /** `(params) result` — the receiver is not repeated (python.ts strips self). */
  private signatureOf(node: Node): string {
    const params = node.childForFieldName("parameters");
    const paramsText = params === null ? "()" : this.slice(params);
    const result = node.childForFieldName("result");
    return truncateSignature(`${paramsText}${result !== null ? ` ${this.slice(result)}` : ""}`);
  }

  /** import specs → packageImports (explicit alias wins; dot/blank skipped). */
  private collectImports(decls: Node[]): void {
    const addSpec = (spec: Node): void => {
      const pathNode = spec.childForFieldName("path");
      if (pathNode === null) return;
      const raw = this.slice(pathNode);
      if (!/^".*"$/s.test(raw)) return;
      const path = raw.slice(1, -1);
      const kids = this.named(spec.namedChildren).filter((c) => c !== pathNode);
      // tree-sitter-go types the explicit import name `package_identifier`
      // (probe: `yaml "gopkg.in/yaml.v3"`); plain identifier kept as fallback
      const aliasNode = kids.find((c) => c.type === "package_identifier" || c.type === "identifier");
      if (aliasNode !== undefined) {
        const alias = this.slice(aliasNode);
        this.packageImports.push({ alias, path });
        this.importAliases.add(alias);
        return;
      }
      // dot / blank_identifier imports contribute nothing (D2)
      if (kids.some((c) => c.type === "dot" || c.type === "blank_identifier")) return;
      const last = path.split("/").filter(Boolean).pop();
      if (last === undefined) return;
      this.packageImports.push({ alias: last, path });
      this.importAliases.add(last);
    };

    for (const decl of decls) {
      if (decl.type !== "import_declaration") continue;
      const kids = this.named(decl.namedChildren);
      const specs = kids.flatMap((c) => (c.type === "import_spec_list" ? this.named(c.namedChildren).filter((s) => s.type === "import_spec") : c.type === "import_spec" ? [c] : []));
      for (const spec of specs) addSpec(spec);
    }
  }

  /** Nearest enclosing emitted symbol; "" = file top level (File node caller). */
  private enclosingSymbol(node: Node): string {
    let current: Node | null = node.parent;
    while (current !== null && current.id !== this.root.id) {
      const symbol = this.symbolOfNode.get(current.id);
      if (symbol !== undefined) return symbol;
      current = current.parent;
    }
    return "";
  }

  /**
   * pass 3 — static var→type bindings (tuning from the testify acceptance run;
   * deterministic, same-file only). Scopes: each function/method body plus one
   * package-level scope. `h, ok := y.(T)` binds only h (the first name); the
   * bool stays unbound. Assignments to declared vars are NOT re-bound.
   */
  private collectVarBindings(decls: Node[]): void {
    const scopeOf = (symbolPath: string): Map<string, VarBinding> => {
      let scope = this.varBindings.get(symbolPath);
      if (scope === undefined) {
        scope = new Map();
        this.varBindings.set(symbolPath, scope);
      }
      return scope;
    };
    const bindParams = (list: Node | null, scope: Map<string, VarBinding>): void => {
      if (list === null) return;
      for (const param of this.named(list.namedChildren)) {
        if (param.type !== "parameter_declaration") continue;
        const kids = this.named(param.namedChildren);
        const typeNode = kids.find((c) => c.type !== "identifier");
        if (typeNode === undefined) continue; // `(x, y)` — names only, no type
        const binding = bindingOfType(typeNode, this.slice);
        if (binding === undefined) continue;
        for (const nameNode of kids) {
          if (nameNode.type !== "identifier") continue;
          scope.set(this.slice(nameNode), binding);
        }
      }
    };
    for (const decl of decls) {
      if (decl.type === "var_declaration") {
        for (const spec of this.named(decl.namedChildren)) {
          if (spec.type !== "var_spec") continue;
          const nameNode = spec.childForFieldName("name");
          if (nameNode === null || nameNode.type !== "identifier") continue;
          const explicitType = spec.childForFieldName("type");
          const value = spec.childForFieldName("value");
          const binding =
            explicitType !== null
              ? bindingOfType(explicitType, this.slice)
              : value !== null
                ? bindingOfExpr(value, this.slice)
                : undefined;
          if (binding !== undefined) scopeOf("").set(this.slice(nameNode), binding);
        }
      } else if (decl.type === "method_declaration" || decl.type === "function_declaration") {
        const symbolPath = this.symbolOfNode.get(decl.id);
        if (symbolPath === undefined) continue; // dropped as broken
        const scope = scopeOf(symbolPath);
        if (decl.type === "method_declaration") {
          const recvType = receiverType(decl.childForFieldName("receiver"), this.slice);
          const recvList = decl.childForFieldName("receiver");
          const param = recvList?.namedChildren.find((c) => c !== null && c.type === "parameter_declaration") ?? null;
          const nameNode = param?.namedChildren.find((c) => c !== null && c.type === "identifier") ?? null;
          if (recvType !== undefined && nameNode !== null) {
            scope.set(this.slice(nameNode), { className: recvType });
          }
        }
        bindParams(decl.childForFieldName("parameters"), scope);
        const body = decl.childForFieldName("body");
        if (body === null) continue;
        this.collectBodyBindings(body, scope);
      }
    }
  }

  /** walk function-body statements for `:=` and inner `var` declarations. */
  private collectBodyBindings(body: Node, scope: Map<string, VarBinding>): void {
    const visit = (node: Node): void => {
      if (node.type === "short_var_declaration") {
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        const firstName = left?.namedChildren.find((c): c is Node => c !== null && c.type === "identifier");
        const firstExpr = right?.namedChildren.find((c): c is Node => c !== null);
        if (firstName !== undefined && firstExpr !== undefined) {
          const binding = bindingOfExpr(firstExpr, this.slice);
          if (binding !== undefined) scope.set(this.slice(firstName), binding);
        }
      } else if (node.type === "var_declaration") {
        for (const spec of this.named(node.namedChildren)) {
          if (spec.type !== "var_spec") continue;
          const nameNode = spec.childForFieldName("name");
          if (nameNode === null || nameNode.type !== "identifier") continue;
          const explicitType = spec.childForFieldName("type");
          const value = spec.childForFieldName("value");
          const binding =
            explicitType !== null
              ? bindingOfType(explicitType, this.slice)
              : value !== null
                ? bindingOfExpr(value, this.slice)
                : undefined;
          if (binding !== undefined) scope.set(this.slice(nameNode), binding);
        }
      }
      for (const child of this.named(node.namedChildren)) visit(child);
    };
    visit(body);
  }

  /** scope-aware: enclosing function's bindings, then package-level vars. */
  private lookupVar(name: string, fromSymbol: string): VarBinding | undefined {
    return this.varBindings.get(fromSymbol)?.get(name) ?? this.varBindings.get("")?.get(name);
  }

  private callerId(symbolPath: string): string {
    if (symbolPath === "") return this.fileId;
    const cls = this.classes.get(symbolPath);
    if (cls !== undefined) return cls.id;
    return makeNodeId("Function", makeQualifiedName(this.relPath, symbolPath));
  }

  private walkCalls(): void {
    const visit = (node: Node): void => {
      if (node.type === "call_expression") this.classifyCall(node);
      for (const child of this.named(node.namedChildren)) visit(child);
    };
    visit(this.root);
  }

  private classifyCall(call: Node): void {
    const from = this.enclosingSymbol(call);
    const callee = call.childForFieldName("function");
    const expressionText = this.slice(call);
    this.metrics.callSites++;
    this.classifySinks(callee, from);

    if (callee === null) {
      this.pushRef(from, { functionName: "", expressionText });
      return;
    }
    if (callee.type === "identifier") {
      const name = this.slice(callee);
      const resolved = this.topFns.get(name);
      if (resolved !== undefined) {
        this.pushResolved(from, resolved);
        return;
      }
      this.pushRef(from, { functionName: name, expressionText }); // bare: never import-bound in Go
      return;
    }
    if (callee.type === "selector_expression") {
      const operand = callee.childForFieldName("operand");
      const field = callee.childForFieldName("field");
      if (operand === null || field === null) {
        this.pushRef(from, { functionName: "", expressionText });
        return;
      }
      const x = this.slice(operand);
      const y = this.slice(field);
      if (this.importAliases.has(x)) {
        this.pushRef(from, { moduleAlias: x, functionName: y, expressionText }, true);
        return;
      }
      const binding = operand.type === "identifier" ? this.lookupVar(x, from) : undefined;
      if (binding !== undefined) {
        this.pushRef(
          from,
          {
            ...(binding.moduleAlias !== undefined ? { moduleAlias: binding.moduleAlias } : {}),
            ...(binding.className !== undefined ? { className: binding.className } : {}),
            ...(binding.constructedBy !== undefined ? { constructedBy: binding.constructedBy } : {}),
            functionName: y,
            expressionText,
          },
          false, // never extract-time external — the resolver decides mapped vs stdlib
        );
        return;
      }
      const sameFile = this.classes.get(x)?.methods.get(y);
      if (sameFile !== undefined) {
        this.pushResolved(from, sameFile);
        return;
      }
      this.pushRef(from, { className: x, functionName: y, expressionText });
      return;
    }
    this.pushRef(from, { functionName: "", expressionText }); // dynamic — honest miss
  }

  private pushResolved(from: string, to: string): void {
    this.metrics.resolved++;
    const fromId = this.callerId(from);
    const key = `${fromId}->${to}`;
    if (this.edgeKeys.has(key)) return;
    this.edgeKeys.add(key);
    this.edges.push({ kind: "calls", from: fromId, to, inferred: true });
  }

  /** externalRef ALWAYS lands (never dropped); import-bound → external metric. */
  private pushRef(from: string, ref: Omit<ExternalCallRef, "fromSymbolPath">, importBound = false): void {
    if (importBound) this.metrics.external++;
    else this.metrics.unresolved++;
    this.externalRefs.push({ fromSymbolPath: from, ...ref });
  }

  /** exact callee-text match against the sink table (python.ts precedent). */
  private classifySinks(callee: Node | null, from: string): void {
    if (callee === null) return;
    if (callee.type !== "identifier" && callee.type !== "selector_expression") return;
    const spec = goSinks.find((s) => s.callee === this.slice(callee));
    if (spec === undefined) return;
    this.sinks.push({ symbolPath: from, spec });
  }
}
