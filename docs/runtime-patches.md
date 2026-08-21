# Local runtime patches

This document describes the canonical set of local patches maintained on the `local/paseo-patched` branch and the `~/worktrees/paseo-local-runtime` worktree. It also covers the Paseo-only runtime guard and the safe update procedure for switching the active `paseo` binary to a freshly built runtime.

## Patch inventory

| Patch                          | Source                                                                                                 | Files                                                                                                                                                                                                                                                                                                                                                                       | Problem solved                                                                                                                                                                                                                                                                                                                   | Backward compatible                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Kimi yolo logical mode         | `13db86379`                                                                                            | `packages/server/src/server/agent/providers/*`                                                                                                                                                                                                                                                                                                                              | Preserves Paseo `yolo` when Kimi echoes the effective `auto` mode, and keeps `availableModes` correct.                                                                                                                                                                                                                           | Yes — no protocol change, internal provider mapping only.                                                                         |
| Kimi yolo startup              | `2ac0c6d56`                                                                                            | `packages/server/src/server/agent/providers/kimi-acp-agent.ts`                                                                                                                                                                                                                                                                                                              | Ensures Kimi starts in `auto` when the Paseo mode is `yolo`, while preserving `availableModes`.                                                                                                                                                                                                                                  | Yes — provider-side mapping.                                                                                                      |
| Apify `--mcp-config`           | `f8e94ab7e` (reworded as `acf90c58f`)                                                                  | `packages/cli/src/commands/agent/run.ts`, `packages/cli/src/commands/agent/run.test.ts`, `packages/protocol/src/messages.ts`                                                                                                                                                                                                                                                | Adds `paseo run --mcp-config <path>` so callers can pass MCP server configuration to agents.                                                                                                                                                                                                                                     | Yes — new optional flag and protocol field.                                                                                       |
| CLI logs authorship            | `14c07b836` / `d7aab7ef2`                                                                              | `packages/cli/src/commands/agent/logs.ts`                                                                                                                                                                                                                                                                                                                                   | Adds `paseo logs --json` / `--format json` to emit the raw structured timeline, preserving provenance fields like `event_type` and `messageId`.                                                                                                                                                                                  | Yes — new CLI flags, default text output unchanged.                                                                               |
| Cross-home daemon shutdown     | `e1c5757e5` (reimplemented as `233fb5fa8`)                                                             | `packages/cli/src/commands/daemon/local-daemon.ts`, `packages/cli/src/commands/daemon/local-daemon.stop-ownership.test.ts`                                                                                                                                                                                                                                                  | Prevents `paseo daemon stop` in one `$PASEO_HOME` from sending a lifecycle shutdown to a daemon that belongs to a different `$PASEO_HOME` on the same port.                                                                                                                                                                      | Yes — server identity check before RPC.                                                                                           |
| Paseo-only session guard       | `36809a23c`                                                                                            | `packages/server/src/server/agent/paseo-only-guard.ts`, `packages/server/src/server/agent/create-agent/create.ts`, `packages/protocol/src/messages.ts`, `packages/client/src/daemon-client.ts`, `packages/cli/src/commands/agent/run.ts`                                                                                                                                    | Central guard enforcing that every new session (agent, delivery, delegate, mission) has `backend=paseo`. No silent fallback to tmux or other runtimes.                                                                                                                                                                           | Yes — `backend`/`category` are optional and default to Paseo for older clients.                                                   |
| YOLO-by-default mode           | `a2ce3628f`                                                                                            | `packages/server/src/server/agent/paseo-yolo-guard.ts`, `packages/server/src/server/agent/create-agent-mode.ts`                                                                                                                                                                                                                                                             | Every new session defaults to `yolo` mode when the provider supports it; legacy aliases like `default`/`smart` are normalized to `yolo`.                                                                                                                                                                                         | Yes — provider-aware, falls back to provider default when `yolo` is unavailable.                                                  |
| Daemon lifecycle approval gate | `d5b4f6b1a` / `402762ae2` (cherry-picked from `feat/daemon-lifecycle-approval-gate`, base `c6df5ffd4`) | `packages/server/src/server/agent/daemon-lifecycle-gate.ts`, `packages/server/src/server/agent/lifecycle-resume{,-manifest}.ts`, `packages/cli/src/commands/daemon/{local-daemon,lifecycle-approval,restart,stop,start}.ts`, `packages/server/src/server/{session,bootstrap,daemon-worker}.ts`, `packages/client/src/daemon-client.ts`, `packages/protocol/src/messages.ts` | Requires operator approval before an agent-initiated `paseo daemon stop\|restart` can touch the shared daemon; snapshots and gracefully interrupts active sessions first, then auto-resumes them once the daemon is back. Human-terminal `paseo daemon stop\|restart` is unaffected. See "Daemon lifecycle approval gate" below. | Yes — gate only applies to connections whose hello handshake carries an `agentId`; human/UI connections behave exactly as before. |
| Workspace id in CLI output     | `25fc6ef44`                                                                                            | `packages/cli/src/commands/agent/{ls,inspect}.ts`                                                                                                                                                                                                                                                                                                                           | Exposes `workspaceId` / `WorkspaceId` in `paseo ls --json` and `paseo inspect`, so a caller can tell which workspace owns a session and archive the workspace once its last agent is gone (ACP `archive_agent` sidebar cleanup).                                                                                                 | Yes — additive output field; existing parsers ignore it.                                                                          |

