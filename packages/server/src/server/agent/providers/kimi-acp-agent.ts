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

const KIMI_PROVIDER_TO_PASEO_MODE: Record<string, string> = {
  auto: "yolo",
  yolo: "yolo",
  plan: "plan",
};

export class KimiACPAgentClient extends GenericACPAgentClient {
  constructor(options: KimiACPAgentClientOptions) {
    super({
      ...options,
      modeIdTransformer: (modeId) => KIMI_PROVIDER_TO_PASEO_MODE[modeId] ?? modeId,
      providerModeWriter: (context) => writeKimiMode(context),
    });
  }
}

async function writeKimiMode(
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
