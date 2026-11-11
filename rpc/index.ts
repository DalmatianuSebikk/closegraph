/**
 * Typed RPC contract between the TUI part and the server part (plan 3 Task 2).
 * Plain JSON Schemas keep this dependency-free; payload types below are the
 * compile-time contract the TUI codes against.
 */
import { Rpc } from "@opencode/plugin";
import type { GraphNode } from "../src/graph/types.js";
import type { RiskBucket } from "../src/view/risk.js";

export type GraphSource = "built" | "snapshot";
export type GraphStaleness = "fresh" | "unknown";

/** Carried by every success payload (Ruling 13: provenance on everything that leaves the service). */
export interface Provenance {
  source: GraphSource;
  staleness: GraphStaleness;
}

export interface FileSummary {
  ref: string;               // repo-relative file path
  symbols: number;
  unresolvedCalls: number;
  riskBucket: RiskBucket;
}

export interface SymbolSummary {
  ref: string;               // qualifiedName, e.g. "src/lib/util.ts#formatName"
  kind: "Function" | "Class";
  callers: number;
  callees: number;
  riskBucket: RiskBucket;
}

export interface NodeDetail {
  node: GraphNode;
  signature?: string;
  callers: string[];         // qualifiedNames, sorted
  callees: string[];         // qualifiedNames, sorted
  unresolvedCount: number;
  risk: { bucket: RiskBucket; because: string[] };
}

export interface NotFoundPayload {
  error: "not-found";
  suggestions: string[];     // qualifiedNames worth retrying
}

export interface UnavailablePayload {
  error: "unavailable";
  message: string;
}

export interface PaletteMatch {
  ref: string;
  kind: string;
}

export type FilesPayload = (Provenance & { files: FileSummary[] }) | UnavailablePayload;
export type FileSymbolsPayload = (Provenance & { symbols: SymbolSummary[] }) | UnavailablePayload;
export type NodeDetailPayload = (Provenance & NodeDetail) | NotFoundPayload | UnavailablePayload;
export type PaletteSearchPayload = { matches: PaletteMatch[] } | UnavailablePayload;

const object = { type: "object" } as const;

export const closegraphRpc = {
  id: "closegraph",
  methods: {
    files: { input: object, output: object },
    fileSymbols: {
      input: { type: "object", properties: { file: { type: "string" } }, required: ["file"], additionalProperties: false },
      output: object,
    },
    nodeDetail: {
      input: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"], additionalProperties: false },
      output: object,
    },
    paletteSearch: {
      input: {
        type: "object",
        properties: { prefix: { type: "string" }, limit: { type: "number" } },
        required: ["prefix"],
        additionalProperties: false,
      },
      output: object,
    },
  },
  events: {},
} satisfies Rpc.PortableDefinition;
