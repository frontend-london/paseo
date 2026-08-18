import { expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { DaemonLifecycleGateBusyError } from "./daemon-lifecycle-gate.js";
import type {
  AgentClient,
  AgentPermissionRequest,
  AgentPermissionResponse,
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
  respondToPermissionCalls: string[] = [];
  private subscribers = new Set<(event: AgentStreamEvent) => void>();

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }
  async startTurn(): Promise<{ turnId: string }> {
    return { turnId: "turn-1" };
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
  async respondToPermission(requestId: string): Promise<void> {
    // A gate-owned requestId must never reach here — the real provider session never
    // created it, so this call would be a bug in AgentManager.respondToPermission.
    this.respondToPermissionCalls.push(requestId);
  }
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

async function setup() {
  const session = new FakeSession();
  const manager = new AgentManager({
    clients: { codex: fakeClient(session) },
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000200",
  });
  const agent = await manager.createAgent({ provider: "codex", cwd: process.cwd() }, undefined, {
    workspaceId: undefined,
  });
  return { manager, session, agentId: agent.id };
}

test("requestDaemonLifecycleApproval attaches a pending permission to the initiating agent", async () => {
  const { manager, agentId } = await setup();

  const approval = await manager.requestDaemonLifecycleApproval({
    agentId,
    operation: "restart",
    host: "127.0.0.1:6767",
  });

  const agent = manager.listAgents().find((a) => a.id === agentId);
  expect(agent?.pendingPermissions.size).toBe(1);
  const request = agent?.pendingPermissions.get(approval.requestId);
  expect(request?.kind).toBe("other");
  expect(request?.name).toBe("DaemonLifecycle");
});

test("a second concurrent lifecycle approval request is rejected while one is pending", async () => {
  const { manager, agentId } = await setup();

  await manager.requestDaemonLifecycleApproval({ agentId, operation: "restart", host: "h" });

  await expect(
    manager.requestDaemonLifecycleApproval({ agentId, operation: "stop", host: "h" }),
  ).rejects.toBeInstanceOf(DaemonLifecycleGateBusyError);
});

test("respondToPermission resolves a gate-owned request without calling the provider session, and denial carries no token", async () => {
  const { manager, session, agentId } = await setup();

  const approval = await manager.requestDaemonLifecycleApproval({
    agentId,
    operation: "stop",
    host: "h",
  });

  const denyResponse: AgentPermissionResponse = { behavior: "deny", message: "not now" };
  const [resolution] = await Promise.all([
    approval.wait(),
    manager.respondToPermission(agentId, approval.requestId, denyResponse),
  ]);

  expect(resolution).toEqual({ decision: "denied", message: "not now" });
  expect(session.respondToPermissionCalls).toEqual([]);
  const agent = manager.listAgents().find((a) => a.id === agentId);
  expect(agent?.pendingPermissions.size).toBe(0);
});

test("approval mints a one-shot token scoped to exactly this operation/agent/operation-type", async () => {
  const { manager, agentId } = await setup();

  const approval = await manager.requestDaemonLifecycleApproval({
    agentId,
    operation: "restart",
    host: "h",
  });

  const allowResponse: AgentPermissionResponse = { behavior: "allow" };
  const [resolution] = await Promise.all([
    approval.wait(),
    manager.respondToPermission(agentId, approval.requestId, allowResponse),
  ]);

  expect(resolution.decision).toBe("approved");
  const token = resolution.token;
  expect(token).toBeDefined();
  if (!token) throw new Error("expected token");

  const expect_ = {
    operationId: token.operationId,
    agentId,
    operation: "restart" as const,
  };

  // First use succeeds...
  expect(manager.validateDaemonLifecycleAuthorization(token.token, expect_)).toBe(true);
  // ...and consumes the token: a second use fails even with identical parameters.
  expect(manager.validateDaemonLifecycleAuthorization(token.token, expect_)).toBe(false);
});

test("token validation rejects mismatched agentId or operation", async () => {
  const { manager, agentId } = await setup();

  const approval = await manager.requestDaemonLifecycleApproval({
    agentId,
    operation: "stop",
    host: "h",
  });
  const [resolution] = await Promise.all([
    approval.wait(),
    manager.respondToPermission(agentId, approval.requestId, { behavior: "allow" }),
  ]);
  const token = resolution.token;
  if (!token) throw new Error("expected token");

  expect(
    manager.validateDaemonLifecycleAuthorization(token.token, {
      operationId: token.operationId,
      agentId: "some-other-agent",
      operation: "stop",
    }),
  ).toBe(false);

  expect(
    manager.validateDaemonLifecycleAuthorization(token.token, {
      operationId: token.operationId,
      agentId,
      operation: "restart",
    }),
  ).toBe(false);

  // Still unconsumed after the two failed attempts above.
  expect(
    manager.validateDaemonLifecycleAuthorization(token.token, {
      operationId: token.operationId,
      agentId,
      operation: "stop",
    }),
  ).toBe(true);
});
