/**
 * Typed RPC contract between the TUI part and the server part (plan 3 Task 2).
 * Plain JSON Schemas keep this runtime-dependency-free (type-only imports);
 * payload types below are the compile-time contract the TUI codes against.
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
  language: string;          // "typescript" | "javascript" | pack ids — the file-map column (Task 10)
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
  /** dangerous calls found in this symbol (pack sink tables, Task 9); sorted by
   *  name; Function nodes plus bash File nodes for file-level bodies. */
  dangerousCalls?: { name: string; count: number }[];
  risk: { bucket: RiskBucket; because: string[] };
}

export interface NotFoundPayload extends Provenance {
  error: "not-found";
  /** true = the ref matched several nodes (suffix/file ambiguity); false = zero or one look-alike. */
  ambiguous: boolean;
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

/** One node of the ego graph: the center or a direct neighbor. `callers`/`callees`
 *  ARE the fan-in/fan-out counts — context for the re-center choice. The enrichment
 *  fields (box-enrichment iteration) answer the reviewer's five questions per box,
 *  every one bounded: one-line reason, clipped signature, ≤4 sink badges — never a
 *  raw body (egoSource is the pointer). */
export interface EgoNeighbor {
  ref: string;              // qualifiedName, e.g. "src/service/user.ts#UserService.greet"
  kind: "Function" | "Class" | "File";
  riskBucket: RiskBucket;
  callers: number;          // fan-in: direct resolved callers
  callees: number;          // fan-out: direct resolved callees
  signature?: string;       // node signature clipped to ~48 chars (functions only)
  file: string;             // repo-relative file path
  startLine: number;        // node span start — the file:line answer
  riskReason: string;       // the riskExplain line — WHY it was flagged
  sinks: { name: string; count: number }[]; // dangerous calls, ≤4 (names + per-sink count)
  sinksTotal: number;       // full dangerousCalls count when the badge list is capped
  exported: boolean;
  language: string;         // "typescript" | pack ids — the file-map column source
  unresolvedCount: number;  // the node's own unresolved outgoing calls (honesty meter)
}

export interface EgoGraphData extends Provenance {
  center: EgoNeighbor;
  callers: EgoNeighbor[];   // code-unit sorted (byQualifiedName), center EXCLUDED, capped at 15
  callees: EgoNeighbor[];   // same rules; a mutual-cycle neighbor may appear in BOTH — honest
  totalCallers: number;     // exact distinct-other totals — caps disclosed, never silent
  totalCallees: number;
  unresolvedOut: number;    // center's unresolved+external outgoing calls (summary line)
}

/** Lazy source preview (the `i` overlay): signature + the first ~10 lines of the
 *  node's source, read from disk under the caller's root. Never rides egoGraph. */
export interface EgoSourceData extends Provenance {
  ref: string;
  signature?: string;
  file: string;
  startLine: number;
  lines: string[];
}

export type FilesPayload = (Provenance & { files: FileSummary[] }) | UnavailablePayload;
export type FileSymbolsPayload = (Provenance & { symbols: SymbolSummary[] }) | UnavailablePayload;
export type NodeDetailPayload = (Provenance & NodeDetail) | NotFoundPayload | UnavailablePayload;
export type PaletteSearchPayload = (Provenance & { matches: PaletteMatch[] }) | UnavailablePayload;
export type EgoGraphPayload = EgoGraphData | NotFoundPayload | UnavailablePayload;
export type EgoSourcePayload = EgoSourceData | NotFoundPayload | UnavailablePayload;

const object = { type: "object" } as const;

/** Optional per-call graph root (shared services): the TUI sends its own
 *  directory; the server resolves one GraphService per root. Optional so
 *  legacy callers without a root keep the setup-default service. */
const rootProperty = { root: { type: "string" } } as const;

export const closegraphRpc = {
  id: "closegraph",
  methods: {
    files: { input: { type: "object", properties: { ...rootProperty }, additionalProperties: false }, output: object },
    fileSymbols: {
      input: {
        type: "object",
        properties: { file: { type: "string" }, ...rootProperty },
        required: ["file"],
        additionalProperties: false,
      },
      output: object,
    },
    nodeDetail: {
      input: {
        type: "object",
        properties: { ref: { type: "string" }, ...rootProperty },
        required: ["ref"],
        additionalProperties: false,
      },
      output: object,
    },
    paletteSearch: {
      input: {
        type: "object",
        properties: { prefix: { type: "string" }, limit: { type: "number" }, ...rootProperty },
        required: ["prefix"],
        additionalProperties: false,
      },
      output: object,
    },
    egoGraph: {
      input: {
        type: "object",
        properties: { ref: { type: "string" }, ...rootProperty },
        required: ["ref"],
        additionalProperties: false,
      },
      output: object,
    },
    egoSource: {
      input: {
        type: "object",
        properties: { ref: { type: "string" }, ...rootProperty },
        required: ["ref"],
        additionalProperties: false,
      },
      output: object,
    },
  },
  events: {},
} satisfies Rpc.PortableDefinition;
