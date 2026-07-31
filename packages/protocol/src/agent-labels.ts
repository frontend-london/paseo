export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";

/**
 * Marks a Paseo agent record as an externally managed runtime session
 * (e.g. a tmux session owned by agent-manager). External agents are
 * visibility/lifecycle projections only — Paseo must not spawn a provider
 * process for them.
 */
export const EXTERNAL_RUNTIME_LABEL = "paseo.external-runtime";

/**
 * Stable external session key used for idempotent register/reconcile.
 * For agent-manager this is typically the Agents `agent_id`.
 */
export const EXTERNAL_SESSION_KEY_LABEL = "paseo.external-session-key";

/** Optional tmux session name for externally managed sessions. */
export const EXTERNAL_TMUX_SESSION_LABEL = "paseo.external-tmux-session";

/** Optional Agents role for externally managed sessions. */
export const EXTERNAL_ROLE_LABEL = "paseo.external-role";

/** Optional ticket/task id for externally managed sessions. */
export const EXTERNAL_TICKET_LABEL = "paseo.external-ticket";

export interface AgentLabelSource {
  labels?: Record<string, unknown> | null;
}

export function getParentAgentIdFromLabels(labels: Record<string, unknown> | null | undefined) {
  const parentAgentId = labels?.[PARENT_AGENT_ID_LABEL];
  return typeof parentAgentId === "string" && parentAgentId.trim().length > 0
    ? parentAgentId.trim()
    : null;
}

export function isDelegatedAgent(agent: AgentLabelSource): boolean {
  return getParentAgentIdFromLabels(agent.labels) !== null;
}

export function isExternalRuntimeAgent(agent: AgentLabelSource): boolean {
  const value = agent.labels?.[EXTERNAL_RUNTIME_LABEL];
  return value === "true" || value === "1";
}

export function getExternalSessionKeyFromLabels(
  labels: Record<string, unknown> | null | undefined,
): string | null {
  const key = labels?.[EXTERNAL_SESSION_KEY_LABEL];
  return typeof key === "string" && key.trim().length > 0 ? key.trim() : null;
}
