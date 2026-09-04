# claude MEMORY

Role: single-file tiny tasks only until limit renews (limit now renewed).
Branch: harnet/claude. Dir: .harnet/agents/claude/wt.
Status: idle. Last job: claude-spike-1 (live spike, done).

## Standing facts about src/observe/transcript.js (my file)

- Summary counters: lines / parsed / skipped, and lines === parsed + skipped always.
  A bad line never throws; it is skipped and counted so a broken transcript is visible.
- pane.log is never opened by this module. A test writes a real escape-code pane.log
  next to a transcript and asserts the counts do not move.
- Usage shapes accepted: message.usage and top-level usage, snake_case and camelCase.
- Money is out of scope. There is no cost field anywhere in the reader: no price
  table, no costUSD reading, no summary.cost. Two turns were spent removing it
  (claude-costcut-1, claude-costcut-2) - do not add it back. Callers that need a
  figure read `usage` and apply their own price sheet.
- summarizeUsage stays exported: test/smoke.test.js and docs/API.md depend on it.

## Log

### claude-transcript-1 (done, PR #6 merged)
Turned src/observe/transcript.js from a stub into a real jsonl reader:
parseLine / parseTranscript / readTranscript (streaming, readline) / addEntry /
readUsage / emptySummary. Added test/transcript.test.js and a 9-line
test/fixtures/transcript.jsonl with 3 deliberately broken lines plus a blank one.

### claude-costcut-1 (done)
Removed the cost-estimation feature I had added in claude-transcript-1.

Changed:
- src/observe/transcript.js - deleted MODEL_PRICES, priceFor, estimateCost.
  summary.cost is now `number|null`: the sum of harness-written costUSD / cost_usd,
  or null when the harness wrote none. emptySummary().cost is null, not 0.
- test/transcript.test.js - dropped the 3 pricing tests, added 3 for the new rule
  (null with no cost line, sums across lines, ignores a non-numeric cost field).

Why: the price table was a placeholder, not a verified price sheet. A guessed number
looks like a measurement, so it is worse than no number. Tokens are still counted in
full for a caller that has real prices.

### claude-costcut-2 (done)
Removed the cost field entirely - the rest of what claude-costcut-1 left behind.

Changed:
- src/observe/transcript.js - dropped summary.cost from TranscriptSummary and
  emptySummary, entry.cost from TranscriptEntry, and the costUSD / cost_usd read
  in parseLine. addEntry now folds usage only. Header comment states the rule.
- test/transcript.test.js - the cost suite is replaced by one guard test asserting
  `"cost" in entry === false` and `"cost" in summary === false` for a line that
  does carry costUSD, so a reintroduction fails loudly.

Left / for whoever picks this up:
- summarizeUsage is now the only place in the file that mentions cost. It is the
  legacy block helper, unrelated to the jsonl reader, and both test/smoke.test.js
  and docs/API.md pin its `{tokens, cost}` shape. Removing it needs a job that is
  allowed to touch docs/ - worth doing, it is dead weight.
- docs/API.md still documents only summarizeUsage; the reader API is undocumented
  there. Out of my allowed paths (src/observe/ + test/).
- No consumer read summary.cost (grepped src + bin), so removing it broke nothing.

## Standing facts from the live spike (measured 2026-09-04, not assumed)

Run `scripts/live-spike.sh` to reproduce; it is manual-only and never in CI.

- The README chain is real: `tmux new-session -d -c <wt> claude` -> `pipe-pane -o`
  -> `send-keys -l -- <text>` + `send-keys Enter` -> Stop/notify -> jsonl parse.
  Measured latency send-keys -> signal: claude 3s, codex 5s. No polling, no
  screen scraping needed.
- Both harnesses show a trust dialog on first run in a fresh directory, and
  codex may show a self-update offer before it. `send-keys` clears both, which
  is itself proof the keyboard path works. The spike declines the update (Down
  then Enter = "Skip"); accepting would run an installer.
- Readiness must be checked BEFORE dialog detection: codex leaves its "Update
  available" banner printed above the composer, so a dialog-first loop matches
  forever and never starts.
- claude Stop payload arrives on stdin and carries session_id, transcript_path
  and last_assistant_message. `src/adapters/claude.js` reads it correctly.
- codex notify gets its JSON as argv[1] and uses HYPHENATED keys: `thread-id`,
  `last-assistant-message`, `turn-id`, `input-messages`.
  `src/adapters/codex.js` reads `thread_id` / `last_assistant_message`, so a real
  turn never matches and the job would hang. Not fixed here (src/ is outside my
  allowed paths); pinned by test/live-signals.test.js.
- codex rollout jsonl nests every record under `.payload`. transcript.js is
  Claude-shaped, so it parses 5/5 lines, skips 0, and extracts zero messages,
  zero usage, null sessionId - a transcript that looks read and is empty.
  Also pinned by test/live-signals.test.js.

### claude-spike-1 (done)
Added scripts/live-spike.sh (manual live spike, both harnesses) plus
test/live-signals.test.js and 4 real captured fixtures under test/fixtures/
(live-claude-stop.json, live-claude-transcript.jsonl, live-codex-notify.json,
live-codex-rollout.jsonl). 204/204 tests pass, `npm run check` clean.

Two of the new tests are characterization tests: they assert the current broken
behaviour on real codex input so the gap is visible in CI. Fixing the adapter /
adding a codex-shaped reader must flip them - that failure is the signal.

Left / for whoever picks this up:
- Fix `src/adapters/codex.js` to read the hyphenated notify keys (or normalise
  them at the entry point). Highest-value follow-up: without it codex agents
  never complete.
- Give codex its own rollout reader (unwrap `.payload`, read
  `event_msg.task_complete.last_agent_message` and `token_usage_record`).
- Neither is in my allowed paths (scripts/ + test/ this turn).
