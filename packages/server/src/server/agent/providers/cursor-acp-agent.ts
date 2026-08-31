import type { Logger } from "pino";

import type { AgentMode } from "../agent-sdk-types.js";
import type { ACPConfigFeatureOption } from "./acp-agent.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

const CURSOR_MODES: AgentMode[] = [
  {
    id: "agent",
    label: "Agent",
    description: "Cursor's unattended agent mode",
    isUnattended: true,
  },
  { id: "plan", label: "Plan", description: "Cursor's plan mode" },
  { id: "ask", label: "Ask", description: "Cursor's ask mode" },
];

interface CursorACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  providerParams?: unknown;
}

const CURSOR_INITIAL_COMMANDS_WAIT_TIMEOUT_MS = 10_000;
const CURSOR_CLIENT_CAPABILITY_META = {
  parameterizedModelPicker: true,
};

export const CURSOR_FAST_FEATURE_OPTION: ACPConfigFeatureOption = {
  id: "fast",
  configId: "fast",
  label: "Fast",
  description: "Cursor fast mode",
  tooltip: "Select Cursor fast mode",
  icon: "zap",
};

export class CursorACPAgentClient extends GenericACPAgentClient {
  constructor(options: CursorACPAgentClientOptions) {
    super({
      logger: options.logger,
      command: options.command,
      env: options.env,
      providerId: options.providerId,
      label: options.label,
      providerParams: options.providerParams,
      defaultModes: CURSOR_MODES,
      // cursor-agent publishes slash commands asynchronously via available_commands_update.
      waitForInitialCommands: true,
      initialCommandsWaitTimeoutMs: CURSOR_INITIAL_COMMANDS_WAIT_TIMEOUT_MS,
      clientCapabilityMeta: CURSOR_CLIENT_CAPABILITY_META,
      configFeatureOptions: [CURSOR_FAST_FEATURE_OPTION],
    });
  }
}
