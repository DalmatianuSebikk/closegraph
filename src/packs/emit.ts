/**
 * Shared emission helpers — every pack converts tree-sitter nodes to graph
 * primitives through these so spans and signature caps stay identical.
 */
import type { Node as SyntaxNode } from "web-tree-sitter";
import type { SourceSpan } from "../graph/types.js";

const MAX_SIGNATURE_LENGTH = 120; // same cap as the ts-morph pass (extract.ts)

/** tree-sitter positions are 0-based {row, column}; graph spans are 1-based. */
export function spanFromNode(node: SyntaxNode): SourceSpan {
  return {
    start: { line: node.startPosition.row + 1, col: node.startPosition.column + 1 },
    end: { line: node.endPosition.row + 1, col: node.endPosition.column + 1 },
  };
}

/** ≤120 chars with the same "…" convention as extract.ts's truncate(). */
export function truncateSignature(text: string): string {
  return text.length > MAX_SIGNATURE_LENGTH ? `${text.slice(0, MAX_SIGNATURE_LENGTH - 1)}…` : text;
}
