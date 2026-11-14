/**
 * Pack registry — process-global, registration order preserved. `registerPacks()`
 * (src/packs/index.ts) is the only production registrar; tests register stubs
 * directly and MUST clear them afterwards (bun runs all test files in one process).
 */
import type { LanguagePack } from "./types.js";
import { fileExtension, firstLineOf } from "./discover.js";

const packs: LanguagePack[] = [];

/** Registers a pack; idempotent by id (first registration wins), keeps order. */
export function registerPack(pack: LanguagePack): void {
  if (packs.some((existing) => existing.id === pack.id)) return;
  packs.push(pack);
}

/** Every registered pack, in registration order. */
export function allPacks(): readonly LanguagePack[] {
  return packs;
}

/** The pack owning this file, or undefined: extension match first, then (for
 *  extensionless files only) the first registered pack whose shebang pattern
 *  claims the file's first line. `.ts`/`.tsx` → undefined (ts-morph's territory). */
export function packForFile(relPath: string, absPath: string): LanguagePack | undefined {
  const ext = fileExtension(relPath);
  if (ext !== "") {
    return packs.find((pack) => pack.extensions.includes(ext));
  }
  let firstLine: string | undefined;
  for (const pack of packs) {
    if (pack.shebang === undefined) continue;
    if (firstLine === undefined) firstLine = firstLineOf(absPath);
    if (firstLine !== undefined && pack.shebang.test(firstLine)) return pack;
  }
  return undefined;
}

/** TEST-ONLY: empties the registry. Production code never calls this. */
export function clearRegisteredPacks(): void {
  packs.length = 0;
}
