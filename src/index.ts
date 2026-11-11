import { Plugin } from "@opencode/plugin";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { Info } from "@opencode/plugin/promise/tool";
import { createGraphService, type GraphService } from "./tools/graph-service.js";
import { createQueryTool } from "./tools/query.js";
import { createBlastRadiusTool } from "./tools/blast-radius.js";
import { createSubgraphTool } from "./tools/subgraph.js";

/** The plugin's three tools, each bound to the given service (factory form so ctx root + storage flow through). */
export function createTools(service: GraphService): Info[] {
  return [createQueryTool(service), createBlastRadiusTool(service), createSubgraphTool(service)];
}

export default Plugin.define({
  id: "closegraph",
  async setup(context: Context) {
    console.log("[closegraph] server plugin loaded");
    if (context.options.disable === true) {
      console.log("[closegraph] disabled via plugin options");
      return;
    }

    const service = createGraphService(context.location.project.directory, context.storage);
    const reg = await context.tool.transform((editor) => {
      for (const tool of createTools(service)) editor.add(tool);
    });
    // confirm through the live registry, not just what we pushed
    const registered = await context.tool.list();
    const names = registered.map((tool) => tool.name).filter((name) => name.startsWith("closegraph_"));
    console.log(`[closegraph] registered tools: ${names.join(", ")}`);
    return () => reg.dispose();
  },
})
