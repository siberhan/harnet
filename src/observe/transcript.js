/**
 * Transcript observer stub. README: Gozlem ve Tamamlanma. Structural read from harness jsonl; pane.log is human-only, never parsed for decisions.
 * @typedef {{ tokens?: number, cost?: number }} UsageBlock
 * @param {UsageBlock[]} blocks
 * @returns {{ tokens: number, cost: number }}
 */
export function summarizeUsage(blocks) {
  /** @type {{ tokens: number, cost: number }} */
  const total = { tokens: 0, cost: 0 };
  for (const b of blocks) {
    total.tokens += b.tokens ?? 0;
    total.cost += b.cost ?? 0;
  }
  return total;
}
