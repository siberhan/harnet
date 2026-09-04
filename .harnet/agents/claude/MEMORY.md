# claude MEMORY

Role: single-file tiny tasks only until limit renews (limit now renewed).
Branch: harnet/claude. Dir: .harnet/agents/claude/wt.
Status: idle.

## Standing facts about src/observe/transcript.js (my file)

- Summary counters: lines / parsed / skipped, and lines === parsed + skipped always.
  A bad line never throws; it is skipped and counted so a broken transcript is visible.
- pane.log is never opened by this module. A test writes a real escape-code pane.log
  next to a transcript and asserts the counts do not move.
- Usage shapes accepted: message.usage and top-level usage, snake_case and camelCase.
- Cost is NOT estimated. Only costUSD / cost_usd written by the harness is reported;
  summary.cost is `number|null` and stays null when no line carried one. See the
  claude-costcut-1 entry for why - do not reintroduce a price table.
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

Left / for whoever picks this up:
- docs/API.md still documents only summarizeUsage. Out of my allowed paths
  (src/observe/ + test/), so the reader API is undocumented there.
- No consumer reads summary.cost yet (grepped src + bin: none), so the number->null
  type change broke nothing. Whoever wires the panel cost view must handle null.
