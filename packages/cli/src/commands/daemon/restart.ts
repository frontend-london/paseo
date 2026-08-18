import type { Command } from "commander";
import {
  startLocalDaemonDetached,
  stopLocalDaemon,
  DEFAULT_STOP_TIMEOUT_MS,
  DaemonLifecycleDeniedError,
  type DaemonStartOptions,
} from "./local-daemon.js";
import { detectCallingAgentId } from "./lifecycle-approval.js";
import type {
  CommandOptions,
  SingleResult,
  OutputSchema,
  CommandError,
} from "../../output/index.js";

interface RestartResult {
  action: "restarted";
  home: string;
  pid: string;
  message: string;
}

const restartResultSchema: OutputSchema<RestartResult> = {
  idField: "action",
  columns: [
    {
      header: "STATUS",
      field: "action",
      color: () => "green",
    },
    { header: "HOME", field: "home" },
    { header: "PID", field: "pid" },
    { header: "MESSAGE", field: "message" },
  ],
};

export type RestartCommandResult = SingleResult<RestartResult>;

function parseTimeoutMs(raw: unknown): number {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return DEFAULT_STOP_TIMEOUT_MS;
  }

  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    const error: CommandError = {
      code: "INVALID_TIMEOUT",
      message: `Invalid timeout value: ${raw}`,
      details: "Timeout must be a positive number of seconds",
    };
    throw error;
  }

  return Math.ceil(seconds * 1000);
}

function toStartOptions(options: CommandOptions): DaemonStartOptions {
  const startOptions: DaemonStartOptions = {
    home: typeof options.home === "string" ? options.home : undefined,
    listen: typeof options.listen === "string" ? options.listen : undefined,
    port: typeof options.port === "string" ? options.port : undefined,
    relay: typeof options.relay === "boolean" ? options.relay : undefined,
    mcp: typeof options.mcp === "boolean" ? options.mcp : undefined,
    injectMcp: typeof options.injectMcp === "boolean" ? options.injectMcp : undefined,
    webUi: typeof options.webUi === "boolean" ? options.webUi : undefined,
    hostnames: typeof options.hostnames === "string" ? options.hostnames : undefined,
  };

  if (startOptions.listen && startOptions.port) {
    const error: CommandError = {
      code: "INVALID_OPTIONS",
      message: "Cannot use --listen and --port together",
    };
    throw error;
  }

  return startOptions;
}

export async function runRestartCommand(
  options: CommandOptions,
  _command: Command,
): Promise<RestartCommandResult> {
  const timeoutMs = parseTimeoutMs(options.timeout);
  const force = options.force === true;
  const startOptions = toStartOptions(options);
  const agentId = detectCallingAgentId();

  try {
    let stopResult: Awaited<ReturnType<typeof stopLocalDaemon>>;
    try {
      stopResult = await stopLocalDaemon({
        home: startOptions.home,
        timeoutMs,
        force,
        agentId,
      });
    } catch (err) {
      if (err instanceof DaemonLifecycleDeniedError) {
        // A denial is definitive — never retry a denied approval automatically.
        throw err;
      }
      const isTimeout =
        err instanceof Error && err.message.includes("Timed out waiting for daemon PID");
      if (!force && isTimeout) {
        stopResult = await stopLocalDaemon({
          home: startOptions.home,
          timeoutMs,
          force: true,
          agentId,
        });
      } else {
        throw err;
      }
    }

    const startup = await startLocalDaemonDetached(startOptions);
    const before = stopResult.pid === null ? "not running" : `PID ${stopResult.pid}`;
    const after = startup.pid === null ? "unknown PID" : `PID ${startup.pid}`;

    return {
      type: "single",
      data: {
        action: "restarted",
        home: stopResult.home,
        pid: startup.pid === null ? "-" : String(startup.pid),
        message: `Local daemon restarted (${before} -> ${after})`,
      },
      schema: restartResultSchema,
    };
  } catch (err) {
    if (err instanceof DaemonLifecycleDeniedError) {
      const error: CommandError = {
        code: "LIFECYCLE_APPROVAL_DENIED",
        message: `Daemon restart denied by operator: ${err.message}`,
        details: "Ask the operator to run 'paseo daemon restart' manually, or retry later.",
      };
      throw error;
    }
    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "RESTART_FAILED",
      message: `Failed to restart local daemon: ${message}`,
    };
    throw error;
  }
}