## Canonical worktree and branch

- **Branch:** `local/paseo-patched`
- **Worktree:** `~/worktrees/paseo-local-runtime`
- **Base:** `b44bb63cf chore(release): cut 0.4.0`
- **Tip:** the latest commit on `local/paseo-patched`

The branch is the source of truth. New runtime fixes should be applied as clean, separate commits on top of it. The `paseo` binary in `~/.local/bin` is repointed to `packages/cli/bin/paseo` inside this worktree only through the update script.

## Paseo-only runtime guard

The backend guard lives in `packages/server/src/server/agent/paseo-only-guard.ts` and is invoked at the top of `createAgentCommand`, the single point where every agent session is created in the daemon.

Behavior:

- All new sessions must declare `backend: "paseo"`.
- Categories covered: `agent`, `delivery`, `delegate`, `mission`.
- A missing `backend` is treated as Paseo for backward compatibility.
- Any other explicit backend (for example `tmux`) throws `PaseoOnlyGuardError` and the session start is rejected.
- There is no silent fallback to tmux. If Paseo is unavailable, the start fails with an error.

The mode guard lives in `packages/server/src/server/agent/paseo-yolo-guard.ts` and is applied by `resolveAndValidateCreateAgentMode`.

Behavior:

- A missing, empty, `default`, or `smart` mode is normalized to `yolo` when the target provider exposes `yolo`.
- Explicit concrete modes (e.g. `plan`, `auto`, `bypassPermissions`) are preserved.
- If the provider does not support `yolo`, the provider's own default is used.

### Contract for external callers

External session-start callers, including the Agents Control Plane (ACP), must set the `backend` and `category` fields when creating a session. The CLI and the in-process MCP tools already set `backend: "paseo"`. ACP integration requiring these fields is a separate follow-up in the `~/projects/agents-control-plane` repository.

## Daemon lifecycle approval gate

Cherry-picked from `feat/daemon-lifecycle-approval-gate` (base `c6df5ffd4`, commits `d5b4f6b1a` / `402762ae2`) after an incident where an unrelated agent ran `paseo daemon stop && paseo daemon start` on the shared daemon and unconditionally killed every active session.

Behavior:

- **Agent-originated `paseo daemon stop|restart`** (the CLI's own process has `$PASEO_AGENT_ID` set, injected by the daemon into every agent's process env) blocks and waits for an operator Approve/Deny on the normal permission-request UI before doing anything. Deny raises `DaemonLifecycleDeniedError`; the daemon is never touched.
- **Human-terminal `paseo daemon stop|restart`** (no `$PASEO_AGENT_ID` in the invoking process's env) is completely unaffected — no approval, no behavior change from before this patch.
- The gate is also enforced at the RPC layer (`shutdown_server_request` / `restart_server_request` in `session.ts`), independent of the CLI: any connection whose hello handshake carried an `agentId` must present a valid, unconsumed, operation-and-agent-scoped authorization token, or the RPC is rejected with `lifecycle_approval_required`. This still composes with the pre-existing cross-home identity check (`getOrCreateServerId`/`getLastServerInfoMessage`) — that check runs first and independently refuses to touch a daemon belonging to a different `$PASEO_HOME`.
- Approval tokens are one-shot (consumed on first successful validation), scoped to the exact `operationId` + `agentId` + `operation` (`stop` vs `restart` are distinct — a restart approval cannot be replayed against a stop, or vice versa), and expire after 5 minutes.
- On approval, the initiating agent's own CLI subprocess re-execs itself as a `setsid`-detached clone (carrying the already-granted authorization via a short-lived env var, never persisted to disk) before doing the actual shutdown — this is what survives the daemon's own session teardown killing the invoking process tree via SIGHUP. The parent CLI invocation returns `handed_off` immediately.
- Before any shutdown/restart (agent-approved or human-initiated), every session with an active turn is snapshotted to a resume manifest, then gracefully interrupted. The initiating agent's own session is excluded from _this_ process's interrupt pass (it's still recorded in the manifest) so its detached clone can finish independently.
- On the next daemon startup, `resumePendingLifecycleManifests` drains any pending manifest and re-injects a system continuation notice into each affected session's provider connection — not a synthetic user message. Each manifest entry is marked `resumed` or `failed_to_resume` individually and atomically, so a crash mid-resume just picks up where it left off, and one failed resume never blocks the others.

Manifest location: `$PASEO_HOME/daemon-lifecycle/<operationId>.json` while pending; moved to `$PASEO_HOME/daemon-lifecycle/archived/<operationId>.json` once every entry is terminal.

Troubleshooting a failed resume:

1. Check `$PASEO_HOME/daemon-lifecycle/archived/` for the operation's manifest — entries with `status: "failed_to_resume"` name the affected `agentId`.
2. Check the daemon log around startup for `"Failed to auto-resume agent after daemon lifecycle operation"`.
3. The session itself is not lost — reconnect to it normally (`paseo attach <agentId>` / the app); the failure only means the automatic continuation notice wasn't delivered, not that the underlying session state was dropped.

Known limitation: `paseo daemon start` cannot be gated the same way, because there is no live daemon to attach a pending-approval request to. An agent-originated `start` against a fully-down daemon fails closed with an error asking the operator to start it manually; the subsequent startup recovery (manifest drain + auto-resume) then runs normally regardless of who started the daemon.

Rollback: revert commits `d5b4f6b1a` and `402762ae2` (in that order, most-recent-first) on `local/paseo-patched`, rebuild, and re-run `scripts/update-local-runtime.sh --apply`. No persisted state format changes survive a revert — the resume manifest directory is additive and simply stops being written/read.

## Update procedure

Use `scripts/update-local-runtime.sh` to build and optionally repoint the global `paseo` binary to the canonical worktree.

```bash
# Dry run — build, typecheck, lint, format check, but do not touch the shim.
scripts/update-local-runtime.sh

# Apply with interactive approval.
scripts/update-local-runtime.sh --apply

# Apply non-interactively (only when approval is already explicit).
scripts/update-local-runtime.sh --apply --yes
```

Safety rules:

1. The script aborts if `paseo ls -a -g` shows any session with status `running`.
2. The script verifies the worktree is on `local/paseo-patched` and has no uncommitted changes.
3. The script runs `build:server`, `typecheck`, `lint`, and `format:check` before touching the shim.
4. Without `--apply`, the script never writes the shim.
5. With `--apply` but without `--yes`, the script prompts for explicit confirmation.
6. The script never restarts `paseo.service` or the daemon on port 6767.

## Deployment readiness

The runtime is ready to become the active `paseo` binary when:

- `npm run typecheck`, `npm run lint`, and `npm run format:check` pass.
- The targeted test files pass.
- No active sessions are running.
- `scripts/update-local-runtime.sh --apply` is run with approval.
