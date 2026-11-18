/**
 * Deterministic ingest derivation: raw observations + agent claims → surface
 * graph. The ONLY write path into the store. Observations are ground truth;
 * claims are validated wholesale (unknown evidence → the whole claim is
 * rejected, never partially applied).
 */
import { inScope } from "./store";
import { isLoginPath, normalizeEndpointPath, normalizePageUrl, normalizeTarget } from "./normalize";
import {
  makeSurfaceNodeId,
  type IngestInput,
  type Observation,
  type Provenance,
  type StoredObservation,
  type SurfaceNode,
  type SurfaceNodeKind,
  type SurfaceStore,
} from "./types";

export interface IngestResult {
  target: string;
  scopeChanged: boolean;
  scope: string[];
  created: Partial<Record<SurfaceNodeKind, number>>;
  updated: Partial<Record<SurfaceNodeKind, number>>;
  edgesCreated: number;
  edgesMerged: number;
  observations: { total: number; new: number; merged: number; outOfScope: number };
  rejectedClaims: { kind: "functionality" | "wiring"; name: string; reason: string }[];
}

/** See StoredObservation.signature. Params render as sorted "location:name" joined with "|". */
function signatureOf(method: string, path: string, obs: Observation): string {
  const params = (obs.params ?? []).map((p) => `${p.in}:${p.name}`).sort().join("|");
  const status = obs.response?.status ?? "";
  return `${method}|${path}|${params}|${status}`;
}

function urlPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url; // relative — normalizeEndpointPath passes it through
  }
}

/** 401/403, or a 3xx whose redirect target is a login path. v1: Location arrives
 *  via note ONLY, as "redirect:<path>" — the response headers are not in the contract. */
function authRequired(obs: Observation): boolean {
  const status = obs.response?.status;
  if (status === 401 || status === 403) return true;
  if (status !== undefined && status >= 300 && status < 400) {
    const m = /^redirect:(\S+)$/.exec(obs.note ?? "");
    if (m && isLoginPath(m[1])) return true;
  }
  return false;
}

const COOKIE_SEEN_CAP = 50;

