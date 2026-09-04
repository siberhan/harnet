/** Claude adapter stub. README: Ajanla Konusmak + Gozlem ve Tamamlanma. Spawn `claude` in tmux, write via send-keys, completion via Stop hook. */

export const CLAUDE = Object.freeze({
  spawn: "claude",
  write: "tmux send-keys",
  doneSignal: "Stop hook",
  log: "transcript .jsonl",
});
