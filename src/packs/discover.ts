/**
 * Pack file discovery — shared by every pack and (from Task 8) the merged pipeline.
 *
 * Ownership rule: a file belongs to a pack by EXTENSION, or — only when the pack
 * declares a shebang pattern — by the FIRST LINE of an extensionless file.
 * `.ts`/`.tsx` are never claimed here: that is ts-morph's territory.
 */
import { closeSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { LanguagePack } from "./types.js";

/** Directory names never descended into. `vendor` joins the shared skip list here
 *  (pipeline.ts starts consuming this list in Task 8 — the excalidraw before/after
 *  check lands there). */
export const SKIP_DIR_NAMES: readonly string[] = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  "vendor",
];

/** Claims a first line as a bash-family interpreter line: bash or sh, direct or
 *  via env (incl. `env -S`). Deliberately narrow — perl, python3, zsh, and dash
 *  are NOT claimed (dash is POSIX sh but staying narrow avoids false positives;
 *  documented limitation). */
export const SHEBANG_RE = /^#!\s*\/(?:[^\s/]+\/)*(?:env\s+(?:-S\s+)?)?(?:ba)?sh(?:[\s;#]|$)/;

/** Shebang lines live in the first bytes of a file; a longer first line cannot
 *  start with a shorter match than this without already having decided. */
const FIRST_LINE_BYTES = 512;

/** Reads ONLY the first line of a file (undefined when it cannot be read). */
export function firstLineOf(absPath: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(absPath, "r");
    const buffer = Buffer.alloc(FIRST_LINE_BYTES);
    const read = readSync(fd, buffer, 0, FIRST_LINE_BYTES, 0);
    const text = buffer.toString("utf8", 0, read);
    return text.split(/[\r\n]/, 1)[0] ?? "";
  } catch {
    return undefined; // missing or unreadable files claim nothing
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** True when the file's FIRST line is a bash/sh shebang (later lines never count). */
export function hasBashShebang(absPath: string): boolean {
  const firstLine = firstLineOf(absPath);
  return firstLine !== undefined && SHEBANG_RE.test(firstLine);
}

/** The lowercase extension of a path's basename, posix-style; "" when there is
 *  none (a leading dot alone is not an extension: ".gitignore" → ""). Uppercase
 *  suffixes are claimed too: `Module.PY` lowercases to `.py` (final-review minor 3). */
export function fileExtension(relPath: string): string {
  const base = relPath.split("/").pop() ?? relPath;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

/** Repo-relative posix paths (sorted) of every file this pack owns under repoRoot:
 *  extension matches, plus extensionless files claimed by the pack's shebang. */
export function discoverPackFiles(repoRoot: string, pack: LanguagePack): string[] {
  const skip = new Set(SKIP_DIR_NAMES);
  const out: string[] = [];
  for (const entry of new Bun.Glob("**/*").scanSync({ cwd: repoRoot })) {
    const segments = entry.split(/[\\/]/);
    if (segments.some((segment) => skip.has(segment))) continue;
    const rel = segments.join("/");
    const ext = fileExtension(rel);
    if (pack.extensions.includes(ext)) {
      out.push(rel);
      continue;
    }
    if (ext === "" && pack.shebang !== undefined) {
      const firstLine = firstLineOf(join(repoRoot, rel));
      if (firstLine !== undefined && pack.shebang.test(firstLine)) out.push(rel);
    }
  }
  return out.sort();
}
