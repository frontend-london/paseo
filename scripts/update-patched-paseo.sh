#!/usr/bin/env bash
#
# update-patched-paseo.sh — rebase local ACP crash recovery patch onto latest upstream
#
# Usage: scripts/update-patched-paseo.sh [--force-push]
#
# What it does:
#   1. Fetches latest upstream (getpaseo/paseo).
#   2. Rebases patched-main onto upstream/main.
#   3. Stops on conflicts for manual resolution.
#   4. Runs typecheck + ACP tests.
#   5. Rebuilds the server dist.
#   6. Force-pushes patched-main to origin (fork) with --force-with-lease.
#   7. Does NOT install or deploy if tests fail.
#
# Exit codes:
#   0 — success, patched-main is up to date and tested
#   1 — test/typecheck failure, do not deploy
#   2 — rebase conflict, resolve manually then re-run with --continue
#   3 — prerequisite error (wrong branch, dirty tree, missing remote)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

FORCE_PUSH=false
CONTINUE=false

for arg in "$@"; do
  case "$arg" in
    --force-push) FORCE_PUSH=true ;;
    --continue)   CONTINUE=true ;;
    --help|-h)
      echo "Usage: $0 [--force-push] [--continue]"
      echo ""
      echo "  --force-push   Force-push rebased patched-main to origin (fork)."
      echo "  --continue     Continue after manually resolving a rebase conflict."
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 3
      ;;
  esac
done

# ── Prerequisites ──────────────────────────────────────────────

if ! git remote get-url upstream >/dev/null 2>&1; then
  echo "ERROR: 'upstream' remote not configured." >&2
  echo "  git remote add upstream https://github.com/getpaseo/paseo.git" >&2
  exit 3
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "ERROR: 'origin' remote not configured." >&2
  echo "  origin should point to your fork." >&2
  exit 3
fi

CURRENT_BRANCH="$(git branch --show-current)"

if [ "$CONTINUE" = false ]; then
  if [ "$CURRENT_BRANCH" != "patched-main" ]; then
    echo "ERROR: not on patched-main (currently on $CURRENT_BRANCH)." >&2
    echo "  git checkout patched-main" >&2
    exit 3
  fi

  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "ERROR: working tree is dirty. Commit or stash first." >&2
    exit 3
  fi
fi

# ── Step 1: Fetch upstream ─────────────────────────────────────

echo "=== Fetching upstream ==="
git fetch upstream --prune
UPSTREAM_MAIN="$(git rev-parse upstream/main)"
echo "upstream/main is at $UPSTREAM_MAIN"

# ── Step 2: Check if already up to date ────────────────────────

MERGE_BASE="$(git merge-base patched-main upstream/main)"
if [ "$MERGE_BASE" = "$UPSTREAM_MAIN" ] && [ "$CONTINUE" = false ]; then
  echo "patched-main is already up to date with upstream/main."
else
  if [ "$CONTINUE" = true ]; then
    echo "=== Continuing rebase ==="
    if ! GIT_EDITOR=true git rebase --continue 2>&1; then
      echo "" >&2
      echo "CONFLICT: resolve manually, then run:" >&2
      echo "  $0 --continue" >&2
      exit 2
    fi
  else
    # ── Step 3: Rebase ─────────────────────────────────────────
    echo "=== Rebasing patched-main onto upstream/main ==="

    # Find the fork point: the oldest patch commit on patched-main
    # (all commits after the upstream/main merge-base are local patches)
    PATCH_BASE="$(git log --reverse --format='%H' "$MERGE_BASE..patched-main" | head -1)"

    if ! git rebase --onto upstream/main "$MERGE_BASE" patched-main 2>&1; then
      echo "" >&2
      echo "CONFLICT: rebase stopped. Resolve conflicts, then run:" >&2
      echo "  $0 --continue" >&2
      exit 2
    fi
  fi

  echo "Rebase complete."
  echo ""
  echo "Patch commits on top of upstream/main:"
  git log --oneline upstream/main..patched-main
fi

# ── Step 4: Typecheck + ACP tests ──────────────────────────────

echo ""
echo "=== Building server ==="
if ! (cd "$REPO_ROOT" && npm run build:server > /tmp/update-patched-build.log 2>&1); then
  echo "BUILD FAILED. See /tmp/update-patched-build.log" >&2
  exit 1
fi
echo "Build OK."

echo ""
echo "=== Typecheck (server) ==="
if ! (cd "$REPO_ROOT/packages/server" && npx tsgo --noEmit > /tmp/update-patched-typecheck.log 2>&1); then
  echo "TYPECHECK FAILED. See /tmp/update-patched-typecheck.log" >&2
  echo "Check if failures are pre-existing or introduced by the rebase." >&2
  exit 1
fi
echo "Typecheck OK."

echo ""
echo "=== ACP tests ==="
if ! (cd "$REPO_ROOT/packages/server" && npx vitest run \
    src/server/agent/providers/acp-agent.test.ts \
    src/server/agent/providers/acp-agent.initialize-hang.test.ts \
    --bail=1 --reporter=verbose > /tmp/update-patched-acp-tests.log 2>&1); then
  echo "ACP TESTS FAILED. See /tmp/update-patched-acp-tests.log" >&2
  echo "DO NOT DEPLOY. Investigate before proceeding." >&2
  exit 1
fi
echo "ACP tests PASS."

# ── Step 5: Re-link server (in case dist path changed) ─────────

echo ""
echo "=== Re-linking @getpaseo/server ==="
GLOBAL_CLI_DIR="$(npm root -g 2>/dev/null || echo "$HOME/.local/lib/node_modules")/@getpaseo/cli"
if [ -d "$GLOBAL_CLI_DIR" ]; then
  (cd "$GLOBAL_CLI_DIR" && npm link @getpaseo/server 2>/dev/null) || true
  echo "Server linked to $REPO_ROOT/packages/server/dist"
else
  echo "WARNING: global CLI not found at $GLOBAL_CLI_DIR — skip re-link." >&2
fi

# ── Step 6: Force-push to origin (fork) ────────────────────────

if [ "$FORCE_PUSH" = true ]; then
  echo ""
  echo "=== Pushing patched-main to origin (fork) ==="
  git push origin patched-main --force-with-lease
  echo "Pushed."
else
  echo ""
  echo "Skipping push (use --force-push to push to origin)."
fi

# ── Done ───────────────────────────────────────────────────────

echo ""
echo "=== Update complete ==="
echo "  patched-main:  $(git rev-parse patched-main)"
echo "  upstream/main: $UPSTREAM_MAIN"
echo "  patch commits: $(git rev-list --count upstream/main..patched-main)"
echo ""
echo "To deploy: restart the Paseo daemon."
echo "  paseo daemon stop && paseo start --foreground"
echo "  (or restart via autostart.sh / tmux)"