export function deriveIngest(store: SurfaceStore, input: IngestInput, nowIso: string): IngestResult {
  const seenIds = new Set<string>();
  for (const obs of input.observations) {
    if (seenIds.has(obs.id)) throw new Error(`duplicate observation id: ${obs.id}`);
    seenIds.add(obs.id);
  }
  const target = normalizeTarget(input.target);
  if (target !== store.target) throw new Error(`target mismatch: ${input.target} (store: ${store.target})`);

  const created: Partial<Record<SurfaceNodeKind, number>> = {};
  const updated: Partial<Record<SurfaceNodeKind, number>> = {};
  const bump = (map: Partial<Record<SurfaceNodeKind, number>>, kind: SurfaceNodeKind) => {
    map[kind] = (map[kind] ?? 0) + 1;
  };
  const rejectedClaims: IngestResult["rejectedClaims"] = [];
  let edgesCreated = 0;
  let edgesMerged = 0;

  let scopeChanged = false;
  if (input.scope !== undefined) {
    store.setScope(input.scope);
    scopeChanged = true;
  }
  const scope = store.scope();

  const batch = store.nextBatch();
  const rawToStored = new Map<string, string>();
  // Signature merge: an incoming observation whose signature was seen before
  // (this batch or any earlier one) merges into that stored observation, so
  // stored ids stay citable across sessions.
  const signatureIndex = new Map<string, string>(store.observations().map((o) => [o.signature, o.storedId]));

  interface Derived {
    obs: Observation;
    stored: StoredObservation;
    method: string;
    path: string;
  }
  const derived: Derived[] = [];

  for (const obs of input.observations) {
    const method = obs.request.method.trim().toUpperCase();
    const path = normalizeEndpointPath(urlPath(obs.request.url));
    const signature = signatureOf(method, path, obs);
    const existingStoredId = signatureIndex.get(signature);
    const storedId = existingStoredId ?? `batch:${batch}/${obs.id}`;
    signatureIndex.set(signature, storedId);
    rawToStored.set(obs.id, storedId);
    derived.push({
      obs,
      method,
      path,
      stored: {
        ...obs,
        request: { method, url: obs.request.url },
        signature,
        sources: [obs.source],
        count: 1,
        firstSeen: nowIso,
        lastSeen: nowIso,
        batch,
        storedId,
        outOfScope: scope.length > 0 && !inScope(scope, obs.request.url),
        endpointQn: `${target}|${path}|${method}`,
        pageQn: obs.pageUrl ? `${target}|page:${normalizePageUrl(obs.pageUrl)}` : undefined,
      },
    });
  }

  const obsCounts = { total: input.observations.length, new: 0, merged: 0, outOfScope: 0 };
  for (const d of derived) {
    const res = store.upsertObservation(d.stored);
    if (res === "created") obsCounts.new++;
    else obsCounts.merged++;
    if (d.stored.outOfScope) obsCounts.outOfScope++;
  }

  /** Node provenance: observation-derived nodes are "observed" (or "openapi"),
   *  and never change after creation — the first sighting sticks. */
  const obsProvenance = (obs: Observation): Provenance => (obs.source === "openapi" ? "openapi" : "observed");

  for (const d of derived) {
    const { obs, stored, method, path } = d;
    const evidence = [stored.storedId];
    const endpointQn = stored.endpointQn!;
    const endpointId = makeSurfaceNodeId("Endpoint", endpointQn);
    const existing = store.findByQualifiedName("Endpoint", endpointQn);
    const endpoint: SurfaceNode = {
      id: endpointId,
      kind: "Endpoint",
      name: `${method} ${path}`,
      qualifiedName: endpointQn,
      provenance: existing?.provenance ?? obsProvenance(obs),
      outOfScope: false,
      attrs: {
        method,
        path,
        statusSeen: obs.response?.status !== undefined ? [obs.response.status] : [],
        requiresAuth: existing?.attrs.requiresAuth === true || authRequired(obs),
        sources: [obs.source],
        firstSeen: nowIso,
        lastSeen: nowIso,
      },
    };
    bump(store.upsertNode(endpoint) === "created" ? created : updated, "Endpoint");

    const paramSeen = new Set<string>();
    for (const p of obs.params ?? []) {
      const key = `${p.in}:${p.name}`;
      if (paramSeen.has(key)) continue;
      paramSeen.add(key);
      const pqn = `${endpointQn}|param:${key}`;
      const paramNode: SurfaceNode = {
        id: makeSurfaceNodeId("Param", pqn),
        kind: "Param",
        name: p.name,
        qualifiedName: pqn,
        provenance: existing?.provenance ?? obsProvenance(obs),
        outOfScope: false,
        attrs: { location: p.in, sources: [obs.source], firstSeen: nowIso, lastSeen: nowIso },
      };
      bump(store.upsertNode(paramNode) === "created" ? created : updated, "Param");
      store.addEdge({
        kind: "takes",
        from: endpointId,
        to: paramNode.id,
        provenance: obsProvenance(obs),
        evidence,
      }) === "created" ? edgesCreated++ : edgesMerged++;
    }

    for (const cookie of obs.cookies ?? []) {
      const cqn = `${target}|cookie:${cookie}`;
      const cookieId = makeSurfaceNodeId("Cookie", cqn);
      const cookieNode: SurfaceNode = {
        id: cookieId,
        kind: "Cookie",
        name: cookie,
        qualifiedName: cqn,
        provenance: existing?.provenance ?? obsProvenance(obs),
        outOfScope: false,
        attrs: { seenOn: [endpointQn], sources: [obs.source], firstSeen: nowIso, lastSeen: nowIso },
      };
      bump(store.upsertNode(cookieNode) === "created" ? created : updated, "Cookie");
      // seenOn is documented as capped 50 — trim after the union
      const node = store.node(cookieId)!;
      const seenOn = [...new Set(node.attrs.seenOn as string[])].sort();
      if (seenOn.length !== node.attrs.seenOn.length || (seenOn as string[]).length > COOKIE_SEEN_CAP) {
        node.attrs.seenOn = seenOn.slice(0, COOKIE_SEEN_CAP);
      }
      store.addEdge({
        kind: "receives",
        from: endpointId,
        to: cookieId,
        provenance: obsProvenance(obs),
        evidence,
      }) === "created" ? edgesCreated++ : edgesMerged++;
    }

    if (obs.pageUrl) {
      const pageQn = stored.pageQn!;
      const existingPage = store.findByQualifiedName("Page", pageQn);
      const page: SurfaceNode = {
        id: makeSurfaceNodeId("Page", pageQn),
        kind: "Page",
        name: normalizePageUrl(obs.pageUrl),
        qualifiedName: pageQn,
        provenance: existingPage?.provenance ?? obsProvenance(obs),
        outOfScope: false,
        attrs: { url: obs.pageUrl, sources: [obs.source], firstSeen: nowIso, lastSeen: nowIso },
      };
      bump(store.upsertNode(page) === "created" ? created : updated, "Page");
    }
  }

  /** Resolve a claim evidence id: raw id of this batch, or an already-stored id. */
  const resolveEvidence = (ids: readonly string[]): { storedIds: string[]; bad?: string } => {
    const storedIds: string[] = [];
    for (const id of ids) {
      const storedId = rawToStored.get(id) ?? (store.observation(id) ? id : undefined);
      if (storedId === undefined) return { storedIds: [], bad: id };
      if (!storedIds.includes(storedId)) storedIds.push(storedId);
    }
    return { storedIds };
  };

  for (const claim of input.claims?.functionalities ?? []) {
    const { storedIds, bad } = resolveEvidence(claim.evidence);
    if (bad !== undefined) {
      rejectedClaims.push({ kind: "functionality", name: claim.name, reason: `unknown evidence id: ${bad}` });
      continue;
    }
    const pageRef = normalizePageUrl(claim.pageUrl);
    const pageQn = `${target}|page:${pageRef}`;
    const existingPage = store.findByQualifiedName("Page", pageQn);
    bump(
      store.upsertNode({
        id: makeSurfaceNodeId("Page", pageQn),
        kind: "Page",
        name: pageRef,
        qualifiedName: pageQn,
        provenance: existingPage?.provenance ?? "agent-inferred",
        outOfScope: false,
        attrs: { url: claim.pageUrl, sources: ["agent"], firstSeen: nowIso, lastSeen: nowIso },
      }) === "created"
        ? created
        : updated,
      "Page",
    );
    const fnQn = `${target}|fn:${pageRef}::${claim.name}`;
    const fnId = makeSurfaceNodeId("Functionality", fnQn);
    const fnAttrs: Record<string, unknown> = {
      pageRef,
      evidence: storedIds,
      sources: ["agent"],
      firstSeen: nowIso,
      lastSeen: nowIso,
    };
    if (claim.description !== undefined) fnAttrs.description = claim.description;
    bump(
      store.upsertNode({
        id: fnId,
        kind: "Functionality",
        name: claim.name,
        qualifiedName: fnQn,
        provenance: "agent-inferred",
        outOfScope: false,
        attrs: fnAttrs,
      }) === "created"
        ? created
        : updated,
      "Functionality",
    );
    store.addEdge({
      kind: "contains",
      from: makeSurfaceNodeId("Page", pageQn),
      to: fnId,
      provenance: "agent-inferred",
      evidence: storedIds,
    }) === "created" ? edgesCreated++ : edgesMerged++;
    // calls edges: group the evidence observations by the endpoint they hit
    const byEndpoint = new Map<string, string[]>();
    for (const storedId of storedIds) {
      const eqn = store.observation(storedId)!.endpointQn;
      const list = byEndpoint.get(eqn) ?? [];
      if (!list.includes(storedId)) list.push(storedId);
      byEndpoint.set(eqn, list);
    }
    for (const [eqn, ids] of byEndpoint) {
      store.addEdge({
        kind: "calls",
        from: fnId,
        to: makeSurfaceNodeId("Endpoint", eqn),
        provenance: "agent-inferred",
        evidence: ids,
      }) === "created" ? edgesCreated++ : edgesMerged++;
    }
  }

  // Wiring claims run after functionality claims so same-call names resolve.
  for (const claim of input.claims?.wiring ?? []) {
    const label = `${claim.from} -> ${claim.to}`;
    const { storedIds, bad } = resolveEvidence(claim.evidence);
    if (bad !== undefined) {
      rejectedClaims.push({ kind: "wiring", name: label, reason: `unknown evidence id: ${bad}` });
      continue;
    }
    const fns = store.nodesOf("Functionality");
    const from = fns.filter((f) => f.name === claim.from);
    const to = fns.filter((f) => f.name === claim.to);
    const reject = (reason: string) => rejectedClaims.push({ kind: "wiring", name: label, reason });
    if (from.length === 0) reject(`unknown functionality: ${claim.from}`);
    else if (from.length > 1) reject(`ambiguous functionality: ${claim.from} (${from.length} matches)`);
    else if (to.length === 0) reject(`unknown functionality: ${claim.to}`);
    else if (to.length > 1) reject(`ambiguous functionality: ${claim.to} (${to.length} matches)`);
    else {
      const edge = {
        kind: "wires" as const,
        from: from[0].id,
        to: to[0].id,
        provenance: "agent-inferred" as const,
        evidence: storedIds,
        ...(claim.description !== undefined ? { note: claim.description } : {}),
      };
      store.addEdge(edge) === "created" ? edgesCreated++ : edgesMerged++;
    }
  }

  store.recomputeScope(); // ALWAYS — scope flags reflect the final rules
  store.touch(
    [...new Set(input.observations.map((obs) => obs.source))],
    nowIso,
  );

  return {
    target,
    scopeChanged,
    scope: store.scope(),
    created,
    updated,
    edgesCreated,
    edgesMerged,
    observations: obsCounts,
    rejectedClaims,
  };
}
