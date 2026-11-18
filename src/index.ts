import { Plugin } from "@opencode/plugin";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { Info } from "@opencode/plugin/promise/tool";
import { homedir } from "node:os";
import { createGraphServicePool, type ToolServiceScope, type ToolServices } from "./tools/service-pool.js";
import { createQueryTool } from "./tools/query.js";
import { createBlastRadiusTool } from "./tools/blast-radius.js";
import { createSubgraphTool } from "./tools/subgraph.js";
import { createReportTool } from "./tools/report.js";
import { createSurfaceIngestTool } from "./tools/surface-ingest.js";
import { createSurfaceQueryTool } from "./tools/surface-query.js";
import { createSurfaceReportTool } from "./tools/surface-report.js";
import { createSurfaceService, type SurfaceService } from "./surface/surface-service.js";
import { createRpcHandlers } from "./rpc-methods.js";
import { closegraphRpc } from "../rpc/index.js";

/**
 * Graph-root selection (live follow-up): OpenCode's project detection walks UP
 * from the session directory looking for a project root — a workspace FOLDER
 * containing several git repos but no `.git` of its own matches nothing, so
 * `location.project.directory` falls back to HOME. Binding the graph to HOME
 * walks (or gets refused over) the entire home directory. When the project dir
 * IS the fallback (HOME or "/"), a strictly deeper session directory is the
 * honest root instead. A real project directory always wins; a session AT the
 * fallback root changes nothing (the zero-indexable-files guard downstream
 * still refuses it — untouched).
 */
export function pickGraphRoot(projectDir: string, sessionDir: string | undefined, home: string): string {
  const isFallbackRoot = projectDir === home || projectDir === "/";
  if (!isFallbackRoot || sessionDir === undefined) return projectDir;
  const prefix = projectDir.endsWith("/") ? projectDir : `${projectDir}/`;
  return sessionDir.startsWith(prefix) && sessionDir !== projectDir ? sessionDir : projectDir;
}

/** The plugin's seven tools, each bound to the given services (factory form so ctx root + storage flow through).
 *  Graph tools accept a plain GraphService (single project) or a ToolServiceScope (shared services — per-session roots);
 *  surface tools bind their own SurfaceService (per-target black-box observations, no graph dependency). */
export function createTools(services: ToolServices, surface: SurfaceService): Info[] {
  return [
    createQueryTool(services),
    createBlastRadiusTool(services),
    createSubgraphTool(services),
    createReportTool(services),
    createSurfaceIngestTool(surface),
    createSurfaceQueryTool(surface),
    createSurfaceReportTool(surface),
  ];
}

export default Plugin.define({
  id: "closegraph",
  async setup(context: Context) {
    console.log("[closegraph] server plugin loaded");
    if (context.options.disable === true) {
      console.log("[closegraph] disabled via plugin options");
      return;
    }

    // SHARED SERVICES (live follow-up #2): setup() runs once per service and its
    // location cannot reflect every TUI session's directory — d7e3301's setup-time
    // root therefore bound ALL sessions to one root (HOME on this user's host).
    // The default stays the pickGraphRoot choice; every rpc call now carries the
    // TUI's own directory as `root`, and tools resolve their sessionID's directory
    // through session.get — both route through this LRU pool per root.
    const graphRoot = pickGraphRoot(context.location.project.directory, context.location.directory, homedir());
    const pool = createGraphServicePool(graphRoot, context.storage);
    const sessionDirectories = new Map<string, string>();
    const scope: ToolServiceScope = {
      pool,
      async sessionDirectory(sessionID) {
        // one host lookup per session, cached — session directories are stable
        const cached = sessionDirectories.get(sessionID);
        if (cached !== undefined) return cached;
        const info = await context.session.get({ sessionID });
        const directory = info.location?.directory;
        if (directory !== undefined) sessionDirectories.set(sessionID, directory);
        return directory;
      },
    };

    const reg = await context.tool.transform((editor) => {
      for (const tool of createTools(scope, createSurfaceService(context.storage))) editor.add(tool);
    });
    // confirm through the live registry, not just what we pushed
    const registered = await context.tool.list();
    const names = registered.map((tool) => tool.name).filter((name) => name.startsWith("closegraph_"));
    console.log(`[closegraph] registered tools: ${names.join(", ")}`);
    if (names.length === 0) {
      console.error("[closegraph] no tools registered — transform did not apply?");
    }
    const rpcReg = await context.rpc.register(closegraphRpc, createRpcHandlers(pool));
    console.log(`[closegraph] registered rpc methods: ${Object.keys(closegraphRpc.methods).join(", ")}`);
    return () => {
      reg.dispose();
      rpcReg.dispose();
    };
  },
})
