import type { Command } from "commander";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import { collectMultiple } from "../../utils/command-options.js";
import type { CommandError, CommandOptions, SingleResult } from "../../output/index.js";
import { agentRunSchema, type AgentRunResult } from "./run.js";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";

export function addRegisterExternalOptions(cmd: Command): Command {
  return cmd
    .description(
      "Register an externally managed session as a Paseo agent (visibility only; no provider process)",
    )
    .requiredOption(
      "--external-session-key <key>",
      "Stable external session key (e.g. Agents agent_id)",
    )
    .requiredOption("--provider <provider>", "Display provider id (e.g. devin, tmux, agents)")
    .option("--cwd <path>", "Working directory shown for the agent")
    .option("--title <title>", "Display title")
    .option("--model <model>", "Display model id")
    .option("--session-handle <handle>", "Optional native/session handle stored on the agent")
    .option(
      "--label <key=value>",
      "Add label(s) to the agent (can be used multiple times)",
      collectMultiple,
      [],
    );
}

export interface AgentRegisterExternalOptions extends CommandOptions {
  externalSessionKey?: string;
  provider?: string;
  cwd?: string;
  title?: string;
  model?: string;
  sessionHandle?: string;
  label?: string[];
  host?: string;
}

export type AgentRegisterExternalCommandResult = SingleResult<
  AgentRunResult & { created: boolean }
>;

function parseLabels(labelFlags: string[] | undefined): Record<string, string> {
  const labels: Record<string, string> = {};
  if (!labelFlags) {
    return labels;
  }

  for (const labelFlag of labelFlags) {
    const eqIndex = labelFlag.indexOf("=");
    if (eqIndex === -1) {
      throw {
        code: "INVALID_LABEL",
        message: `Invalid label format: ${labelFlag}`,
        details: "Labels must be in key=value format",
      } satisfies CommandError;
    }

    const key = labelFlag.slice(0, eqIndex).trim();
    if (!key) {
      throw {
        code: "INVALID_LABEL",
        message: `Invalid label format: ${labelFlag}`,
        details: "Labels must include a non-empty key in key=value format",
      } satisfies CommandError;
    }

    labels[key] = labelFlag.slice(eqIndex + 1);
  }

  return labels;
}

function toResult(
  agent: AgentSnapshotPayload,
  created: boolean,
): AgentRunResult & { created: boolean } {
  return {
    agentId: agent.id,
    status: agent.status === "running" ? "running" : "created",
    provider: agent.provider,
    cwd: agent.cwd,
    title: agent.title,
    created,
  };
}

export async function runRegisterExternalCommand(
  options: AgentRegisterExternalOptions,
  _command: Command,
): Promise<AgentRegisterExternalCommandResult> {
  const host = getDaemonHost({ host: options.host });
  const externalSessionKey = options.externalSessionKey?.trim();
  if (!externalSessionKey) {
    throw {
      code: "MISSING_EXTERNAL_SESSION_KEY",
      message: "--external-session-key is required",
    } satisfies CommandError;
  }

  const provider = options.provider?.trim();
  if (!provider) {
    throw {
      code: "MISSING_PROVIDER",
      message: "--provider is required",
    } satisfies CommandError;
  }

  const cwd = options.cwd?.trim() || process.cwd();
  const labels = parseLabels(options.label);

  let client;
  try {
    client = await connectToDaemon({ host: options.host });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
      details: "Start the daemon with: paseo daemon start",
    } satisfies CommandError;
  }

  try {
    const result = await client.registerExternalAgent({
      externalSessionKey,
      provider,
      cwd,
      ...(options.title ? { title: options.title } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.sessionHandle ? { sessionHandle: options.sessionHandle } : {}),
      ...(Object.keys(labels).length > 0 ? { labels } : {}),
    });

    await client.close();

    return {
      type: "single",
      data: toResult(result.agent, result.created),
      schema: {
        ...agentRunSchema,
        columns: [
          ...agentRunSchema.columns,
          { header: "CREATED", field: "created", width: 8 },
        ],
      },
    };
  } catch (err) {
    await client.close().catch(() => {});

    if (err && typeof err === "object" && "code" in err) {
      throw err;
    }

    const message = err instanceof Error ? err.message : String(err);
    throw {
      code: "EXTERNAL_REGISTER_FAILED",
      message: `Failed to register external agent: ${message}`,
    } satisfies CommandError;
  }
}
