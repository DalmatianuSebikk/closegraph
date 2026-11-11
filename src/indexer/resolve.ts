import type { Project, SourceFile } from "ts-morph";
import { relative, resolve } from "node:path";

/** Converts an absolute path to a repo-relative posix path; undefined when empty. */
function toRepoRelative(absPath: string, repoRoot: string): string | undefined {
  const rel = relative(resolve(repoRoot), resolve(absPath));
  if (rel === "") return undefined;
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

function moduleSpecifierTarget(decl: ModuleSpecified): SourceFile | undefined {
  try {
    return decl.getModuleSpecifierSourceFile();
  } catch {
    return undefined;
  }
}

/** True when the file itself declares the symbol (not merely re-exports it). */
function fileDeclares(sf: SourceFile, name: string): boolean {
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
  const queue: SourceFile[] = [sourceFile];
  while (queue.length > 0) {
    const sf = queue.shift()!;
    if (visited.has(sf)) continue;
    visited.add(sf);
    if (fileDeclares(sf, symbolName)) return sf;
    for (const exportDecl of sf.getExportDeclarations()) {
      const target = moduleSpecifierTarget(exportDecl);
      if (target === undefined || visited.has(target)) continue;
      if (exportDecl.isNamespaceExport()) {
        // `export * from "./x"`: safe to follow, fileDeclares gates the final answer
        queue.push(target);
        continue;
      }
      const named = exportDecl.getNamedExports().some(
        (spec) => spec.getName() === symbolName || spec.getAliasNode()?.getText() === symbolName,
      );
      if (named) queue.push(target);
    }
  }
  return undefined;
}
