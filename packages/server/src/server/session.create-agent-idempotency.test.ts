import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { Session } from "./session.js";
import { AgentManager } from "./agent/agent-manager.js";
import { AgentStorage } from "./agent/agent-storage.js";
import { FileBackedProjectRegistry, FileBackedWorkspaceRegistry } from "./workspace-registry.js";
import { CreateAgentDedupeRegistry } from "./agent/create-agent/create-agent-dedupe.js";
import type { SessionOutboundMessage } from "./messages.js";
import {
  asCheckoutDiffManager,
  asDaemonConfigStore,
  asDownloadTokenStore,
  asPushNotifications,
  asScheduleService,
  asSessionLogger,
  createProviderSnapshotManagerStub,
} from "./test-utils/session-stubs.js";
import { createNoopWorkspaceGitService } from "./test-utils/workspace-git-service-stub.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
} from "./workspace-registry.js";
import type { AgentClient, AgentSession, AgentTurnStartResult } from "./agent/agent-sdk-types.js";

class FakeCodexClient implements AgentClient {
  public capabilities = {
    supportsStreaming: false,
    supportsNativePaseoTools: false,
  };
  public startShouldFail = false;
  public startFailureMessage = "Pre-provider initialization failed";
  public startCallCount = 0;
  public createSessionCallCount = 0;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(): Promise<AgentSession> {
    this.createSessionCallCount++;
    const sessionId = `fake-session-${Date.now()}-${Math.random()}`;
    return {
      provider: "codex",
      id: sessionId,
      sessionId,
      startTurn: async (): Promise<AgentTurnStartResult> => {
        this.startCallCount++;
        if (this.startShouldFail) {
          throw new Error(this.startFailureMessage);
        }
        return { activeTurnId: "turn-1" };
      },
      steerTurn: async () => ({ activeTurnId: "turn-1" }),
      cancelTurn: async () => undefined,
      respondToPermission: async () => undefined,
      close: async () => undefined,
      describePersistence: () => ({
        provider: "codex",
        sessionId,
      }),
      getRuntimeInfo: async () => ({
        provider: "codex",
        sessionId,
        model: "gpt-test",
        modeId: "default",
      }),
      getAvailableModes: async () => [],
      getCurrentMode: async () => null,
      getPendingPermissions: () => [],
      subscribe: () => () => {},
    } as unknown as AgentSession;
  }
}

