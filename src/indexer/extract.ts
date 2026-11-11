import type {
  ArrowFunction,
  BindingElement,
  CallExpression,
  ClassDeclaration,
  ConstructorDeclaration,
  ExportDeclaration,
  ExportSpecifier,
  FunctionDeclaration,
  FunctionExpression,
  GetAccessorDeclaration,
  Identifier,
  ImportDeclaration,
  ImportSpecifier,
  MethodDeclaration,
  Node,
  ParameterDeclaration,
  Project,
  PropertyAccessExpression,
  PropertyDeclaration,
  SetAccessorDeclaration,
  SourceFile,
  Symbol,
  VariableDeclaration,
  VariableStatement,
} from "ts-morph";
import { SyntaxKind } from "ts-morph";
import type { GraphEdge, GraphNode, SourceSpan } from "../graph/types.js";
import { makeNodeId, makeQualifiedName } from "../graph/types.js";
import { followToDeclaration, moduleSpecifierTarget, toRepoRelative } from "./resolve.js";

export interface FileExtraction {
  nodes: GraphNode[]; // 1 File node + symbol nodes
  edges: GraphEdge[]; // contains edges only at this stage
}

/** Concrete function-like nodes: ts-morph's FunctionLikeDeclaration mixin is not a Node for getText(scope). */
type FunctionNode =
  | FunctionDeclaration
  | MethodDeclaration
  | ConstructorDeclaration
  | ArrowFunction
  | FunctionExpression
  | GetAccessorDeclaration
  | SetAccessorDeclaration;

const MAX_SIGNATURE_LENGTH = 120;

function spanOf(sourceFile: SourceFile, startPos: number, endPos: number): SourceSpan {
  const start = sourceFile.getLineAndColumnAtPos(startPos);
  const end = sourceFile.getLineAndColumnAtPos(endPos);
  return {
    start: { line: start.line, col: start.column },
    end: { line: end.line, col: end.column },
  };
}

function truncate(text: string): string {
  return text.length > MAX_SIGNATURE_LENGTH ? `${text.slice(0, MAX_SIGNATURE_LENGTH - 1)}…` : text;
}

function parameterText(param: ParameterDeclaration): string {
  const optional = param.isOptional() ? "?" : "";
  const rest = param.isRestParameter() ? "..." : "";
  let typeText = "unknown";
  try {
    typeText = param.getType().getText(param);
  } catch {
    // a parameter whose type cannot be rendered still yields a signature
  }
  return `${rest}${param.getName()}${optional}: ${typeText}`;
}

function signatureOf(fn: FunctionNode, fallbackReturn?: string): string {
  const params = fn.getParameters().map(parameterText).join(", ");
  let returnType = fallbackReturn;
  if (returnType === undefined) {
    try {
      returnType = fn.getReturnType().getText(fn);
    } catch {
      returnType = "unknown";
    }
  }
  return truncate(`(${params}) => ${returnType}`);
}

/** Names of each file's symbols that other project files re-export (e.g. via a barrel). */
export type ReExportMap = Map<SourceFile, Set<string>>;

/** Precomputes the re-export map once per run; per-file scans are O(N²) at pipeline scale. */
export function collectReExportMap(project: Project): ReExportMap {
  const map: ReExportMap = new Map();
  for (const sf of project.getSourceFiles()) {
    if (sf.isFromExternalLibrary()) continue;
    for (const exportDecl of sf.getExportDeclarations()) {
      const target = moduleSpecifierTarget(exportDecl);
      if (target === undefined) continue;
      let names = map.get(target);
      if (names === undefined) {
        names = new Set();
        map.set(target, names);
      }
      // `export * from "./mod"` re-exports every non-default export of the target
      // under its own name; `export * as ns` exports one symbol (ns) and is skipped.
      // ts-morph's isExported() misses the declaration-site fallback for variable
      // statements (`const helper = …; export { helper };`), so accumulate the
      // target's export names and let the extraction sites mark them exported.
      if (exportDecl.isNamespaceExport() && exportDecl.getNamespaceExport() === undefined) {
        for (const symbol of target.getExportSymbols()) {
          const name = symbol.getName();
          if (name !== "default") names.add(name); // star re-export never carries default
        }
      }
      for (const spec of exportDecl.getNamedExports()) names.add(spec.getName());
    }
  }
  return map;
}

