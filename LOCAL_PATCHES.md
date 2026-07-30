# Local Patches — Paseo

This fork (`frontend-london/paseo`) carries local patches on top of upstream
`getpaseo/paseo`. The production branch is **`patched-main`**, not `main`.

---

## Active patches

### ACP crash recovery — bounded attach RPCs

**Problem:** SDK ACP nie rozlicza pending attach RPC po zamknięciu transportu.
Jeżeli proces ACP zginie w trakcie `session/load`, `session/new`,
`unstable_resumeSession` lub runtime override RPC, attach może wisieć bez końca.
Powiązany Promise nigdy nie zostaje ani spełniony (`resolved`), ani odrzucony
(`rejected`). Prowadzi to do nierozliczonego `respawnPromise` i trwałego
blokowania `ensureProcess()`.

**Fix:** Wspólny mechanizm `runAttachRequest` — każde attach RPC jest wykonywane
w wyścigu (`Promise.race`) z `connection.closed`, z timeoutem i anulowaniem przez
`close()`. Pełny cleanup childa i managed process ledger po porażce. Poprawny
retry po nieudanym attachu.

**Patch commits (12):**

```
8fe9063c6 fix(server): route ACP config modes via config options
58d4fab0b fix(server): map bypassPermissions to OpenCode build + Devin SWE system prompt
6e00ac0a7 style(server): apply oxfmt to acp-agent files
75a10b182 test(server): add failing ACP process crash recovery tests
a6b379c29 fix(server): recover ACP sessions from unexpected agent process exits
6718e47bf feat(server): register ACP agent process PIDs in the managed process ledger
d04f876d7 fix(server): reap ACP orphans whose process rewrote its command line
a6ebefe69 test(server): add regression tests for ACP crash recovery review findings
2401a542d fix(server): harden ACP crash recovery for runtime state, transport loss, and cancel/close races
8e49252df feat(server): harden managed process identity and daemon ownership in the ledger
ee82b31bd fix(server): bound ACP initialize and shutdown cleanup
76ae7d77e fix(server): bound ACP session-attach RPCs so a hung session/load cannot deadlock respawn
```

**Tag:** `local-crash-recovery-v1`

**Upstream PR:** https://github.com/getpaseo/paseo/pull/2633

---

## Branch layout

```
upstream/main  →  patched-main (12 patch commits on top)
                      ↑
                   origin/patched-main (fork: frontend-london/paseo)
```

- `upstream` → `getpaseo/paseo` (read-only, never push here)
- `origin` → `frontend-london/paseo` (your fork, push here)
- `patched-main` → production branch, always = upstream/main + local patches
- `fix/acp-process-crash-recovery` → PR branch for upstream submission

---

## Update procedure

```bash
scripts/update-patched-paseo.sh --force-push
```

The script:

1. Fetches latest `upstream/main`.
2. Rebases `patched-main` onto it (stops on conflicts).
3. Runs typecheck + ACP tests.
4. Rebuilds server dist.
5. Re-links `@getpaseo/server` into the global CLI.
6. Force-pushes `patched-main` to `origin` with `--force-with-lease`.
7. **Does not deploy if tests fail.**

After a successful update, restart the daemon:

```bash
paseo daemon stop
paseo start --foreground   # or via autostart.sh / tmux
```

---

## Recovery after a rebase conflict

If the update script exits with code 2:

```bash
# 1. Inspect conflicted files
git status

# 2. Resolve each conflict manually
#    Keep BOTH upstream changes and patch functionality.
#    Key files: packages/server/src/server/agent/providers/acp-agent.ts

# 3. Stage resolved files
git add <resolved-files>

# 4. Continue the rebase
scripts/update-patched-paseo.sh --continue

# 5. If tests pass, push
scripts/update-patched-paseo.sh --force-push
```

If the rebase is beyond repair:

```bash
git rebase --abort
git reset --hard origin/patched-main   # back to last known good
```

---

## Check if upstream already includes the patch

If the fix is merged upstream, the local patch becomes redundant. Check:

```bash
# Search for the key mechanism in upstream/main
git log --oneline upstream/main --grep="runAttachRequest"
git log --oneline upstream/main --grep "session-attach"
git log --oneline upstream/main --grep "crash recovery"

# Or check if the code already has the fix
git show upstream/main:packages/server/src/server/agent/providers/acp-agent.ts | grep -c "runAttachRequest"
# 0 = not merged, >0 = merged
```

---

## Remove local patch after upstream merge

Once the fix is in `upstream/main`:

```bash
# 1. Fast-forward patched-main to upstream/main (drop all local commits)
git checkout patched-main
git reset --hard upstream/main

# 2. Force-push the clean state
git push origin patched-main --force-with-lease

# 3. Delete the tag
git tag -d local-crash-recovery-v1

# 4. Update this document — remove the patch section.
```

---

## Production setup

The daemon runs from the global `@getpaseo/cli` install, with `@getpaseo/server`
npm-linked to this repo's `packages/server/dist`:

```
~/.local/bin/paseo
  → ~/.local/lib/node_modules/@getpaseo/cli
    → node_modules/@getpaseo/server (symlink)
      → /home/piotr/projects/paseo-v0104-bypass-patch/packages/server/dist
```

Autostart: `~/.paseo/autostart.sh` calls `paseo start --foreground`.

After each update, the dist is rebuilt and re-linked automatically by the
update script. A daemon restart picks up the new code.
