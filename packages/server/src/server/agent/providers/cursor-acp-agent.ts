import type { Logger } from "pino";

import type {
  ResolveAgentCreateConfigInput,
  ResolveAgentCreateConfigResult,
} from "../agent-sdk-types.js";
import { resolveDefaultAgentCreateConfig } from "../create-agent-mode.js";
import type { ACPConfigFeatureOption } from "./acp-agent.js";
import type { ManagedProcessRegistry } from "../../managed-processes/managed-processes.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

interface CursorACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  providerParams?: unknown;
  managedProcesses?: ManagedProcessRegistry;
}

const CURSOR_INITIAL_COMMANDS_WAIT_TIMEOUT_MS = 10_000;
const CURSOR_CLIENT_CAPABILITY_META = {
  parameterizedModelPicker: true,
};

/** Cursor ACP session mode used by Agents unattended/bypass mapping. */
export const CURSOR_AGENT_MODE_ID = "agent";

/**
 * Paseo ACP auto-accept feature. Cursor's `agent` mode is an execution mode
 * (vs plan/ask), not "Run Everything"; unattended permission approval is
 * carried separately by this feature — same id as generic ACP auto_accept.
 */
const CURSOR_AUTO_ACCEPT_FEATURE_ID = "auto_accept";

export const CURSOR_FAST_FEATURE_OPTION: ACPConfigFeatureOption = {
  id: "fast",
  configId: "fast",
  label: "Fast",
  description: "Cursor fast mode",
  tooltip: "Select Cursor fast mode",
  icon: "zap",
};

function withCursorAutoAcceptFeature(
  featureValues: Record<string, unknown> | undefined,
  enabled: boolean,
): Record<string, unknown> {
  return {
    ...featureValues,
    [CURSOR_AUTO_ACCEPT_FEATURE_ID]: enabled,
  };
}

/**
 * Cursor unattended/bypass must keep mode=`agent` and also enable
 * `auto_accept`. Mode alone does not auto-approve ACP `requestPermission`
 * prompts (CLI `--force/--yolo` is unavailable on `cursor-agent acp`).
 */
export function resolveCursorCreateConfig(
  input: ResolveAgentCreateConfigInput,
): ResolveAgentCreateConfigResult {
  const agentModeRequested = input.requestedMode === CURSOR_AGENT_MODE_ID;
  const isUnattendedCreate = input.unattended || input.parent?.isUnattended === true;
  const shouldEnableAutoAccept = agentModeRequested || isUnattendedCreate;

  const featureValues =
    shouldEnableAutoAccept && input.featureValues?.[CURSOR_AUTO_ACCEPT_FEATURE_ID] === undefined
      ? withCursorAutoAcceptFeature(input.featureValues, true)
      : input.featureValues;

  // Prefer Cursor's agent mode for unattended creates that omitted mode.
  let requestedMode = input.requestedMode;
  if (
    requestedMode === undefined &&
    isUnattendedCreate &&
    input.availableModes?.some((mode) => mode.id === CURSOR_AGENT_MODE_ID)
  ) {
    requestedMode = CURSOR_AGENT_MODE_ID;
  }

  // Preserve generic ACP cross-provider behavior when agent mode is unavailable:
  // leave mode unset and rely on auto_accept.
  if (
    input.requestedMode === undefined &&
    requestedMode === undefined &&
    isUnattendedCreate &&
    input.parent !== null &&
    input.parent.provider !== input.provider
  ) {
    return { modeId: undefined, featureValues };
  }

  const resolved = resolveDefaultAgentCreateConfig({
    ...input,
    requestedMode,
    featureValues,
  });
  return { ...resolved, featureValues };
}

export class CursorACPAgentClient extends GenericACPAgentClient {
  override readonly resolveCreateConfig = resolveCursorCreateConfig;

  constructor(options: CursorACPAgentClientOptions) {
    super({
      logger: options.logger,
      command: options.command,
      env: options.env,
      providerId: options.providerId,
      label: options.label,
      providerParams: options.providerParams,
      // cursor-agent publishes slash commands asynchronously via available_commands_update.
      waitForInitialCommands: true,
      initialCommandsWaitTimeoutMs: CURSOR_INITIAL_COMMANDS_WAIT_TIMEOUT_MS,
      clientCapabilityMeta: CURSOR_CLIENT_CAPABILITY_META,
      configFeatureOptions: [CURSOR_FAST_FEATURE_OPTION],
      managedProcesses: options.managedProcesses,
    });
  }
}
