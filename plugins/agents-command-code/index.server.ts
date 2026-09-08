import type { PluginServerContext } from "@getpaseo/plugin/server";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Agents Command Code provider for Paseo 0.8 via runAcpProvider ACP shim.
 * Requires COMMAND_CODE_CLI_PATH in the daemon environment.
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

  return () => {};
}
