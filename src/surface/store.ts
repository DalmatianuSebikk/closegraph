/**
 * In-memory surface store: merge-by-id nodes/edges/observations plus scope
 * flags and a deterministic v1 snapshot. The only writers are ingest
 * derivation (src/surface/derive.ts) and scope changes; every mutation is a
 * merge, nothing is ever silently deleted.
 */
import type {
  StoredObservation,
  SurfaceEdge,
  SurfaceEdgeKind,
  SurfaceMeta,
  SurfaceNode,
  SurfaceNodeKind,
  SurfaceSnapshot,
} from "./types";

/** Sorted unique union, keyed by String(el) so 200 and "200" dedupe; original elements kept. */
function sortedUnion(a: unknown[], b: unknown[]): unknown[] {
  const byKey = new Map<string, unknown>();
  for (const el of [...a, ...b]) byKey.set(String(el), el);
  return [...byKey.entries()].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)).map(([, el]) => el);
}

/**
 * Prefix scope matching on RAW urls, host case-insensitive. A rule matches
 * when the url starts with the rule (scheme://host[:port]/path prefix). An
 * empty rule list means everything is in scope.
 */
function lowerAuthority(u: string): string {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([\s\S]*)$/.exec(u);
  if (!m) return u;
  return `${m[1].toLowerCase()}://${m[2].toLowerCase()}${m[3]}`;
}

export function inScope(scope: string[], url: string): boolean {
  if (scope.length === 0) return true;
  const u = lowerAuthority(url);
  // boundary-aware prefix: a rule owns itself and everything BELOW its path
  // segment (/api does not own /apiv2). Errs toward flagging out of scope.
  return scope.some((r) => {
    const rule = lowerAuthority(r);
    return u === rule || u.startsWith(rule.endsWith("/") ? rule : `${rule}/`);
  });
}

const EVIDENCE_CAP = 100;

export interface SurfaceStore {
  readonly target: string;
  scope(): string[];
  setScope(rules: string[]): void; // REPLACE semantics
  meta(): SurfaceMeta;
  touch(sources: string[], nowIso: string): void; // merges sources, bumps lastIngest + ingestCalls
  nextBatch(): number; // ++batchSeq (batch numbers start at 1)
  node(id: string): SurfaceNode | undefined;
  nodesOf(kind: SurfaceNodeKind): SurfaceNode[]; // qualifiedName-sorted
  findByQualifiedName(kind: SurfaceNodeKind, qn: string): SurfaceNode | undefined;
  upsertNode(node: SurfaceNode): "created" | "updated"; // array attrs union, scalars overwrite, firstSeen kept
  edge(from: string, kind: SurfaceEdgeKind, to: string): SurfaceEdge | undefined;
  addEdge(edge: SurfaceEdge): "created" | "merged"; // evidence union (sorted, unique, cap 100)
  edgesOf(id: string): SurfaceEdge[]; // both directions, kind+id-sorted
  observation(storedId: string): StoredObservation | undefined;
  observations(): StoredObservation[]; // storedId-sorted
  upsertObservation(obs: StoredObservation): "created" | "merged"; // sources union, count+, lastSeen
  recomputeScope(): number; // set outOfScope on EVERY node/observation vs scope(); "" scope = all in scope; returns flagged count
  toSnapshot(): SurfaceSnapshot; // deterministic: nodes/edges/observations sorted
}

export function createSurfaceStore(target: string): SurfaceStore {
  return new SurfaceStoreImpl(target, [], new Map(), new Map(), new Map(), {
    lastIngest: "",
    sources: [],
    observationCount: 0,
    ingestCalls: 0,
    batchSeq: 0,
  });
}

export function restoreSurfaceStore(snap: SurfaceSnapshot): SurfaceStore {
  const nodes = new Map(snap.nodes.map((n) => [n.id, cloneNode(n)]));
  const edges = new Map(snap.edges.map((e) => [edgeKey(e), cloneEdge(e)]));
  const observations = new Map(snap.observations.map((o) => [o.storedId, cloneObservation(o)]));
  return new SurfaceStoreImpl(snap.target, [...snap.scope], nodes, edges, observations, {
    lastIngest: snap.meta.lastIngest,
    sources: [...snap.meta.sources],
    observationCount: snap.observations.length,
    ingestCalls: snap.meta.ingestCalls,
    batchSeq: snap.meta.batchSeq,
  });
}

