import { describe, expect, test, vi } from "vitest";

import type { SpawnedACPProcess, SessionStateResponse } from "./acp-agent.js";
import {
  CURSOR_AGENT_MODE_ID,
  CURSOR_FAST_FEATURE_OPTION,
  CursorACPAgentClient,
  resolveCursorCreateConfig,
} from "./cursor-acp-agent.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";

describe("CursorACPAgentClient model discovery", () => {
  function fastConfigOption(currentValue: "false" | "true") {
    return {
      id: "fast",
      name: "Fast",
      type: "select" as const,
      currentValue,
      options: [
        { value: "false", name: "Off" },
        { value: "true", name: "Fast" },
      ],
    };
  }
  class TestCursorACPAgentClient extends CursorACPAgentClient {
    constructor(response: SessionStateResponse) {
      super({
        logger: createTestLogger(),
        command: ["cursor-agent", "acp"],
      });
      this.response = response;
    }

    private readonly response: SessionStateResponse;

    protected override async spawnProcess(): Promise<SpawnedACPProcess> {
      return {
        child: { kill: vi.fn(), exitCode: 0, signalCode: null, once: vi.fn() },
        connection: {
          newSession: vi.fn().mockResolvedValue(this.response),
        },
        initialize: { agentCapabilities: {} },
      } as SpawnedACPProcess;
    }

    protected override async closeProbe(): Promise<void> {}
  }

  test("returns only ACP model ids because Cursor CLI ids cannot select ACP models", async () => {
    const client = new TestCursorACPAgentClient({
      sessionId: "session-1",
      models: {
        currentModelId: "gpt-5.4[context=272k,reasoning=medium,fast=false]",
        availableModels: [
          {
            modelId: "gpt-5.4[context=272k,reasoning=medium,fast=false]",
            name: "gpt-5.4",
            description: null,
          },
        ],
      },
      configOptions: [],
    });

    await expect(
      client.fetchCatalog({ scope: "workspace", cwd: "/tmp/cursor", force: false }),
    ).resolves.toEqual({
      models: [
        {
          provider: "acp",
          id: "gpt-5.4[context=272k,reasoning=medium,fast=false]",
          label: "gpt-5.4",
          description: undefined,
          isDefault: true,
          thinkingOptions: undefined,
          defaultThinkingOptionId: undefined,
        },
      ],
      modes: [],
    });
  });

  test("does not fall back to cursor-agent models when ACP reports zero models", async () => {
    const client = new TestCursorACPAgentClient({
      sessionId: "session-1",
      models: null,
      configOptions: [],
    });

    await expect(
      client.fetchCatalog({ scope: "workspace", cwd: "/tmp/cursor", force: false }),
    ).resolves.toEqual({
      models: [],
      modes: [],
    });
  });

  test("keeps modern Cursor models as plain ACP ids", async () => {
    const client = new TestCursorACPAgentClient({
      sessionId: "session-1",
      models: {
        currentModelId: "composer-2.5",
        availableModels: [
          {
            modelId: "composer-2.5",
            name: "Composer 2.5",
            description: null,
          },
        ],
      },
      configOptions: [fastConfigOption("false")],
    });

    await expect(
      client.fetchCatalog({ scope: "workspace", cwd: "/tmp/cursor", force: false }),
    ).resolves.toEqual({
      models: [
        {
          provider: "acp",
          id: "composer-2.5",
          label: "Composer 2.5",
          description: undefined,
          isDefault: true,
          thinkingOptions: undefined,
          defaultThinkingOptionId: undefined,
        },
      ],
      modes: [],
    });
  });

  test("exposes Cursor fast mode through provider features", async () => {
    const client = new TestCursorACPAgentClient({
      sessionId: "session-1",
      models: null,
      configOptions: [fastConfigOption("false")],
    });

    await expect(
      client.listFeatures({
        provider: "acp",
        cwd: "/tmp/cursor",
      }),
    ).resolves.toEqual([
      {
        type: "toggle",
        id: "auto_accept",
        label: "Auto Accept",
        description: "Automatically approves ACP permission prompts.",
        tooltip: "Auto accept permission prompts",
        icon: "shield-check",
        value: false,
      },
      {
        type: "select",
        id: CURSOR_FAST_FEATURE_OPTION.id,
        label: "Fast",
        description: "Cursor fast mode",
        tooltip: "Select Cursor fast mode",
        icon: "zap",
        value: "false",
        options: [
          {
            id: "false",
            label: "Off",
            isDefault: true,
            description: undefined,
            metadata: undefined,
          },
          {
            id: "true",
            label: "Fast",
            isDefault: false,
            description: undefined,
            metadata: undefined,
          },
        ],
      },
    ]);
  });
});

describe("Cursor unattended auto_accept", () => {
  const cursorModes = [
    { id: "agent", label: "Agent" },
    { id: "plan", label: "Plan" },
    { id: "ask", label: "Ask" },
  ];

  test("maps agent mode to agent plus auto_accept (Agents bypass path)", () => {
    const client = new CursorACPAgentClient({
      logger: createTestLogger(),
      command: ["cursor-agent", "acp"],
    });

    expect(
      client.resolveCreateConfig({
        provider: "acp",
        requestedMode: CURSOR_AGENT_MODE_ID,
        featureValues: undefined,
        parent: null,
        unattended: false,
        availableModes: cursorModes,
      }),
    ).toEqual({
      modeId: "agent",
      featureValues: { auto_accept: true },
    });
  });

  test("exported resolver keeps agent mode and enables auto_accept", () => {
    expect(
      resolveCursorCreateConfig({
        provider: "acp",
        requestedMode: "agent",
        featureValues: undefined,
        parent: null,
        unattended: false,
        availableModes: cursorModes,
      }),
    ).toEqual({
      modeId: "agent",
      featureValues: { auto_accept: true },
    });
  });

  test("does not enable auto_accept for plan or ask modes", () => {
    expect(
      resolveCursorCreateConfig({
        provider: "acp",
        requestedMode: "plan",
        featureValues: undefined,
        parent: null,
        unattended: false,
        availableModes: cursorModes,
      }),
    ).toEqual({ modeId: "plan", featureValues: undefined });

    expect(
      resolveCursorCreateConfig({
        provider: "acp",
        requestedMode: "ask",
        featureValues: undefined,
        parent: null,
        unattended: false,
        availableModes: cursorModes,
      }),
    ).toEqual({ modeId: "ask", featureValues: undefined });
  });

  test("unattended create without mode selects agent and auto_accept", () => {
    expect(
      resolveCursorCreateConfig({
        provider: "acp",
        requestedMode: undefined,
        featureValues: undefined,
        parent: null,
        unattended: true,
        availableModes: cursorModes,
      }),
    ).toEqual({
      modeId: "agent",
      featureValues: { auto_accept: true },
    });
  });

  test("preserves an explicit auto_accept=false override", () => {
    expect(
      resolveCursorCreateConfig({
        provider: "acp",
        requestedMode: "agent",
        featureValues: { auto_accept: false },
        parent: null,
        unattended: false,
        availableModes: cursorModes,
      }),
    ).toEqual({
      modeId: "agent",
      featureValues: { auto_accept: false },
    });
  });
});
