# ORCHESTRATION (phase 1: sequential)

Harnet spec: README.md. Read it first. It is the only authority on architecture.

## How we work right now
- One agent works at a time. The human carries prompts between agents by copy-paste.
- Never start work you were not asked for. Never touch another agent's branch.
- Your branch: harnet/<your-name>. Your dir: .harnet/agents/<your-name>/wt.
- Commit every finished turn on your branch. Never push to main. Merges to main are done by the human.

## Memory protocol (sessions persist, so keep them clean)
- Start of turn: read your MEMORY.md + ORCHESTRATION.md, write 3-line recap.
- End of turn: append to your MEMORY.md: what changed, file list, what is left.

## Phase 1 order
1. scaffold (repo layout, package, lint, test runner)
2. worktree + branch manager
3. control service (queue, busy state, job ids)
4. harness adapters (claude Stop hook, codex notify)
5. web panel (read-only first)
6. docs + e2e

Steps 2+ start only when the orchestrator says so.
