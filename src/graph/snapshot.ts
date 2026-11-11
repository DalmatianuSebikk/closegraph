import type { GraphNode, GraphEdge } from "./types.js";
import type { GraphStore } from "./store.js";
import { createMemoryStore } from "./memory.js";

export const SNAPSHOT_VERSION = 1;

export interface SnapshotData {
  version: number;
  createdAt: string;      // ISO
  repoRoot: string;
  gitHead?: string;       // commit hash if repoRoot is a git repo
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function takeSnapshot(store: GraphStore, repoRoot: string, gitHead?: string): SnapshotData {
  const nodes = store.allNodes();
  const seen = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const n of nodes) {
    for (const e of store.edgesFrom(n.id)) {
      const key = `${e.kind}:${e.from}->${e.to}`;
      if (!seen.has(key)) {
        seen.add(key);
        edges.push(e);
      }
    }
  }
  return {
    version: SNAPSHOT_VERSION,
    createdAt: new Date().toISOString(),
    repoRoot,
    gitHead,
    nodes,
    edges,
  };
}

export function restoreSnapshot(data: unknown): GraphStore {
  if (typeof data !== "object" || data === null) {
    throw new Error("invalid snapshot: not an object");
  }
  const snap = data as SnapshotData;
  if (snap.version !== SNAPSHOT_VERSION) {
    throw new Error(`unsupported snapshot version: ${String(snap.version)} (expected ${SNAPSHOT_VERSION})`);
  }
  if (!Array.isArray(snap.nodes) || !Array.isArray(snap.edges)) {
    throw new Error("invalid snapshot: nodes/edges must be arrays");
  }
  const store = createMemoryStore();
  for (const n of snap.nodes) store.upsertNode(n);
  for (const e of snap.edges) store.addEdge(e);
  return store;
}

export function isStale(snap: SnapshotData, currentGitHead?: string): boolean {
  if (snap.gitHead === undefined || currentGitHead === undefined) return false;
  return snap.gitHead !== currentGitHead;
}
