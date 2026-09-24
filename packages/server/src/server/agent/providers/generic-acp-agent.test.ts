import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";

const mockState = vi.hoisted(() => ({
  superConstructorOptions: [] as unknown[],
}));

vi.mock("./acp-agent.js", () => ({
  DEFAULT_ACP_CAPABILITIES: {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: true,
    supportsMcpServers: true,
    supportsReasoningStream: true,
    supportsToolInvocations: true,
    supportsRewindConversation: false,
    supportsRewindFiles: false,
    supportsRewindBoth: false,
  },
  ACPAgentClient: class ACPAgentClient {
    readonly provider: string;

    constructor(options: unknown) {
      this.provider = "acp";
      mockState.superConstructorOptions.push(options);
    }
  },
}));

import { GenericACPAgentClient } from "./generic-acp-agent.js";

describe("GenericACPAgentClient", () => {
  test("passes the custom command only as defaultCommand", () => {
    const _client = new GenericACPAgentClient({
      logger: createTestLogger(),
      command: ["hermes", "acp"],
      env: {
        HERMES_LOG: "info",
      },
    });
    void _client;

    expect(mockState.superConstructorOptions).toEqual([
      {
        provider: "acp",
        logger: expect.any(Object),
        runtimeSettings: {
          env: {
            HERMES_LOG: "info",
          },
        },
        defaultCommand: ["hermes", "acp"],
        defaultModes: [],
        capabilities: {
          supportsStreaming: true,
          supportsSessionPersistence: true,
          supportsDynamicModes: true,
          supportsMcpServers: true,
          supportsReasoningStream: true,
          supportsToolInvocations: true,
          supportsRewindConversation: false,
          supportsRewindFiles: false,
          supportsRewindBoth: false,
        },
      },
    ]);
  });

  test("marks Factory auto-high as unattended for existing provider configs", () => {
    const _client = new GenericACPAgentClient({
      logger: createTestLogger(),
      command: ["npx", "-y", "droid@0.179.0", "exec", "--output-format", "acp-daemon"],
      providerId: "factory-droid",
      providerParams: {
        supportsMcpServers: false,
      },
    });
    void _client;

    expect(mockState.superConstructorOptions.at(-1)).toMatchObject({
      defaultModes: [{ id: "auto-high", label: "auto-high", isUnattended: true }],
    });
  });

  test("accepts provider-configured unattended mode ids", () => {
    const _client = new GenericACPAgentClient({
      logger: createTestLogger(),
      command: ["custom-acp"],
      providerId: "custom-acp",
      providerParams: {
        unattendedModeIds: ["yolo"],
      },
    });
    void _client;

    expect(mockState.superConstructorOptions.at(-1)).toMatchObject({
      defaultModes: [{ id: "yolo", label: "yolo", isUnattended: true }],
    });
  });

  test("uses provider params to report MCP support", () => {
    const _client = new GenericACPAgentClient({
      logger: createTestLogger(),
      command: ["no-mcp-acp", "serve"],
      providerParams: {
        supportsMcpServers: false,
      },
    });
    void _client;

    expect(mockState.superConstructorOptions.at(-1)).toMatchObject({
      capabilities: {
        supportsMcpServers: false,
      },
    });
  });
});
