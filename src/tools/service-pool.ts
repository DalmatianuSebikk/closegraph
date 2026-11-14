/**
 * Per-root GraphService pool for SHARED OpenCode services (live follow-up #2).
 *
 * A shared service runs plugin setup() once; its context.location cannot reflect
 * every TUI session's directory, so one setup-time GraphService binds every
 * session to a single root — the d7e3301 HOME fallback then hit ALL sessions.
 * The rpc contract now carries the caller's own `root` per call (RpcCallContext
 * is {signal, error} only — the payload is the only channel), and tool contexts
 * carry sessionID (resolvable to a directory via session.get). Both funnel into
 * this pool: one lazily-created GraphService per requested root, LRU-capped.
 *
 * Snapshots stay per-root by construction (graph-service keys storage by
 * snapshotStorageKey(root), which hashes the absolute root). Eviction only drops
 * the in-memory cache entry; the evicted root's snapshot persists and a later
 * resolve transparently rehydrates from it.
 */
import { resolve } from "node:path";
import { createGraphService, type GraphService, type PluginStorage } from "./graph-service.js";

export interface GraphServicePool {
  /** The setup-root service: legacy no-root rpc calls and tool fallbacks. */
  readonly default: GraphService;
  /** Service for a requested root (normalized absolute); undefined/"" → default.
   *  Lazily created, cached, LRU-touched on every hit. */
  resolve(root: string | undefined): GraphService;
  /** Live cached non-default roots (test hook). */
  size(): number;
}

export function createGraphServicePool(defaultRoot: string, storage?: PluginStorage, cap = 4): GraphServicePool {
  const defaultService = createGraphService(defaultRoot, storage);
  const defaultKey = resolve(defaultRoot);
  const cache = new Map<string, GraphService>(); // insertion order = LRU order
  return {
    default: defaultService,
    resolve(root) {
      if (root === undefined || root === "") return defaultService;
      const key = resolve(root);
      if (key === defaultKey) return defaultService; // the setup root is never duplicated
      const hit = cache.get(key);
      if (hit !== undefined) {
        cache.delete(key);
        cache.set(key, hit); // most-recently-used moves to the end
        return hit;
      }
      const service = createGraphService(key, storage);
      cache.set(key, service);
      while (cache.size > cap) cache.delete(cache.keys().next().value as string); // evict the least-recent
      return service;
    },
    size: () => cache.size,
  };
}

/**
 * Tools accept EITHER a plain GraphService (Plan-2 single-project behavior —
 * every existing factory call keeps working unchanged) OR a scope that resolves
 * the calling session's directory (setup context's session.get) and routes
 * through the pool. Best-effort: no sessionID / lookup failure / missing
 * directory all fall back to the pool's default service — the primary project
 * keeps working exactly as before.
 */
export interface ToolServiceScope {
  readonly pool: GraphServicePool;
  /** SessionID → its directory (from the setup context's session domain); the
   *  caller caches per sessionID — one host lookup per session, not per call. */
  sessionDirectory(sessionID: string): Promise<string | undefined>;
}

export type ToolServices = GraphService | ToolServiceScope;

export async function toolService(services: ToolServices, sessionID: string | undefined): Promise<GraphService> {
  if (!("pool" in services)) return services; // plain service — unchanged Plan-2 path
  if (sessionID === undefined) return services.pool.default;
  try {
    return services.pool.resolve(await services.sessionDirectory(sessionID));
  } catch {
    return services.pool.default; // a session that cannot be resolved is not a tool failure
  }
}
