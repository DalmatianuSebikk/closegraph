/**
 * closegraph_surface_ingest: the ONLY write path of the black-box surface
 * family. Raw observations go in exactly as observed (never summarized),
 * deriveIngest builds the graph deterministically, and the summary echoes
 * scope + counts honestly — nothing applied is always said, never implied.
 * See docs/superpowers/specs/2026-11-18-closegraph-blackbox-surface-design.md.
 */
import type { Info } from "@opencode/plugin/promise/tool";
import type { SurfaceService } from "../surface/surface-service.js";
import { deriveIngest, type IngestResult } from "../surface/derive.js";
import type { IngestInput, SurfaceNodeKind } from "../surface/types.js";

/** Hard input caps (Review Focus 5: an agent pasting a proxy log must be
 * rejected whole, not half-applied) — mirrored in the JSON schema below. */
const OBSERVATIONS_CAP = 500;
const CLAIMS_CAP = 100;
/** Rejected-claim echo cap: the full list is in metadata, content is an overview. */
const REJECTED_ECHO_CAP = 10;

/** Fixed kind order for the counts line — same order everywhere the family
 * names kinds, so output never depends on iteration order. */
const KIND_ORDER: SurfaceNodeKind[] = ["endpoint", "page", "functionality", "param", "cookie"] as never[];

function overCap(kind: string, count: number, cap: number): string {
  return `surface ingest rejected: ${count} ${kind} exceed the ${cap} cap — split the batch (nothing applied)`;
}

function renderSummary(result: IngestResult): string {
  const lines: string[] = [`closegraph surface ingest — target: ${result.target}`];
  if (result.scopeChanged) lines.push(`scope set (replaced): ${result.scope.join(", ")}`);
  lines.push(`scope: ${result.scope.length > 0 ? result.scope.join(", ") : "(unset — everything recorded is in scope)"}`);

  const created = KIND_ORDER.map((k) => `${k} ${result.created[`${k[0].toUpperCase()}${k.slice(1)}` as SurfaceNodeKind] ?? 0}`).join(", ");
  const totalNew = Object.values(result.created).reduce((a, b) => a + (b ?? 0), 0);
  const totalUpdated = Object.values(result.updated).reduce((a, b) => a + (b ?? 0), 0);
  lines.push(`nodes: +${totalNew} new (${created}) · updated ${totalUpdated} · edges +${result.edgesCreated}`);

  const o = result.observations;
  lines.push(`observations: ${o.total} total — new ${o.new}, merged ${o.merged}, out-of-scope ${o.outOfScope}`);

  if (result.rejectedClaims.length > 0) {
    lines.push(`rejected claims: ${result.rejectedClaims.length} (nothing applied for them)`);
    for (const claim of result.rejectedClaims.slice(0, REJECTED_ECHO_CAP)) {
      lines.push(`  - ${claim.kind} ${claim.name}: ${claim.reason}`);
    }
    const hidden = result.rejectedClaims.length - REJECTED_ECHO_CAP;
    if (hidden > 0) lines.push(`  … +${hidden} more`);
  }
  return lines.join("\n");
}

export function createSurfaceIngestTool(surface: SurfaceService): Info {
  return {
    name: "closegraph_surface_ingest",
    description:
      "Ingest RAW black-box observations for one target — exactly as observed (method, url, params, response status, cookies), never summarized or invented; source tells where each was seen (puppeteer, burp-proxy, openapi, manual). " +
      "Claims name functionalities and MUST cite observation ids of this call or stored ids (batch:<n>/<id>) from earlier ingests. " +
      "scope REPLACES the target's scope rules and is echoed back; observations outside scope are still recorded but flagged. " +
      "Call closegraph_surface_report after ingest to see the discovered surface.",
    input: {
      type: "object",
      properties: {
        target: { type: "string", description: "Hostname (+port when non-default) — scheme ignored" },
        scope: { type: "array", items: { type: "string" }, description: "url-prefix rules; REPLACES the target's scope" },
        observations: {
          type: "array",
          minItems: 1,
          maxItems: OBSERVATIONS_CAP,
          description: "raw observations, ids unique within this call",
        },
        claims: {
          type: "object",
          properties: {
            functionalities: { type: "array", maxItems: CLAIMS_CAP },
            wiring: { type: "array", maxItems: CLAIMS_CAP },
          },
        },
      },
      required: ["target", "observations"],
      additionalProperties: false,
    },
    async execute(input: IngestInput, _ctx) {
      // size gates FIRST — an oversized batch is rejected before any handle
      // exists, so nothing is cached or persisted for that target
      if (input.observations.length > OBSERVATIONS_CAP) {
        return {
          content: overCap("observations", input.observations.length, OBSERVATIONS_CAP),
          metadata: { rejected: true, count: input.observations.length },
        };
      }
      const fnClaims = input.claims?.functionalities?.length ?? 0;
      if (fnClaims > CLAIMS_CAP) {
        return { content: overCap("functionalities", fnClaims, CLAIMS_CAP), metadata: { rejected: true, count: fnClaims } };
      }
      const wiringClaims = input.claims?.wiring?.length ?? 0;
      if (wiringClaims > CLAIMS_CAP) {
        return { content: overCap("wiring", wiringClaims, CLAIMS_CAP), metadata: { rejected: true, count: wiringClaims } };
      }

      try {
        const handle = await surface.get(input.target); // throws on invalid target
        const result = deriveIngest(handle.store, input, new Date().toISOString());
        await handle.save(); // best-effort; in-memory stays the truth
        return { content: renderSummary(result), metadata: { result } };
      } catch (error) {
        // invalid target / duplicate ids / target mismatch — nothing was applied
        return { content: `surface ingest: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  };
}
