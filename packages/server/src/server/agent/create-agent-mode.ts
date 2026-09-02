import { getUnattendedModeId } from "@getpaseo/protocol/provider-manifest";

import type {
  AgentCreateConfigParent,
  AgentCreateConfigUnattendedInput,
  AgentMode,
  AgentProvider,
  ResolveAgentCreateConfigInput,
  ResolveAgentCreateConfigResult,
} from "./agent-sdk-types.js";

export interface ResolveCreateAgentModeInput {
  requestedMode: string | undefined;
  targetProvider: AgentProvider;
  parent: AgentCreateConfigParent | null;
  unattended: boolean;
  // `undefined` = target provider's modes unknown: explicit modes pass through
  // unvalidated, but cross-provider inheritance is still refused.
  // `[]` = target provider explicitly has no modes: use its default behavior.
  availableModes: string[] | undefined;
  // Target provider's own unattended mode id, if it has one. Used to bridge
  // unattended parents into unattended children across providers.
  targetUnattendedMode: string | undefined;
}

function listModes(modes: string[] | undefined): string {
  if (modes === undefined) {
    return "unknown";
  }
  return modes.length > 0 ? modes.join(", ") : "(none)";
}

function isUnattendedCreateConfigParent(parent: AgentCreateConfigParent): boolean {
  return parent.isUnattended;
}

function formatCreateConfigParentMode(parent: AgentCreateConfigParent): string {
  return parent.modeId ?? "<none>";
}

function formatCreateConfigParentSource(parent: AgentCreateConfigParent): string {
  return `caller (provider '${parent.provider}')`;
}

export function resolveAndValidateCreateAgentMode(
  input: ResolveCreateAgentModeInput,
): string | undefined {
  const { requestedMode, targetProvider, parent, availableModes } = input;
  const fallbackUnattendedMode = getUnattendedModeId(targetProvider);
  let targetUnattendedMode = input.targetUnattendedMode;
  if (targetUnattendedMode === undefined && fallbackUnattendedMode !== undefined) {
    if (availableModes === undefined) {
      targetUnattendedMode = fallbackUnattendedMode;
    } else if (availableModes.length > 0 && availableModes.includes(fallbackUnattendedMode)) {
      targetUnattendedMode = fallbackUnattendedMode;
    }
  }

  if (requestedMode !== undefined) {
    if (availableModes !== undefined && !availableModes.includes(requestedMode)) {
      throw new Error(
        `Invalid mode '${requestedMode}' for provider '${targetProvider}'. Available modes: ${listModes(availableModes)}`,
      );
    }
    return requestedMode;
  }

  if (!parent) {
    if (targetUnattendedMode !== undefined) {
      return targetUnattendedMode;
    }
    if (availableModes !== undefined && availableModes.length > 0) {
      throw new Error(
        `Provider '${targetProvider}' has no unattended/no-prompts mode and cannot be started without an explicit mode. Available modes: ${listModes(availableModes)}`,
      );
    }
    return undefined;
  }

  if (parent.provider === targetProvider) {
    return parent.modeId ?? undefined;
  }

  if (
    (input.unattended || isUnattendedCreateConfigParent(parent)) &&
    targetUnattendedMode !== undefined
  ) {
    return targetUnattendedMode;
  }

  if (availableModes?.length === 0) {
    return undefined;
  }

  throw new Error(
    `cannot inherit mode '${formatCreateConfigParentMode(parent)}' from ${formatCreateConfigParentSource(parent)} for new agent (provider '${targetProvider}'). Pass an explicit mode. Available modes for '${targetProvider}': ${listModes(availableModes)}`,
  );
}

export function resolveDefaultAgentCreateConfig(
  input: ResolveAgentCreateConfigInput,
): ResolveAgentCreateConfigResult {
  const availableModeIds = input.availableModes?.map((mode) => mode.id);
  const targetUnattendedMode =
    input.availableModes === undefined
      ? getUnattendedModeId(input.provider)
      : input.availableModes.find(isUnattendedMode)?.id;
  return {
    modeId: resolveAndValidateCreateAgentMode({
      requestedMode: input.requestedMode,
      targetProvider: input.provider,
      parent: input.parent,
      unattended: input.unattended,
      availableModes: availableModeIds,
      targetUnattendedMode,
    }),
    featureValues: input.featureValues,
  };
}

export function isDefaultAgentCreateConfigUnattended(
  input: AgentCreateConfigUnattendedInput,
): boolean {
  if (input.modeId === null) {
    return false;
  }
  return input.availableModes.some((mode) => mode.id === input.modeId && isUnattendedMode(mode));
}

function isUnattendedMode(mode: AgentMode): boolean {
  return mode.isUnattended === true;
}
