import type { GraphNode, GraphEdge, EdgeKind } from "./types.js";
import type { GraphStore, GraphStats } from "./store.js";

function sameEdge(a: GraphEdge, b: GraphEdge): boolean {
  return a.kind === b.kind && a.from === b.from && a.to === b.to;
}

function isResolvedCall(e: GraphEdge): boolean {
  return e.kind === "calls" && !e.unresolved;
}

class MemoryStore implements GraphStore {
  private nodes = new Map<string, GraphNode>();
  private out = new Map<string, GraphEdge[]>();
  private inc = new Map<string, GraphEdge[]>();

  upsertNode(node: GraphNode): void {
    this.nodes.set(node.id, node);
  }

  addEdge(edge: GraphEdge): void {
    const outEdges = this.out.get(edge.from) ?? [];
    if (outEdges.some((e) => sameEdge(e, edge))) return;
    outEdges.push(edge);
    this.out.set(edge.from, outEdges);
    const incEdges = this.inc.get(edge.to) ?? [];
    incEdges.push(edge);
    this.inc.set(edge.to, incEdges);
  }

  removeFile(fileNodeId: string): void {
    const doomed = new Set<string>([fileNodeId]);
    for (const e of this.edgesFrom(fileNodeId, "contains")) doomed.add(e.to);
    for (const id of doomed) this.nodes.delete(id);
    const touch = (e: GraphEdge) => doomed.has(e.from) || doomed.has(e.to);
    for (const [key, edges] of this.out) {
      const kept = edges.filter((e) => !touch(e));
      if (kept.length === 0) this.out.delete(key);
      else this.out.set(key, kept);
    }
    for (const [key, edges] of this.inc) {
      const kept = edges.filter((e) => !touch(e));
      if (kept.length === 0) this.inc.delete(key);
      else this.inc.set(key, kept);
    }
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  nodesOfFile(fileNodeId: string): GraphNode[] {
    return this.edgesFrom(fileNodeId, "contains")
      .map((e) => this.nodes.get(e.to))
      .filter((n): n is GraphNode => n !== undefined);
  }

  edgesFrom(id: string, kind?: EdgeKind): GraphEdge[] {
    const edges = this.out.get(id) ?? [];
    return kind === undefined ? [...edges] : edges.filter((e) => e.kind === kind);
  }

  edgesTo(id: string, kind?: EdgeKind): GraphEdge[] {
    const edges = this.inc.get(id) ?? [];
    return kind === undefined ? [...edges] : edges.filter((e) => e.kind === kind);
  }

  callers(id: string): GraphNode[] {
    return this.edgesTo(id, "calls")
      .filter(isResolvedCall)
      .map((e) => this.nodes.get(e.from))
      .filter((n): n is GraphNode => n !== undefined);
  }

  callees(id: string): GraphNode[] {
    return this.edgesFrom(id, "calls")
      .filter(isResolvedCall)
      .map((e) => this.nodes.get(e.to))
      .filter((n): n is GraphNode => n !== undefined);
  }

  allNodes(): GraphNode[] {
    return [...this.nodes.values()];
  }

  stats(): GraphStats {
    const s: GraphStats = { files: 0, functions: 0, classes: 0, edges: 0, unresolvedCalls: 0 };
    for (const n of this.nodes.values()) {
      if (n.kind === "File") s.files++;
      else if (n.kind === "Function") s.functions++;
      else s.classes++;
    }
    for (const edges of this.out.values()) {
      s.edges += edges.length;
      for (const e of edges) {
        if (e.kind === "calls" && e.unresolved) s.unresolvedCalls++;
      }
    }
    return s;
  }
}

export function createMemoryStore(): GraphStore {
  return new MemoryStore();
}
