/**
 * Production pack registrar. Packs add exactly one registration line here as
 * they land (Task 5 python, Task 6 php, Task 7 bash) — Wave 2 follows suit.
 * Runtime, discovery, registry, and the merged pipeline are closed to packs.
 */
import { registerPack } from "./registry.js";
import { pythonPack } from "./python.js";

/** Registers every built-in language pack (idempotent — safe to call repeatedly). */
export function registerPacks(): void {
  registerPack(pythonPack);
  // Task 6: registerPack(phpPack);
  // Task 7: registerPack(bashPack);
}
