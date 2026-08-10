import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDaemonTestContext, type DaemonTestContext } from "./test-utils/index.js";
import { getFullAccessConfig } from "./daemon-e2e/agent-configs.js";

let ctx: DaemonTestContext;
let cwd: string;

beforeEach(async () => {
  ctx = await createDaemonTestContext();
  cwd = await mkdtemp(path.join(tmpdir(), "paseo-inventory-e2e-"));
});

afterEach(async () => {
  await ctx.cleanup();
  await rm(cwd, { recursive: true, force: true });
});

test("enumerates an isolated daemon inventory beyond the legacy 200-row ceiling", async () => {
  for (let index = 0; index < 201; index += 1) {
    await ctx.client.createAgent({
      config: {
        ...getFullAccessConfig("codex"),
        cwd,
        title: `inventory-fixture-${index}`,
      },
    });
  }

  const first = await ctx.client.inventorySessions({ limit: 200 });
  expect(first).toMatchObject({
    schema_version: "paseo.inventory_sessions.v1",
    entries: expect.any(Array),
    has_more: true,
  });
  expect(first.entries).toHaveLength(200);
  expect(first.next_cursor).not.toBeNull();

  const second = await ctx.client.inventorySessions({
    snapshot_id: first.snapshot_id,
    cursor: first.next_cursor!,
    limit: 200,
  });
  expect(second).toMatchObject({
    snapshot_id: first.snapshot_id,
    has_more: false,
    next_cursor: null,
  });
  expect(second.entries).toHaveLength(1);

  const identities = [...first.entries, ...second.entries].map((entry) => entry.native_id);
  expect(new Set(identities)).toHaveLength(201);
}, 60000);
