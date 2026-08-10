import { createHash, createHmac, randomBytes } from "node:crypto";

export const INVENTORY_SCHEMA_VERSION = "paseo.inventory_sessions.v1";
const DEFAULT_PAGE_LIMIT = 200;
const MAX_PAGE_LIMIT = 200;
const DEFAULT_SNAPSHOT_TTL_MS = 10 * 60 * 1000;

export interface InventorySessionEntry {
  backend: "paseo";
  native_id: string;
  provider: string;
  status_raw: string;
  archived: boolean;
  archived_at: string | null;
  internal: boolean;
  cwd: string;
  created_at: string;
  updated_at: string;
  persistence_session_id: string | null;
}

export interface InventorySnapshotPage {
  schema_version: typeof INVENTORY_SCHEMA_VERSION;
  snapshot_id: string;
  entries: InventorySessionEntry[];
  next_cursor: string | null;
  has_more: boolean;
}

export class InventorySnapshotError extends Error {
  constructor(
    readonly code:
      | "invalid_inventory_cursor"
      | "inventory_cursor_snapshot_mismatch"
      | "inventory_snapshot_expired"
      | "inventory_snapshot_not_found"
      | "inventory_snapshot_conflict",
    message: string,
  ) {
    super(message);
    this.name = "InventorySnapshotError";
  }
}

interface FrozenInventorySnapshot {
  entries: InventorySessionEntry[];
  expiresAt: number;
}

interface CursorPayload {
  snapshot_id: string;
  offset: number;
  proof: string;
}

export interface InventorySnapshotRequest {
  snapshot_id?: string;
  cursor?: string;
  limit?: number;
}

/**
 * A daemon-local, immutable materialization of the Paseo registry inventory.
 *
 * The snapshot id is the SHA-256 of the canonical, fully materialized entry
 * list. A cursor is HMAC-bound and names both that id and an
 * absolute offset, so it cannot be moved to another snapshot or forged into a
 * different position. Snapshot entries are cloned before storage: later
 * lifecycle mutations cannot change a page already belonging to this snapshot.
 */
export class InventorySnapshotService {
  private readonly snapshots = new Map<string, FrozenInventorySnapshot>();
  private readonly cursorSecret = randomBytes(32).toString("base64url");

  constructor(
    private readonly captureEntries: () => InventorySessionEntry[],
    private readonly now: () => number = Date.now,
    private readonly ttlMs = DEFAULT_SNAPSHOT_TTL_MS,
  ) {}

