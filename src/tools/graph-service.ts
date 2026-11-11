import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { indexRepo } from "../indexer/pipeline.js";
import { isStale, restoreSnapshot, takeSnapshot } from "../graph/snapshot.js";
import type { SnapshotData } from "../graph/snapshot.js";
import type { GraphStore } from "../graph/store.js";
import type { IndexResult } from "../indexer/pipeline.js";

export type IndexMetrics = IndexResult["metrics"];

/** Raised by get() when the root is not an indexable TypeScript project; tools catch and render it. */
export class GraphUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphUnavailableError";
  }
}

/**
 * Minimal plugin-storage surface, structurally satisfied by ctx.storage
 * (StorageDomain: get/set/remove over JSON values). See dist/promise/storage.d.ts.
 */
export interface PluginStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface GraphHandle {
  readonly store: GraphStore;
  readonly metrics: IndexMetrics;
  readonly source: "built" | "snapshot";
  /** "fresh" when built or when the snapshot's gitHead matches; "unknown" when gitHead is absent on either side (Ruling 13) */
  readonly staleness: "fresh" | "unknown";
}

export interface GraphService {
  get(progress?: (msg: string) => void): Promise<GraphHandle>;
  invalidate(): void;
}

/** 8-hex-char digest of a string (FNV-1a 32-bit) — the same slice-width approach as the
 *  graph's disambiguateId (src/graph/types.ts); disambiguateId slices an existing content
 *  hash, so the digest itself lives here. */
function hash8(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Ruling 7: snapshot storage key namespaced per root — closegraph/<basename>-<hash8(abs
 *  root)>/snapshot.json — so multiple roots never collide on one key. The pre-namespace
 *  single key simply becomes stale garbage (accepted migration: no removal of the old key). */
export function snapshotStorageKey(root: string): string {
  const absRoot = resolve(root);
  const basename = absRoot.split("/").filter(Boolean).at(-1) ?? "root";
  return `closegraph/${basename}-${hash8(absRoot)}/snapshot.json`;
}

/** git rev-parse HEAD; undefined when not a git repo or git fails (mirrors cli.ts's helper). */
async function currentGitHead(root: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "HEAD"], {
      cwd: root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const head = (await new Response(proc.stdout).text()).trim();
    const code = await proc.exited;
    if (code !== 0) return undefined;
    return head === "" ? undefined : head;
  } catch {
    return undefined;
  }
}

/** Snapshots persist edges, not per-site metrics: fall back to an edge-based breakdown (cli.ts precedent). */
function edgeBasedMetrics(store: GraphStore): IndexMetrics {
  let resolved = 0;
  let unresolved = 0;
  for (const node of store.allNodes()) {
    for (const edge of store.edgesFrom(node.id, "calls")) {
      if (edge.unresolved) unresolved++;
      else resolved++;
    }
  }
  return {
    callSites: resolved + unresolved,
    resolved,
    external: 0,
    unresolved,
    files: store.stats().files,
    dynamicImports: 0,
    durationMs: 0,
  };
}

/** Lazy graph lifecycle: build once, reuse in-memory, reuse across services via the persisted snapshot. */
export function createGraphService(root: string, storage?: PluginStorage): GraphService {
  let cached: Promise<GraphHandle> | undefined;
  const SNAPSHOT_KEY = snapshotStorageKey(root);

  async function build(progress?: (msg: string) => void): Promise<GraphHandle> {
    if (!existsSync(join(root, "tsconfig.json"))) {
      throw new GraphUnavailableError(`tsconfig.json not found in ${root} — closegraph requires a TypeScript project`);
    }
    progress?.(`[closegraph] indexing ${root}`);
    const result = indexRepo(root);
    progress?.(`[closegraph] indexed ${result.metrics.files} files in ${result.metrics.durationMs}ms`);
    if (storage !== undefined) {
      try {
        await storage.set(SNAPSHOT_KEY, JSON.stringify(takeSnapshot(result.store, root, await currentGitHead(root))));
      } catch {
        // persistence is best-effort: a failing storage must not discard a successful index
        progress?.(`[closegraph] snapshot write failed — keeping graph in memory`);
      }
    }
    return { store: result.store, metrics: result.metrics, source: "built", staleness: "fresh" };
  }

  async function removeSnapshotBestEffort(): Promise<void> {
    try {
      await storage?.remove(SNAPSHOT_KEY);
    } catch {
      // a storage that cannot remove must not block the rebuild either
    }
  }

  async function load(progress?: (msg: string) => void): Promise<GraphHandle> {
    // snapshot reuse: staleness needs a gitHead on BOTH sides — undefined on either
    // side means "cannot detect staleness", never "stale" (ledger Ruling 13)
    if (storage !== undefined) {
      let raw: unknown;
      try {
        raw = await storage.get(SNAPSHOT_KEY);
      } catch {
        // storage outage: degrade silently to an in-memory build — no remove, no throw
        raw = undefined;
      }
      if (raw !== undefined && typeof raw !== "string") {
        // non-string at the key is corruption: drop it and rebuild
        await removeSnapshotBestEffort();
      }
      if (typeof raw === "string") {
        try {
          const snap = JSON.parse(raw) as SnapshotData;
          const store = restoreSnapshot(snap);
          const head = await currentGitHead(root);
          if (snap.repoRoot === root && !isStale(snap, head)) {
            return {
              store,
              metrics: edgeBasedMetrics(store),
              source: "snapshot",
              staleness: snap.gitHead === undefined || head === undefined ? "unknown" : "fresh",
            };
          }
          // different repo or moved HEAD: fall through to a rebuild
        } catch {
          // corrupt snapshot: drop the key and rebuild
          await removeSnapshotBestEffort();
        }
      }
    }

    return build(progress);
  }

  function get(progress?: (msg: string) => void): Promise<GraphHandle> {
    // single-flight: assign the promise synchronously so concurrent cold callers
    // share one load instead of each running a full indexRepo
    if (cached === undefined) {
      const promise = load(progress);
      cached = promise;
      // a rejected build must not poison the cache: clear it so the next get() retries
      void promise.catch(() => {
        if (cached === promise) cached = undefined;
      });
    }
    return cached;
  }

  return {
    get,
    /** Drop the in-memory cache; the next get re-checks storage and rebuilds if needed. */
    invalidate() {
      cached = undefined;
    },
  };
}
