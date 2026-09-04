#!/usr/bin/env bash
#
# Harnet live end-to-end run - the control service driving a real agent.
#
# live-spike.sh proved the raw chain (tmux -> send-keys -> hook -> jsonl).
# This one proves the service on top of it: a real queue, result registry,
# control service and the real claude adapter, with nothing mocked. The job
# goes in through service.submitGroup and comes back out as a wake-up message.
#
#   scripts/live-e2e.sh                 # run it
#   KEEP=1 scripts/live-e2e.sh          # leave the tmux session open to inspect
#   SIGNAL_TIMEOUT=300 scripts/live-e2e.sh
#
# Manual only. It opens a real TUI, spends real tokens and needs a logged-in
# claude, so it is NOT part of `npm test` and must never be wired into CI.
#
# Isolation: its own tmux socket (-L harnet-e2e) and a throwaway git repo under
# $TMPDIR. The user's tmux server, repos and ~/.claude settings are untouched -
# the Stop hook lives in the throwaway repo's own .claude/settings.json.
#
# This script only builds that environment; every harnet decision is made by
# scripts/live-e2e.mjs, which imports src/ directly.

set -uo pipefail

SOCKET="${HARNET_E2E_SOCKET:-harnet-e2e}"
AGENT="${HARNET_E2E_AGENT:-e2e}"
TMUX_="tmux -L $SOCKET"
KEEP="${KEEP:-0}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/harnet-live-e2e-XXXXXX")"
WORKTREE="$RUN_ROOT/agent-wt"
STOP="$RUN_ROOT/stop.jsonl"
NOTIFY="$RUN_ROOT/notification.jsonl"

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
fail() { printf '\n\033[1;31mBLOCKED: %s\033[0m\n' "$*" >&2; exit 1; }

cleanup() {
  if [ "$KEEP" = "1" ]; then
    say "KEEP=1: session left alive on socket '$SOCKET'"
    $TMUX_ ls 2>&1 | sed 's/^/   /'
    info "attach with: tmux -L $SOCKET attach -t harnet-$AGENT"
    info "kill with:   tmux -L $SOCKET kill-server"
  else
    $TMUX_ kill-server >/dev/null 2>&1
  fi
  info "evidence kept at: $RUN_ROOT"
}
trap cleanup EXIT

say "harnet live e2e - socket '$SOCKET', evidence in $RUN_ROOT"

# ------------------------------------------------------------------ preflight
say "preflight"
missing=0
for bin in tmux node git claude; do
  if command -v "$bin" >/dev/null 2>&1; then
    printf '   found %-8s %s\n' "$bin" "$(command -v "$bin")"
  else
    printf '   MISSING: %s\n' "$bin" >&2
    missing=1
  fi
done
[ "$missing" = "0" ] || fail "missing prerequisites (see above)"
printf '   tmux     %s\n' "$($TMUX_ -V 2>&1)"
printf '   node     %s\n' "$(node --version)"
printf '   claude   %s\n' "$(claude --version 2>&1 | head -1)"

# ------------------------------------------------- throwaway repo + Stop hook
say "throwaway worktree + Stop hook"
mkdir -p "$WORKTREE"
git init -q "$WORKTREE" || fail "cannot git init $WORKTREE"
printf '# harnet live e2e\n' > "$WORKTREE/README.md"
git -C "$WORKTREE" add -A >/dev/null 2>&1
git -C "$WORKTREE" -c user.email=e2e@harnet -c user.name=e2e commit -qm "e2e" \
  || fail "cannot commit in $WORKTREE"

: > "$STOP"
: > "$NOTIFY"
mkdir -p "$WORKTREE/.claude"
# The Stop payload arrives on stdin; append it verbatim so the report can quote
# the real thing. Notification means the agent is waiting for a human.
cat > "$WORKTREE/.claude/settings.json" <<EOF
{
  "hooks": {
    "Stop": [
      { "matcher": "", "hooks": [ { "type": "command", "command": "cat >> '$STOP'" } ] }
    ],
    "Notification": [
      { "matcher": "", "hooks": [ { "type": "command", "command": "cat >> '$NOTIFY'" } ] }
    ]
  }
}
EOF
info "worktree:  $WORKTREE"
info "stop hook: $STOP"

# ----------------------------------------------------------- kill any leftover
$TMUX_ kill-session -t "harnet-$AGENT" >/dev/null 2>&1

# ------------------------------------------------------------------ the run
export HARNET_E2E_ROOT="$RUN_ROOT"
export HARNET_E2E_WORKTREE="$WORKTREE"
export HARNET_E2E_STOP="$STOP"
export HARNET_E2E_NOTIFY="$NOTIFY"
export HARNET_E2E_SOCKET="$SOCKET"
export HARNET_E2E_AGENT="$AGENT"
export KEEP

cd "$REPO_ROOT" || fail "cannot cd to $REPO_ROOT"
node scripts/live-e2e.mjs
status=$?

say "done"
if [ "$status" = "0" ]; then
  info "control service verified end to end against a real claude session"
else
  info "run failed; full output above"
fi
exit "$status"
