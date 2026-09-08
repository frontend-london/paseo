import type { PluginServerContext } from "@getpaseo/plugin/server";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import { existsSync } from "node:fs";
import path from "node:path";
import { registerApifyMcpInjection } from "./server/apify-mcp-inject.ts";

function resolvePluginRoot(): string {
  const fromEnv = process.env.AGENTS_COMMAND_CODE_PLUGIN_ROOT?.trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  // Fallback for local/dev checkouts of this package directory.
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), ".");
}

/**
 * Agents plugin for Paseo 0.8:
 * - Command Code provider via runAcpProvider ACP shim
 * - Apify/Agents MCP injection via before("agent.create")
 *
 * Note: after esbuild bundling, import.meta.url may not point at the on-disk
 * plugin directory. Prefer AGENTS_COMMAND_CODE_PLUGIN_ROOT.
 */
export default function contribute(server: PluginServerContext) {
  const root = resolvePluginRoot();
  const agentScript = path.join(root, "server", "command-code-acp-agent.ts");
  if (!existsSync(agentScript)) {
    throw new Error(
      `Command Code ACP agent script missing at ${agentScript}. Set AGENTS_COMMAND_CODE_PLUGIN_ROOT.`,
    );
  }

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
