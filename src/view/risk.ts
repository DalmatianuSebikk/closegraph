/**
 * Structural risk score v1.1 (controller ruling, reconciling plan Ruling 5 with review
 * Importants 3+4): derived from graph facts, never stored.
 *
 *   entry point        = exported && directCallers === 0
 *   high               = reachedFromEntries >= 5
 *   medium             = entry point || reachedFromEntries >= 1 || directCallers >= 5
 *   low                = otherwise
 *
 * reachedFromEntries counts the DISTINCT entry points that reach the node within depth 3
 * over forward (callees) edges — precomputed once per graph handle by src/rpc-methods.ts.
 * The v1 factors (transitiveCallers thresholds, entry && transitive >= 5) are superseded:
 * transitive callers are reverse-reachability through direct callers, so the old `high`
 * condition (entry point with transitive callers) was unreachable from real graphs.
 */

export type RiskBucket = "low" | "medium" | "high";

export interface RiskFacts {
  readonly exported: boolean;
  readonly callers: number;
  readonly transitiveCallers: number;
  readonly reachedFromEntries: number;
}

export function isEntryPoint(facts: RiskFacts): boolean {
  return facts.exported && facts.callers === 0;
}

export function riskBucket(facts: RiskFacts): RiskBucket {
  if (facts.reachedFromEntries >= 5) return "high";
  if (isEntryPoint(facts) || facts.reachedFromEntries >= 1 || facts.callers >= 5) return "medium";
  return "low";
}

/** Human-readable reasons naming each fired rule; never empty so panels can render "risk: X — …" inline. */
export function riskExplain(facts: RiskFacts): string[] {
  const reasons: string[] = [];
  if (isEntryPoint(facts)) reasons.push("entry point");
  if (facts.reachedFromEntries > 0) {
    reasons.push(`reached from ${facts.reachedFromEntries} entry point${facts.reachedFromEntries === 1 ? "" : "s"} within depth 3`);
  }
  if (facts.callers >= 5) {
    reasons.push(`${facts.callers} direct caller${facts.callers === 1 ? "" : "s"}`);
  }
  return reasons.length > 0 ? reasons : ["no structural risk factors"];
}