describe("create_agent_request idempotency and deduplication (AGT-284)", () => {
  let workdir: string;
  let testCwd: string;
  let fakeClient: FakeCodexClient;
  let agentManager: AgentManager;
  let agentStorage: AgentStorage;
  let projectRegistry: FileBackedProjectRegistry;
  let workspaceRegistry: FileBackedWorkspaceRegistry;
  let sharedDedupeRegistry: CreateAgentDedupeRegistry;
  let logger: Parameters<typeof asSessionLogger>[0];

  beforeEach(async () => {
    workdir = mkdtempSync(path.join(tmpdir(), "paseo-create-agent-idem-"));
    testCwd = path.join(workdir, "project");
    mkdirSync(testCwd, { recursive: true });

    logger = {
      child: () => logger,
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as Parameters<typeof asSessionLogger>[0];

    fakeClient = new FakeCodexClient();
    agentStorage = new AgentStorage(path.join(workdir, "agents"), asSessionLogger(logger));
    agentManager = new AgentManager({
      clients: { codex: fakeClient },
      registry: agentStorage,
      logger: asSessionLogger(logger),
      idFactory: (() => {
        let counter = 0;
        return () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
      })(),
    });

    sharedDedupeRegistry = new CreateAgentDedupeRegistry({
      agentManager,
      agentStorage,
      logger: asSessionLogger(logger),
    });

    projectRegistry = new FileBackedProjectRegistry(
      path.join(workdir, "projects.json"),
      asSessionLogger(logger),
    );
    workspaceRegistry = new FileBackedWorkspaceRegistry(
      path.join(workdir, "workspaces.json"),
      asSessionLogger(logger),
    );

    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "proj-1",
        rootPath: testCwd,
        kind: "non_git",
        displayName: "project",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "ws-1",
        projectId: "proj-1",
        cwd: testCwd,
        kind: "directory",
        displayName: "workspace",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  function createTestSession(emitted: SessionOutboundMessage[]): Session {
    return new Session({
      clientId: "test-client",
      serverId: "test-server",
      scopes: ["*"],
      appVersion: null,
      onMessage: (message) => emitted.push(message),
      logger: asSessionLogger(logger),
      downloadTokenStore: asDownloadTokenStore(),
      pushNotifications: asPushNotifications(),
      paseoHome: path.join(workdir, "paseo-home"),
      agentManager,
      agentStorage,
      createAgentDedupeRegistry: sharedDedupeRegistry,
      projectRegistry,
      workspaceRegistry,
      scheduleService: asScheduleService(),
      checkoutDiffManager: asCheckoutDiffManager({
        subscribe: async () => ({
          initial: { cwd: testCwd, files: [], error: null },
          unsubscribe: () => {},
        }),
        scheduleRefreshForCwd: () => {},
        onWorkspaceStateMayHaveChanged: () => {},
        invalidateForge: () => {},
        getMetrics: () => ({
          checkoutDiffTargetCount: 0,
          checkoutDiffSubscriptionCount: 0,
          checkoutDiffWatcherCount: 0,
          checkoutDiffFallbackRefreshTargetCount: 0,
        }),
        dispose: () => {},
      }),
      workspaceGitService: createNoopWorkspaceGitService({
        getCheckout: async (cwd: string) => ({
          cwd,
          isGit: false,
          currentBranch: null,
          remoteUrl: null,
          worktreeRoot: null,
          isPaseoOwnedWorktree: false,
          mainRepoRoot: null,
        }),
      }),
      daemonConfigStore: asDaemonConfigStore({
        get: () => ({ mcp: { injectIntoAgents: false }, providers: {} }),
        onChange: () => () => {},
      }),
      mcpBaseUrl: null,
      stt: null,
      tts: null,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      terminalManager: null,
    });
  }

  it("coalesces near-simultaneous duplicate creates with the same idempotencyKey", async () => {
    const emitted1: SessionOutboundMessage[] = [];
    const emitted2: SessionOutboundMessage[] = [];
    const session1 = createTestSession(emitted1);
    const session2 = createTestSession(emitted2);

    const idempotencyKey = "shared-request-key-1";

    const request1 = session1.handleMessage({
      type: "create_agent_request",
      requestId: "req-1",
      idempotencyKey,
      config: { provider: "codex", cwd: testCwd },
      workspaceId: "ws-1",
      initialPrompt: "Run task A",
      attachments: [],
    });

    const request2 = session2.handleMessage({
      type: "create_agent_request",
      requestId: "req-2",
      idempotencyKey,
      config: { provider: "codex", cwd: testCwd },
      workspaceId: "ws-1",
      initialPrompt: "Run task A",
      attachments: [],
    });

    await Promise.all([request1, request2]);

    // Exactly one agent should be created in AgentManager
    const agents = agentManager.listAgents();
    expect(agents).toHaveLength(1);
    const agentId = agents[0].id;

    // Both sessions should receive agent_created status with their respective requestId
    const status1 = emitted1.find(
      (m): m is Extract<SessionOutboundMessage, { type: "status" }> =>
        m.type === "status" && m.payload.requestId === "req-1",
    );
    const status2 = emitted2.find(
      (m): m is Extract<SessionOutboundMessage, { type: "status" }> =>
        m.type === "status" && m.payload.requestId === "req-2",
    );

    expect(status1).toBeDefined();
    expect(status2).toBeDefined();
    expect(status1?.payload.status).toBe("agent_created");
    expect(status2?.payload.status).toBe("agent_created");
    expect(status1?.payload.agentId).toBe(agentId);
    expect(status2?.payload.agentId).toBe(agentId);
  });

  it("returns existing agent on repeated sequential create with the same idempotencyKey", async () => {
    const emitted1: SessionOutboundMessage[] = [];
    const emitted2: SessionOutboundMessage[] = [];
    const session1 = createTestSession(emitted1);
    const session2 = createTestSession(emitted2);

    const idempotencyKey = "sequential-idem-key";

    // First request
    await session1.handleMessage({
      type: "create_agent_request",
      requestId: "req-first",
      idempotencyKey,
      config: { provider: "codex", cwd: testCwd },
      workspaceId: "ws-1",
      initialPrompt: "Do initial work",
      attachments: [],
    });

    expect(agentManager.listAgents()).toHaveLength(1);
    const createdAgentId = agentManager.listAgents()[0].id;
    expect(fakeClient.createSessionCallCount).toBe(1);

    // Repeated request with same idempotencyKey
    await session2.handleMessage({
      type: "create_agent_request",
      requestId: "req-second",
      idempotencyKey,
      config: { provider: "codex", cwd: testCwd },
      workspaceId: "ws-1",
      initialPrompt: "Do initial work",
      attachments: [],
    });

    // Still exactly one agent in manager, no new provider session created
    expect(agentManager.listAgents()).toHaveLength(1);
    expect(fakeClient.createSessionCallCount).toBe(1);

    const statusSecond = emitted2.find(
      (m): m is Extract<SessionOutboundMessage, { type: "status" }> =>
        m.type === "status" && m.payload.requestId === "req-second",
    );
    expect(statusSecond?.payload.status).toBe("agent_created");
    expect(statusSecond?.payload.agentId).toBe(createdAgentId);
  });

  it("allows clean retry without duplicate sessions/agents after pre-provider startup failure", async () => {
    const emitted1: SessionOutboundMessage[] = [];
    const emitted2: SessionOutboundMessage[] = [];
    const session1 = createTestSession(emitted1);
    const session2 = createTestSession(emitted2);

    const idempotencyKey = "retry-after-fail-key";

    // Set provider to fail initially
    fakeClient.startShouldFail = true;

    await session1.handleMessage({
      type: "create_agent_request",
      requestId: "req-fail",
      idempotencyKey,
      config: { provider: "codex", cwd: testCwd },
      workspaceId: "ws-1",
      initialPrompt: "This will fail on startup",
      attachments: [],
    });

    const statusFail = emitted1.find(
      (m): m is Extract<SessionOutboundMessage, { type: "status" }> =>
        m.type === "status" && m.payload.requestId === "req-fail",
    );
    expect(statusFail?.payload.status).toBe("agent_create_failed");

    // The failed agent was archived/cleaned up, so active agents list has no living active agent
    const activeAgents = agentManager.listAgents().filter((a) => !a.archivedAt);
    console.log(
      "ACTIVE AGENTS AFTER FAIL:",
      activeAgents.map((a) => ({ id: a.id, archivedAt: a.archivedAt, status: a.lifecycle })),
    );
    expect(activeAgents).toHaveLength(0);

    // Now fix the failure condition and retry with the same idempotency key
    fakeClient.startShouldFail = false;

    await session2.handleMessage({
      type: "create_agent_request",
      requestId: "req-retry",
      idempotencyKey,
      config: { provider: "codex", cwd: testCwd },
      workspaceId: "ws-1",
      initialPrompt: "This should succeed on retry",
      attachments: [],
    });

    const statusRetry = emitted2.find(
      (m): m is Extract<SessionOutboundMessage, { type: "status" }> =>
        m.type === "status" && m.payload.requestId === "req-retry",
    );
    expect(statusRetry?.payload.status).toBe("agent_created");

    // Exactly one active agent exists after retry
    const finalActive = agentManager.listAgents().filter((a) => !a.archivedAt);
    expect(finalActive).toHaveLength(1);
    expect(statusRetry?.payload.agentId).toBe(finalActive[0].id);
  });

  it("creates distinct agents when idempotencyKey is omitted", async () => {
    const emitted: SessionOutboundMessage[] = [];
    const session = createTestSession(emitted);

    await session.handleMessage({
      type: "create_agent_request",
      requestId: "req-no-idem-1",
      config: { provider: "codex", cwd: testCwd },
      workspaceId: "ws-1",
      attachments: [],
    });

    await session.handleMessage({
      type: "create_agent_request",
      requestId: "req-no-idem-2",
      config: { provider: "codex", cwd: testCwd },
      workspaceId: "ws-1",
      attachments: [],
    });

    expect(agentManager.listAgents()).toHaveLength(2);
  });

  it("creates distinct agents for different idempotency keys", async () => {
    const emitted: SessionOutboundMessage[] = [];
    const session = createTestSession(emitted);

    await session.handleMessage({
      type: "create_agent_request",
      requestId: "req-key-a",
      idempotencyKey: "key-a",
      config: { provider: "codex", cwd: testCwd },
      workspaceId: "ws-1",
      attachments: [],
    });

    await session.handleMessage({
      type: "create_agent_request",
      requestId: "req-key-b",
      idempotencyKey: "key-b",
      config: { provider: "codex", cwd: testCwd },
      workspaceId: "ws-1",
      attachments: [],
    });

    expect(agentManager.listAgents()).toHaveLength(2);
  });

  it("does not create duplicate directory workspaces on retry after pre-provider startup failure", async () => {
    const emitted1: SessionOutboundMessage[] = [];
    const emitted2: SessionOutboundMessage[] = [];
    const session1 = createTestSession(emitted1);
    const session2 = createTestSession(emitted2);

    const idempotencyKey = "ws-retry-fail-key";

    // Initial count of workspaces
    const initialWorkspaces = await workspaceRegistry.list();

    // Set startup failure
    fakeClient.startShouldFail = true;

    // First request without workspaceId (will provision a directory workspace)
    await session1.handleMessage({
      type: "create_agent_request",
      requestId: "req-ws-fail",
      idempotencyKey,
      config: { provider: "codex", cwd: testCwd },
      initialPrompt: "Startup will fail",
      attachments: [],
    });

    const workspacesAfterFail = await workspaceRegistry.list();
    // One workspace provisioned during attempt 1
    expect(workspacesAfterFail.length).toBe(initialWorkspaces.length + 1);

    // Fix failure condition and retry with the SAME idempotencyKey without workspaceId
    fakeClient.startShouldFail = false;

    await session2.handleMessage({
      type: "create_agent_request",
      requestId: "req-ws-retry",
      idempotencyKey,
      config: { provider: "codex", cwd: testCwd },
      initialPrompt: "Retry will succeed",
      attachments: [],
    });

    const workspacesAfterRetry = await workspaceRegistry.list();
    // The retry MUST NOT create a second workspace; it must reuse the provisioned workspace
    expect(workspacesAfterRetry.length).toBe(workspacesAfterFail.length);

    const statusRetry = emitted2.find(
      (m): m is Extract<SessionOutboundMessage, { type: "status" }> =>
        m.type === "status" && m.payload.requestId === "req-ws-retry",
    );
    expect(statusRetry?.payload.status).toBe("agent_created");

    // Exactly one active agent exists
    const active = agentManager.listAgents().filter((a) => !a.archivedAt);
    expect(active).toHaveLength(1);
  });
});