function posixBasename(path: string): string {
  return path.split("/").pop() ?? path;
}

export function extractFileSymbols(sourceFile: SourceFile, relPath: string, reExportedNames?: Set<string>): FileExtraction {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const fileId = makeNodeId("File", relPath);
  nodes.push({
    id: fileId,
    kind: "File",
    name: posixBasename(relPath),
    qualifiedName: relPath,
    filePath: relPath,
    span: spanOf(sourceFile, sourceFile.getStart(), sourceFile.getEnd()),
    exported: true,
  });

  const reExported = reExportedNames ?? collectReExportMap(sourceFile.getProject()).get(sourceFile) ?? new Set<string>();

  const addSymbol = (node: GraphNode): void => {
    nodes.push(node);
    edges.push({ kind: "contains", from: fileId, to: node.id });
  };

  const addFunctionSymbol = (
    symbolPath: string,
    shortName: string,
    decl: { getStart(): number; getEnd(): number },
    fn: FunctionNode,
    exported: boolean,
    fallbackReturn?: string,
  ): void => {
    const qualifiedName = makeQualifiedName(relPath, symbolPath);
    addSymbol({
      id: makeNodeId("Function", qualifiedName),
      kind: "Function",
      name: shortName,
      qualifiedName,
      filePath: relPath,
      span: spanOf(sourceFile, decl.getStart(), decl.getEnd()),
      signature: signatureOf(fn, fallbackReturn),
      exported,
    });
  };

  for (const cls of sourceFile.getClasses()) {
    const className = cls.getName();
    if (className === undefined) continue; // anonymous classes have no stable symbol path
    const classExported = cls.isExported() || reExported.has(className);
    const qualifiedName = makeQualifiedName(relPath, className);
    addSymbol({
      id: makeNodeId("Class", qualifiedName),
      kind: "Class",
      name: className,
      qualifiedName,
      filePath: relPath,
      span: spanOf(sourceFile, cls.getStart(), cls.getEnd()),
      exported: classExported,
    });
    // methods (incl. constructors, getters/setters) become Function nodes; there is
    // no isExported() on class members, so they follow their class's export status
    for (const ctor of cls.getConstructors()) {
      addFunctionSymbol(`${className}.constructor`, "constructor", ctor, ctor, classExported, className);
    }
    const members = [
      ...cls.getMethods(),
      ...cls.getGetAccessors(),
      ...cls.getSetAccessors(),
    ];
    for (const member of members) {
      const memberName = member.getName();
      if (memberName === undefined) continue;
      addFunctionSymbol(`${className}.${memberName}`, memberName, member, member, classExported);
    }
    // function-valued class properties (arrow/function-expression initializers)
    // are Function nodes too, e.g. `static flushSave = () => …` → `Class.flushSave`
    for (const prop of cls.getProperties()) {
      if (prop.getNameNode().getKind() !== SyntaxKind.Identifier) continue;
      const init = prop.getInitializer();
      if (init === undefined) continue;
      if (init.getKind() !== SyntaxKind.ArrowFunction && init.getKind() !== SyntaxKind.FunctionExpression) continue;
      const propName = prop.getName();
      addFunctionSymbol(`${className}.${propName}`, propName, prop, init as ArrowFunction | FunctionExpression, classExported);
    }
  }

  for (const fn of sourceFile.getFunctions()) {
    const name = fn.getName();
    if (name === undefined) continue; // anonymous functions produce no node (naming policy)
    addFunctionSymbol(name, name, fn, fn, fn.isExported() || reExported.has(name));
  }

  for (const stmt of sourceFile.getVariableStatements()) {
    for (const decl of stmt.getDeclarations()) {
      if (decl.getNameNode().getKind() !== SyntaxKind.Identifier) continue;
      const init = decl.getInitializer();
      if (init === undefined) continue;
      if (init.getKind() !== SyntaxKind.ArrowFunction && init.getKind() !== SyntaxKind.FunctionExpression) continue;
      const fn = init as ArrowFunction | FunctionExpression;
      const name = decl.getName();
      const exported = stmt.isExported() || reExported.has(name);
      addFunctionSymbol(name, name, decl, fn, exported);
    }
  }

  // nested function-valued locals become Function nodes under their enclosing
  // symbol (`page.fetchData`); exported is false by construction
  for (const decl of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    if (decl.getParent()?.getParent()?.getKind() === SyntaxKind.VariableStatement) {
      const stmt = decl.getParent()!.getParent() as VariableStatement;
      if (stmt.getParent()?.getKind() === SyntaxKind.SourceFile) continue; // handled above
    }
    if (decl.getNameNode().getKind() !== SyntaxKind.Identifier) continue;
    const init = decl.getInitializer();
    if (init === undefined) continue;
    if (init.getKind() !== SyntaxKind.ArrowFunction && init.getKind() !== SyntaxKind.FunctionExpression) continue;
    const path = symbolPathOf(decl);
    if (path === undefined) continue;
    addFunctionSymbol(path, decl.getName(), decl, init as ArrowFunction | FunctionExpression, false);
  }

  return { nodes, edges };
}

