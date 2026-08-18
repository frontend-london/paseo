import { describe, expect, test, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";

import {
  archiveLifecycleManifestIfComplete,
  listPendingLifecycleManifests,
  lifecycleManifestDir,
  readLifecycleResumeManifest,
  updateLifecycleResumeEntryStatus,
  writeLifecycleResumeManifest,
  type LifecycleResumeManifest,
} from "./lifecycle-resume-manifest.js";

let paseoHome: string;

beforeEach(() => {
  paseoHome = mkdtempSync(path.join(os.tmpdir(), "paseo-lifecycle-manifest-"));
});

afterEach(() => {
  rmSync(paseoHome, { recursive: true, force: true });
});

function manifest(overrides: Partial<LifecycleResumeManifest> = {}): LifecycleResumeManifest {
  return {
    operationId: "op-1",
    createdAt: new Date().toISOString(),
    entries: [
      {
        agentId: "agent-a",
        cwd: "/tmp/a",
        priorStatus: "running",
        capturedAt: new Date().toISOString(),
        status: "pending",
      },
      {
        agentId: "agent-b",
        cwd: "/tmp/b",
        priorStatus: "running",
        capturedAt: new Date().toISOString(),
        status: "pending",
      },
    ],
    ...overrides,
  };
}

describe("lifecycle-resume-manifest", () => {
  test("write then read round-trips the manifest", async () => {
    await writeLifecycleResumeManifest(paseoHome, manifest());
    const read = await readLifecycleResumeManifest(paseoHome, "op-1");
    expect(read?.entries).toHaveLength(2);
    expect(read?.entries.map((e) => e.agentId)).toEqual(["agent-a", "agent-b"]);
  });

  test("reading a manifest that was never written returns null", async () => {
    expect(await readLifecycleResumeManifest(paseoHome, "never-written")).toBeNull();
  });

  test("listPendingLifecycleManifests only returns manifests with at least one pending entry", async () => {
    await writeLifecycleResumeManifest(paseoHome, manifest({ operationId: "op-pending" }));
    await writeLifecycleResumeManifest(
      paseoHome,
      manifest({
        operationId: "op-done",
        entries: [
          {
            agentId: "agent-c",
            cwd: "/tmp/c",
            priorStatus: "running",
            capturedAt: new Date().toISOString(),
            status: "resumed",
          },
        ],
      }),
    );

    const pending = await listPendingLifecycleManifests(paseoHome);
    expect(pending.map((m) => m.operationId)).toEqual(["op-pending"]);
  });

  test("listPendingLifecycleManifests returns an empty array when the manifest dir doesn't exist yet", async () => {
    expect(await listPendingLifecycleManifests(paseoHome)).toEqual([]);
  });

  test("updateLifecycleResumeEntryStatus updates only the matching entry, atomically", async () => {
    await writeLifecycleResumeManifest(paseoHome, manifest());
    await updateLifecycleResumeEntryStatus(paseoHome, "op-1", "agent-a", "resumed");

    const read = await readLifecycleResumeManifest(paseoHome, "op-1");
    const byId = new Map(read?.entries.map((e) => [e.agentId, e.status]));
    expect(byId.get("agent-a")).toBe("resumed");
    expect(byId.get("agent-b")).toBe("pending");
  });

  test("updateLifecycleResumeEntryStatus is a no-op for a manifest that doesn't exist", async () => {
    await expect(
      updateLifecycleResumeEntryStatus(paseoHome, "missing-op", "agent-a", "resumed"),
    ).resolves.toBeUndefined();
  });

  test("archiveLifecycleManifestIfComplete is a no-op while any entry is still pending", async () => {
    await writeLifecycleResumeManifest(paseoHome, manifest());
    await updateLifecycleResumeEntryStatus(paseoHome, "op-1", "agent-a", "resumed");
    await archiveLifecycleManifestIfComplete(paseoHome, "op-1");

    // Still present in the active (non-archived) location — one entry is still pending.
    expect(await readLifecycleResumeManifest(paseoHome, "op-1")).not.toBeNull();
    const pending = await listPendingLifecycleManifests(paseoHome);
    expect(pending.map((m) => m.operationId)).toEqual(["op-1"]);
  });

  test("archiveLifecycleManifestIfComplete moves the manifest out once every entry is terminal", async () => {
    await writeLifecycleResumeManifest(paseoHome, manifest());
    await updateLifecycleResumeEntryStatus(paseoHome, "op-1", "agent-a", "resumed");
    await updateLifecycleResumeEntryStatus(paseoHome, "op-1", "agent-b", "failed_to_resume");
    await archiveLifecycleManifestIfComplete(paseoHome, "op-1");

    expect(await readLifecycleResumeManifest(paseoHome, "op-1")).toBeNull();
    expect(await listPendingLifecycleManifests(paseoHome)).toEqual([]);

    const archivedDir = path.join(lifecycleManifestDir(paseoHome), "archived");
    expect(existsSync(archivedDir)).toBe(true);
    expect(readdirSync(archivedDir)).toEqual(["op-1.json"]);
  });

  test("a partial crash mid-resume (some entries terminal, some still pending) is recoverable: re-reading finds exactly the still-pending entries", async () => {
    await writeLifecycleResumeManifest(paseoHome, manifest());
    // Simulate a crash right after agent-a was marked resumed but before agent-b.
    await updateLifecycleResumeEntryStatus(paseoHome, "op-1", "agent-a", "resumed");

    const [pending] = await listPendingLifecycleManifests(paseoHome);
    const stillPending = pending?.entries.filter((e) => e.status === "pending") ?? [];
    expect(stillPending.map((e) => e.agentId)).toEqual(["agent-b"]);
  });
});
