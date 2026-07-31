import { expect, test } from "vitest";
import {
  EXTERNAL_RUNTIME_LABEL,
  EXTERNAL_SESSION_KEY_LABEL,
  isExternalRuntimeAgent,
} from "@getpaseo/protocol/agent-labels";

import type { StoredAgentRecord } from "./agent-storage.js";
import { registerExternalAgent } from "./external-register.js";

function createMemoryStorage(seed: StoredAgentRecord[] = []) {
  const cache = new Map(seed.map((record) => [record.id, structuredClone(record)]));
  return {
    async list() {
      return Array.from(cache.values()).map((record) => structuredClone(record));
    },
    async get(agentId: string) {
      const record = cache.get(agentId);
      return record ? structuredClone(record) : null;
    },
    async upsert(record: StoredAgentRecord) {
      cache.set(record.id, structuredClone(record));
    },
    dump() {
      return Array.from(cache.values());
    },
  };
}

test("registerExternalAgent creates a storage-only external agent", async () => {
  const storage = createMemoryStorage();
  const result = await registerExternalAgent(
    { agentStorage: storage, idFactory: () => "agent-ext-1" },
    {
      externalSessionKey: "bus-worker-01",
      provider: "devin",
      cwd: "/home/piotr/agents",
      title: "bus-worker-01",
      model: "glm-5.2-high",
      labels: {
        role: "bus-worker",
        tmux: "devin-bus-worker-01",
      },
      sessionHandle: "devin-bus-worker-01",
    },
  );

  expect(result.accepted).toBe(true);
  expect(result.created).toBe(true);
  expect(result.agentId).toBe("agent-ext-1");
  expect(result.record?.labels[EXTERNAL_RUNTIME_LABEL]).toBe("true");
  expect(result.record?.labels[EXTERNAL_SESSION_KEY_LABEL]).toBe("bus-worker-01");
  expect(result.record?.labels.role).toBe("bus-worker");
  expect(result.record?.labels.tmux).toBe("devin-bus-worker-01");
  expect(result.record?.lastStatus).toBe("idle");
  expect(result.record?.archivedAt).toBeNull();
  expect(result.record?.persistence?.sessionId).toBe("devin-bus-worker-01");
  expect(isExternalRuntimeAgent(result.record!)).toBe(true);
  expect(storage.dump()).toHaveLength(1);
});

test("registerExternalAgent is idempotent on externalSessionKey", async () => {
  const storage = createMemoryStorage();
  const first = await registerExternalAgent(
    { agentStorage: storage, idFactory: () => "agent-ext-1" },
    {
      externalSessionKey: "bus-worker-01",
      provider: "devin",
      cwd: "/home/piotr/agents",
      title: "bus-worker-01",
    },
  );
  const second = await registerExternalAgent(
    { agentStorage: storage, idFactory: () => "agent-ext-2" },
    {
      externalSessionKey: "bus-worker-01",
      provider: "devin",
      cwd: "/home/piotr/agents",
      title: "bus-worker-01 updated",
      model: "glm-5.2-high",
      labels: { ticket: "AGT-1" },
    },
  );

  expect(first.created).toBe(true);
  expect(second.created).toBe(false);
  expect(second.agentId).toBe(first.agentId);
  expect(second.record?.title).toBe("bus-worker-01 updated");
  expect(second.record?.labels.ticket).toBe("AGT-1");
  expect(storage.dump()).toHaveLength(1);
});

test("registerExternalAgent unarchives an existing archived external agent", async () => {
  const storage = createMemoryStorage([
    {
      id: "archived-1",
      provider: "devin",
      cwd: "/tmp/project",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      title: "old",
      labels: {
        [EXTERNAL_RUNTIME_LABEL]: "true",
        [EXTERNAL_SESSION_KEY_LABEL]: "coder-01",
      },
      lastStatus: "idle",
      archivedAt: "2026-01-02T00:00:00.000Z",
      config: {},
      internal: false,
    },
  ]);

  const result = await registerExternalAgent(
    { agentStorage: storage, idFactory: () => "should-not-be-used" },
    {
      externalSessionKey: "coder-01",
      provider: "devin",
      cwd: "/tmp/project",
      title: "coder-01 live",
    },
  );

  expect(result.accepted).toBe(true);
  expect(result.created).toBe(false);
  expect(result.agentId).toBe("archived-1");
  expect(result.record?.archivedAt).toBeNull();
  expect(result.record?.title).toBe("coder-01 live");
  expect(storage.dump()).toHaveLength(1);
});
