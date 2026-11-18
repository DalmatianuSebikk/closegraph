/**
 * Per-target surface service: plugin-scope singleton over PluginStorage.
 * Storage is read-through lazy (a handle is created empty on miss and hydrated
 * from `closegraph/surface/<target>/surface.json` when present); snapshots are
 * written best-effort after each successful ingest — a storage outage degrades
 * to in-memory, the graph-service precedent.
 */
import { createSurfaceStore, restoreSurfaceStore, type SurfaceStore } from "./store";
import { normalizeTarget } from "./normalize";
import type { PluginStorage } from "../tools/graph-service";
import type { SurfaceSnapshot } from "./types";

export const SURFACE_INDEX_KEY = "closegraph/surface/index.json";

export function surfaceStorageKey(target: string): string {
  return `closegraph/surface/${normalizeTarget(target)}/surface.json`;
}

export interface SurfaceHandle {
  readonly target: string;
  readonly store: SurfaceStore;
  /** Persist best-effort: storage errors are swallowed (the in-memory graph
   *  stays the truth); ALSO updates the index key. Returns whether the write succeeded. */
  save(): Promise<boolean>;
}

export interface SurfaceService {
  /** normalizeTarget(input); storage read-through; creates an empty store on miss. */
  get(target: string): Promise<SurfaceHandle>;
  /** Cached targets UNION index key targets (sorted). */
  list(): Promise<string[]>;
  invalidate(target?: string): void; // drop cache (never deletes storage)
}

export function createSurfaceService(storage?: PluginStorage): SurfaceService {
  const handles = new Map<string, SurfaceHandle>();

  async function readIndex(): Promise<string[]> {
    if (!storage) return [];
    try {
      const raw = await storage.get(SURFACE_INDEX_KEY);
      if (typeof raw !== "string") return [];
      const parsed = JSON.parse(raw) as { targets?: string[] };
      return Array.isArray(parsed.targets) ? parsed.targets : [];
    } catch {
      return []; // unreadable index — treat as empty, never throw
    }
  }

  async function writeIndex(targets: string[]): Promise<boolean> {
    if (!storage) return false;
    try {
      await storage.set(SURFACE_INDEX_KEY, JSON.stringify({ targets: [...targets].sort() }));
      return true;
    } catch {
      return false;
    }
  }

  return {
    async get(input: string): Promise<SurfaceHandle> {
      const target = normalizeTarget(input);
      const cached = handles.get(target);
      if (cached) return cached;

      let store: SurfaceStore = createSurfaceStore(target);
      if (storage) {
        try {
          const raw = await storage.get(surfaceStorageKey(target));
          if (typeof raw === "string") {
            const snap = JSON.parse(raw) as SurfaceSnapshot;
            if (snap?.v === 1 && snap.target === target) store = restoreSurfaceStore(snap);
          }
        } catch {
          // corrupted snapshot — start empty; in-memory stays the truth
        }
      }

      const handle: SurfaceHandle = {
        target,
        store,
        async save(): Promise<boolean> {
          if (!storage) return false;
          try {
            await storage.set(surfaceStorageKey(target), JSON.stringify(store.toSnapshot()));
          } catch {
            return false;
          }
          const targets = new Set([...(await readIndex()), target]);
          return writeIndex([...targets]);
        },
      };
      handles.set(target, handle);
      return handle;
    },

    async list(): Promise<string[]> {
      return [...new Set([...handles.keys(), ...(await readIndex())])].sort();
    },

    invalidate(target?: string): void {
      if (target === undefined) handles.clear();
      else handles.delete(normalizeTarget(target));
    },
  };
}
