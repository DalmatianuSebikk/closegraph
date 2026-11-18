/**
 * closegraph_surface_query: read side of the black-box surface family.
 * Resolves one ref (functionality `url :: name` > page url > `METHOD /path`
 * > bare path with disambiguation) and renders the node's facts with the
 * same honesty rules as the code-graph tools — caps disclosed, exact totals,
 * provenance and scope flags always explicit.
 * See docs/superpowers/specs/2026-11-18-closegraph-blackbox-surface-design.md.
 */
import type { Info } from "@opencode/plugin/promise/tool";
import type { SurfaceService } from "../surface/surface-service.js";
import type { SurfaceStore } from "../surface/store.js";
import { normalizeEndpointPath, normalizePageUrl, normalizeTarget } from "../surface/normalize.js";
import { parseEndpointRef, type SurfaceEdge, type SurfaceNode, type StoredObservation } from "../surface/types.js";

/** Every rendered list caps at 10 with the hidden count disclosed. */
const LIST_CAP = 10;

function noMatch(ref: string): string {
  return `surface query: no match for ${ref} — closegraph_surface_report lists pages, functionalities, and endpoints`;
}

function headerLine(store: SurfaceStore): string {
  const meta = store.meta();
  return `closegraph surface — target: ${store.target} (last ingest ${meta.lastIngest}, sources: ${meta.sources.join(", ")})`;
}

function joinCapped(refs: string[]): string {
  const shown = refs.slice(0, LIST_CAP).join(", ");
  const hidden = refs.length - LIST_CAP;
  return hidden > 0 ? `${shown}, … +${hidden} more` : shown;
}

function fnRef(node: SurfaceNode): string {
  return `${node.attrs.pageRef} :: ${node.name}`;
}

function evidenceLine(observations: StoredObservation[]): string {
  const sources = [...new Set(observations.flatMap((o) => o.sources))].sort().join(", ");
  const first = observations.map((o) => o.firstSeen).sort()[0];
  const last = observations.map((o) => o.lastSeen).sort().at(-1);
  return `evidence: ${observations.length} observation(s) — sources ${sources} — first ${first}, last ${last}`;
}

function requiresAuthLine(node: SurfaceNode): string {
  if (!node.attrs.requiresAuth) return "requires auth: no (never challenged — absence is not proof)";
  const statusSeen = node.attrs.statusSeen as number[];
  if (statusSeen.includes(401)) return "requires auth: yes (401 observed)";
  if (statusSeen.includes(403)) return "requires auth: yes (403 observed)";
  return "requires auth: yes (redirect to login observed)";
}

function renderEndpoint(store: SurfaceStore, node: SurfaceNode): string {
  const edges = store.edgesOf(node.id);
  const params = edges
    .filter((e) => e.kind === "takes" && e.to !== node.id)
    .map((e) => store.node(e.to)!)
    .sort((a, b) => a.name.localeCompare(b.name));
  const cookies = edges
    .filter((e) => e.kind === "receives" && e.to !== node.id)
    .map((e) => store.node(e.to)!)
    .sort((a, b) => a.name.localeCompare(b.name));
  const calledBy = edges
    .filter((e) => e.kind === "calls" && e.to === node.id)
    .map((e) => store.node(e.from)!)
    .map(fnRef)
    .sort();
  const evidence = store.observations().filter((o) => o.endpointQn === node.qualifiedName);

  const paramEntries = [
    ...params.map((p) => `${p.name} (${p.attrs.location})`),
    ...cookies.map((c) => `${c.name} (cookie)`),
  ];
  const lines = [
    headerLine(store),
    `endpoint: ${node.name}`,
    `provenance: ${node.provenance} (${(node.attrs.sources as string[]).join(", ")})`,
    paramEntries.length > 0 ? `params (${paramEntries.length}): ${paramEntries.join(", ")}` : "params: —",
    cookies.length > 0 ? `cookies: ${cookies.map((c) => c.name).join(", ")}` : "cookies: —",
    requiresAuthLine(node),
    calledBy.length > 0 ? `called by functionalities: ${joinCapped(calledBy)}` : "called by functionalities: —",
    evidenceLine(evidence),
    `out of scope: ${node.outOfScope ? "yes" : "no"}`,
  ];
  return lines.join("\n");
}

