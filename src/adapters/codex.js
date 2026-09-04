/** Codex adapter stub. README: Ajanla Konusmak + Gozlem ve Tamamlanma. Spawn `codex` in tmux, write via send-keys, completion via notify program. */

export const CODEX = Object.freeze({
  spawn: "codex",
  write: "tmux send-keys",
  doneSignal: "notify program",
  log: "rollout .jsonl",
});
