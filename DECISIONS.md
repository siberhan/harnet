# DECISIONS

Log format: date + decision + why + revisit when. Short entries only.

## 2026-09-04: Language is JavaScript on Node 18+, zero runtime dependencies
- Why: panel needs JS anyway (xterm.js), Windows roadmap needs node-pty, one language for hooks and service.
- Consulted: orchestrator table + Claude Code review (TS 92, JS 84-88, Go 76-78).
- Revisit: never for phase 1. Real `.ts` only evaluated at node-pty/Windows phase.

## 2026-09-04: Types via JSDoc + `tsc --noEmit` strict gate, no build step
- Why: catches queue/result shape errors at check time, runtime stays dependency-free.
- Revisit: if JSDoc annotations cost more than they save.

## 2026-09-04: Phase 1 is sequential, one agent at a time
- Why: human is the transport (copy-paste), parallel dependent work creates needless branching.
- Parallel rule: parallel agents only when tasks are truly independent.
- Revisit: when Harnet itself can merge (dogfooding).

## 2026-09-04: Queue lives in memory, no DB persistence yet
- Why: persistence only pays off once adapters + panel feed the queue (step 4+).
- Revisit: when Stop/notify signals get wired (adapters step).

## 2026-09-04: Delivery merges with --no-ff, never auto-resolves conflicts
- Why: delivery stays visible in history; on conflict abort and report file list, parent agent resolves.
- Revisit: never in MVP.

## 2026-09-04: Worktree layout `.harnet/agents/<id>/wt` on branch `harnet/<id>`
- Why: README spec; tmux session opens in that dir and history holds absolute paths, so it must be stable.
- Revisit: never in MVP.

## 2026-09-04: src/MAP.js bans cross-imports between modules (temporary)
- Why: keeps parallel agents from breaking each other's interfaces; shared shapes duplicated knowingly, guarded by contract tests.
- Revisit: merge shared types first, then update MAP.js before unifying.