function edgeKey(e: Pick<SurfaceEdge, "kind" | "from" | "to">): string {
  return `${e.kind}|${e.from}|${e.to}`;
}

function cloneNode(n: SurfaceNode): SurfaceNode {
  return { ...n, outOfScope: n.outOfScope, attrs: { ...n.attrs } };
}
function cloneEdge(e: SurfaceEdge): SurfaceEdge {
  return { ...e, evidence: [...e.evidence] };
}
function cloneObservation(o: StoredObservation): StoredObservation {
  return { ...o, sources: [...o.sources] };
}

class SurfaceStoreImpl implements SurfaceStore {
  readonly target: string;
  #scope: string[];
  #nodes: Map<string, SurfaceNode>;
  #edges: Map<string, SurfaceEdge>;
  #observations: Map<string, StoredObservation>;
  #sources = new Set<string>();
  #lastIngest = "";
  #ingestCalls = 0;
  #batchSeq: number;

  constructor(
    target: string,
    scope: string[],
    nodes: Map<string, SurfaceNode>,
    edges: Map<string, SurfaceEdge>,
    observations: Map<string, StoredObservation>,
    meta: SurfaceMeta,
  ) {
    this.target = target;
    this.#scope = scope;
    this.#nodes = nodes;
    this.#edges = edges;
    this.#observations = observations;
    for (const s of meta.sources) this.#sources.add(s);
    this.#lastIngest = meta.lastIngest;
    this.#ingestCalls = meta.ingestCalls;
    this.#batchSeq = meta.batchSeq;
  }

