/**
 * Pack file discovery — shared by every pack and (from Task 8) the merged pipeline.
 *
 * Ownership rule: a file belongs to a pack by EXTENSION, or — only when the pack
 * declares a shebang pattern — by the FIRST LINE of an extensionless file.
 * `.ts`/`.tsx` are never claimed here: that is ts-morph's territory.
 */
import { closeSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { LanguagePack } from "./types.js";

/** Directory names never descended into. `vendor` joins the shared skip list here
 *  (pipeline.ts starts consuming this list in Task 8 — the excalidraw before/after
 *  check lands there). The OS junk entries exist because a HOME-rooted session
 *  (no tsconfig.json → packs-only/allowJs fallback) walks a real user home:
 *  macOS `Library` and Windows `AppData`/`$RECYCLE.BIN`/`System Volume Information`
 *  carry caches/system state — EPERM-prone and never project source (live-hotfix:
 *  one Library/Caches read 500'd the whole files RPC). */
export const SKIP_DIR_NAMES: readonly string[] = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  "vendor",
  "Library",
  "AppData",
  "$RECYCLE.BIN",
  "System Volume Information",
  // macOS TCC-protected media dirs + trash: reading them prompts the user and
  // denies with EPERM (the Ghostty/opencode-serve consent incident). Segment-
  // matched like the rest — a repo genuinely containing e.g. a "Music" folder
  // trades that folder for never prompting on ~/Music.
  "Music",
  "Movies",
  "Pictures",
  ".Trash",
];

export interface ScanResult {
  entries: string[];
  /** one entry per directory that could not be READ (EPERM/EACCES/…): that
   *  directory is skipped and the walk continues everywhere else — a partial
   *  walk with reasons, never a thrown index. */
  walkErrors: string[];
}

const SKIP_DIRS = new Set(SKIP_DIR_NAMES);

/** Recursive file walk with per-directory fault isolation. Dot-names are pruned
 *  (parity with Bun.Glob's default dot:false — the previous walker) and
 *  SKIP_DIR_NAMES are pruned during traversal; symlinked directories are not
 *  followed (cycle safety). `matches` receives the repo-relative posix path. */
export function scanRepoFiles(repoRoot: string, matches: (relPath: string) => boolean): ScanResult {
  const entries: string[] = [];
  const walkErrors: string[] = [];
  const visit = (absDir: string, relDir: string): void => {
    let dirents: import("node:fs").Dirent[];
    try {
      dirents = readdirSync(absDir, { withFileTypes: true });
    } catch (error) {
      walkErrors.push(`${relDir === "" ? "." : relDir} (${error instanceof Error ? error.message : String(error)})`);
      return;
    }
    for (const dirent of dirents) {
      if (dirent.name.startsWith(".")) continue;
      const rel = relDir === "" ? dirent.name : `${relDir}/${dirent.name}`;
      if (dirent.isDirectory()) {
        if (!SKIP_DIRS.has(dirent.name)) visit(join(absDir, dirent.name), rel);
      } else if (matches(rel)) {
        entries.push(rel);
      }
    }
  };
  visit(repoRoot, "");
  return { entries, walkErrors };
}

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
export function discoverPackFiles(repoRoot: string, pack: LanguagePack): { files: string[]; walkErrors: string[] } {
  const out: string[] = [];
  const { entries, walkErrors } = scanRepoFiles(repoRoot, () => true);
  for (const rel of entries) {
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
  return { files: out.sort(), walkErrors };
}
