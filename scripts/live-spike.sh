#!/usr/bin/env bash
#
# Harnet live spike - the architecture's heart, run for real.
#
# README (Ajanla Konusmak + Gozlem ve Tamamlanma) claims a chain that every
# unit test so far has only mocked:
#
#   tmux new-session -> pipe-pane -> send-keys -> Stop/notify signal -> jsonl
#
# This script runs that chain against a real `claude` / `codex` TUI and prints
# what actually happened. It is a manual tool on purpose: it opens real
# sessions, spends real tokens and needs a logged-in harness, so it is NOT part
# of `npm test` and must never be wired into CI.
#
#   scripts/live-spike.sh              # both harnesses
#   scripts/live-spike.sh claude       # one of them
#   KEEP=1 scripts/live-spike.sh codex # leave the tmux session open to inspect
#
# Everything runs on its own tmux socket (-L harnet-spike) and in a throwaway
# git repo under $TMPDIR, so the user's own tmux server and repos are untouched.
# Any failure stops the script and prints the full command output; nothing is
# retried and nothing is forced.

set -uo pipefail

SOCKET="harnet-spike"
TMUX_="tmux -L $SOCKET"
KEEP="${KEEP:-0}"
# Generous: a cold TUI has to boot, log in and answer before we give up.
BOOT_TIMEOUT="${BOOT_TIMEOUT:-45}"
SIGNAL_TIMEOUT="${SIGNAL_TIMEOUT:-120}"

RUN_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/harnet-live-spike-XXXXXX")"
SIGNALS="$RUN_ROOT/signals"
PANES="$RUN_ROOT/panes"
mkdir -p "$SIGNALS" "$PANES"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

FAILED=0

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
fail() {
  printf '\n\033[1;31mBLOCKED: %s\033[0m\n' "$1" >&2
  shift
  [ "$#" -gt 0 ] && printf '%s\n' "$@" >&2
  FAILED=1
  return 1
}

now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }

cleanup() {
  if [ "$KEEP" = "1" ]; then
    say "KEEP=1: sessions left alive on socket '$SOCKET'"
    $TMUX_ ls 2>&1 | sed 's/^/   /'
    info "attach with: tmux -L $SOCKET attach -t <name>"
    info "kill with:   tmux -L $SOCKET kill-server"
    info "evidence:    $RUN_ROOT"
  else
    $TMUX_ kill-server >/dev/null 2>&1
    info "evidence kept at: $RUN_ROOT"
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------- preflight --

preflight() {
  local harness="$1" missing=0
  for bin in tmux node python3 "$harness"; do
    if ! command -v "$bin" >/dev/null 2>&1; then
      printf '   MISSING: %s\n' "$bin" >&2
      missing=1
    else
      printf '   found %-8s %s\n' "$bin" "$(command -v "$bin")"
    fi
  done
  [ "$missing" = "0" ] || return 1
  printf '   tmux     %s\n' "$($TMUX_ -V 2>&1)"
  printf '   %-8s %s\n' "$harness" "$("$harness" --version 2>&1 | head -1)"
  return 0
}

# Throwaway git repo: both harnesses behave differently outside one.
make_worktree() {
  local dir="$1"
  mkdir -p "$dir"
  git init -q "$dir" || return 1
  printf '# harnet live spike\n' > "$dir/README.md"
  git -C "$dir" add -A >/dev/null 2>&1
  git -C "$dir" -c user.email=spike@harnet -c user.name=spike commit -qm "spike" || return 1
}

# The pane is the human's channel (README: "yalnizca insanin izlemesi icin"), so
# we only read it for the two things a keyboard would look at: is the TUI up,
# and is a trust dialog blocking it. No decision about the *job* comes from here.
pane_text() { $TMUX_ capture-pane -p -t "$1" 2>/dev/null; }

wait_for_prompt() {
  local session="$1" harness="$2" deadline=$(( SECONDS + BOOT_TIMEOUT )) text
  local trust_answered=0 update_declined=0
  while [ "$SECONDS" -lt "$deadline" ]; do
    text="$(pane_text "$session")"

    # Readiness is checked first on purpose: codex leaves its "Update available"
    # banner printed above the composer long after the offer is gone, so a
    # dialog check that ran first would match forever and never let the loop
    # finish. Composer line = the TUI is ready for input.
    if printf '%s' "$text" | grep -qE 'Try "|auto mode on|Ask Codex'; then
      return 0
    fi

    # First run in a fresh directory: both harnesses ask the human to trust it.
    # Harnet is the keyboard, so it answers the same way a human would - and the
    # fact that this works is itself evidence that send-keys drives the TUI.
    # Answered once: a dialog that survives the keystroke is a real block, and
    # the timeout should report it instead of the loop hammering Enter.
    if [ "$trust_answered" = "0" ] && printf '%s' "$text" | grep -qi 'trust'; then
      info "trust dialog detected, answering with send-keys"
      trust_answered=1
      if [ "$harness" = "claude" ]; then
        $TMUX_ send-keys -t "$session" Down; sleep 1
      fi
      $TMUX_ send-keys -t "$session" Enter
      sleep 4
      continue
    fi

    # codex may offer a self-update before it ever shows a prompt. Never take
    # it: the spike must run the binary the user actually has. Down + Enter
    # lands on "Skip"; the default option 1 would run an installer.
    if [ "$update_declined" = "0" ] && printf '%s' "$text" | grep -q 'Update now'; then
      info "update offer detected, declining with send-keys (Skip)"
      update_declined=1
      $TMUX_ send-keys -t "$session" Down
      sleep 1
      $TMUX_ send-keys -t "$session" Enter
      sleep 4
      continue
    fi

    sleep 2
  done
  return 1
}

wait_for_signal() {
  local file="$1" deadline=$(( SECONDS + SIGNAL_TIMEOUT ))
  while [ "$SECONDS" -lt "$deadline" ]; do
    [ -s "$file" ] && return 0
    sleep 1
  done
  return 1
}

# Parse a real transcript with the module under test (src/observe/transcript.js).
parse_transcript() {
  node -e '
import("./src/observe/transcript.js").then(async (m) => {
  const s = await m.readTranscript(process.argv[1]);
  console.log(JSON.stringify({
    lines: s.lines, parsed: s.parsed, skipped: s.skipped,
    sessionId: s.sessionId, lastMessage: s.lastMessage,
    usage: s.usage, toolCounts: s.toolCounts, messages: s.messages.length,
  }, null, 2));
}).catch((e) => { console.error(String(e)); process.exit(1); });
' "$1"
}

json_field() { node -e '
const fs = require("node:fs");
const line = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").pop();
const obj = JSON.parse(line);
const v = obj[process.argv[2]];
process.stdout.write(v === undefined || v === null ? "" : String(v));
' "$1" "$2" 2>/dev/null; }

# ------------------------------------------------------------------- claude --

spike_claude() {
  local session="harnet-spike-claude"
  local wt="$RUN_ROOT/claude-wt"
  local stop="$SIGNALS/claude-stop.jsonl"
  local notify="$SIGNALS/claude-notification.jsonl"
  local pane="$PANES/claude.log"
  local question='Reply with exactly this one word and nothing else: HARNET-SPIKE-CLAUDE-OK'

  say "claude: preflight"
  preflight claude || return 1

  say "claude: worktree + Stop hook"
  make_worktree "$wt" || { fail "cannot create throwaway repo at $wt"; return 1; }
  : > "$stop"; : > "$notify"
  mkdir -p "$wt/.claude"
  # The Stop hook is fed the payload on stdin; append it verbatim so the report
  # can quote the real thing instead of a paraphrase.
  cat > "$wt/.claude/settings.json" <<EOF
{
  "hooks": {
    "Stop": [
      { "matcher": "", "hooks": [ { "type": "command", "command": "cat >> '$stop'" } ] }
    ],
    "Notification": [
      { "matcher": "", "hooks": [ { "type": "command", "command": "cat >> '$notify'" } ] }
    ]
  }
}
EOF
  info "worktree: $wt"
  info "stop signal file: $stop"

  say "claude: tmux new-session + pipe-pane"
  $TMUX_ kill-session -t "$session" >/dev/null 2>&1
  if ! $TMUX_ new-session -d -s "$session" -x 200 -y 50 -c "$wt" claude; then
    fail "tmux new-session failed for $session"; return 1
  fi
  sleep 1
  # pipe-pane right after creation: one byte log, no history/live split.
  $TMUX_ pipe-pane -t "$session" -o "cat >> '$pane'" || { fail "pipe-pane failed"; return 1; }
  info "session list:"
  $TMUX_ ls 2>&1 | sed 's/^/     /'

  say "claude: waiting for the TUI to come up"
  if ! wait_for_prompt "$session" claude; then
    fail "claude TUI never reached its prompt within ${BOOT_TIMEOUT}s" \
         "--- last pane ---" "$(pane_text "$session")"
    return 1
  fi
  info "TUI ready"

  say "claude: send-keys"
  local sent_ms t0
  t0=$SECONDS
  sent_ms="$(now_ms)"
  $TMUX_ send-keys -t "$session" -l -- "$question" || { fail "send-keys (text) failed"; return 1; }
  sleep 1
  $TMUX_ send-keys -t "$session" Enter || { fail "send-keys (Enter) failed"; return 1; }
  info "sent at $(date '+%H:%M:%S'): $question"

  say "claude: waiting for the Stop hook"
  if ! wait_for_signal "$stop"; then
    fail "no Stop signal within ${SIGNAL_TIMEOUT}s" \
         "--- pane ---" "$(pane_text "$session")" \
         "--- notifications (agent may be waiting for a human) ---" "$(cat "$notify")"
    return 1
  fi
  local elapsed=$(( SECONDS - t0 ))
  info "Stop signal arrived ${elapsed}s after send-keys, at $(date '+%H:%M:%S')"
  info "raw payload:"
  sed 's/^/     /' "$stop"
  if [ -s "$notify" ]; then
    info "Notification hook also fired (human-needed entries):"
    sed 's/^/     /' "$notify"
  fi

  local last transcript
  last="$(json_field "$stop" last_assistant_message)"
  transcript="$(json_field "$stop" transcript_path)"
  info "last_assistant_message: $last"
  info "transcript_path:        $transcript"
  [ "$last" = "HARNET-SPIKE-CLAUDE-OK" ] \
    && info "round trip verified: sent text produced the expected answer" \
    || info "WARNING: answer did not match the requested token"

  say "claude: parse the transcript with src/observe/transcript.js"
  if [ -z "$transcript" ] || [ ! -f "$transcript" ]; then
    fail "Stop payload carried no readable transcript_path: '$transcript'"; return 1
  fi
  ( cd "$REPO_ROOT" && parse_transcript "$transcript" ) | sed 's/^/     /' \
    || { fail "transcript parse failed"; return 1; }

  info "pane.log bytes: $(wc -c < "$pane" | tr -d ' ')"
  [ "$KEEP" = "1" ] || $TMUX_ kill-session -t "$session" >/dev/null 2>&1
  return 0
}

# -------------------------------------------------------------------- codex --

spike_codex() {
  local session="harnet-spike-codex"
  local wt="$RUN_ROOT/codex-wt"
  local notify="$SIGNALS/codex-notify.jsonl"
  local notify_sh="$RUN_ROOT/codex-notify.sh"
  local pane="$PANES/codex.log"
  local question='Reply with exactly this one word and nothing else: HARNET-SPIKE-CODEX-OK'

  say "codex: preflight"
  preflight codex || return 1

  say "codex: worktree + notify program"
  make_worktree "$wt" || { fail "cannot create throwaway repo at $wt"; return 1; }
  : > "$notify"
  # codex hands the notify program its JSON as argv[1], not on stdin.
  cat > "$notify_sh" <<EOF
#!/bin/sh
printf '%s\n' "\$1" >> '$notify'
EOF
  chmod +x "$notify_sh"
  info "worktree: $wt"
  info "notify program: $notify_sh"

  say "codex: tmux new-session + pipe-pane"
  $TMUX_ kill-session -t "$session" >/dev/null 2>&1
  if ! $TMUX_ new-session -d -s "$session" -x 200 -y 50 -c "$wt" codex -c "notify=[\"$notify_sh\"]"; then
    fail "tmux new-session failed for $session"; return 1
  fi
  sleep 1
  $TMUX_ pipe-pane -t "$session" -o "cat >> '$pane'" || { fail "pipe-pane failed"; return 1; }
  info "session list:"
  $TMUX_ ls 2>&1 | sed 's/^/     /'

  say "codex: waiting for the TUI to come up"
  if ! wait_for_prompt "$session" codex; then
    fail "codex TUI never reached its prompt within ${BOOT_TIMEOUT}s" \
         "--- last pane ---" "$(pane_text "$session")"
    return 1
  fi
  info "TUI ready"

  say "codex: send-keys"
  local t0
  t0=$SECONDS
  $TMUX_ send-keys -t "$session" -l -- "$question" || { fail "send-keys (text) failed"; return 1; }
  sleep 1
  $TMUX_ send-keys -t "$session" Enter || { fail "send-keys (Enter) failed"; return 1; }
  info "sent at $(date '+%H:%M:%S'): $question"

  say "codex: waiting for the notify program"
  if ! wait_for_signal "$notify"; then
    fail "no notify signal within ${SIGNAL_TIMEOUT}s" \
         "--- pane ---" "$(pane_text "$session")"
    return 1
  fi
  local elapsed=$(( SECONDS - t0 ))
  info "notify arrived ${elapsed}s after send-keys, at $(date '+%H:%M:%S')"
  info "raw payload:"
  sed 's/^/     /' "$notify"

  # Real payload keys are hyphenated (thread-id, last-assistant-message), which
  # is NOT what src/adapters/codex.js expects. Read both so the script reports
  # the truth rather than the assumption.
  local last thread
  last="$(json_field "$notify" 'last-assistant-message')"
  [ -n "$last" ] || last="$(json_field "$notify" last_assistant_message)"
  thread="$(json_field "$notify" 'thread-id')"
  [ -n "$thread" ] || thread="$(json_field "$notify" thread_id)"
  info "last assistant message: $last"
  info "thread id:              $thread"
  [ "$last" = "HARNET-SPIKE-CODEX-OK" ] \
    && info "round trip verified: sent text produced the expected answer" \
    || info "WARNING: answer did not match the requested token"

  say "codex: parse the rollout with src/observe/transcript.js"
  local rollout=""
  if [ -n "$thread" ]; then
    rollout="$(find "$HOME/.codex/sessions" -name "*$thread*.jsonl" 2>/dev/null | head -1)"
  fi
  if [ -z "$rollout" ]; then
    info "no rollout jsonl found for thread '$thread' under ~/.codex/sessions"
  else
    info "rollout: $rollout"
    ( cd "$REPO_ROOT" && parse_transcript "$rollout" ) | sed 's/^/     /' \
      || { fail "rollout parse failed"; return 1; }
    info "NOTE: codex nests everything under .payload, so the Claude-shaped"
    info "      reader parses every line but extracts nothing. See report."
  fi

  info "pane.log bytes: $(wc -c < "$pane" | tr -d ' ')"
  [ "$KEEP" = "1" ] || $TMUX_ kill-session -t "$session" >/dev/null 2>&1
  return 0
}

# --------------------------------------------------------------------- main --

target="${1:-both}"
say "harnet live spike - socket '$SOCKET', evidence in $RUN_ROOT"

case "$target" in
  claude) spike_claude ;;
  codex)  spike_codex ;;
  both)   spike_claude; spike_codex ;;
  *) echo "usage: $0 [claude|codex|both]" >&2; exit 2 ;;
esac

say "done"
if [ "$FAILED" = "0" ]; then
  info "chain verified: new-session -> pipe-pane -> send-keys -> signal -> jsonl parse"
else
  info "one or more steps failed; full output above"
fi
exit "$FAILED"
