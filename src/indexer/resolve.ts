import type { Project, SourceFile } from "ts-morph";
import { relative, resolve } from "node:path";

/**
 * Converts an absolute path to a repo-relative posix path; undefined when the
 * path is the repo root itself or escapes it (".."). Shared by resolve and
 * extract — keep semantics identical when touching this.
 */
export function toRepoRelative(absPath: string, repoRoot: string): string | undefined {
  const rel = relative(resolve(repoRoot), resolve(absPath));
  if (rel === "" || rel.startsWith("..")) return undefined;
  return rel.split(/[\\/]/).join("/");
}

function isProjectLocal(sf: SourceFile, repoRoot: string): boolean {
  if (sf.isFromExternalLibrary()) return false;
  const rel = toRepoRelative(sf.getFilePath(), repoRoot);
  return rel !== undefined && !rel.startsWith("..") && !rel.includes("/node_modules/");
}

/** Common shape of import/export declarations that can point at a module source file. */
interface ModuleSpecified {
  getModuleSpecifierSourceFile(): SourceFile | undefined;
}

export function moduleSpecifierTarget(decl: ModuleSpecified): SourceFile | undefined {
  try {
    return decl.getModuleSpecifierSourceFile();
  } catch {
    return undefined;
  }
}

/**
 * True when the file itself declares the symbol (not merely re-exports it).
 * Name "default" matches the file's default export. Broader than extract.ts's
 * declarationsOfNameIn (which returns only extractable kinds) on purpose:
 * this gates "does the walk stop here", that maps to nodes.
 */
function fileDeclares(sf: SourceFile, name: string): boolean {
  if (name === "default") {
    try {
      return sf.getDefaultExportSymbol() !== undefined;
    } catch {
      return false;
    }
  }
  return (
    sf.getFunction(name) !== undefined ||
    sf.getClass(name) !== undefined ||
    sf.getInterface(name) !== undefined ||
    sf.getEnum(name) !== undefined ||
    sf.getTypeAlias(name) !== undefined ||
    sf.getModule(name) !== undefined ||
    sf.getVariableDeclaration(name) !== undefined
  );
}

/**
 * Maps every import specifier in sourceFile to a repo-relative target path.
 * Returns only project-local resolutions; externals (node_modules, node:*) are omitted.
 */
export function resolveImports(project: Project, sourceFile: SourceFile, repoRoot: string): string[] {
  const out: string[] = [];
  for (const importDecl of sourceFile.getImportDeclarations()) {
    const target = moduleSpecifierTarget(importDecl);
    if (target === undefined || target === sourceFile) continue; // external or unresolvable
    if (!isProjectLocal(target, repoRoot)) continue;
    const rel = toRepoRelative(target.getFilePath(), repoRoot)!;
    if (!out.includes(rel)) out.push(rel);
  }
  return out;
}

/**
 * Follows a (possibly barrel-mediated) export to the file that actually declares the symbol.
 * Walks named-export chains (and `export *` fallbacks) until a file whose own
 * declaration defines the symbol; returns undefined when the symbol stays external.
 */
export function followToDeclaration(project: Project, sourceFile: SourceFile, symbolName: string): SourceFile | undefined {
  const visited = new Set<SourceFile>();
  // walk entries carry the name the symbol travels under: matching an export
  // specifier by ALIAS continues the walk under its ORIGINAL name — for
  // `export { named as NAMED } from "./mod"` the target declares `named`
  const queue: Array<{ sf: SourceFile; name: string }> = [{ sf: sourceFile, name: symbolName }];
  while (queue.length > 0) {
    const entry = queue.shift()!;
    if (visited.has(entry.sf)) continue;
    visited.add(entry.sf);
    if (fileDeclares(entry.sf, entry.name)) return entry.sf;
    for (const exportDecl of entry.sf.getExportDeclarations()) {
      const target = moduleSpecifierTarget(exportDecl);
      if (target === undefined || visited.has(target)) continue;
      if (exportDecl.isNamespaceExport()) {
        // `export * from "./x"`: safe to follow, fileDeclares gates the final answer
        queue.push({ sf: target, name: entry.name });
        continue;
      }
      for (const spec of exportDecl.getNamedExports()) {
        const original = spec.getName();
        const alias = spec.getAliasNode()?.getText();
        if (original === entry.name) {
          queue.push({ sf: target, name: entry.name });
          break;
        }
        if (alias !== undefined && alias === entry.name) {
          queue.push({ sf: target, name: original }); // rename hop
          break;
        }
      }
    }
  }
  return undefined;
}
