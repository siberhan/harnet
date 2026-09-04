#!/usr/bin/env bash
#
# Harnet live end-to-end run - the control service driving a real agent.
#
# live-spike.sh proved the raw chain (tmux -> send-keys -> hook -> jsonl).
# This one proves the service on top of it: a real queue, result registry,
# control service and a real adapter, with nothing mocked. The job goes in
# through service.submitGroup and comes back out as a wake-up message.
#
#   scripts/live-e2e.sh                 # claude (default)
#   scripts/live-e2e.sh codex           # codex
#   KEEP=1 scripts/live-e2e.sh          # leave the tmux session open to inspect
#   DRY_BOOT=1 scripts/live-e2e.sh codex  # boot only: no prompt, no tokens
#   SIGNAL_TIMEOUT=300 scripts/live-e2e.sh
#
# Manual only. It opens a real TUI, spends real tokens and needs a logged-in
# harness, so it is NOT part of `npm test` and must never be wired into CI.
# DRY_BOOT=1 is the cheap half: it proves spawn + dialogs + readiness without
# ever sending a prompt, which matters when a harness has a weekly quota.
#
# Isolation: its own tmux socket (-L harnet-e2e) and a throwaway git repo under
# $TMPDIR. The user's tmux server and repos are untouched, and so are their
# global harness settings - the completion signal is configured per run:
#   claude: a Stop hook in the throwaway repo's own .claude/settings.json
#   codex:  a notify program passed as `-c notify=[...]` on the command line
#
# This script only builds that environment; every harnet decision is made by
# scripts/live-e2e.mjs, which imports src/ directly.

set -uo pipefail

HARNESS="${1:-claude}"
case "$HARNESS" in
  claude|codex) ;;
  *) echo "usage: $0 [claude|codex]" >&2; exit 2 ;;
esac

SOCKET="${HARNET_E2E_SOCKET:-harnet-e2e}"
AGENT="${HARNET_E2E_AGENT:-e2e}"
TMUX_="tmux -L $SOCKET"
KEEP="${KEEP:-0}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/harnet-live-e2e-XXXXXX")"
WORKTREE="$RUN_ROOT/agent-wt"
# Where the harness writes its completion signal: the Stop hook's stdin for
# claude, the notify program's argv[1] for codex. One file either way.
SIGNAL="$RUN_ROOT/signal.jsonl"
NOTIFY="$RUN_ROOT/notification.jsonl"
NOTIFY_PROGRAM="$RUN_ROOT/codex-notify.sh"

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

say "harnet live e2e ($HARNESS) - socket '$SOCKET', evidence in $RUN_ROOT"

# ------------------------------------------------------------------ preflight
say "preflight"
missing=0
for bin in tmux node git "$HARNESS"; do
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
printf '   %-8s %s\n' "$HARNESS" "$("$HARNESS" --version 2>&1 | head -1)"

# --------------------------------------------- throwaway repo + signal config
say "throwaway worktree + completion signal"
mkdir -p "$WORKTREE"
git init -q "$WORKTREE" || fail "cannot git init $WORKTREE"
printf '# harnet live e2e\n' > "$WORKTREE/README.md"
git -C "$WORKTREE" add -A >/dev/null 2>&1
git -C "$WORKTREE" -c user.email=e2e@harnet -c user.name=e2e commit -qm "e2e" \
  || fail "cannot commit in $WORKTREE"

: > "$SIGNAL"
: > "$NOTIFY"

if [ "$HARNESS" = "claude" ]; then
  mkdir -p "$WORKTREE/.claude"
  # The Stop payload arrives on stdin; append it verbatim so the report can
  # quote the real thing. Notification means the agent is waiting for a human.
  cat > "$WORKTREE/.claude/settings.json" <<EOF
{
  "hooks": {
    "Stop": [
      { "matcher": "", "hooks": [ { "type": "command", "command": "cat >> '$SIGNAL'" } ] }
    ],
    "Notification": [
      { "matcher": "", "hooks": [ { "type": "command", "command": "cat >> '$NOTIFY'" } ] }
    ]
  }
}
EOF
  info "signal:   Stop hook -> $SIGNAL"
else
  # codex hands the notify program its JSON as argv[1], not on stdin - measured
  # by live-spike.sh, not assumed. The program is passed to codex with
  # `-c notify=[...]`, so nothing global is touched.
  cat > "$NOTIFY_PROGRAM" <<EOF
#!/bin/sh
printf '%s\n' "\$1" >> '$SIGNAL'
EOF
  chmod +x "$NOTIFY_PROGRAM"
  info "signal:   notify program $NOTIFY_PROGRAM -> $SIGNAL"
fi
info "worktree: $WORKTREE"

# ----------------------------------------------------------- kill any leftover
$TMUX_ kill-session -t "harnet-$AGENT" >/dev/null 2>&1

# ------------------------------------------------------------------ the run
export HARNET_E2E_HARNESS="$HARNESS"
export HARNET_E2E_ROOT="$RUN_ROOT"
export HARNET_E2E_WORKTREE="$WORKTREE"
export HARNET_E2E_SIGNAL="$SIGNAL"
export HARNET_E2E_NOTIFY="$NOTIFY"
export HARNET_E2E_NOTIFY_PROGRAM="$NOTIFY_PROGRAM"
export HARNET_E2E_SOCKET="$SOCKET"
export HARNET_E2E_AGENT="$AGENT"
export KEEP

cd "$REPO_ROOT" || fail "cannot cd to $REPO_ROOT"
node scripts/live-e2e.mjs
status=$?

say "done"
if [ "$status" = "0" ]; then
  info "control service verified end to end against a real $HARNESS session"
else
  info "run failed; full output above"
fi
exit "$status"
