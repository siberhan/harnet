/** Transcript observer stub. README: Gozlem ve Tamamlanma. Structural read from harness jsonl; pane.log is human-only, never parsed for decisions. */

export function summarizeUsage(blocks) {
  return blocks.reduce(
    (acc, b) => ({
      tokens: acc.tokens + (b.tokens ?? 0),
      cost: acc.cost + (b.cost ?? 0),
    }),
    { tokens: 0, cost: 0 },
  );
}
