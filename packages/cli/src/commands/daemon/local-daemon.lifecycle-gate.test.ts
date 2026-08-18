import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const requestDaemonLifecycleApproval = vi.fn();
const shutdownServer = vi.fn();
const close = vi.fn().mockResolvedValue(undefined);

vi.mock("../../utils/client.js", () => ({
  tryConnectToDaemon: vi.fn(async () => ({
    requestDaemonLifecycleApproval,
    shutdownServer,
    close,
  })),
}));

const { stopLocalDaemon, DaemonLifecycleDeniedError } = await import("./local-daemon.js");

const tempRoots: string[] = [];

async function createPaseoHomeWithRunningDaemon(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-lifecycle-gate-"));
  tempRoots.push(root);
  const paseoHome = path.join(root, ".paseo");
  await mkdir(paseoHome, { recursive: true });
  await writeFile(path.join(paseoHome, "config.json"), JSON.stringify({ version: 1 }, null, 2));
  // Both signalProcessSafely and signalProcessTreeSafely refuse to signal
  // pid === process.pid, so using our own test PID here is safe even if the bug this
  // test guards against were to reproduce.
  await writeFile(
    path.join(paseoHome, "paseo.pid"),
    JSON.stringify({ pid: process.pid, listen: "127.0.0.1:6767" }, null, 2),
  );
  return paseoHome;
}

describe("stopLocalDaemon lifecycle approval gate", () => {
  beforeEach(() => {
    requestDaemonLifecycleApproval.mockReset();
    shutdownServer.mockReset();
    close.mockClear();
  });

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  test("a denied approval throws DaemonLifecycleDeniedError and never calls shutdownServer (must not fall through to raw process signaling)", async () => {
    requestDaemonLifecycleApproval.mockResolvedValue({
      decision: "denied",
      message: "operator said no",
    });
    const home = await createPaseoHomeWithRunningDaemon();

    await expect(
      stopLocalDaemon({ home, agentId: "agent-123", timeoutMs: 2000 }),
    ).rejects.toBeInstanceOf(DaemonLifecycleDeniedError);

    expect(requestDaemonLifecycleApproval).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-123", operation: "stop" }),
    );
    expect(shutdownServer).not.toHaveBeenCalled();
  });

  test("an approval with no usable token is treated as a denial, not as a green light", async () => {
    requestDaemonLifecycleApproval.mockResolvedValue({ decision: "approved", token: undefined });
    const home = await createPaseoHomeWithRunningDaemon();

    await expect(
      stopLocalDaemon({ home, agentId: "agent-123", timeoutMs: 2000 }),
    ).rejects.toBeInstanceOf(DaemonLifecycleDeniedError);
    expect(shutdownServer).not.toHaveBeenCalled();
  });

  test("an approved request calls shutdownServer with the granted authorization token", async () => {
    requestDaemonLifecycleApproval.mockResolvedValue({
      decision: "approved",
      token: { token: "tok-abc", operationId: "op-abc" },
    });
    shutdownServer.mockResolvedValue({ status: "shutdown_requested" });
    const home = await createPaseoHomeWithRunningDaemon();

    // We only assert on the RPC call shape here; waiting for the (fake, never-exiting)
    // PID to disappear would hang, so a short timeout + tolerating the resulting
    // stop-timeout error is fine — the thing under test already happened by then.
    await stopLocalDaemon({ home, agentId: "agent-123", timeoutMs: 50 }).catch(() => undefined);

    expect(shutdownServer).toHaveBeenCalledWith(
      expect.objectContaining({ authorization: { token: "tok-abc", operationId: "op-abc" } }),
    );
  });

  test("a human-terminal invocation (no agentId) never requests approval", async () => {
    const home = await createPaseoHomeWithRunningDaemon();
    shutdownServer.mockResolvedValue({ status: "shutdown_requested" });

    await stopLocalDaemon({ home, timeoutMs: 50 }).catch(() => undefined);

    expect(requestDaemonLifecycleApproval).not.toHaveBeenCalled();
    expect(shutdownServer).toHaveBeenCalledWith(
      expect.not.objectContaining({ authorization: expect.anything() }),
    );
  });
});
