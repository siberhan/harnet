# claude MEMORY

Role: single-file tiny tasks only until limit renews (limit now renewed).
Branch: harnet/claude. Dir: .harnet/agents/claude/wt.
Status: idle.

## Log

### claude-transcript-1 (done)
Turned src/observe/transcript.js from a stub into a real jsonl reader.

Changed:
- src/observe/transcript.js - parseLine / parseTranscript / readTranscript (streaming,
  readline) / addEntry / readUsage / priceFor / estimateCost / emptySummary.
  Kept summarizeUsage exported unchanged: test/smoke.test.js and docs/API.md depend on it.
- test/transcript.test.js - 31 new tests.
- test/fixtures/transcript.jsonl - 9-line fixture, 3 of them deliberately broken
  (non-json, no type field, truncated tail) plus a blank line.

Decisions worth remembering:
- Summary counters: lines / parsed / skipped, and lines === parsed + skipped always.
  A bad line never throws; it is skipped and counted so a broken transcript is visible.
- Cost: a costUSD/cost_usd written by the harness always wins over our own estimate.
  MODEL_PRICES is a longest-prefix table; unknown model = 0, never a guess.
- pane.log is never opened by this module. A test writes one next to a transcript and
  asserts the counts do not move.
- Usage shapes accepted: message.usage and top-level usage, snake_case and camelCase.

Left / for whoever picks this up:
- docs/API.md still documents only summarizeUsage. Out of my allowed paths this turn
  (src/observe/ + test/ only), so the new API is undocumented there.
- src/panel/server.js does not consume readTranscript yet (cost view). Needs its own job.
- Prices in MODEL_PRICES are placeholders, not a verified price sheet.
