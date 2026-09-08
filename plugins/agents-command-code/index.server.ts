import type { PluginServerContext } from "@getpaseo/plugin/server";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerApifyMcpInjection } from "./server/apify-mcp-inject.ts";

/**
 * Agents plugin for Paseo 0.8:
 * - Command Code provider via runAcpProvider ACP shim
 * - Apify/Agents MCP injection via before("agent.create")
 */
export default function contribute(server: PluginServerContext) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const agentScript = path.join(here, "server", "command-code-acp-agent.ts");

  server.registerProvider(
    runAcpProvider({
      id: "command-code",
      label: "Command Code",
      description: "Agents Command Code ACP bridge (frontend-london)",
      command: [process.execPath, "--import", "tsx", agentScript],
    }),
  );

  const disposeApify = registerApifyMcpInjection(server);
  return () => {
    disposeApify();
  };
}
