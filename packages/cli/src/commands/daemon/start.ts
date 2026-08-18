import { Command, Option } from "commander";
import chalk from "chalk";
import {
  startLocalDaemonForeground,
  startLocalDaemonDetached,
  resolveLocalDaemonState,
  resolveTcpHostFromListen,
  type DaemonStartOptions as StartOptions,
} from "./local-daemon.js";
import { detectCallingAgentId } from "./lifecycle-approval.js";
import { tryConnectToDaemon } from "../../utils/client.js";
import { getErrorMessage } from "../../utils/errors.js";

export type { DaemonStartOptions as StartOptions } from "./local-daemon.js";

type RawStartCommandOptions = StartOptions & {
  allowedHosts?: string;
};

export function startCommand(): Command {
  return new Command("start")
    .description("Start the local Paseo daemon")
    .option("--listen <listen>", "Listen target (host:port, port, or unix socket path)")
    .option("--port <port>", "Port to listen on (default: 6767)")
    .option("--home <path>", "Paseo home directory (default: ~/.paseo)")
    .option("--foreground", "Run in foreground (don't daemonize)")
    .option("--no-relay", "Disable relay connection")
    .option("--relay-use-tls", "Use wss:// for the relay connection and pairing offers")
    .option("--no-mcp", "Disable the Agent MCP HTTP endpoint")
    .option("--no-inject-mcp", "Disable auto-injecting the Paseo MCP into created agents")
    .option("--web-ui", "Enable the bundled daemon web UI")
    .option("--no-web-ui", "Disable the bundled daemon web UI")
    .option(
      "--hostnames <hosts>",
      'Daemon hostnames (comma-separated, e.g. "myhost,.example.com" or "true" for any)',
    )
    .addOption(new Option("--allowed-hosts <hosts>").hideHelp())
    .action(async (options: RawStartCommandOptions) => {
      await runStart({
        ...options,
        hostnames: options.hostnames ?? options.allowedHosts,
      });
    });
}

/**
 * Agent-initiated `paseo daemon start` requires a live daemon to attach an approval
 * request to (there is nowhere to host the pending-permission map/promise for a daemon
 * that doesn't exist yet). Rather than build a separate always-on control-plane broker
 * just to gate this one edge case, the architectural choice here is to fail closed:
 * an agent can't start a fully-down shared daemon at all, and must ask the operator to
 * do it from a real terminal. When a daemon IS already reachable, `start` is a no-op
 * that already fails cleanly via the PID lock with no session impact — no gating needed.
 */
async function isDaemonReachable(home?: string): Promise<boolean> {
  const state = resolveLocalDaemonState({ home });
  const host = resolveTcpHostFromListen(state.listen);
  if (!host) {
    return false;
  }
  const client = await tryConnectToDaemon({ host, timeout: 3000 });
  if (!client) {
    return false;
  }
  await client.close().catch(() => undefined);
  return true;
}

export async function runStart(options: StartOptions): Promise<void> {
  if (options.listen && options.port) {
    console.error(chalk.red("Cannot use --listen and --port together"));
    process.exit(1);
  }

  const agentId = detectCallingAgentId();
  if (agentId && !(await isDaemonReachable(options.home))) {
    exitWithError(
      `'paseo daemon start' was invoked from inside an agent session (${agentId}), but no ` +
        "daemon is currently reachable to attach an approval request to. Ask the operator to " +
        "start the daemon manually from a real terminal.",
    );
  }

  if (!options.foreground) {
    try {
      const startup = await startLocalDaemonDetached(options);
      console.log(chalk.green(`Daemon starting in background (PID ${startup.pid ?? "unknown"}).`));
      console.log(chalk.dim(`Logs: ${startup.logPath}`));
    } catch (err) {
      exitWithError(getErrorMessage(err));
    }
    return;
  }
  try {
    const status = startLocalDaemonForeground(options);
    process.exit(status);
  } catch (err) {
    const message = getErrorMessage(err);
    exitWithError(`Failed to start daemon: ${message}`);
  }
}

function exitWithError(message: string): never {
  console.error(chalk.red(message));
  process.exit(1);
}