  page(request: InventorySnapshotRequest): InventorySnapshotPage {
    this.removeExpiredSnapshots();
    const limit = this.normalizeLimit(request.limit);
    const hasSnapshotId = request.snapshot_id !== undefined;
    const hasCursor = request.cursor !== undefined;
    if (hasSnapshotId !== hasCursor) {
      throw new InventorySnapshotError(
        "invalid_inventory_cursor",
        "inventory snapshot_id and cursor must be supplied together after the first page",
      );
    }

    if (!hasSnapshotId) {
      const entries = this.freezeAndValidate(this.captureEntries());
      const snapshotId = this.snapshotId(entries);
      this.snapshots.set(snapshotId, { entries, expiresAt: this.now() + this.ttlMs });
      return this.buildPage(snapshotId, entries, 0, limit);
    }

    const snapshotId = request.snapshot_id!;
    const cursor = this.decodeCursor(request.cursor!);
    if (cursor.snapshot_id !== snapshotId) {
      throw new InventorySnapshotError(
        "inventory_cursor_snapshot_mismatch",
        "inventory cursor belongs to a different snapshot_id",
      );
    }
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) {
      throw new InventorySnapshotError(
        "inventory_snapshot_expired",
        "inventory snapshot has expired or is unknown",
      );
    }
    if (snapshot.expiresAt <= this.now()) {
      this.snapshots.delete(snapshotId);
      throw new InventorySnapshotError(
        "inventory_snapshot_expired",
        "inventory snapshot has expired",
      );
    }
    if (cursor.offset <= 0 || cursor.offset >= snapshot.entries.length) {
      throw new InventorySnapshotError(
        "invalid_inventory_cursor",
        "inventory cursor offset is invalid",
      );
    }
    return this.buildPage(snapshotId, snapshot.entries, cursor.offset, limit);
  }

  private normalizeLimit(limit: number | undefined): number {
    if (limit === undefined) return DEFAULT_PAGE_LIMIT;
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_PAGE_LIMIT) {
      throw new InventorySnapshotError(
        "invalid_inventory_cursor",
        `inventory page limit must be an integer between 1 and ${MAX_PAGE_LIMIT}`,
      );
    }
    return limit;
  }

  private buildPage(
    snapshotId: string,
    entries: InventorySessionEntry[],
    offset: number,
    limit: number,
  ): InventorySnapshotPage {
    const pageEntries = entries.slice(offset, offset + limit);
    const nextOffset = offset + pageEntries.length;
    const hasMore = nextOffset < entries.length;
    return {
      schema_version: INVENTORY_SCHEMA_VERSION,
      snapshot_id: snapshotId,
      entries: structuredClone(pageEntries),
      next_cursor: hasMore ? this.encodeCursor(snapshotId, nextOffset) : null,
      has_more: hasMore,
    };
  }

  private freezeAndValidate(entries: InventorySessionEntry[]): InventorySessionEntry[] {
    const byIdentity = new Set<string>();
    const frozen = entries
      .map((entry) => structuredClone(entry))
      .sort((left, right) => left.native_id.localeCompare(right.native_id));
    for (const entry of frozen) {
      if (
        !entry.native_id ||
        !entry.provider ||
        !entry.status_raw ||
        Number.isNaN(Date.parse(entry.created_at)) ||
        Number.isNaN(Date.parse(entry.updated_at))
      ) {
        throw new InventorySnapshotError(
          "inventory_snapshot_conflict",
          "inventory source returned a malformed session entry",
        );
      }
      const identity = `${entry.backend}\u0000${entry.native_id}`;
      if (byIdentity.has(identity)) {
        throw new InventorySnapshotError(
          "inventory_snapshot_conflict",
          `duplicate canonical inventory identity: ${entry.backend}/${entry.native_id}`,
        );
      }
      byIdentity.add(identity);
    }
    return frozen;
  }

  private snapshotId(entries: InventorySessionEntry[]): string {
    const canonical = JSON.stringify({ schema_version: INVENTORY_SCHEMA_VERSION, entries });
    return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
  }

  private encodeCursor(snapshotId: string, offset: number): string {
    const proof = this.cursorProof(snapshotId, offset);
    return Buffer.from(JSON.stringify({ snapshot_id: snapshotId, offset, proof })).toString(
      "base64url",
    );
  }

  private decodeCursor(cursor: string): CursorPayload {
    try {
      const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as CursorPayload).snapshot_id !== "string" ||
        !Number.isInteger((parsed as CursorPayload).offset) ||
        typeof (parsed as CursorPayload).proof !== "string"
      ) {
        throw new Error("invalid shape");
      }
      const payload = parsed as CursorPayload;
      if (payload.proof !== this.cursorProof(payload.snapshot_id, payload.offset)) {
        throw new Error("invalid proof");
      }
      return payload;
    } catch {
      throw new InventorySnapshotError("invalid_inventory_cursor", "inventory cursor is invalid");
    }
  }

  private cursorProof(snapshotId: string, offset: number): string {
    return createHmac("sha256", this.cursorSecret)
      .update(`${snapshotId}\u0000${offset}`)
      .digest("base64url");
  }

  private removeExpiredSnapshots(): void {
    const now = this.now();
    for (const [snapshotId, snapshot] of this.snapshots) {
      if (snapshot.expiresAt <= now) {
        this.snapshots.delete(snapshotId);
      }
    }
  }
}
