import type {
  ArrowFunction,
  ConstructorDeclaration,
  FunctionDeclaration,
  FunctionExpression,
  GetAccessorDeclaration,
  MethodDeclaration,
  ParameterDeclaration,
  SetAccessorDeclaration,
  SourceFile,
} from "ts-morph";
import { SyntaxKind } from "ts-morph";
import type { GraphEdge, GraphNode, SourceSpan } from "../graph/types.js";
import { makeNodeId, makeQualifiedName } from "../graph/types.js";

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