function renderFunctionality(store: SurfaceStore, node: SurfaceNode): string {
  const edges = store.edgesOf(node.id);
  const calls = edges
    .filter((e) => e.kind === "calls" && e.from === node.id)
    .map((e) => store.node(e.to)!.name)
    .sort();
  const wiredTo = edges
    .filter((e) => e.kind === "wires")
    .map((e) => store.node(e.from === node.id ? e.to : e.from)!)
    .map(fnRef)
    .sort();
  const evidence = (node.attrs.evidence as string[])
    .map((id) => store.observation(id))
    .filter((o): o is StoredObservation => o !== undefined);

  const lines = [
    headerLine(store),
    `functionality: ${fnRef(node)}`,
    `page: ${node.attrs.pageRef}`,
    ...(node.attrs.description ? [`description: ${node.attrs.description}`] : []),
    `calls (${calls.length}): ${joinCapped(calls)}`,
    `wired to (${wiredTo.length}): ${joinCapped(wiredTo)}`,
    evidenceLine(evidence),
  ];
  return lines.join("\n");
}

function renderPage(store: SurfaceStore, node: SurfaceNode): string {
  const functionalities = store
    .edgesOf(node.id)
    .filter((e) => e.kind === "contains" && e.from === node.id)
    .map((e) => store.node(e.to)!)
    .map(fnRef)
    .sort();
  return [
    headerLine(store),
    `page: ${node.attrs.url}`,
    `functionalities (${functionalities.length}): ${joinCapped(functionalities)}`,
  ].join("\n");
}

/** JSON-safe copies for metadata: no undefined-valued keys cross the boundary. */
function jsonSafeEdges(edges: SurfaceEdge[]): SurfaceEdge[] {
  return edges.map(({ note, ...rest }) => (note === undefined ? rest : { ...rest, note }));
}

export function createSurfaceQueryTool(surface: SurfaceService): Info {
  return {
    name: "closegraph_surface_query",
    description:
      "Query the black-box surface graph of one target by ref: functionality `<page-url> :: <name>`, page url, endpoint `METHOD /path`, or a bare path (lists every method when ambiguous). " +
      "Every fact is observed-raw and carries provenance, evidence, and an out-of-scope flag. " +
      "closegraph_surface_report lists what exists to query.",
    input: {
      type: "object",
      properties: {
        target: { type: "string", description: "Hostname (+port when non-default) — scheme ignored" },
        ref: { type: "string", description: "functionality `url :: name`, page url, `METHOD /path`, or bare path" },
      },
      required: ["target", "ref"],
      additionalProperties: false,
    },
    async execute(input: { target: string; ref: string }, _ctx) {
      try {
        const target = normalizeTarget(input.target); // throws on invalid target
        // never-ingested target: honest no-match, and no empty handle is cached
        if (!(await surface.list()).includes(target)) {
          return { content: noMatch(input.ref) };
        }
        const store = (await surface.get(target)).store;
        const ref = input.ref.trim();

        // 1. exact functionality ref: `<page-url> :: <name>`
        const sep = ref.indexOf(" :: ");
        if (sep !== -1) {
          try {
            const fn = store.findByQualifiedName(
              "Functionality",
              `${target}|fn:${normalizePageUrl(ref.slice(0, sep).trim())}::${ref.slice(sep + 4)}`,
            );
            if (fn) {
              return { content: renderFunctionality(store, fn), metadata: { node: fn, edges: jsonSafeEdges(store.edgesOf(fn.id)) } };
            }
          } catch {
            // page part is not a valid url — fall through to the next form
          }
        }

        // 2. exact page url
        try {
          const page = store.findByQualifiedName("Page", `${target}|page:${normalizePageUrl(ref)}`);
          if (page) {
            return { content: renderPage(store, page), metadata: { node: page, edges: jsonSafeEdges(store.edgesOf(page.id)) } };
          }
        } catch {
          // not an absolute url — fall through
        }

        // 3. exact endpoint ref: `METHOD /path`
        const parsed = parseEndpointRef(ref);
        if (parsed) {
          const ep = store.findByQualifiedName(
            "Endpoint",
            `${target}|${normalizeEndpointPath(parsed.path)}|${parsed.method}`,
          );
          if (ep) {
            return { content: renderEndpoint(store, ep), metadata: { node: ep, edges: jsonSafeEdges(store.edgesOf(ep.id)) } };
          }
        }

        // 4. bare path: any-method match, disambiguate when several
        if (ref.startsWith("/")) {
          const path = normalizeEndpointPath(ref);
          const matches = store
            .nodesOf("Endpoint")
            .filter((n) => n.qualifiedName.startsWith(`${target}|${path}|`));
          if (matches.length === 1) {
            const ep = matches[0]!;
            return { content: renderEndpoint(store, ep), metadata: { node: ep, edges: jsonSafeEdges(store.edgesOf(ep.id)) } };
          }
          if (matches.length > 1) {
            const content = [
              headerLine(store),
              `ambiguous path ${path} — ${matches.length} endpoints match:`,
              ...matches.map((m) => `  ${m.name}`),
            ].join("\n");
            return { content, metadata: { matches } };
          }
        }

        return { content: noMatch(input.ref) };
      } catch (error) {
        return { content: `surface query: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  };
}
