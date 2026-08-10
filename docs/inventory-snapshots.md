# Inventory snapshots

`inventory.sessions.request` is the read-only inventory API for a controller
that must prove it enumerated every Paseo session in one daemon. It is not the
UI directory API and must not be replaced with `fetch_agents_request` or
`paseo ls`.

## Scope

One initial request has the fixed scope `all/global`: every record known to the
daemon's canonical `AgentManager` and `$PASEO_HOME/agents/` registry. This
includes running, initializing, idle, error, closed, archived, internal, and
providers which are unavailable to the normal client directory. Project
placement, active-workspace scope, provider visibility, and persisted-provider
availability do not filter this inventory.

The returned identity is `backend: "paseo"` plus `native_id`, the Paseo daemon
agent UUID. A multi-host controller supplies its configured source/host when it
forms its frozen `(source, backend, native_id)` identity; `native_id` alone is
not cross-daemon identity. `persistence_session_id` is correlation metadata for
the provider session, not a replacement identity.

The daemon refuses the whole inventory if the persistent registry contains a
malformed JSON record, a duplicate agent id, or a conflicting live/persisted
provider. Those are explicit `rpc_error`s, never omitted rows.

## Snapshot and pagination semantics

The API uses materialized snapshot semantics. At the first page the daemon reads
the manager and registry synchronously in one event-loop turn, validates the
union, sorts it by `native_id`, deep-clones the full entries, and retains that
immutable materialization for ten minutes. `snapshot_id` is the SHA-256 digest
of its schema version and canonical complete entry list. It therefore names a
specific enumerated set, not a request time or an arbitrary UUID.

Every continuation sends both `snapshot_id` and `cursor`. The cursor is
daemon-secret-bound to that snapshot and its absolute next offset. It cannot be
used with another snapshot, changed into a different offset, or loop back to
the first page. Page size is 1–200, ordering is deterministic, and only
`has_more: false` proves the end. Replaying a valid snapshot/cursor pair returns
the same page. A missing, malformed, foreign, looping, or expired cursor yields
an explicit `rpc_error`; expiration is `inventory_snapshot_expired`.

Later creation, deletion, lifecycle change, or archiving does not alter an
existing snapshot. It appears in the next snapshot instead. The capability has
no lifecycle, prompt, registry-write, provider, or recovery call path.

## Wire contract

Start an enumeration:

```json
{
  "type": "inventory.sessions.request",
  "requestId": "inventory-1",
  "limit": 200
}
```

Continue it with the returned values:

```json
{
  "type": "inventory.sessions.request",
  "requestId": "inventory-2",
  "snapshot_id": "sha256:…",
  "cursor": "…",
  "limit": 200
}
```

```json
{
  "type": "inventory.sessions.response",
  "payload": {
    "requestId": "inventory-1",
    "schema_version": "paseo.inventory_sessions.v1",
    "snapshot_id": "sha256:…",
    "entries": [
      {
        "backend": "paseo",
        "native_id": "6e77c819-…",
        "provider": "claude",
        "status_raw": "closed",
        "archived": true,
        "archived_at": "2026-08-10T12:00:00.000Z",
        "internal": false,
        "cwd": "/work/project",
        "created_at": "2026-08-01T12:00:00.000Z",
        "updated_at": "2026-08-10T12:00:00.000Z",
        "persistence_session_id": "provider-session-id"
      }
    ],
    "next_cursor": null,
    "has_more": false
  }
}
```

The CLI exposes the same one-page contract as `paseo inventory sessions --json`
and accepts `--snapshot-id`, `--cursor`, and `--limit` for continuation.
