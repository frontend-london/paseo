import { describe, expect, it } from "vitest";
import {
  INVENTORY_SCHEMA_VERSION,
  InventorySnapshotError,
  InventorySnapshotService,
  type InventorySessionEntry,
} from "./inventory-snapshot-service.js";

function entry(
  index: number,
  overrides: Partial<InventorySessionEntry> = {},
): InventorySessionEntry {
  return {
    backend: "paseo",
    native_id: `session-${String(index).padStart(4, "0")}`,
    provider: "claude",
    status_raw: "idle",
    archived: false,
    archived_at: null,
    internal: false,
    cwd: `/worktree/${index}`,
    created_at: "2026-08-10T00:00:00.000Z",
    updated_at: "2026-08-10T00:00:00.000Z",
    persistence_session_id: `provider-${index}`,
    ...overrides,
  };
}

function serviceFor(
  entries: InventorySessionEntry[],
  options?: { ttlMs?: number; now?: () => number },
) {
  return new InventorySnapshotService(() => entries, options?.now, options?.ttlMs);
}

function allIds(
  service: InventorySnapshotService,
  limit: number,
): {
  snapshotId: string;
  ids: string[];
  cursors: string[];
} {
  let page = service.page({ limit });
  const snapshotId = page.snapshot_id;
  const ids = page.entries.map((item) => item.native_id);
  const cursors: string[] = [];
  while (page.has_more) {
    expect(page.next_cursor).not.toBeNull();
    cursors.push(page.next_cursor!);
    page = service.page({ snapshot_id: snapshotId, cursor: page.next_cursor!, limit });
    ids.push(...page.entries.map((item) => item.native_id));
  }
  return { snapshotId, ids, cursors };
}

function expectErrorCode(action: () => unknown, code: InventorySnapshotError["code"]): void {
  try {
    action();
    throw new Error("Expected inventory snapshot failure");
  } catch (error) {
    expect(error).toBeInstanceOf(InventorySnapshotError);
    expect((error as InventorySnapshotError).code).toBe(code);
  }
}

