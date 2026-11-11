/**
 * Structural risk score (plan 3 Ruling 5): derived from graph facts, never stored.
 * entry point = exported && no intra-project callers;
 * medium = entry point || transitiveCallers >= 5; high = entry point && transitiveCallers >= 5.
 */

export type RiskBucket = "low" | "medium" | "high";

export interface RiskFacts {
  readonly exported: boolean;
  readonly callers: number;
  readonly transitiveCallers: number;
}

export function isEntryPoint(facts: RiskFacts): boolean {
  return facts.exported && facts.callers === 0;
}

export function riskBucket(facts: RiskFacts): RiskBucket {
  const entry = isEntryPoint(facts);
  if (entry && facts.transitiveCallers >= 5) return "high";
  if (entry || facts.transitiveCallers >= 5) return "medium";
  return "low";
}

/** Human-readable reasons for the bucket; never empty so panels can render "risk: X — …" inline. */
export function riskExplain(facts: RiskFacts): string[] {
  const reasons: string[] = [];
  if (isEntryPoint(facts)) reasons.push("entry point");
  if (facts.transitiveCallers > 0) {
    reasons.push(`${facts.transitiveCallers} transitive caller${facts.transitiveCallers === 1 ? "" : "s"}`);
  }
  return reasons.length > 0 ? reasons : ["no structural risk factors"];
}
