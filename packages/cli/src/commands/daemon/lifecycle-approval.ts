import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  DaemonLifecycleAuthorization,
  DaemonLifecycleOperation,
} from "@getpaseo/protocol/messages";

/**
 * Same pattern used by heartbeat/agent-run/chat/schedule commands: PASEO_AGENT_ID is
 * injected by the daemon into every agent's own process env, and inherited by any child
 * process that agent's Shell/tool invocations spawn — so this reliably distinguishes "a
 * process descending from an agent's own process tree" from "a human typing in a plain
 * terminal" without relying on parent-process-name heuristics.
 */
export function detectCallingAgentId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.PASEO_AGENT_ID?.trim() || undefined;
}

export type LifecycleApprovalOutcome =
  | { skip: true }
  | { denied: true; message?: string }
  | { approved: true; authorization: DaemonLifecycleAuthorization };

/**
 * Set by spawnDetachedLifecycleContinuation on the detached clone it spawns, carrying
 * the authorization already granted to the (still-attached) parent invocation. Read
 * here so the clone skips re-requesting approval — the operator already decided.
 */
export const LIFECYCLE_AUTHORIZATION_ENV_VAR = "PASEO_LIFECYCLE_AUTHORIZATION";

function readPreGrantedAuthorization(
  env: NodeJS.ProcessEnv,
): DaemonLifecycleAuthorization | undefined {
  const raw = env[LIFECYCLE_AUTHORIZATION_ENV_VAR];
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { token?: unknown }).token === "string" &&
      typeof (parsed as { operationId?: unknown }).operationId === "string"
    ) {
      return parsed as DaemonLifecycleAuthorization;
    }
  } catch {
    // fall through to undefined
  }
  return undefined;
}

/**
 * Gate for agent-initiated `paseo daemon stop|restart`. A no-op (`{ skip: true }`) when
 * not running inside an agent — human-terminal behavior is completely unchanged. When
 * agent-invoked, blocks (no short timeout; the operator may be away) until the daemon
 * reports the operator's Approve/Deny decision — *unless* this process is itself the
 * detached continuation spawned after an approval already happened (see
 * spawnDetachedLifecycleContinuation in local-daemon.ts), in which case the grant is
 * read from the environment instead of asking again.
 */
export async function requestApprovalIfAgentInvoked(params: {
  client: DaemonClient;
  agentId: string | undefined;
  operation: DaemonLifecycleOperation;
  host: string;
  env?: NodeJS.ProcessEnv;
}): Promise<LifecycleApprovalOutcome> {
  if (!params.agentId) {
    return { skip: true };
  }

  const preGranted = readPreGrantedAuthorization(params.env ?? process.env);
  if (preGranted) {
    return { approved: true, authorization: preGranted };
  }

  process.stderr.write(
    `'paseo daemon ${params.operation}' was invoked from inside an agent session (${params.agentId}). ` +
      "Waiting for operator approval before proceeding — this may take a while...\n",
  );

  const response = await params.client.requestDaemonLifecycleApproval({
    agentId: params.agentId,
    operation: params.operation,
    host: params.host,
  });

  if (response.decision === "denied" || !response.token) {
    return {
      denied: true,
      message: response.message ?? "Daemon lifecycle operation was not approved",
    };
  }

  return { approved: true, authorization: response.token };
}
