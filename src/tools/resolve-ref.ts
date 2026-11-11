import type { GraphNode } from "../graph/types.js";
import type { GraphHandle } from "./graph-service.js";

const MAX_MATCHES = 5;

/** Resolution stage 1: a qualifiedName is exact — try each kind-prefixed node id. */
function exactNode(handle: GraphHandle, ref: string): GraphNode | undefined {
  for (const kind of ["File", "Function", "Class"] as const) {
    const node = handle.store.getNode(`${kind}:${ref}`);
    if (node !== undefined) return node;
  }
  return undefined;
}

export interface Resolution {
  readonly node?: GraphNode;
  readonly candidates: GraphNode[];
  readonly suggestion?: string;
  /** true when the ref matched several nodes; false when nothing matched and these are only look-alikes */
  readonly ambiguous: boolean;
}

/** qualifiedName → symbolPath suffix → file path prefix → not found with suggestions. */
export function resolveRef(handle: GraphHandle, ref: string): Resolution {
  const exact = exactNode(handle, ref);
  if (exact !== undefined) return { node: exact, candidates: [], ambiguous: false };

  const all = handle.store.allNodes();

  const suffixMatches = all
    .filter((n) => n.qualifiedName.endsWith(ref))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (suffixMatches.length === 1) return { node: suffixMatches[0], candidates: [], ambiguous: false };
  if (suffixMatches.length > 1) {
    return { candidates: suffixMatches.slice(0, MAX_MATCHES), suggestion: suffixMatches[0].qualifiedName, ambiguous: true };
  }

  const fileMatches = all
    .filter((n) => n.kind === "File" && n.filePath.startsWith(ref))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (fileMatches.length === 1) return { node: fileMatches[0], candidates: [], ambiguous: false };
  if (fileMatches.length > 1) {
    return { candidates: fileMatches.slice(0, MAX_MATCHES), suggestion: fileMatches[0].filePath, ambiguous: true };
  }

  const needle = ref.toLowerCase();
  const suggestions = all
    .filter((n) => n.qualifiedName.toLowerCase().includes(needle))
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, MAX_MATCHES);
  return { candidates: suggestions, suggestion: suggestions[0]?.qualifiedName, ambiguous: false };
}

/** Miss rendering shared by the closegraph tools: heading + one candidate per line. */
export function renderMatches(ref: string, candidates: GraphNode[], heading: string): string {
  return [`${heading} (${candidates.length}) for ${ref}:`, ...candidates.map((n) => `  - ${n.qualifiedName}`)].join("\n");
}
