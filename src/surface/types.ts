/**
 * Black-box attack-surface graph types.
 *
 * The surface family is parallel to src/graph (white-box code graph): it models
 * what was OBSERVED about a running target (pages, functionalities, endpoints,
 * params, cookies) from raw observations — never inferred network facts.
 * See docs/superpowers/specs/2026-11-18-closegraph-blackbox-surface-design.md.
 */

export type SurfaceNodeKind = "Page" | "Functionality" | "Endpoint" | "Param" | "Cookie";
export type Provenance = "observed" | "openapi" | "agent-inferred";
export type ParamLocation = "query" | "body" | "header" | "path" | "cookie";

export interface SurfaceNode {
  /** `${kind}:${qualifiedName}` — see makeSurfaceNodeId. */
  readonly id: string;
  readonly kind: SurfaceNodeKind;
  readonly name: string;
  /** Target-scoped identity, format per kind (documented below). */
  readonly qualifiedName: string;
  readonly provenance: Provenance;
  outOfScope: boolean;
  /** JSON-safe, kind-specific attrs (documented below). */
  attrs: Record<string, unknown>;
}

/**
 * Endpoint attrs: { method, path, statusSeen: number[], requiresAuth: boolean,
 *   contentTypeSeen?: string[], sources: string[], firstSeen, lastSeen }
 *   name = `${method} ${path}`; qualifiedName = `${target}|${path}|${method}`
 * Page attrs: { url (raw first seen), sources: string[], firstSeen, lastSeen }
 *   qualifiedName = `${target}|page:${normalizedUrl}`
 * Functionality attrs: { pageRef (normalizedPageUrl), description?, evidence: string[],
 *   sources: string[], firstSeen, lastSeen }; qualifiedName = `${target}|fn:${pageRef}::${name}`
 * Param attrs: { location: ParamLocation }
 *   qualifiedName = `${endpointQn}|param:${location}:${name}`
 * Cookie attrs: { seenOn: string[] (endpoint qns, sorted, capped 50) }
 *   qualifiedName = `${target}|cookie:${name}`
 */

export type SurfaceEdgeKind = "contains" | "calls" | "takes" | "receives" | "wires";
/** Page->Page "loads" edges are deferred by design ruling (v1 omits them). */

export interface SurfaceEdge {
  readonly kind: SurfaceEdgeKind;
  /** Node id of the source (e.g. Page for `contains`, Functionality for `calls`). */
  readonly from: string;
  /** Node id of the target (e.g. Functionality for `contains`, Endpoint for `calls`). */
  readonly to: string;
  readonly provenance: Provenance;
  /** Observation ids (stored, namespaced `batch:<n>/<id>`). Sorted, unique, capped 100. */
  evidence: string[];
  /** Optional human note (e.g. wiring claim description). */
  note?: string;
}

export type ObservationSource = "puppeteer" | "burp-proxy" | "burp-request" | "openapi" | "manual";

export interface Observation {
  /** Unique within the ingest call; stored namespaced as `batch:<n>/<id>`. */
  readonly id: string;
  readonly source: ObservationSource;
  /** Page the browser showed when this request fired (pages only; absent for pure-API scans). */
  readonly pageUrl?: string;
  readonly request: { method: string; url: string };
  readonly params?: { name: string; in: ParamLocation }[];
  readonly response?: { status: number };
  readonly cookies?: string[];
  readonly note?: string;
}

export interface FunctionalityClaim {
  readonly name: string;
  readonly pageUrl: string;
  readonly description?: string;
  /** Observation ids — of this ingest call (raw ids) or stored ids (`batch:<n>/<id>`). */
  readonly evidence: string[];
}

export interface WiringClaim {
  /** Functionality NAMES (resolved against all functionalities of the target). */
  readonly from: string;
  readonly to: string;
  readonly description?: string;
  readonly evidence: string[];
}

export interface IngestInput {
  readonly target: string;
  readonly scope?: string[];
  readonly observations: Observation[];
  readonly claims?: { functionalities?: FunctionalityClaim[]; wiring?: WiringClaim[] };
}

export interface StoredObservation extends Observation {
  /** `${method}|${normalizedPath}|${sorted "${location}:${name}" params}|${status ?? ""}` */
  readonly signature: string;
  /** ALL sources that ever saw this signature (sorted, unique). */
  readonly sources: string[];
  readonly count: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly batch: number;
  /** The citable id: `batch:<batch>/${id}`. */
  readonly storedId: string;
  /** Mutable scope flag, recomputed in place on scope change (SurfaceNode parity). */
  outOfScope: boolean;
  readonly endpointQn: string;
  readonly pageQn?: string;
}

export interface SurfaceMeta {
  lastIngest: string;
  sources: string[];
  observationCount: number;
  ingestCalls: number;
  batchSeq: number;
}

export interface SurfaceSnapshot {
  readonly v: 1;
  readonly target: string;
  scope: string[];
  meta: SurfaceMeta;
  nodes: SurfaceNode[];
  edges: SurfaceEdge[];
  observations: StoredObservation[];
}

export function makeSurfaceNodeId(kind: SurfaceNodeKind, qualifiedName: string): string {
  return `${kind}:${qualifiedName}`;
}

/** `${METHOD} ${path}` — method upper-cased and trimmed. */
export function endpointRef(method: string, path: string): string {
  return `${method.trim().toUpperCase()} ${path}`;
}

/** `METHOD /path` -> { method, path }; undefined when the ref has no leading method token. */
export function parseEndpointRef(ref: string): { method: string; path: string } | undefined {
  const space = ref.indexOf(" ");
  if (space <= 0) return undefined;
  const method = ref.slice(0, space).toUpperCase();
  const path = ref.slice(space + 1);
  if (!/^[A-Z]+$/.test(method) || path.length === 0) return undefined;
  return { method, path };
}

/** `${pageUrl} :: ${name}` — pageUrl is the normalized page url (caller normalizes). */
export function functionalityRef(pageUrl: string, name: string): string {
  return `${pageUrl} :: ${name}`;
}
