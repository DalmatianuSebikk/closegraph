import type { GraphNode, GraphEdge, EdgeKind } from "./types.js";

export interface GraphStats {
  files: number;
  functions: number;
  classes: number;
  edges: number;
  unresolvedCalls: number;
}

export interface GraphStore {
  upsertNode(node: GraphNode): void;
  addEdge(edge: GraphEdge): void;              // dedupes identical edges
  removeFile(fileNodeId: string): void;        // node + contained nodes + all touching edges
  getNode(id: string): GraphNode | undefined;
  nodesOfFile(fileNodeId: string): GraphNode[];
  edgesFrom(id: string, kind?: EdgeKind): GraphEdge[];
  edgesTo(id: string, kind?: EdgeKind): GraphEdge[];
  callers(id: string): GraphNode[];            // resolved calls only
  callees(id: string): GraphNode[];            // resolved calls only
  allNodes(): GraphNode[];
  stats(): GraphStats;
}
