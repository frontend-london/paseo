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

const spawnProcess = vi.fn(() => ({ pid: 999999, unref: vi.fn() }));

vi.mock("@getpaseo/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@getpaseo/server")>();
  return { ...actual, spawnProcess };
});

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
    spawnProcess.mockClear();
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

  test("an approved agent-context request hands off to a detached clone instead of calling shutdownServer in-process", async () => {
    // This is the fix for a real-process E2E finding: the initiating agent's own CLI
    // subprocess is a descendant of the very daemon session about to die, so the kernel
    // SIGHUPs it before it can finish. The approved request must therefore be handed to
    // a detached (setsid) clone rather than continuing synchronously in this process.
    requestDaemonLifecycleApproval.mockResolvedValue({
      decision: "approved",
      token: { token: "tok-abc", operationId: "op-abc" },
    });
    const home = await createPaseoHomeWithRunningDaemon();

    const result = await stopLocalDaemon({ home, agentId: "agent-123", timeoutMs: 2000 });

    expect(result.action).toBe("handed_off");
    expect(result.pid).toBe(999999);
    // The actual RPC that tears the daemon down must happen in the clone, not here.
    expect(shutdownServer).not.toHaveBeenCalled();

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    const [, , spawnOptions] = spawnProcess.mock.calls[0] as [
      string,
      string[],
      { detached?: boolean; envOverlay?: Record<string, string> },
    ];
    expect(spawnOptions.detached).toBe(true);
    const grantedRaw = spawnOptions.envOverlay?.PASEO_LIFECYCLE_AUTHORIZATION;
    expect(grantedRaw ? JSON.parse(grantedRaw) : null).toEqual({
      token: "tok-abc",
      operationId: "op-abc",
    });
  });

  test("the detached clone (authorization already granted via env) proceeds straight to shutdownServer, without spawning another clone", async () => {
    const home = await createPaseoHomeWithRunningDaemon();
    shutdownServer.mockResolvedValue({ status: "shutdown_requested" });
    const priorEnv = process.env.PASEO_LIFECYCLE_AUTHORIZATION;
    process.env.PASEO_LIFECYCLE_AUTHORIZATION = JSON.stringify({
      token: "tok-abc",
      operationId: "op-abc",
    });

    try {
      await stopLocalDaemon({ home, agentId: "agent-123", timeoutMs: 50 }).catch(() => undefined);
    } finally {
      if (priorEnv === undefined) {
        delete process.env.PASEO_LIFECYCLE_AUTHORIZATION;
      } else {
        process.env.PASEO_LIFECYCLE_AUTHORIZATION = priorEnv;
      }
    }

    // Pre-granted authorization is read from the environment — no RPC round trip.
    expect(requestDaemonLifecycleApproval).not.toHaveBeenCalled();
    expect(spawnProcess).not.toHaveBeenCalled();
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
