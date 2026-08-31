import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createDaemonTestContext,
  createTestPaseoDaemon,
  DaemonClient,
  type DaemonTestContext,
} from "../test-utils/index.js";
import type { PersistenceHandle } from "@getpaseo/protocol/messages";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-restart-resume-"));
}

describe("daemon restart resume", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  }, 60_000);

  test("Codex agent survives daemon restart with persistence handle", async () => {
    const cwd = tmpCwd();
    const marker = `DAEMON_RESTART_MARKER_${Date.now()}`;
    try {
      const agent = await ctx.client.createAgent({
        provider: "codex",
        cwd,
        title: "Daemon Restart Test Agent",
        modeId: "full-access",
      });

      await ctx.client.sendMessage(
        agent.id,
        `Remember this marker string for a test: "${marker}".`,
      );

      const afterRemember = await ctx.client.waitForFinish(agent.id, 5_000);
      expect(afterRemember.status).toBe("idle");
      expect(afterRemember.final?.persistence).toBeTruthy();
      expect(afterRemember.final!.persistence!.metadata).toMatchObject({ marker });

      const handle = afterRemember.final!.persistence as PersistenceHandle;

      await ctx.cleanup();
      ctx = await createDaemonTestContext();

      const resumed = await ctx.client.resumeAgent(handle);
      await ctx.client.sendMessage(
        resumed.id,
        "What was the marker string I asked you to remember earlier?",
      );

      const afterRecall = await ctx.client.waitForFinish(resumed.id, 5_000);
      expect(afterRecall.status).toBe("idle");
      expect(afterRecall.final?.persistence).toBeTruthy();
      expect(afterRecall.final!.persistence!.metadata).toMatchObject({ marker });

      await ctx.client.deleteAgent(resumed.id);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("Codex agent automatically resumes after controlled daemon restart", async () => {
    const paseoHomeRoot = mkdtempSync(path.join(tmpdir(), "daemon-restart-resume-home-"));
    const cwd = tmpCwd();
    const marker = `DAEMON_RESTART_MARKER_${Date.now()}`;
    const daemon1 = await createTestPaseoDaemon({ paseoHomeRoot, cleanup: false });
    const client1 = new DaemonClient({ url: `ws://127.0.0.1:${daemon1.port}/ws` });
    await client1.connect();
    await client1.fetchAgents({ subscribe: { subscriptionId: "test" } });

    try {
      const agent = await client1.createAgent({
        provider: "codex",
        cwd,
        title: "Auto Resume Test Agent",
        modeId: "full-access",
      });

      await client1.sendMessage(agent.id, `Remember this marker string for a test: "${marker}".`);

      const afterRemember = await client1.waitForFinish(agent.id, 5_000);
      expect(afterRemember.status).toBe("idle");
      expect(afterRemember.final?.persistence).toBeTruthy();
      expect(afterRemember.final!.persistence!.metadata).toMatchObject({ marker });

      const firstAgentId = afterRemember.final!.id;
      const handle = afterRemember.final!.persistence as PersistenceHandle;

      await client1.close();
      await daemon1.close();

      const daemon2 = await createTestPaseoDaemon({ paseoHomeRoot, cleanup: true });
      const client2 = new DaemonClient({ url: `ws://127.0.0.1:${daemon2.port}/ws` });
      await client2.connect();
      await client2.fetchAgents({ subscribe: { subscriptionId: "test" } });

      const afterRestart = await client2.waitForFinish(firstAgentId, 5_000);
      expect(afterRestart.status).toBe("idle");
      expect(afterRestart.final?.persistence).toBeTruthy();
      expect(afterRestart.final!.id).toBe(firstAgentId);
      expect(afterRestart.final!.persistence!.sessionId).toBe(handle.sessionId);

      await client2.sendMessage(
        firstAgentId,
        "What was the marker string I asked you to remember?",
      );

      const afterRecall = await client2.waitForFinish(firstAgentId, 5_000);
      expect(afterRecall.status).toBe("idle");
      expect(afterRecall.final?.persistence).toBeTruthy();
      expect(afterRecall.final!.persistence!.metadata).toMatchObject({ marker });

      await client2.deleteAgent(firstAgentId);
      await client2.close();
      await daemon2.close();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(paseoHomeRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