  scope(): string[] {
    return [...this.#scope];
  }

  setScope(rules: string[]): void {
    this.#scope = [...rules];
  }

  meta(): SurfaceMeta {
    return {
      lastIngest: this.#lastIngest,
      sources: [...this.#sources].sort(),
      observationCount: this.#observations.size,
      ingestCalls: this.#ingestCalls,
      batchSeq: this.#batchSeq,
    };
  }

  touch(sources: string[], nowIso: string): void {
    for (const s of sources) this.#sources.add(s);
    this.#lastIngest = nowIso;
    this.#ingestCalls++;
  }

  nextBatch(): number {
    return ++this.#batchSeq;
  }

  node(id: string): SurfaceNode | undefined {
    return this.#nodes.get(id);
  }

  nodesOf(kind: SurfaceNodeKind): SurfaceNode[] {
    return [...this.#nodes.values()]
      .filter((n) => n.kind === kind)
      .sort((a, b) => (a.qualifiedName < b.qualifiedName ? -1 : a.qualifiedName > b.qualifiedName ? 1 : 0));
  }

  findByQualifiedName(kind: SurfaceNodeKind, qn: string): SurfaceNode | undefined {
    return this.#nodes.get(makeId(kind, qn));
  }

  upsertNode(node: SurfaceNode): "created" | "updated" {
    const existing = this.#nodes.get(node.id);
    if (!existing) {
      this.#nodes.set(node.id, cloneNode(node));
      return "created";
    }
    const attrs: Record<string, unknown> = { ...existing.attrs };
    for (const [k, v] of Object.entries(node.attrs)) {
      const old = attrs[k];
      attrs[k] = Array.isArray(old) && Array.isArray(v) ? sortedUnion(old, v) : v;
    }
    if (existing.attrs.firstSeen !== undefined) attrs.firstSeen = existing.attrs.firstSeen;
    this.#nodes.set(node.id, { ...node, attrs });
    return "updated";
  }

  edge(from: string, kind: SurfaceEdgeKind, to: string): SurfaceEdge | undefined {
    return this.#edges.get(`${kind}|${from}|${to}`);
  }

  addEdge(edge: SurfaceEdge): "created" | "merged" {
    const key = edgeKey(edge);
    const existing = this.#edges.get(key);
    if (!existing) {
      this.#edges.set(key, cloneEdge(edge));
      return "created";
    }
    existing.evidence = sortedUnion(existing.evidence, edge.evidence).slice(0, EVIDENCE_CAP) as string[];
    return "merged";
  }

  edgesOf(id: string): SurfaceEdge[] {
    return [...this.#edges.values()]
      .filter((e) => e.from === id || e.to === id)
      .sort((a, b) => (edgeKey(a) < edgeKey(b) ? -1 : 1));
  }

  observation(storedId: string): StoredObservation | undefined {
    return this.#observations.get(storedId);
  }

  observations(): StoredObservation[] {
    return [...this.#observations.values()].sort((a, b) => (a.storedId < b.storedId ? -1 : 1));
  }

  upsertObservation(o: StoredObservation): "created" | "merged" {
    const existing = this.#observations.get(o.storedId);
    if (!existing) {
      this.#observations.set(o.storedId, cloneObservation(o));
      return "created";
    }
    this.#observations.set(o.storedId, {
      ...existing,
      sources: sortedUnion(existing.sources, o.sources) as string[],
      count: existing.count + Math.max(1, o.count),
      lastSeen: o.lastSeen > existing.lastSeen ? o.lastSeen : existing.lastSeen,
      outOfScope: o.outOfScope,
    });
    return "merged";
  }

  /**
   * Scope flags derive from the observations (the raw ground truth):
   * - observations: flagged iff the scope is non-empty and their request url
   *   matches no rule;
   * - Endpoint/Param/Cookie nodes: flagged iff ANY backing observation is
   *   flagged (linked via endpointQn / seenOn); a node with no backing
   *   observation is never flagged by this pass;
   * - Page: attrs.url (raw first seen); Functionality: attrs.pageRef —
   *   direct prefix checks, so claim-only nodes flag too.
   * Widening un-flags (nodes are never deleted). Returns how many
   * nodes+observations are flagged after the pass.
   */
  recomputeScope(): number {
    const rules = this.#scope;
    const scoped = rules.length > 0;
    const flaggedEndpointQns = new Set<string>();
    for (const o of this.#observations.values()) {
      o.outOfScope = scoped && !inScope(rules, o.request.url);
      if (o.outOfScope) flaggedEndpointQns.add(o.endpointQn);
    }
    let flagged = 0;
    for (const o of this.#observations.values()) if (o.outOfScope) flagged++;
    for (const n of this.#nodes.values()) {
      const url = nodeScopeUrl(n);
      let out: boolean;
      if (url !== undefined) out = scoped && !inScope(rules, url);
      else if (n.kind === "Endpoint") out = flaggedEndpointQns.has(n.qualifiedName);
      else if (n.kind === "Param") {
        const parent = n.qualifiedName.slice(0, n.qualifiedName.indexOf("|param:"));
        out = flaggedEndpointQns.has(parent);
      } else if (n.kind === "Cookie") {
        const seenOn = (n.attrs.seenOn as string[] | undefined) ?? [];
        out = seenOn.some((qn) => flaggedEndpointQns.has(qn));
      } else out = false;
      n.outOfScope = out;
      if (out) flagged++;
    }
    return flagged;
  }

  toSnapshot(): SurfaceSnapshot {
    const nodes = [...this.#nodes.values()]
      .sort((a, b) => (a.qualifiedName < b.qualifiedName ? -1 : a.qualifiedName > b.qualifiedName ? 1 : 0))
      .map(cloneNode);
    const edges = [...this.#edges.values()].sort((a, b) => (edgeKey(a) < edgeKey(b) ? -1 : 1)).map(cloneEdge);
    const observations = this.observations().map(cloneObservation);
    return {
      v: 1,
      target: this.target,
      scope: [...this.#scope],
      meta: this.meta(),
      nodes,
      edges,
      observations,
    };
  }
}

function makeId(kind: SurfaceNodeKind, qn: string): string {
  return `${kind}:${qn}`;
}

/** Direct scope-check url for claim-visible nodes; undefined for evidence-linked kinds. */
function nodeScopeUrl(n: SurfaceNode): string | undefined {
  if (typeof n.attrs.url === "string") return n.attrs.url;
  if (typeof n.attrs.pageRef === "string") return n.attrs.pageRef;
  return undefined;
}
