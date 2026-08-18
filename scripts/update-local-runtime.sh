#!/usr/bin/env bash
set -euo pipefail

# update-local-runtime.sh
#
# Update the canonical local Paseo runtime and, on --apply, repoint the
# global paseo shim to the freshly built canonical worktree.
#
# Defaults to dry-run.  Never restarts paseo.service.  Refuses to touch
# the shim while any Paseo session is active.

CANONICAL_WORKTREE="${CANONICAL_WORKTREE:-$HOME/worktrees/paseo-local-runtime}"
CANONICAL_BRANCH="${CANONICAL_BRANCH:-local/paseo-patched}"
SHIM_TARGET="${SHIM_TARGET:-$HOME/.local/bin/paseo}"
PASEO_HOME="${PASEO_HOME:-$HOME/.paseo}"

APPLY=0
YES=0

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red() { printf '\033[31m%s\033[0m\n' "$*" >&2; }

usage() {
  cat <<'EOF'
Usage: scripts/update-local-runtime.sh [OPTIONS]

Options:
  --apply            Actually repoint the paseo shim after verifying the build.
  --yes              Skip the interactive approval prompt (use with --apply).
  --worktree PATH    Path to the canonical Paseo runtime worktree.
  --shim PATH        Path to the global paseo binary/symlink to update.
  -h, --help         Show this help.

Examples:
  scripts/update-local-runtime.sh
  scripts/update-local-runtime.sh --apply
  scripts/update-local-runtime.sh --apply --yes
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)
      APPLY=1
      ;;
    --yes)
      YES=1
      ;;
    --worktree)
      shift
      CANONICAL_WORKTREE="$1"
      ;;
    --shim)
      shift
      SHIM_TARGET="$1"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      red "Unknown option: $1"
      usage >&2
      exit 2
      ;;
  esac
  shift
done

# 1. Verify the canonical worktree and branch.
if [[ ! -d "$CANONICAL_WORKTREE/.git" ]]; then
  red "Canonical worktree does not look like a git repository: $CANONICAL_WORKTREE"
  exit 1
fi

current_branch=$(git -C "$CANONICAL_WORKTREE" branch --show-current)
if [[ "$current_branch" != "$CANONICAL_BRANCH" ]]; then
  red "Canonical worktree is on '$current_branch', expected '$CANONICAL_BRANCH'"
  exit 1
fi

if ! git -C "$CANONICAL_WORKTREE" diff-index --quiet HEAD; then
  red "Canonical worktree has uncommitted changes. Clean before updating."
  git -C "$CANONICAL_WORKTREE" status --short >&2
  exit 1
fi

green "Canonical worktree: $CANONICAL_WORKTREE ($CANONICAL_BRANCH)"

# 2. Check for active sessions.
ls_output=$(mktemp "${TMPDIR:-/tmp}/paseo-ls.XXXXXX")
cleanup_ls() { rm -f -- "$ls_output"; }
trap cleanup_ls EXIT

cli_bin="$CANONICAL_WORKTREE/packages/cli/bin/paseo"
if [[ ! -x "$cli_bin" ]]; then
  red "Built CLI binary not found at $cli_bin"
  red "Run a build first or ensure the worktree is not a fresh checkout."
  exit 1
fi

PASEO_HOME="$PASEO_HOME" "$cli_bin" ls -a -g >"$ls_output" 2>&1 || true

if grep -Eq '(^|[[:space:]])running([[:space:]]|$)' "$ls_output"; then
  red "Active Paseo session(s) are still running. Refusing to update the runtime."
  red "Stop or wait for all agents first:"
  sed 's/^/  /' "$ls_output" >&2
  exit 1
fi

green "No active Paseo sessions."

# 3. Build and verify the runtime.
cd "$CANONICAL_WORKTREE"
green "Building runtime..."
npm run build:server

green "Running typecheck..."
npm run typecheck

green "Running lint..."
npm run lint

green "Running format check..."
npm run format:check

green "Runtime build and checks passed."

# 4. Dry-run or apply.
if [[ "$APPLY" -eq 0 ]]; then
  green "DRY-RUN: no changes written."
  green "Re-run with --apply (and --yes) to update $SHIM_TARGET."
  exit 0
fi

# 5. Approval required for --apply.
if [[ "$YES" -eq 0 ]]; then
  if [[ ! -t 0 ]]; then
    red "--apply requested without a tty. Use --yes to confirm explicitly."
    exit 1
  fi
  read -r -p "Repoint $SHIM_TARGET to $cli_bin? Type 'yes' to continue: " answer
  if [[ "$answer" != "yes" ]]; then
    red "Approval not given. Aborting."
    exit 1
  fi
fi

# 6. Update the global paseo shim.
shim_dir=$(dirname "$SHIM_TARGET")
if [[ ! -d "$shim_dir" ]]; then
  mkdir -p "$shim_dir"
fi

if [[ -e "$SHIM_TARGET" && ! -L "$SHIM_TARGET" ]]; then
  backup="$SHIM_TARGET.bak.$(date +%s)"
  green "Existing file at $SHIM_TARGET moved to $backup"
  mv "$SHIM_TARGET" "$backup"
fi

ln -sfn "$cli_bin" "$SHIM_TARGET"
green "Updated $SHIM_TARGET -> $cli_bin"
green "No daemon restart was performed."
