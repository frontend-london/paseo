import type { PluginServerContext } from "@getpaseo/plugin/server";
import { mergeMcpServers, resolveAgentsMcpConfigPath } from "../shared/mcp-config.ts";
import { loadMcpServersConfigFile } from "./mcp-config-load.ts";

/**
 * Inject Agents/Apify MCP servers into every agent.create via before hook.
 * Config path: AGENTS_MCP_CONFIG | APIFY_MCP_CONFIG | PASEO_MCP_CONFIG.
 * No-op when unset. Does not add a core CLI --mcp-config flag.
 */
export function registerApifyMcpInjection(server: PluginServerContext): () => void {
  server.before("agent.create", ({ request }) => {
    const path = resolveAgentsMcpConfigPath();
    if (!path) {
      return request;
    }
    let incoming;
    try {
      incoming = loadMcpServersConfigFile(path);
    } catch (error) {
      console.error("[agents-command-code] failed to load MCP config", path, error);
      return request;
    }
    return {
      ...request,
      config: {
        ...request.config,
        mcpServers: mergeMcpServers(request.config.mcpServers as never, incoming),
      },
    };
  });
  return () => {};
}
