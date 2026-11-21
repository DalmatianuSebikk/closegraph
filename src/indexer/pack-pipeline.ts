/**
 * Pack pass over an indexed repo (Task 8): every registered language pack
 * discovers its files, parses them, and merges nodes/edges into the SAME store
 * the ts-morph pass filled. This module is where the packs' ExternalCallRef
 * contract is honored — same-file calls arrive already resolved by the pack;
 * everything else arrives as refs resolved HERE over the full walked set or
 * kept as unresolved edges named by the exact expression text. Never dropped.
 *
 * Two phases per pack (pinned by tests/packs/coexistence.test.ts):
 *   1. per file: parse + extract, fold sinks into node dangerousCalls, upsert
 *      nodes, close literal imports over the walked set;
 *   2. resolve every collected externalRef using the pack's resolution flags
 *      (moduleAliases → import-bound file; classIndex → repo-wide short-class
 *      map; includeClosure → same file + literal include/source closure).
 *      Resolved → inferred call edge (both endpoints must exist — the dangling
 *      edge rule); unresolved → `external:<expressionText>` edge.
 *
 * A missing grammar degrades to a note (`pack skipped: …`), never a crashed
 * index; a pack with zero discovered files never loads its grammar at all
 * (lazy-by-construction pin from the runtime).
 */
import { join, resolve as resolvePath, sep } from "node:path";
import { readFileSync } from "node:fs";
import type { GraphStore } from "../graph/store.js";
import type { GraphEdge } from "../graph/types.js";
import { makeNodeId, makeQualifiedName } from "../graph/types.js";
import { allPacks } from "../packs/registry.js";
import { discoverPackFiles } from "../packs/discover.js";
import { GrammarMissingError, loadParser } from "../packs/runtime.js";
import type { ExternalCallRef, LanguagePack, PackExtraction, PackResolveCtx } from "../packs/types.js";
import type { LanguageRunMetrics } from "./pipeline.js";

export interface PackPassResult {
  metrics: Record<string, LanguageRunMetrics>;
  notes: string[];
}

interface FilePass {
  relPath: string;
  extraction: PackExtraction;
}

/** PackResolveCtx factory (design D1): readable walked files + their extractions
 *  + a cached sync reader that serves ANY repo-relative path (manifests like
 *  go.mod are never walked) and refuses paths that escape the root. */
function makeCtx(repoRoot: string, records: FilePass[], sources: Map<string, string>): PackResolveCtx {
  const rootAbs = resolvePath(repoRoot);
  const cache = new Map<string, string | undefined>([...sources.entries()].map(([k, v]) => [k, v] as const));
  return {
    root: repoRoot,
    files: records.map((r) => r.relPath),
    extractions: new Map(records.map((r) => [r.relPath, r.extraction] as const)),
    readFile(relPath: string): string | undefined {
      if (cache.has(relPath)) return cache.get(relPath);
      let text: string | undefined;
      const abs = resolvePath(rootAbs, relPath);
      if (abs.startsWith(rootAbs + sep)) {
        try {
          text = readFileSync(abs, "utf8");
        } catch {
          text = undefined;
        }
      }
      cache.set(relPath, text);
      return text;
    },
  };
}