export interface CallMetrics {
  callSites: number;
  resolved: number;
  external: number;
  unresolved: number;
}

/** One classified call site; exposed for diagnostics (benchmark breakdowns). */
export interface CallSiteInfo {
  outcome: CalleeOutcome;
  declKinds: string[]; // declaration kinds the callee symbol resolved to (empty = none found)
}

export interface FullFileExtraction extends FileExtraction {
  callEdges: GraphEdge[];
  metrics: CallMetrics;
}

type CalleeOutcome =
  | { kind: "node"; id: string }
  | { kind: "external" }
  | { kind: "unresolved"; targetName: string };

export type { CalleeOutcome };

/** Runs Tasks 8+9 logic plus call extraction for one file. */
export function extractFile(
  project: Project,
  sourceFile: SourceFile,
  repoRoot: string,
  relPath: string,
  reExportedNames?: Set<string>,
  onCallSite?: (info: CallSiteInfo) => void,
): FullFileExtraction {
  const base = extractFileSymbols(sourceFile, relPath, reExportedNames);
  const callEdges: GraphEdge[] = [];
  const seen = new Set<string>();
  const metrics: CallMetrics = { callSites: 0, resolved: 0, external: 0, unresolved: 0 };

  for (const callExpr of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const fromId = enclosingSymbolId(callExpr, relPath);
    if (fromId === undefined) continue; // module-top-level call: no enclosing named symbol (calls in class property initializers attribute to the Class node)
    metrics.callSites++;

    const { outcome, declKinds } = resolveCallee(project, callExpr, repoRoot);
    onCallSite?.({ outcome, declKinds });
    if (outcome.kind === "node") {
      metrics.resolved++;
      const key = `${fromId}->${outcome.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        callEdges.push({ kind: "calls", from: fromId, to: outcome.id });
      }
    } else if (outcome.kind === "external") {
      metrics.external++;
    } else {
      metrics.unresolved++;
      const to = `external:${outcome.targetName}`;
      const key = `${fromId}->${to}`;
      if (!seen.has(key)) {
        seen.add(key);
        // first classification is final: the store is first-write-wins per (kind, from, to)
        callEdges.push({ kind: "calls", from: fromId, to, unresolved: true, targetName: outcome.targetName });
      }
    }
  }

  return { nodes: base.nodes, edges: base.edges, callEdges, metrics };
}

function parentClassNameOf(node: Node): string | undefined {
  const parent = node.getParent();
  if (parent === undefined || parent.getKind() !== SyntaxKind.ClassDeclaration) return undefined;
  // mirror of extractFileSymbols (sourceFile.getClasses()): only top-level classes
  // and their members become nodes — members of nested classes produce none
  if (!isTopLevel(parent)) return undefined;
  return (parent as ClassDeclaration).getName() ?? undefined;
}

function isTopLevel(node: Node): boolean {
  return node.getParent()?.getKind() === SyntaxKind.SourceFile;
}

/**
 * Canonical symbol path for any node the naming policy extracts; undefined when
 * the node produces no node. Single source of truth shared by extraction
 * (extractFileSymbols) and declaration mapping (nodeIdFor).
 */
function symbolPathOf(node: Node): string | undefined {
  switch (node.getKind()) {
    case SyntaxKind.ClassDeclaration: {
      const cls = node as ClassDeclaration;
      const name = cls.getName();
      return name !== undefined && isTopLevel(cls) ? name : undefined;
    }
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor: {
      const cls = parentClassNameOf(node);
      const name = (node as MethodDeclaration | GetAccessorDeclaration | SetAccessorDeclaration).getName();
      return cls !== undefined && name !== undefined ? `${cls}.${name}` : undefined;
    }
    case SyntaxKind.Constructor: {
      const cls = parentClassNameOf(node);
      return cls !== undefined ? `${cls}.constructor` : undefined;
    }
    case SyntaxKind.PropertyDeclaration: {
      const prop = node as PropertyDeclaration;
      if (prop.getNameNode().getKind() !== SyntaxKind.Identifier) return undefined;
      const init = prop.getInitializer();
      if (init === undefined) return undefined;
      if (init.getKind() !== SyntaxKind.ArrowFunction && init.getKind() !== SyntaxKind.FunctionExpression) return undefined;
      const cls = parentClassNameOf(node);
      return cls !== undefined ? `${cls}.${prop.getName()}` : undefined;
    }
    case SyntaxKind.FunctionDeclaration: {
      const fn = node as FunctionDeclaration;
      const name = fn.getName();
      return name !== undefined && isTopLevel(fn) ? name : undefined;
    }
    case SyntaxKind.VariableDeclaration: {
      // function-valued variables anywhere in the file: nested locals are named
      // after their nearest enclosing extracted symbol (`page.fetchData`)
      const decl = node as VariableDeclaration;
      if (decl.getNameNode().getKind() !== SyntaxKind.Identifier) return undefined;
      const init = decl.getInitializer();
      if (init === undefined) return undefined;
      if (init.getKind() !== SyntaxKind.ArrowFunction && init.getKind() !== SyntaxKind.FunctionExpression) return undefined;
      const owner = enclosingSymbolPath(decl);
      if (owner === undefined) return undefined;
      return owner === "" ? decl.getName() : `${owner}.${decl.getName()}`;
    }
    default:
      return undefined;
  }
}

/** Symbol path of the nearest enclosing extracted symbol; "" when directly at top level. */
function enclosingSymbolPath(node: Node): string {
  let current: Node | undefined = node.getParent();
  while (current !== undefined && !current.isKind(SyntaxKind.SourceFile)) {
    const path = symbolPathOf(current);
    if (path !== undefined) return path;
    current = current.getParent();
  }
  return "";
}

/** Node id for a ts-morph node under the naming policy, or undefined when it produces no node. */
function nodeIdFor(node: Node, relPath: string): string | undefined {
  const path = symbolPathOf(node);
  if (path === undefined) return undefined;
  const qualifiedName = makeQualifiedName(relPath, path);
  return makeNodeId(node.getKind() === SyntaxKind.ClassDeclaration ? "Class" : "Function", qualifiedName);
}

/** Enclosing named symbol for a call site; anonymous callbacks attribute to the enclosing named symbol. */
function enclosingSymbolId(node: Node, relPath: string): string | undefined {
  let current: Node | undefined = node.getParent();
  while (current !== undefined && !current.isKind(SyntaxKind.SourceFile)) {
    if (current.getKind() === SyntaxKind.ArrowFunction || current.getKind() === SyntaxKind.FunctionExpression) {
      // the function node itself only exists when it is a variable's initializer
      const parent = current.getParent();
      if (parent === undefined || parent.getKind() !== SyntaxKind.VariableDeclaration) {
        current = current.getParent();
        continue;
      }
    }
    const id = nodeIdFor(current, relPath);
    if (id !== undefined) return id;
    current = current.getParent();
  }
  return undefined;
}

const MAX_SPECIFIER_FOLLOW_DEPTH = 5;

/** Module source file behind an import/export specifier declaration, if any. */
function moduleTargetOf(decl: Node): SourceFile | undefined {
  // ImportSpecifier → NamedImports → ImportDeclaration (same shape for exports)
  let current: Node | undefined = decl;
  for (let i = 0; i < 3 && current !== undefined; i++) {
    current = current.getParent();
    if (current === undefined) return undefined;
    if (current.getKind() === SyntaxKind.ImportDeclaration || current.getKind() === SyntaxKind.ExportDeclaration) {
      try {
        return (current as ImportDeclaration | ExportDeclaration).getModuleSpecifierSourceFile() ?? undefined;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Top-level declarations of `name` in a file (mirrors the extraction walk). */
/** Top-level declarations of `name` in a file (mirrors the extraction walk); "default" maps to the default export. */
function declarationsOfNameIn(sf: SourceFile, name: string): Node[] {
  if (name === "default") {
    // narrower than resolve.ts's fileDeclares on purpose: only extractable kinds
    try {
      const symbol = sf.getDefaultExportSymbol();
      if (symbol === undefined) return [];
      try {
        const aliased = symbol.getAliasedSymbol();
        if (aliased !== undefined) {
          const aliasedDecls = aliased.getDeclarations();
          if (aliasedDecls.length > 0) return aliasedDecls;
        }
      } catch {
        // not an alias — fall through to the symbol's own declarations
      }
      return symbol.getDeclarations();
    } catch {
      return [];
    }
  }
  const out: Node[] = [];
  const fn = sf.getFunction(name);
  if (fn !== undefined) out.push(fn);
  const cls = sf.getClass(name);
  if (cls !== undefined) out.push(cls);
  const vd = sf.getVariableDeclaration(name);
  if (vd !== undefined) out.push(vd);
  return out;
}

/** Declarations the checker resolves an import/export binding alias to (empty when not an alias or unresolvable). */
function aliasedDeclarationsOf(decl: Node): Node[] {
  try {
    const symbol = decl.getSymbol();
    if (symbol === undefined) return [];
    const aliased = symbol.getAliasedSymbol();
    if (aliased === undefined) return [];
    return aliased.getDeclarations();
  } catch {
    return [];
  }
}

/**
 * Replaces import/export bindings with the real declarations they point at.
 * Checker first: alias resolution walks whole re-export chains, including
 * default imports (declaration is the ImportClause) and aliased re-exports
 * (`export { named as Y }`). The manual fallback looks the ORIGINAL name up
 * in the module target — for `export { a as B }` the target declares `a`.
 */
function followSpecifiers(project: Project, decl: Node, depth: number): Node[] {
  if (depth >= MAX_SPECIFIER_FOLLOW_DEPTH) return [];
  const kind = decl.getKind();
  if (kind !== SyntaxKind.ImportClause && kind !== SyntaxKind.ImportSpecifier && kind !== SyntaxKind.ExportSpecifier) {
    return [decl];
  }
  const aliased = aliasedDeclarationsOf(decl);
  if (aliased.length > 0) {
    return aliased.flatMap((d) => followSpecifiers(project, d, depth + 1));
  }
  const target = moduleTargetOf(decl);
  if (target === undefined) return [];
  if (kind === SyntaxKind.ImportClause) {
    // `import X from "mod"`: the target's default export
    return declarationsOfNameIn(target, "default").flatMap((d) => followSpecifiers(project, d, depth + 1));
  }
  const name = (decl as ImportSpecifier | ExportSpecifier).getName();
  if (name === undefined) return [];
  const followed = followToDeclaration(project, target, name);
  if (followed === undefined) return [];
  return declarationsOfNameIn(followed, name).flatMap((d) => followSpecifiers(project, d, depth + 1));
}

function isExternalFile(sf: SourceFile): boolean {
  if (sf.isFromExternalLibrary()) return true;
  const path = sf.getFilePath();
  return path.includes("/node_modules/") || /^lib\..*\.d\.ts$/.test(posixBasename(path));
}

type DeclarationClass =
  | { kind: "node"; id: string }
  | { kind: "external" }       // node_modules, lib.*.d.ts, builtins, outside the repo
  | { kind: "unextractable" }; // project-local declaration that lands in no node we extract

function classifyDeclaration(decl: Node, repoRoot: string): DeclarationClass {
  const sf = decl.getSourceFile();
  const rel = toRepoRelative(sf.getFilePath(), repoRoot);
  if (rel === undefined || rel.includes("/node_modules/") || isExternalFile(sf)) {
    return { kind: "external" };
  }
  const id = nodeIdFor(decl, rel);
  return id === undefined ? { kind: "unextractable" } : { kind: "node", id };
}

function bestEffortName(expr: Node): string {
  return expr.getText();
}

/** Leftmost identifier of an expression chain, descending through property accesses and call results. */
function leftmostIdentifier(node: Node): Identifier | undefined {
  let current: Node = node;
  for (let depth = 0; depth < 10 && current !== undefined; depth++) {
    if (current.getKind() === SyntaxKind.Identifier) return current as Identifier;
    if (current.getKind() === SyntaxKind.PropertyAccessExpression) {
      current = (current as PropertyAccessExpression).getExpression();
      continue;
    }
    if (current.getKind() === SyntaxKind.CallExpression) {
      current = (current as CallExpression).getExpression();
      continue;
    }
    return undefined;
  }
  return undefined;
}

/** True when `name` is imported through a bare specifier that fails to resolve to a project file. */
function nameBindsToUnresolvedBareImport(sourceFile: SourceFile, name: string): boolean {
  for (const importDecl of sourceFile.getImportDeclarations()) {
    const specifier = importDecl.getModuleSpecifierValue();
    if (specifier === undefined || specifier.startsWith(".") || specifier.startsWith("/")) continue;
    let target: SourceFile | undefined;
    try {
      target = importDecl.getModuleSpecifierSourceFile() ?? undefined;
    } catch {
      target = undefined;
    }
    if (target !== undefined) continue; // resolves (e.g. via tsconfig paths): project-local, not external
    const clause = importDecl.getImportClause();
    if (clause === undefined) continue;
    if (clause.getDefaultImport()?.getText() === name) return true;
    if (clause.getNamespaceImport()?.getText() === name) return true;
    for (const named of clause.getNamedImports()) {
      if (named.getName() === name || named.getAliasNode()?.getText() === name) return true;
    }
  }
  return false;
}

/**
 * True when the callee's value originates in an external package that is not
 * installed: the expression's leftmost identifier binds to an unresolvable bare
 * import, directly or through a destructured binding whose initializer is that
 * import's call (e.g. `const [, forceRefresh] = useState(false)` → react).
 * Failed relative imports and unknown local names stay unresolved.
 */
function bindsToUnresolvedBareImport(sourceFile: SourceFile, expr: Node): boolean {
  let base = leftmostIdentifier(expr);
  for (let hops = 0; base !== undefined && hops < 4; hops++) {
    if (nameBindsToUnresolvedBareImport(sourceFile, base.getText())) return true;
    // follow a destructured binding back to its initializer's origin call
    let bindingDecl: Node | undefined;
    try {
      bindingDecl = base.getSymbol()?.getDeclarations().find((d) => d.getKind() === SyntaxKind.BindingElement);
    } catch {
      bindingDecl = undefined;
    }
    if (bindingDecl === undefined) return false;
    const varDecl = bindingDecl.getParent()?.getParent();
    if (varDecl === undefined || varDecl.getKind() !== SyntaxKind.VariableDeclaration) return false;
    const initializer = (varDecl as VariableDeclaration).getInitializer();
    if (initializer === undefined || initializer.getKind() !== SyntaxKind.CallExpression) return false;
    base = leftmostIdentifier(initializer);
  }
  return false;
}

/**
 * Checker-driven resolution for destructured bindings: `const { x } = origin` (or a
 * destructured parameter) resolves through origin's type — e.g. a `typeof import(...)`
 * module namespace yields the real exported declarations. Interfaces yield signatures,
 * which downstream classification keeps unresolved.
 */
function bindingElementDeclarations(decl: Node): Node[] {
  const binding = decl as BindingElement;
  const propName = (binding.getPropertyNameNode() ?? binding.getNameNode()).getText();
  const pattern = binding.getParent();
  if (pattern === undefined) return [];
  if (pattern.getKind() !== SyntaxKind.ObjectBindingPattern && pattern.getKind() !== SyntaxKind.ArrayBindingPattern) return [];
  const owner = pattern.getParent();
  if (owner === undefined) return [];
  let originNode: Node | undefined;
  if (owner.getKind() === SyntaxKind.VariableDeclaration) {
    originNode = (owner as VariableDeclaration).getInitializer();
  } else if (owner.getKind() === SyntaxKind.Parameter) {
    originNode = owner; // the parameter's own type is the origin
  }
  if (originNode === undefined) return [];
  let type;
  try {
    type = originNode.getType();
  } catch {
    return [];
  }
  let prop;
  try {
    prop = type.getProperty(propName);
  } catch {
    return [];
  }
  if (prop === undefined) return [];
  try {
    return prop.getDeclarations();
  } catch {
    return [];
  }
}

function resolveCallee(project: Project, callExpr: CallExpression, repoRoot: string): { outcome: CalleeOutcome; declKinds: string[] } {
  const expr = callExpr.getExpression();
  const targetName = bestEffortName(expr);

  let symbol: Symbol | undefined;
  try {
    const nameNode = expr.getKind() === SyntaxKind.PropertyAccessExpression
      ? (expr as PropertyAccessExpression).getNameNode()
      : expr;
    symbol = nameNode.getSymbol();
  } catch {
    symbol = undefined;
  }

  let decls: Node[] = [];
  if (symbol !== undefined) {
    try {
      decls = symbol.getDeclarations();
    } catch {
      decls = [];
    }
    if (decls.length === 0) {
      try {
        decls = symbol.getAliasedSymbol()?.getDeclarations() ?? [];
      } catch {
        decls = [];
      }
    }
  }

  decls = decls
    .flatMap((decl) => followSpecifiers(project, decl, 0))
    .flatMap((decl) => {
      if (decl.getKind() !== SyntaxKind.BindingElement) return [decl];
      const followed = bindingElementDeclarations(decl).flatMap((extra) => followSpecifiers(project, extra, 0));
      return [decl, ...followed];
    });
  const declKinds = decls.map((decl) => decl.getKindName());
  if (decls.length === 0) {
    return { outcome: externalOriginOutcome(callExpr, expr, targetName), declKinds };
  }

  const outcomes = decls.map((decl) => classifyDeclaration(decl, repoRoot));
  const resolved = outcomes.find((o) => o.kind === "node");
  if (resolved !== undefined) return { outcome: resolved, declKinds };
  if (outcomes.some((o) => o.kind === "external")) {
    return { outcome: { kind: "external" }, declKinds };
  }
  // declaration found but it lands in no node we extract (member of a nested class,
  // destructured hook binding, parameter, …): unresolved edge to external:<bestEffortName>
  // unless the value originates in an unresolvable external package
  return { outcome: externalOriginOutcome(callExpr, expr, targetName), declKinds };
}

/** Unresolved by default; external when the callee originates in an uninstalled package. */
function externalOriginOutcome(callExpr: CallExpression, expr: Node, targetName: string): CalleeOutcome {
  if (bindsToUnresolvedBareImport(callExpr.getSourceFile(), expr)) return { kind: "external" };
  return { kind: "unresolved", targetName };
}