describe("InventorySnapshotService", () => {
  it.each([0, 1, 199, 200, 201, 401])(
    "materializes %i sessions with a bounded deterministic page contract",
    (count) => {
      const result = allIds(
        serviceFor(Array.from({ length: count }, (_, index) => entry(index))),
        200,
      );
      expect(result.ids).toHaveLength(count);
      expect(new Set(result.ids)).toHaveLength(count);
      expect(result.ids).toEqual([...result.ids].sort());
    },
  );

  it("returns three pages with every identity exactly once and no cursor loop", () => {
    const result = allIds(serviceFor(Array.from({ length: 401 }, (_, index) => entry(index))), 200);
    expect(result.cursors).toHaveLength(2);
    expect(new Set(result.cursors)).toHaveLength(result.cursors.length);
    expect(result.ids).toHaveLength(401);
    expect(new Set(result.ids)).toHaveLength(401);
  });

  it("fails closed for a duplicate canonical identity", () => {
    const service = serviceFor([entry(1), entry(1, { provider: "codex" })]);
    expectErrorCode(() => service.page({}), "inventory_snapshot_conflict");
  });

  it("rejects a cursor supplied with a different snapshot", () => {
    const source = [entry(1), entry(2), entry(3)];
    const service = serviceFor(source);
    const first = service.page({ limit: 1 });
    source[0].status_raw = "running";
    const secondSnapshot = service.page({ limit: 2 });
    expectErrorCode(
      () =>
        service.page({
          snapshot_id: secondSnapshot.snapshot_id,
          cursor: first.next_cursor!,
          limit: 1,
        }),
      "inventory_cursor_snapshot_mismatch",
    );
  });

  it("rejects an expired snapshot", () => {
    let now = 0;
    const service = serviceFor([entry(1), entry(2)], { ttlMs: 10, now: () => now });
    const first = service.page({ limit: 1 });
    now = 11;
    expectErrorCode(
      () => service.page({ snapshot_id: first.snapshot_id, cursor: first.next_cursor!, limit: 1 }),
      "inventory_snapshot_expired",
    );
  });

  it("keeps lifecycle mutations out of an existing snapshot", () => {
    const source = [entry(1), entry(2), entry(3)];
    const service = serviceFor(source);
    const first = service.page({ limit: 1 });
    source[1].status_raw = "closed";
    source[1].archived = true;
    source[1].archived_at = "2026-08-10T00:01:00.000Z";
    const second = service.page({
      snapshot_id: first.snapshot_id,
      cursor: first.next_cursor!,
      limit: 2,
    });
    expect(second.entries[0]).toMatchObject({ native_id: "session-0002", status_raw: "idle" });
  });

  it("keeps deleted records in an existing snapshot", () => {
    const source = [entry(1), entry(2), entry(3)];
    const service = serviceFor(source);
    const first = service.page({ limit: 1 });
    source.splice(1, 1);
    const second = service.page({
      snapshot_id: first.snapshot_id,
      cursor: first.next_cursor!,
      limit: 2,
    });
    expect(second.entries.map((item) => item.native_id)).toEqual(["session-0002", "session-0003"]);
  });

  it("does not add newly created records to an existing snapshot", () => {
    const source = [entry(1), entry(3)];
    const service = serviceFor(source);
    const first = service.page({ limit: 1 });
    source.push(entry(2));
    const second = service.page({
      snapshot_id: first.snapshot_id,
      cursor: first.next_cursor!,
      limit: 2,
    });
    expect(second.entries.map((item) => item.native_id)).toEqual(["session-0003"]);
  });

  it("includes archived, internal, and unavailable-provider records instead of filtering them", () => {
    const service = serviceFor([
      entry(1, { status_raw: "running" }),
      entry(2, {
        status_raw: "closed",
        archived: true,
        archived_at: "2026-08-10T00:01:00.000Z",
      }),
      entry(3, { provider: "unavailable-provider", internal: true, status_raw: "error" }),
    ]);
    const page = service.page({ limit: 200 });
    expect(page.entries).toHaveLength(3);
    expect(page.entries.map((item) => item.status_raw)).toEqual(["running", "closed", "error"]);
    expect(page.entries[2]).toMatchObject({ provider: "unavailable-provider", internal: true });
  });

  it("replays the same snapshot and cursor deterministically", () => {
    const service = serviceFor([entry(1), entry(2), entry(3)]);
    const first = service.page({ limit: 1 });
    const pageA = service.page({
      snapshot_id: first.snapshot_id,
      cursor: first.next_cursor!,
      limit: 1,
    });
    const pageB = service.page({
      snapshot_id: first.snapshot_id,
      cursor: first.next_cursor!,
      limit: 1,
    });
    expect(pageA).toEqual(pageB);
    expect(pageA.schema_version).toBe(INVENTORY_SCHEMA_VERSION);
  });

  it("rejects invalid, incomplete, and forged cursors", () => {
    const service = serviceFor([entry(1), entry(2)]);
    const first = service.page({ limit: 1 });
    for (const request of [
      { snapshot_id: first.snapshot_id },
      { cursor: first.next_cursor! },
      { snapshot_id: first.snapshot_id, cursor: "not-a-cursor" },
    ]) {
      expect(() => service.page(request)).toThrow(InventorySnapshotError);
    }
  });

  it("fails a cursor that would loop back to the first page", () => {
    const service = serviceFor([entry(1), entry(2)]);
    const first = service.page({ limit: 1 });
    const loopCursor = (
      service as unknown as { encodeCursor(snapshotId: string, offset: number): string }
    ).encodeCursor(first.snapshot_id, 0);
    expectErrorCode(
      () => service.page({ snapshot_id: first.snapshot_id, cursor: loopCursor, limit: 1 }),
      "invalid_inventory_cursor",
    );
  });

  it("fails closed for malformed canonical source state", () => {
    const malformed = entry(1, { updated_at: "not-a-timestamp" });
    expectErrorCode(() => serviceFor([malformed]).page({}), "inventory_snapshot_conflict");
  });

  it("only invokes the source read path and never a mutation path", () => {
    let reads = 0;
    let mutations = 0;
    const source = {
      read: () => {
        reads += 1;
        return [entry(1)];
      },
      mutate: () => {
        mutations += 1;
      },
    };
    const service = new InventorySnapshotService(source.read);
    service.page({});
    expect(reads).toBe(1);
    expect(mutations).toBe(0);
  });
});
