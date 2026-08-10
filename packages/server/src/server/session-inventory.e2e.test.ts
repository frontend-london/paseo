import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestPaseoDaemon, DaemonClient, type TestPaseoDaemon } from "./test-utils/index.js";
import { getFullAccessConfig } from "./daemon-e2e/agent-configs.js";

let daemon: TestPaseoDaemon;
let client: DaemonClient;
let cwd: string;
const clientId = "inventory-reconnect-fixture";

beforeEach(async () => {
  daemon = await createTestPaseoDaemon();
  client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    clientId,
  });
  await client.connect();
  await client.fetchAgents({ subscribe: { subscriptionId: "inventory-fixture" } });
  cwd = await mkdtemp(path.join(tmpdir(), "paseo-inventory-e2e-"));
});

afterEach(async () => {
  await client.close();
  await daemon.close();
  await rm(cwd, { recursive: true, force: true });
});

test("reconnects an isolated daemon inventory snapshot across 200 fixture records", async () => {
  for (let index = 0; index < 200; index += 1) {
    await client.createAgent({
      config: {
        ...getFullAccessConfig("codex"),
        cwd,
        title: `inventory-fixture-${index}`,
      },
    });
  }

  const first = await client.inventorySessions({ limit: 100 });
  expect(first).toMatchObject({
    schema_version: "paseo.inventory_sessions.v1",
    entries: expect.any(Array),
    has_more: true,
  });
  expect(first.entries).toHaveLength(100);
  expect(first.next_cursor).not.toBeNull();

  await client.close();
  client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    clientId,
  });
  await client.connect();

  const second = await client.inventorySessions({
    snapshot_id: first.snapshot_id,
    cursor: first.next_cursor!,
    limit: 100,
  });
  expect(second).toMatchObject({
    snapshot_id: first.snapshot_id,
    has_more: false,
    next_cursor: null,
  });
  expect(second.entries).toHaveLength(100);

  const identities = [...first.entries, ...second.entries].map((entry) => entry.native_id);
  expect(new Set(identities)).toHaveLength(200);
}, 60000);

test("reports a seeded persisted-only running status as non-live", async () => {
  const homeRoot = await mkdtemp(path.join(tmpdir(), "paseo-inventory-persisted-"));
  const recordDir = path.join(homeRoot, ".paseo", "agents", "tmp-persisted-only");
  const recordPath = path.join(recordDir, "persisted-only.json");
  await mkdir(recordDir, { recursive: true });
  await writeFile(
    recordPath,
    JSON.stringify({
      id: "persisted-only",
      provider: "codex",
      cwd: "/tmp/persisted-only",
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
      lastStatus: "running",
    }),
    "utf8",
  );

  const persistedDaemon = await createTestPaseoDaemon({ paseoHomeRoot: homeRoot });
  const persistedClient = new DaemonClient({
    url: `ws://127.0.0.1:${persistedDaemon.port}/ws`,
    clientId: "persisted-only-fixture",
  });
  try {
    await persistedClient.connect();
    const page = await persistedClient.inventorySessions({ limit: 200 });
    expect(page.entries).toContainEqual(
      expect.objectContaining({
        native_id: "persisted-only",
        status_raw: "running",
        live: false,
      }),
    );
  } finally {
    await persistedClient.close();
    await persistedDaemon.close();
    await rm(homeRoot, { recursive: true, force: true });
  }
}, 30000);
