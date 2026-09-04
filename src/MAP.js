/** Phase 1 module map. Each file owns one README section. No cross-imports yet. */

// src/service/queue.js      -> job queue, busy state, job ids (README: Kontrol Servisi, Mesguliyet)
// src/service/jobs.js       -> result groups, error states done/error/timeout/crashed/refused
// src/service/control.js    -> wiring: submit/dispatch/signal -> result group -> one wake-up
// src/service/report.js     -> signal -> job report: transcript flush poll + payload fallback
// src/git/worktree.js       -> per-profile worktree open/abandon/remove
// src/git/deliver.js        -> bottom-up merge + conflict abort + report
// src/adapters/claude.js    -> claude TUI spawn, send-keys, Stop hook intake
// src/adapters/codex.js     -> codex TUI spawn, send-keys, notify intake
// src/observe/transcript.js -> structured read: transcript jsonl usage + tool calls
// src/panel/server.js       -> HTTP + WebSocket, xterm.js attach, permission queue, cost view
