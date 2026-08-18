import { expect, test } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { resumePendingLifecycleManifests } from "./lifecycle-resume.js";
import {
  listPendingLifecycleManifests,
  writeLifecycleResumeManifest,
} from "./lifecycle-resume-manifest.js";
import { isSystemInjectedEnvelope } from "./agent-prompt.js";
import type {
  AgentClient,
  AgentPermissionRequest,
  AgentPromptInput,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "./agent-sdk-types.js";

const TEST_CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsSessionListing: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

class FakeSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly id = "fake-session";
  readonly capabilities = TEST_CAPABILITIES;
  startedPrompts: AgentPromptInput[] = [];
  private subscribers = new Set<(event: AgentStreamEvent) => void>();

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }
  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    this.startedPrompts.push(prompt);
    const turnId = "turn-1";
    setTimeout(() => {
      for (const cb of this.subscribers) {
        cb({ type: "turn_started", provider: this.provider, turnId });
        cb({ type: "turn_completed", provider: this.provider, turnId });
      }
    }, 0);
    return { turnId };
  }
  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }
  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}
  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id, model: null, modeId: null };
  }
  async getAvailableModes() {
    return [];
  }
  async getCurrentMode() {
    return null;
  }
  async setMode(): Promise<void> {}
  getPendingPermissions(): AgentPermissionRequest[] {
    return [];
  }
  async respondToPermission(): Promise<void> {}
  describePersistence() {
    return null;
  }
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {}
}

function fakeClient(session: FakeSession): AgentClient {
  return {
    provider: "codex",
    capabilities: TEST_CAPABILITIES,
    async isAvailable() {
      return true;
    },
    async createSession(_config: AgentSessionConfig) {
      return session;
    },
    async resumeSession() {
      throw new Error("unused");
    },
    async fetchCatalog() {
      return { models: [], modes: [] };
    },
  };
}

const logger = createTestLogger();

test("resumePendingLifecycleManifests sends a system-envelope continuation prompt and marks the entry resumed", async () => {
  const paseoHome = mkdtempSync(path.join(os.tmpdir(), "paseo-lifecycle-resume-"));
  try {
    const session = new FakeSession();
    const agentManager = new AgentManager({
      clients: { codex: fakeClient(session) },
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000300",
    });
    const agent = await agentManager.createAgent(
      { provider: "codex", cwd: process.cwd() },
      undefined,
      { workspaceId: undefined },
    );
    const agentStorage = new AgentStorage(path.join(paseoHome, "agents"), logger);

    await writeLifecycleResumeManifest(paseoHome, {
      operationId: "op-1",
      createdAt: new Date().toISOString(),
      entries: [
        {
          agentId: agent.id,
          cwd: process.cwd(),
          priorStatus: "running",
          capturedAt: new Date().toISOString(),
          status: "pending",
        },
      ],
    });

    await resumePendingLifecycleManifests({ paseoHome, agentManager, agentStorage, logger });

    expect(session.startedPrompts).toHaveLength(1);
    const prompt = session.startedPrompts[0];
    expect(typeof prompt).toBe("string");
    expect(isSystemInjectedEnvelope(prompt as string)).toBe(true);

    expect(await listPendingLifecycleManifests(paseoHome)).toEqual([]);
  } finally {
    rmSync(paseoHome, { recursive: true, force: true });
  }
});

test("resumePendingLifecycleManifests marks an entry failed_to_resume without throwing when the agent can't be loaded", async () => {
  const paseoHome = mkdtempSync(path.join(os.tmpdir(), "paseo-lifecycle-resume-fail-"));
  try {
    const agentManager = new AgentManager({ clients: {}, logger });
    const agentStorage = new AgentStorage(path.join(paseoHome, "agents"), logger);

    await writeLifecycleResumeManifest(paseoHome, {
      operationId: "op-missing",
      createdAt: new Date().toISOString(),
      entries: [
        {
          agentId: "does-not-exist",
          cwd: process.cwd(),
          priorStatus: "running",
          capturedAt: new Date().toISOString(),
          status: "pending",
        },
      ],
    });

    await expect(
      resumePendingLifecycleManifests({ paseoHome, agentManager, agentStorage, logger }),
    ).resolves.toBeUndefined();

    // The manifest is archived (removed from the pending set) once its one entry is
    // terminal, even though that terminal state is failed_to_resume, not resumed.
    expect(await listPendingLifecycleManifests(paseoHome)).toEqual([]);
  } finally {
    rmSync(paseoHome, { recursive: true, force: true });
  }
});
