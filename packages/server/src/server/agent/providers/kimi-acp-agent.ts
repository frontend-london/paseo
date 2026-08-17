import type { Logger } from "pino";

import { GenericACPAgentClient } from "./generic-acp-agent.js";
import type { ACPProviderModeWriteResult, ACPProviderModeWriterContext } from "./acp-agent.js";

interface KimiACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  providerParams?: unknown;
}

// Kimi exposes three internal permission modes: yolo, manual, auto.
// The Kimi "yolo" mode auto-approves tool calls but still allows the
// model to ask questions. The "auto" mode is the truly autonomous mode
// that prevents operator questions. Paseo's "yolo" mode means "no
// operator questions for pre-approved work", so we map it to Kimi
// "auto".
const KIMI_PASEO_TO_PROVIDER_MODE: Record<string, string> = {
  yolo: "auto",
  auto: "auto",
  plan: "plan",
};

// Map a Kimi-reported mode id back to the Paseo UI mode id.
//
// The only non-identity mapping is the auto → yolo echo: when the user
// selects Paseo "yolo" we send Kimi "auto", and Kimi later echoes "auto" in
// current_mode_update. In that case we keep showing "yolo" to the user. For
// every other combination we preserve the provider's own id, so a genuine
// Paseo "auto" selection (which also maps to Kimi "auto") stays "auto" in
// the UI instead of being falsely renamed to "yolo".
export function kimiProviderToPaseoMode(
  providerModeId: string,
  currentPaseoModeId: string | null | undefined,
): string | null {
  if (providerModeId === "auto" && currentPaseoModeId === "yolo") {
    return "yolo";
  }
  if (providerModeId === "yolo" || providerModeId === "auto" || providerModeId === "plan") {
    return providerModeId;
  }
  return providerModeId;
}

export class KimiACPAgentClient extends GenericACPAgentClient {
  constructor(options: KimiACPAgentClientOptions) {
    super({
      ...options,
      modeIdTransformer: (providerModeId, currentModeId) =>
        kimiProviderToPaseoMode(providerModeId, currentModeId),
      providerModeWriter: (context) => writeKimiMode(context),
    });
  }
}

export async function writeKimiMode(
  context: ACPProviderModeWriterContext,
): Promise<ACPProviderModeWriteResult> {
  const providerModeId = KIMI_PASEO_TO_PROVIDER_MODE[context.requestedModeId];
  if (!providerModeId) {
    return { handled: false };
  }

  // If the provider already exposes this mode under the same id, let the
  // default ACP path handle the switch so we do not bypass any config-option
  // bookkeeping unnecessarily.
  if (
    context.selection.availableMode?.id === providerModeId ||
    context.selection.configChoice?.value === providerModeId
  ) {
    return { handled: false };
  }

  await context.connection.setSessionMode({
    sessionId: context.sessionId,
    modeId: providerModeId,
  });

  // Report the Paseo mode id back so the UI stays aligned with the user's
  // selection, even though Kimi is operating in a different internal mode.
  return { handled: true, currentModeId: context.requestedModeId };
}
