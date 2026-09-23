import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import {
  CreateAgentDedupeRegistry,
  type CreateAgentDedupeFailedRecord,
} from "./create-agent-dedupe.js";
import type { AgentManager, ManagedAgent } from "../agent-manager.js";

const testLogger = pino({ level: "silent" });

describe("CreateAgentDedupeRegistry", () => {
  it("executes normally when no idempotencyKey is provided", async () => {
    const agentManager = {
      getAgent: vi.fn(),
      deleteAgentState: vi.fn(),
    } as unknown as AgentManager;

    const registry = new CreateAgentDedupeRegistry({ agentManager, logger: testLogger });
    const execute = vi.fn().mockResolvedValue({ agentId: "agent-1", result: { data: "test" } });

    const outcome = await registry.execute({
      idempotencyKey: "",
      execute,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({
      agentId: "agent-1",
      result: { data: "test" },
      reused: false,
    });
  });

  it("coalesces concurrent requests with the same idempotencyKey (in-progress join)", async () => {
    const agentManager = {
      getAgent: vi.fn(),
      deleteAgentState: vi.fn(),
    } as unknown as AgentManager;

    const registry = new CreateAgentDedupeRegistry({ agentManager, logger: testLogger });

    let resolveExecution!: (val: { agentId: string; result: { data: string } }) => void;
    const executionPromise = new Promise<{ agentId: string; result: { data: string } }>(
      (resolve) => {
        resolveExecution = resolve;
      },
    );

    const execute1 = vi.fn().mockImplementation(() => executionPromise);
    const execute2 = vi.fn().mockResolvedValue({ agentId: "agent-2", result: { data: "test2" } });

    const promise1 = registry.execute({
      idempotencyKey: "idem-key-1",
      execute: execute1,
    });

    const promise2 = registry.execute({
      idempotencyKey: "idem-key-1",
      execute: execute2,
    });

    resolveExecution({ agentId: "agent-1", result: { data: "success" } });

    const [outcome1, outcome2] = await Promise.all([promise1, promise2]);

    expect(execute1).toHaveBeenCalledTimes(1);
    expect(execute2).not.toHaveBeenCalled();

    expect(outcome1).toEqual({
      agentId: "agent-1",
      result: { data: "success" },
      reused: false,
    });
    expect(outcome2).toEqual({
      agentId: "agent-1",
      result: { data: "success" },
      reused: true,
    });
  });

  it("returns existing result on sequential duplicate create after success", async () => {
    const liveAgent = { id: "agent-1" } as ManagedAgent;
    const agentManager = {
      getAgent: vi.fn().mockReturnValue(liveAgent),
      deleteAgentState: vi.fn(),
    } as unknown as AgentManager;

    const registry = new CreateAgentDedupeRegistry({ agentManager, logger: testLogger });

    const execute1 = vi.fn().mockResolvedValue({ agentId: "agent-1", result: { data: "first" } });
    const execute2 = vi.fn().mockResolvedValue({ agentId: "agent-2", result: { data: "second" } });

    const outcome1 = await registry.execute({
      idempotencyKey: "idem-key-2",
      execute: execute1,
    });

    const outcome2 = await registry.execute({
      idempotencyKey: "idem-key-2",
      execute: execute2,
    });

    expect(execute1).toHaveBeenCalledTimes(1);
    expect(execute2).not.toHaveBeenCalled();

    expect(outcome1.reused).toBe(false);
    expect(outcome2.reused).toBe(true);
    expect(outcome2.agentId).toBe("agent-1");
  });

  it("supports onSuccessReturnExisting custom resolver for live/stored payloads", async () => {
    const agentManager = {
      getAgent: vi.fn().mockReturnValue(null),
      deleteAgentState: vi.fn(),
    } as unknown as AgentManager;

    const registry = new CreateAgentDedupeRegistry({ agentManager, logger: testLogger });

    const execute1 = vi
      .fn()
      .mockResolvedValue({ agentId: "agent-archived", result: { payload: "first" } });
    const execute2 = vi
      .fn()
      .mockResolvedValue({ agentId: "agent-fresh", result: { payload: "second" } });

    await registry.execute({
      idempotencyKey: "idem-key-stored",
      execute: execute1,
    });

    const onSuccessReturnExisting = vi.fn().mockResolvedValue({ payload: "reconstructed" });

    const outcome2 = await registry.execute({
      idempotencyKey: "idem-key-stored",
      execute: execute2,
      onSuccessReturnExisting,
    });

    expect(execute2).not.toHaveBeenCalled();
    expect(onSuccessReturnExisting).toHaveBeenCalledWith("agent-archived");
    expect(outcome2).toEqual({
      agentId: "agent-archived",
      result: { payload: "reconstructed" },
      reused: true,
    });
  });

  it("handles retry after pre-provider startup failure: cleans up failed agent and re-executes cleanly", async () => {
    const deleteAgentState = vi.fn().mockResolvedValue(undefined);
    const agentManager = {
      getAgent: vi.fn().mockReturnValue(null),
      deleteAgentState,
    } as unknown as AgentManager;

    const registry = new CreateAgentDedupeRegistry({ agentManager, logger: testLogger });

    const executeFail = vi
      .fn()
      .mockRejectedValue(new Error("Pre-provider startup failed: OpenCode timeout"));
    const executeSuccess = vi
      .fn()
      .mockResolvedValue({ agentId: "agent-retry-ok", result: { status: "created" } });

    await expect(
      registry.execute({
        idempotencyKey: "idem-key-retry",
        execute: executeFail,
      }),
    ).rejects.toThrow("Pre-provider startup failed");

    // Verify entry is in failed state
    const entry = registry.getEntry("idem-key-retry");
    expect(entry?.state).toBe("failed");

    const cleanupFailedAgent = vi.fn().mockResolvedValue(undefined);

    // Now retry the exact same idempotencyKey
    const retryOutcome = await registry.execute({
      idempotencyKey: "idem-key-retry",
      execute: executeSuccess,
      cleanupFailedAgent,
    });

    expect(executeSuccess).toHaveBeenCalledTimes(1);
    expect(retryOutcome).toEqual({
      agentId: "agent-retry-ok",
      result: { status: "created" },
      reused: false,
    });
  });

  it("tracks provisioned workspace and agent IDs on failure to allow clean retry without duplicates", async () => {
    const deleteAgentState = vi.fn().mockResolvedValue(undefined);
    const agentManager = {
      getAgent: vi.fn().mockReturnValue(null),
      deleteAgentState,
    } as unknown as AgentManager;

    const registry = new CreateAgentDedupeRegistry({ agentManager, logger: testLogger });

    const executeFail = vi.fn().mockImplementation(async (ctx) => {
      ctx.setProvisionedWorkspaceId("ws-failed-attempt");
      ctx.setCreatedAgentId("agent-failed-attempt");
      throw new Error("Initial prompt crashed");
    });

    await expect(
      registry.execute({
        idempotencyKey: "idem-key-ws-retry",
        execute: executeFail,
      }),
    ).rejects.toThrow("Initial prompt crashed");

    const failedEntry = registry.getEntry("idem-key-ws-retry") as
      | CreateAgentDedupeFailedRecord
      | undefined;
    expect(failedEntry?.state).toBe("failed");
    expect(failedEntry?.workspaceId).toBe("ws-failed-attempt");
    expect(failedEntry?.agentId).toBe("agent-failed-attempt");

    const cleanupFailedAgent = vi.fn().mockResolvedValue(undefined);
    const executeSuccess = vi.fn().mockResolvedValue({
      agentId: "agent-retry-ok",
      workspaceId: "ws-new-attempt",
      result: { ok: true },
    });

    const outcome = await registry.execute({
      idempotencyKey: "idem-key-ws-retry",
      execute: executeSuccess,
      cleanupFailedAgent,
    });

    expect(cleanupFailedAgent).toHaveBeenCalledWith("agent-failed-attempt");
    expect(outcome.agentId).toBe("agent-retry-ok");
    expect(outcome.workspaceId).toBe("ws-new-attempt");
    expect(outcome.reused).toBe(false);
  });
});
