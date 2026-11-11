import type {
  ArrowFunction,
  CallExpression,
  ClassDeclaration,
  ConstructorDeclaration,
  ExportDeclaration,
  ExportSpecifier,
  FunctionDeclaration,
  FunctionExpression,
  GetAccessorDeclaration,
  ImportDeclaration,
  ImportSpecifier,
  MethodDeclaration,
  Node,
  ParameterDeclaration,
  Project,
  PropertyAccessExpression,
  SetAccessorDeclaration,
  SourceFile,
  Symbol,
  VariableDeclaration,
} from "ts-morph";
import { SyntaxKind } from "ts-morph";
import { relative, resolve } from "node:path";
import type { GraphEdge, GraphNode, SourceSpan } from "../graph/types.js";
import { makeNodeId, makeQualifiedName } from "../graph/types.js";
import { followToDeclaration } from "./resolve.js";

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

/** Names of this file's symbols that other project files re-export (e.g. via a barrel). */
function collectReExportedNames(sourceFile: SourceFile): Set<string> {
  const names = new Set<string>();
  for (const sf of sourceFile.getProject().getSourceFiles()) {
    if (sf === sourceFile || sf.isFromExternalLibrary()) continue;
    for (const exportDecl of sf.getExportDeclarations()) {
      let target: SourceFile | undefined;
      try {
        target = exportDecl.getModuleSpecifierSourceFile();
      } catch {
        target = undefined;
      }
      if (target !== sourceFile) continue;
      for (const spec of exportDecl.getNamedExports()) names.add(spec.getName());
    }
  }
  return names;
}

function posixBasename(path: string): string {
  return path.split("/").pop() ?? path;
}

export function extractFileSymbols(sourceFile: SourceFile, relPath: string): FileExtraction {
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

  const reExported = collectReExportedNames(sourceFile);

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

  return { nodes, edges };
}

export interface CallMetrics {
  callSites: number;
  resolved: number;
  external: number;
  unresolved: number;
}

export interface FullFileExtraction extends FileExtraction {
  callEdges: GraphEdge[];
  metrics: CallMetrics;
}

type CalleeOutcome =
  | { kind: "node"; id: string }
  | { kind: "external" }
  | { kind: "unresolved"; targetName: string };

/** Runs Tasks 8+9 logic plus call extraction for one file. */
export function extractFile(project: Project, sourceFile: SourceFile, repoRoot: string, relPath: string): FullFileExtraction {
  const base = extractFileSymbols(sourceFile, relPath);
  const callEdges: GraphEdge[] = [];
  const seen = new Set<string>();
  const metrics: CallMetrics = { callSites: 0, resolved: 0, external: 0, unresolved: 0 };

  for (const callExpr of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const fromId = enclosingSymbolId(callExpr, relPath);
    if (fromId === undefined) continue; // call outside any named symbol (e.g. class property initializer)
    metrics.callSites++;

    const outcome = resolveCallee(project, callExpr, repoRoot);
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

/** Repo-relative posix path of an absolute path, or undefined when it escapes the repo. */
function repoRelativeOf(absPath: string, repoRoot: string): string | undefined {
  const rel = relative(resolve(repoRoot), resolve(absPath));
  if (rel === "" || rel.startsWith("..")) return undefined;
  return rel.split(/[\\/]/).join("/");
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

/** Node id for a ts-morph node under the naming policy, or undefined when it produces no node. */
function nodeIdFor(node: Node, relPath: string): string | undefined {
  switch (node.getKind()) {
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor: {
      const cls = parentClassNameOf(node);
      const name = (node as MethodDeclaration | GetAccessorDeclaration | SetAccessorDeclaration).getName();
      if (cls === undefined || name === undefined) return undefined;
      return makeNodeId("Function", makeQualifiedName(relPath, `${cls}.${name}`));
    }
    case SyntaxKind.Constructor: {
      const cls = parentClassNameOf(node);
      return cls === undefined ? undefined : makeNodeId("Function", makeQualifiedName(relPath, `${cls}.constructor`));
    }
    case SyntaxKind.FunctionDeclaration: {
      const fn = node as FunctionDeclaration;
      const name = fn.getName();
      if (name === undefined || !isTopLevel(fn)) return undefined;
      return makeNodeId("Function", makeQualifiedName(relPath, name));
    }
    case SyntaxKind.ClassDeclaration: {
      const cls = node as ClassDeclaration;
      const name = cls.getName();
      if (name === undefined || !isTopLevel(cls)) return undefined;
      return makeNodeId("Class", makeQualifiedName(relPath, name));
    }
    case SyntaxKind.VariableDeclaration: {
      const decl = node as VariableDeclaration;
      if (decl.getNameNode().getKind() !== SyntaxKind.Identifier) return undefined;
      const init = decl.getInitializer();
      if (init === undefined) return undefined;
      if (init.getKind() !== SyntaxKind.ArrowFunction && init.getKind() !== SyntaxKind.FunctionExpression) return undefined;
      // mirror of extractFileSymbols: only top-level variable statements produce nodes
      const stmt = decl.getParent()?.getParent();
      if (stmt === undefined || stmt.getParent()?.getKind() !== SyntaxKind.SourceFile) return undefined;
      return makeNodeId("Function", makeQualifiedName(relPath, decl.getName()));
    }
    default:
      return undefined;
  }
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
function declarationsOfNameIn(sf: SourceFile, name: string): Node[] {
  const out: Node[] = [];
  const fn = sf.getFunction(name);
  if (fn !== undefined) out.push(fn);
  const cls = sf.getClass(name);
  if (cls !== undefined) out.push(cls);
  const vd = sf.getVariableDeclaration(name);
  if (vd !== undefined) out.push(vd);
  return out;
}

/** Replaces import/export specifier declarations with the real declarations they point at. */
function followSpecifiers(project: Project, decl: Node, depth: number): Node[] {
  if (depth >= MAX_SPECIFIER_FOLLOW_DEPTH) return [];
  if (decl.getKind() !== SyntaxKind.ImportSpecifier && decl.getKind() !== SyntaxKind.ExportSpecifier) {
    return [decl];
  }
  const name = (decl as ImportSpecifier | ExportSpecifier).getName();
  if (name === undefined) return [];
  const target = moduleTargetOf(decl);
  if (target === undefined) return [];
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
  const rel = repoRelativeOf(sf.getFilePath(), repoRoot);
  if (rel === undefined || rel.includes("/node_modules/") || isExternalFile(sf)) {
    return { kind: "external" };
  }
  const id = nodeIdFor(decl, rel);
  return id === undefined ? { kind: "unextractable" } : { kind: "node", id };
}

function bestEffortName(expr: Node): string {
  return expr.getText();
}

function resolveCallee(project: Project, callExpr: CallExpression, repoRoot: string): CalleeOutcome {
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

  decls = decls.flatMap((decl) => followSpecifiers(project, decl, 0));
  if (decls.length === 0) return { kind: "unresolved", targetName };

  const outcomes = decls.map((decl) => classifyDeclaration(decl, repoRoot));
  const resolved = outcomes.find((o) => o.kind === "node");
  if (resolved !== undefined) return resolved;
  if (outcomes.some((o) => o.kind === "external")) return { kind: "external" };
  // declaration found but it lands in no node we extract (member of a nested class,
  // nested function, parameter, …): unresolved edge to external:<bestEffortName>
  return { kind: "unresolved", targetName };
}
