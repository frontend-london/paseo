/**
 * Integration coverage for NEW-1: a real ACP child process whose initialize
 * handshake hangs must not pin session close or daemon shutdown. Exercises
 * the real spawn path, the real on-disk managed process ledger, tree-kill
 * termination, and the AgentManager layer that closeAllAgents awaits.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { ACPAgentClient, ACPAgentSession, DEFAULT_ACP_CAPABILITIES } from "./acp-agent.js";
import { AgentManager } from "../agent-manager.js";
import {
  createManagedProcessRegistry,
  createSystemManagedProcessTable,
  type ManagedProcessRegistry,
} from "../../managed-processes/managed-processes.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { terminateWithTreeKill } from "../../../utils/tree-kill.js";
import type { AgentSessionConfig } from "../agent-sdk-types.js";

const logger = createTestLogger();

/**
 * Minimal ACP host over NDJSON stdio. Responds to the first initialize and
 * hangs every later one (tracked via a counter file), or hangs all of them
 * when hangAll is baked in. Everything else gets a canned response.
 */
function mockACPSource(options: { counterFile: string; hangAll: boolean }): string {
  return `
const readline = require("node:readline");
const fs = require("node:fs");
const COUNTER_FILE = ${JSON.stringify(options.counterFile)};
const HANG_ALL = ${JSON.stringify(options.hangAll)};

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined || typeof msg.method !== "string") {
    return;
  }
  switch (msg.method) {
    case "initialize": {
      let count = 0;
      try {
        count = parseInt(fs.readFileSync(COUNTER_FILE, "utf8"), 10) || 0;
      } catch {}
      count += 1;
      fs.writeFileSync(COUNTER_FILE, String(count));
      if (HANG_ALL || count > 1) {
        return; // Hung handshake: never respond.
      }
      respond(msg.id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        authMethods: [],
      });
      break;
    }
    case "session/new":
    case "session/load":
      respond(msg.id, {
        sessionId: "mock-session-1",
        modes: null,
        models: {
          availableModels: [{ modelId: "mock-model", name: "Mock Model" }],
          currentModelId: "mock-model",
        },
        configOptions: [],
      });
      break;
    case "session/prompt":
      respond(msg.id, { stopReason: "end_turn" });
      break;
    default:
      respond(msg.id, {});
  }
});
`;
}

interface IntegrationFixture {
  workdir: string;
  registry: ManagedProcessRegistry;
  mockPath: string;
  counterFile: string;
}

async function createFixture(options: { hangAll: boolean }): Promise<IntegrationFixture> {
  const workdir = await mkdtemp(path.join(tmpdir(), "paseo-acp-init-hang-"));
  const counterFile = path.join(workdir, "mock-initialize-count");
  await writeFile(counterFile, "0", "utf8");
  const mockPath = path.join(workdir, "mock-acp.cjs");
  await writeFile(
    mockPath,
    mockACPSource({
      counterFile,
      hangAll: options.hangAll,
    }),
    "utf8",
  );
  const registry = createManagedProcessRegistry({
    paseoHome: workdir,
    processTable: createSystemManagedProcessTable(),
    terminateProcess: terminateWithTreeKill,
    logger,
  });
  return { workdir, registry, mockPath, counterFile };
}

