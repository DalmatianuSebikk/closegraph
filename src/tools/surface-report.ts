/**
 * closegraph_surface_report: overview of the black-box attack surface.
 * With a target: scope, freshness, kind counts (method-split endpoints),
 * auth-gated count, out-of-scope count, and the unmapped-endpoint to-do
 * list — every number derived from the store, zeros printed as zeros.
 * Without: the target listing. Honesty rules match the code-graph report.
 * See docs/superpowers/specs/2026-11-18-closegraph-blackbox-surface-design.md.
 */
import type { Info } from "@opencode/plugin/promise/tool";
import type { SurfaceService } from "../surface/surface-service.js";
import type { SurfaceStore } from "../surface/store.js";
import { normalizeTarget } from "../surface/normalize.js";

const TARGETS_CAP = 20;
const UNMAPPED_CAP = 10;

interface SurfaceCounts {
  pages: number;
  functionalities: number;
  endpoints: number;
  params: number;
  cookies: number;
  auth: number;
  outOfScope: number;
  unmappedEndpoints: number;
  methods: Record<string, number>;
}

function counts(store: SurfaceStore): SurfaceCounts {
  const endpoints = store.nodesOf("Endpoint");
  const methods: Record<string, number> = {};
  for (const e of endpoints) {
    const method = e.attrs.method as string;
    methods[method] = (methods[method] ?? 0) + 1;
  }
  const unmapped = endpoints.filter((e) => !store.edgesOf(e.id).some((ed) => ed.kind === "calls" && ed.to === e.id));
  return {
    pages: store.nodesOf("Page").length,
    functionalities: store.nodesOf("Functionality").length,
    endpoints: endpoints.length,
    params: store.nodesOf("Param").length,
    cookies: store.nodesOf("Cookie").length,
    auth: endpoints.filter((e) => e.attrs.requiresAuth).length,
    outOfScope: store.observations().filter((o) => o.outOfScope).length,
    unmappedEndpoints: unmapped.length,
    methods,
  };
}

function renderTarget(store: SurfaceStore): { content: string; metadata: SurfaceCounts } {
  const c = counts(store);
  const meta = store.meta();
  const scope = store.scope();
  const methodsPart =
    c.endpoints > 0
      ? ` (${Object.entries(c.methods)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([m, n]) => `${m} ${n}`)
          .join(", ")})`
      : "";
  const unmappedRefs = store
    .nodesOf("Endpoint")
    .filter((e) => !store.edgesOf(e.id).some((ed) => ed.kind === "calls" && ed.to === e.id))
    .map((e) => `  - ${e.name}`);
  const lines = [
    `closegraph surface report — target: ${store.target}`,
    `scope: ${scope.length > 0 ? scope.join(", ") : "(unset — everything recorded is in scope)"}`,
    `last ingest: ${meta.lastIngest || "never"} — sources: ${meta.sources.length > 0 ? [...meta.sources].sort().join(", ") : "none"}`,
    `pages: ${c.pages} · functionalities: ${c.functionalities} · endpoints: ${c.endpoints}${methodsPart} · params: ${c.params} · cookies: ${c.cookies}`,
    `auth: ${c.auth} endpoint(s) require auth`,
    `out of scope: ${c.outOfScope} discovered (flagged, not merged)`,
    `unmapped endpoints (no functionality attached): ${c.unmappedEndpoints}`,
    ...unmappedRefs.slice(0, UNMAPPED_CAP),
  ];
  const hidden = unmappedRefs.length - UNMAPPED_CAP;
  if (hidden > 0) lines.push(`  … +${hidden} more`);
  return { content: lines.join("\n"), metadata: c };
}

export function createSurfaceReportTool(surface: SurfaceService): Info {
  return {
    name: "closegraph_surface_report",
    description:
      "Overview of the black-box attack surface. With no target: every ingested target with counts. With a target: scope, freshness, pages/functionalities/endpoints (method-split)/params/cookies, auth-gated endpoints, out-of-scope discoveries, and the unmapped endpoints — unmapped means observed but attached to no functionality: unexplored surface worth visiting. " +
      "Call after closegraph_surface_ingest and before closegraph_surface_query.",
    input: {
      type: "object",
      properties: {
        target: { type: "string", description: "Hostname (+port when non-default) — omit to list all targets" },
      },
      additionalProperties: false,
    },
    async execute(input: { target?: string }, _ctx) {
      try {
        if (input.target === undefined) {
          const targets = await surface.list();
          if (targets.length === 0) {
            return {
              content:
                "closegraph surface: no targets ingested yet — collect observations (puppeteer/burp) and call closegraph_surface_ingest",
            };
          }
          const lines = [`closegraph surface targets (${targets.length}):`];
          for (const t of targets.slice(0, TARGETS_CAP)) {
            const store = (await surface.get(t)).store;
            const c = counts(store);
            lines.push(
              `  - ${t} — ${c.endpoints} endpoints, ${c.functionalities} functionalities, ${c.pages} pages, last ingest ${store.meta().lastIngest || "never"}`,
            );
          }
          const hidden = targets.length - TARGETS_CAP;
          if (hidden > 0) lines.push(`  … +${hidden} more`);
          return { content: lines.join("\n"), metadata: { targets } };
        }

        const target = normalizeTarget(input.target); // throws on invalid target
        if (!(await surface.list()).includes(target)) {
          return {
            content: `surface report: unknown target ${target} — closegraph_surface_report with no target lists them`,
          };
        }
        const { content, metadata } = renderTarget((await surface.get(target)).store);
        return { content, metadata };
      } catch (error) {
        return { content: `surface report: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  };
}