/** dangerouslyCalls folding: sinks aggregated per node id → { name, count } sorted by name. */
function foldSinks(records: FilePass[]): Map<string, { name: string; count: number }[]> {
  const perNode = new Map<string, Map<string, number>>();
  for (const { relPath, extraction } of records) {
    for (const sink of extraction.sinks) {
      const nodeId =
        sink.symbolPath === ""
          ? makeNodeId("File", relPath)
          : makeNodeId("Function", makeQualifiedName(relPath, sink.symbolPath));
      const counts = perNode.get(nodeId) ?? new Map<string, number>();
      counts.set(sink.spec.callee, (counts.get(sink.spec.callee) ?? 0) + 1);
      perNode.set(nodeId, counts);
    }
  }
  const folded = new Map<string, { name: string; count: number }[]>();
  for (const [nodeId, counts] of perNode) {
    folded.set(
      nodeId,
      [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    );
  }
  return folded;
}

function callerIdOf(relPath: string, fromSymbolPath: string): string {
  return fromSymbolPath === ""
    ? makeNodeId("File", relPath)
    : makeNodeId("Function", makeQualifiedName(relPath, fromSymbolPath));
}

/** Module-level (non-dotted) Function id in a walked file, if that node exists. */
function moduleFunctionId(store: GraphStore, relPath: string, functionName: string): string | undefined {
  if (functionName === "" || functionName.includes(".")) return undefined;
  const id = makeNodeId("Function", makeQualifiedName(relPath, functionName));
  return store.getNode(id) === undefined ? undefined : id;
}

/**
 * Run every registered pack over repoRoot, merging into `store`. `walked` is
 * the walked-file set imports close over: it arrives holding the ts-morph pass
 * files and gains each pack's files as they are discovered.
 */
export async function runPackPasses(repoRoot: string, store: GraphStore, walked: Set<string>): Promise<PackPassResult> {
  const metrics: Record<string, LanguageRunMetrics> = {};
  const notes: string[] = [];

  for (const pack of allPacks()) {
    const { files, walkErrors } = discoverPackFiles(repoRoot, pack);
    for (const walkError of walkErrors) notes.push(`walk skipped unreadable directory: ${walkError}`);
    if (files.length === 0) continue; // lazy: no files ⇒ no grammar load

    let parse;
    try {
      parse = await loadParser(pack.grammarName);
    } catch (error) {
      if (error instanceof GrammarMissingError) {
        notes.push(`pack skipped: ${pack.id} grammar unavailable (${error.message})`);
        continue;
      }
      throw error;
    }

    // per-pack crash isolation (final review Important 2): a throwing extract() —
    // or any failure later in this pack's pass — skips THAT pack with a note,
    // mirroring the grammar-missing path; the ts-morph graph and every other
    // pack's contribution survive. The extract loop runs BEFORE any node of this
    // pack lands in the store, so a mid-pack failure leaves no partial nodes.
    try {
      const records: FilePass[] = [];
      const sources = new Map<string, string>();
      for (const relPath of files) {
        let source: string;
        try {
          source = await Bun.file(join(repoRoot, relPath)).text();
        } catch (error) {
          // per-FILE isolation (live hotfix): one locked/unreadable file skips
          // itself with a note — never its whole language, never the index.
          // The per-pack catch below stays for extract-time failures only.
          notes.push(`file skipped: ${relPath} (${error instanceof Error ? error.message : String(error)})`);
          continue;
        }
        sources.set(relPath, source);
        records.push({ relPath, extraction: pack.extract(parse(source), relPath, source) });
      }
      if (records.length === 0) {
        continue; // every file was unreadable — notes carry why; no empty language entry
      }
      for (const { relPath } of records) walked.add(relPath);

      // wave-2 opening (design D1): the pack's optional resolver, built from a
      // ctx over THIS pack's readable files; undefined keeps phase 2 untouched
      const resolver = pack.createResolver?.(makeCtx(repoRoot, records, sources));

      // sinks fold into node dangerousCalls BEFORE the nodes land in the store
      const dangerous = foldSinks(records);
      for (const { relPath, extraction } of records) {
        for (const node of extraction.nodes) {
          const stamped = dangerous.get(node.id);
          store.upsertNode(stamped === undefined ? node : { ...node, dangerousCalls: stamped });
        }
      }

      // literal imports close over the walked set (pack edges carry inferred)
      const pendingImports: GraphEdge[] = [];
      for (const { relPath, extraction } of records) {
        for (const target of extraction.importTargets) {
          if (!walked.has(target)) continue;
          pendingImports.push({
            kind: "imports",
            from: makeNodeId("File", relPath),
            to: makeNodeId("File", target),
            inferred: true,
          });
        }
      }

      // repo-wide short-class-name map over this pack's files (deterministic: first file wins)
      const classFiles = new Map<string, string>();
      if (pack.resolution.classIndex) {
        for (const { relPath, extraction } of records) {
          for (const node of extraction.nodes) {
            if (node.kind === "Class" && !classFiles.has(node.name)) classFiles.set(node.name, relPath);
          }
        }
      }

      // literal include/source closure per file (same-pack, cycle-safe, walked-only)
      const importTargetsOf = new Map(records.map((r) => [r.relPath, r.extraction.importTargets] as const));
      function closureOf(relPath: string): Set<string> {
        const seen = new Set<string>([relPath]);
        const queue = [relPath];
        while (queue.length > 0) {
          const current = queue.shift()!;
          for (const target of importTargetsOf.get(current) ?? []) {
            if (walked.has(target) && !seen.has(target)) {
              seen.add(target);
              queue.push(target);
            }
          }
        }
        return seen;
      }

      // same-file resolved call edges + contains edges land now that nodes exist
      for (const { relPath, extraction } of records) {
        for (const edge of extraction.edges) store.addEdge(edge);
      }
      for (const edge of pendingImports) store.addEdge(edge);

      // resolver-contributed File→File imports (design D1): walked-only, deduped,
      // deterministic order; inferred like every pack-derived edge. A throwing
      // fileImports contributes nothing — it never fails the pack (final review #1).
      let resolverImports: readonly { fromRelPath: string; targetRelPath: string }[] = [];
      try {
        resolverImports = resolver?.fileImports?.() ?? [];
      } catch {
        resolverImports = [];
      }
      const seenResolverImports = new Set<string>();
      for (const imp of [...resolverImports].sort((a, b) =>
        a.fromRelPath + "\0" + a.targetRelPath < b.fromRelPath + "\0" + b.targetRelPath ? -1 : 1,
      )) {
        if (!walked.has(imp.fromRelPath) || !walked.has(imp.targetRelPath)) continue;
        const key = imp.fromRelPath + "\0" + imp.targetRelPath;
        if (seenResolverImports.has(key)) continue;
        seenResolverImports.add(key);
        store.addEdge({
          kind: "imports",
          from: makeNodeId("File", imp.fromRelPath),
          to: makeNodeId("File", imp.targetRelPath),
          inferred: true,
        });
      }

      // phase 2: resolve every externalRef over the walked set — or keep it as an
      // unresolved edge named by the exact expression text (never dropped)
      const resolveOne = (ref: ExternalCallRef, relPath: string): string | undefined => {
        // hook FIRST. A returned id must exist in the store — a fabricated id
        // yields undefined WITHOUT consulting the flags. Order is hook → flags
        // → external classification, so a repo-declared fn shadowing a builtin
        // resolves before the external classifier can claim it (pinned in
        // go-resolver tests). A throwing hook is a per-ref miss, never a pack
        // failure (final review #1).
        let hooked: string | undefined;
        try {
          hooked = resolver?.resolveRef(ref, relPath);
        } catch {
          hooked = undefined;
        }
        if (hooked !== undefined) {
          return store.getNode(hooked) !== undefined ? hooked : undefined;
        }
        return resolveRef(pack, ref, relPath, store, classFiles, importTargetsOf, closureOf, walked);
      };
      const isExternal = (ref: ExternalCallRef, relPath: string): boolean => {
        try {
          return resolver?.isExternalPackage?.(ref, relPath) === true;
        } catch {
          return false; // a throwing classifier claims nothing (final review #1)
        }
      };

      let sameFileResolved = 0;
      let externalNoRef = 0;
      let phase2Resolved = 0;
      let externalClassified = 0;

      for (const { relPath, extraction } of records) {
        sameFileResolved += extraction.metrics.resolved;
        externalNoRef += extraction.metrics.external;

        for (const ref of extraction.externalRefs) {
          const from = callerIdOf(relPath, ref.fromSymbolPath);
          const target = resolveOne(ref, relPath);
          if (target !== undefined && store.getNode(from) !== undefined) {
            phase2Resolved++;
            store.addEdge({ kind: "calls", from, to: target, inferred: true });
          } else if (isExternal(ref, relPath)) {
            // known-external (design Q1 policy A): counted, NO edge, NOT unresolved
            externalClassified++;
          } else {
            store.addEdge({
              kind: "calls",
              from,
              to: `external:${ref.expressionText}`,
              unresolved: true,
              targetName: ref.expressionText,
            });
          }
        }
        externalNoRef += extraction.metrics.unresolved - extraction.externalRefs.length;
      }
      if (externalNoRef < 0) externalNoRef = 0; // defensive: pack metrics and refs cannot disagree, but never lie negative

      const totals = records.reduce(
        (acc, { extraction }) => ({
          callSites: acc.callSites + extraction.metrics.callSites,
          unparseable: acc.unparseable + extraction.metrics.unparseable,
          sinks: acc.sinks + extraction.sinks.length,
        }),
        { callSites: 0, unparseable: 0, sinks: 0 },
      );
      const refTotal = records.reduce((acc, { extraction }) => acc + extraction.externalRefs.length, 0);
      metrics[pack.id] = {
        files: records.length,
        callSites: totals.callSites,
        resolved: sameFileResolved + phase2Resolved,
        unresolved: refTotal - phase2Resolved - externalClassified,
        external: externalNoRef + externalClassified,
        inferred: phase2Resolved,
        unparseable: totals.unparseable,
        dangerousSinks: totals.sinks,
      };
    } catch (error) {
      notes.push(`pack failed: ${pack.id} (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
  }

  return { metrics, notes };
}

/** One ref → a walked target node id, per the pack's resolution flags (first hit wins). */
function resolveRef(
  pack: LanguagePack,
  ref: ExternalCallRef,
  fromRelPath: string,
  store: GraphStore,
  classFiles: Map<string, string>,
  importTargetsOf: Map<string, readonly string[]>,
  closureOf: (relPath: string) => Set<string>,
  walked: Set<string>,
): string | undefined {
  // ClassName::method() → the repo-wide class index, then Class.method in that file
  if (ref.className !== undefined && pack.resolution.classIndex) {
    const classRel = classFiles.get(ref.className);
    if (classRel !== undefined) {
      const id = makeNodeId("Function", makeQualifiedName(classRel, `${ref.className}.${ref.functionName}`));
      if (store.getNode(id) !== undefined) return id;
    }
    return undefined;
  }

  // import-bound module function (python `from x import f` / `import x.y as z`):
  // the ref's own file's literal import targets, closed over the walked set
  if (pack.resolution.moduleAliases) {
    for (const target of importTargetsOf.get(fromRelPath) ?? []) {
      if (!walked.has(target)) continue;
      const id = moduleFunctionId(store, target, ref.functionName);
      if (id !== undefined) return id;
    }
  }

  // include/source closure: same file + transitively included/sourced walked files
  if (pack.resolution.includeClosure) {
    for (const file of [...closureOf(fromRelPath)].sort()) {
      const id = moduleFunctionId(store, file, ref.functionName);
      if (id !== undefined) return id;
    }
  }

  return undefined;
}
