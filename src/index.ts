import { Plugin } from "@opencode/plugin";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { Info } from "@opencode/plugin/promise/tool";
import { homedir } from "node:os";
import { createGraphService, type GraphService } from "./tools/graph-service.js";
import { createQueryTool } from "./tools/query.js";
import { createBlastRadiusTool } from "./tools/blast-radius.js";
import { createSubgraphTool } from "./tools/subgraph.js";
import { createReportTool } from "./tools/report.js";
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

/** The plugin's four tools, each bound to the given service (factory form so ctx root + storage flow through). */
export function createTools(service: GraphService): Info[] {
  return [createQueryTool(service), createBlastRadiusTool(service), createSubgraphTool(service), createReportTool(service)];
}

export default Plugin.define({
  id: "closegraph",
  async setup(context: Context) {
    console.log("[closegraph] server plugin loaded");
    if (context.options.disable === true) {
      console.log("[closegraph] disabled via plugin options");
      return;
    }

    const service = createGraphService(
      pickGraphRoot(context.location.project.directory, context.location.directory, homedir()),
      context.storage,
    );
    const reg = await context.tool.transform((editor) => {
      for (const tool of createTools(service)) editor.add(tool);
    });
    // confirm through the live registry, not just what we pushed
    const registered = await context.tool.list();
    const names = registered.map((tool) => tool.name).filter((name) => name.startsWith("closegraph_"));
    console.log(`[closegraph] registered tools: ${names.join(", ")}`);
    if (names.length === 0) {
      console.error("[closegraph] no tools registered — transform did not apply?");
    }
    const rpcReg = await context.rpc.register(closegraphRpc, createRpcHandlers(service));
    console.log(`[closegraph] registered rpc methods: ${Object.keys(closegraphRpc.methods).join(", ")}`);
    return () => {
      reg.dispose();
      rpcReg.dispose();
    };
  },
})
