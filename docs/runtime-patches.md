# Local runtime patches

This document describes the canonical set of local patches maintained on the `local/paseo-patched` branch and the `~/worktrees/paseo-local-runtime` worktree. It also covers the Paseo-only runtime guard and the safe update procedure for switching the active `paseo` binary to a freshly built runtime.

## Patch inventory

| Patch                      | Source                                     | Files                                                                                                                                                                                                                                    | Problem solved                                                                                                                                              | Backward compatible                                                              |
| -------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Kimi yolo logical mode     | `13db86379`                                | `packages/server/src/server/agent/providers/*`                                                                                                                                                                                           | Preserves Paseo `yolo` when Kimi echoes the effective `auto` mode, and keeps `availableModes` correct.                                                      | Yes — no protocol change, internal provider mapping only.                        |
| Kimi yolo startup          | `2ac0c6d56`                                | `packages/server/src/server/agent/providers/kimi-acp-agent.ts`                                                                                                                                                                           | Ensures Kimi starts in `auto` when the Paseo mode is `yolo`, while preserving `availableModes`.                                                             | Yes — provider-side mapping.                                                     |
| Apify `--mcp-config`       | `f8e94ab7e` (reworded as `acf90c58f`)      | `packages/cli/src/commands/agent/run.ts`, `packages/cli/src/commands/agent/run.test.ts`, `packages/protocol/src/messages.ts`                                                                                                             | Adds `paseo run --mcp-config <path>` so callers can pass MCP server configuration to agents.                                                                | Yes — new optional flag and protocol field.                                      |
| CLI logs authorship        | `14c07b836` / `d7aab7ef2`                  | `packages/cli/src/commands/agent/logs.ts`                                                                                                                                                                                                | Adds `paseo logs --json` / `--format json` to emit the raw structured timeline, preserving provenance fields like `event_type` and `messageId`.             | Yes — new CLI flags, default text output unchanged.                              |
| Cross-home daemon shutdown | `e1c5757e5` (reimplemented as `233fb5fa8`) | `packages/cli/src/commands/daemon/local-daemon.ts`, `packages/cli/src/commands/daemon/local-daemon.stop-ownership.test.ts`                                                                                                               | Prevents `paseo daemon stop` in one `$PASEO_HOME` from sending a lifecycle shutdown to a daemon that belongs to a different `$PASEO_HOME` on the same port. | Yes — server identity check before RPC.                                          |
| Paseo-only session guard   | `36809a23c`                                | `packages/server/src/server/agent/paseo-only-guard.ts`, `packages/server/src/server/agent/create-agent/create.ts`, `packages/protocol/src/messages.ts`, `packages/client/src/daemon-client.ts`, `packages/cli/src/commands/agent/run.ts` | Central guard enforcing that every new session (agent, delivery, delegate, mission) has `backend=paseo`. No silent fallback to tmux or other runtimes.      | Yes — `backend`/`category` are optional and default to Paseo for older clients.  |
| YOLO-by-default mode       | `a2ce3628f`                                | `packages/server/src/server/agent/paseo-yolo-guard.ts`, `packages/server/src/server/agent/create-agent-mode.ts`                                                                                                                          | Every new session defaults to `yolo` mode when the provider supports it; legacy aliases like `default`/`smart` are normalized to `yolo`.                    | Yes — provider-aware, falls back to provider default when `yolo` is unavailable. |

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