function createClient(
  fixture: IntegrationFixture,
  options: { initializeTimeoutMs?: number } = {},
): ACPAgentClient {
  return new ACPAgentClient({
    provider: "claude-acp",
    logger,
    defaultCommand: [process.execPath, fixture.mockPath],
    defaultModes: [],
    managedProcesses: fixture.registry,
    ...(options.initializeTimeoutMs ? { initializeTimeoutMs: options.initializeTimeoutMs } : {}),
  });
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForCondition(
  assertion: () => void | Promise<void>,
  timeoutMs = 10_000,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() - startedAt > timeoutMs) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

function createSessionDirectly(
  fixture: IntegrationFixture,
  options: { initializeTimeoutMs?: number } = {},
): ACPAgentSession {
  const config: AgentSessionConfig = {
    provider: "claude-acp",
    cwd: fixture.workdir,
    model: "mock-model",
  };
  return new ACPAgentSession(config, {
    provider: "claude-acp",
    logger,
    defaultCommand: [process.execPath, fixture.mockPath],
    defaultModes: [],
    capabilities: DEFAULT_ACP_CAPABILITIES,
    managedProcesses: fixture.registry,
    ...(options.initializeTimeoutMs ? { initializeTimeoutMs: options.initializeTimeoutMs } : {}),
  });
}

describe("ACP hung initialize integration (NEW-1)", () => {
  const fixtures: IntegrationFixture[] = [];

  afterEach(async () => {
    const fixture = fixtures.pop();
    if (fixture) {
      await rm(fixture.workdir, { recursive: true, force: true });
    }
  });

  test("close during hung initialize completes within timeout and leaves no process", async () => {
    const fixture = await createFixture({ hangAll: true });
    fixtures.push(fixture);
    // Use a long timeout so close() is the one that terminates, not the timeout.
    const session = createSessionDirectly(fixture, { initializeTimeoutMs: 30_000 });

    // Start initializeNewSession without awaiting — it hangs on initialize.
    const initPromise = session.initializeNewSession();
    initPromise.catch(() => {});

    // The spawned process is registered in the ledger before initialize.
    let pendingPid = 0;
    await waitForCondition(async () => {
      const records = await fixture.registry.list();
      expect(records).toHaveLength(1);
      pendingPid = records[0]?.pid ?? 0;
      expect(records[0]?.metadata.stage).toBe("starting");
    });
    expect(pendingPid).toBeGreaterThan(0);
    expect(pidIsAlive(pendingPid)).toBe(true);

    // close() must complete in bounded time despite the hung initialize.
    const closeStartedAt = Date.now();
    await session.close();
    const closeDurationMs = Date.now() - closeStartedAt;

    expect(closeDurationMs).toBeLessThan(10_000);

    // The pending child is killed.
    await waitForCondition(() => {
      expect(pidIsAlive(pendingPid)).toBe(false);
    });

    // The ledger is empty.
    expect(await fixture.registry.list()).toHaveLength(0);

    // The init promise rejects (not hangs).
    await expect(initPromise).rejects.toThrow();

    // No late spawn, record, or process appears after the close.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await fixture.registry.list()).toHaveLength(0);

    // A "restarted daemon" reaping the same ledger finds nothing to clean up.
    const restartedRegistry = createManagedProcessRegistry({
      paseoHome: fixture.workdir,
      processTable: createSystemManagedProcessTable(),
      terminateProcess: terminateWithTreeKill,
      logger,
    });
    await expect(restartedRegistry.reapStale()).resolves.toMatchObject({
      checked: 0,
      removed: 0,
      terminated: 0,
    });
  }, 60_000);

  test("initialize timeout kills the real spawned process and clears the ledger", async () => {
    const fixture = await createFixture({ hangAll: true });
    fixtures.push(fixture);
    const client = createClient(fixture, { initializeTimeoutMs: 1_000 });

    const createPromise = client.createSession({
      provider: "claude-acp",
      cwd: fixture.workdir,
      model: "mock-model",
    });
    createPromise.catch(() => {});

    // While initialize hangs, the process is already visible in the ledger.
    let pendingPid = 0;
    await waitForCondition(async () => {
      const records = await fixture.registry.list();
      expect(records).toHaveLength(1);
      pendingPid = records[0]?.pid ?? 0;
      expect(records[0]?.metadata.stage).toBe("starting");
    });
    expect(pidIsAlive(pendingPid)).toBe(true);

    const startedAt = Date.now();
    await expect(createPromise).rejects.toThrow("acp_initialize_timeout");
    expect(Date.now() - startedAt).toBeLessThan(15_000);

    await waitForCondition(() => {
      expect(pidIsAlive(pendingPid)).toBe(false);
    });
    expect(await fixture.registry.list()).toHaveLength(0);
  }, 60_000);

  test("close is idempotent after timeout", async () => {
    const fixture = await createFixture({ hangAll: true });
    fixtures.push(fixture);
    const session = createSessionDirectly(fixture, { initializeTimeoutMs: 500 });

    const initPromise = session.initializeNewSession();
    initPromise.catch(() => {});

    await waitForCondition(async () => {
      expect(await fixture.registry.list()).toHaveLength(1);
    });

    // Wait for the timeout to reject the init.
    await expect(initPromise).rejects.toThrow("acp_initialize_timeout");
    await waitForCondition(async () => {
      expect(await fixture.registry.list()).toHaveLength(0);
    });

    // A second close must not hang or throw.
    await expect(session.close()).resolves.toBeUndefined();
    expect(await fixture.registry.list()).toHaveLength(0);
  }, 60_000);

  test("child exit during initialize does not wait for timeout", async () => {
    const workdir = await mkdtemp(path.join(tmpdir(), "paseo-acp-exit-init-"));
    const mockPath = path.join(workdir, "mock-exit.cjs");
    await writeFile(mockPath, `process.exit(0);`, "utf8");
    const registry = createManagedProcessRegistry({
      paseoHome: workdir,
      processTable: createSystemManagedProcessTable(),
      terminateProcess: terminateWithTreeKill,
      logger,
    });
    fixtures.push({ workdir, registry, mockPath, counterFile: "" });

    const session = new ACPAgentSession(
      { provider: "claude-acp", cwd: workdir, model: "mock-model" },
      {
        provider: "claude-acp",
        logger,
        defaultCommand: [process.execPath, mockPath],
        defaultModes: [],
        capabilities: DEFAULT_ACP_CAPABILITIES,
        managedProcesses: registry,
        initializeTimeoutMs: 30_000,
      },
    );

    const startedAt = Date.now();
    await expect(session.initializeNewSession()).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    expect(await registry.list()).toHaveLength(0);
  }, 60_000);

  test("closeAllAgents finishes despite a hung initialize", async () => {
    const fixture = await createFixture({ hangAll: true });
    fixtures.push(fixture);
    // Short timeout so the registration task settles quickly.
    const client = createClient(fixture, { initializeTimeoutMs: 1_000 });
    const manager = new AgentManager({
      clients: { "claude-acp": client },
      logger,
    });

    const createPromise = manager.createAgent(
      { provider: "claude-acp", cwd: fixture.workdir, model: "mock-model" },
      undefined,
      { workspaceId: undefined },
    );
    createPromise.catch(() => {});

    await waitForCondition(async () => {
      expect(await fixture.registry.list()).toHaveLength(1);
    });

    // flushForShutdown is what the daemon calls during shutdown.
    // It must complete despite the hung initialize — the timeout settles
    // the registration task, and the teardown clears the ledger.
    const startedAt = Date.now();
    await manager.flushForShutdown();
    expect(Date.now() - startedAt).toBeLessThan(15_000);

    const records = await fixture.registry.list();
    expect(records).toHaveLength(0);
  }, 60_000);
});
