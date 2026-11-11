export type NodeKind = "File" | "Function" | "Class";

export interface SourceSpan {
  start: { line: number; col: number };
  end: { line: number; col: number };
}

export interface GraphNode {
  id: string;            // `${kind}:${qualifiedName}`
  kind: NodeKind;
  name: string;          // short name, e.g. "login"
  qualifiedName: string; // "src/auth/login.ts#AuthService.login"
  filePath: string;      // repo-relative, posix separators
  span: SourceSpan;
  signature?: string;    // functions only, ≤120 chars
  exported: boolean;
}

export type EdgeKind = "contains" | "imports" | "calls";

export interface GraphEdge {
  kind: EdgeKind;
  from: string;          // node id
  to: string;            // node id, or `external:${targetName}` when unresolved
  unresolved?: boolean;  // calls only
  targetName?: string;   // best-effort callee name when unresolved
}

export function makeQualifiedName(relPath: string, symbolPath: string): string {
  return `${relPath}#${symbolPath}`;
}

export function makeNodeId(kind: NodeKind, qualifiedName: string): string {
  return `${kind}:${qualifiedName}`;
}

export function disambiguateId(id: string, contentHash: string): string {
  return `${id}@${contentHash.slice(0, 8)}`;
}
