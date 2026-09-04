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
