# STATE (updated by orchestrator every turn)

## Jobs
- done: scaffold (orchestrator, main) - node skeleton + 5 smoke tests
- done: workbuddy-queue-1 (wb) - queue, busy, result groups, 48 tests
- done: workbuddy-git-1 (wb) - worktree manager + delivery merge, 89 tests
- done: antigravity-panel-1 (agy) - read-only panel, 67 tests
- open: none

## Board + limits
- workbuddy: idle
- antigravity: idle
- chatgpt: idle, RESERVED expert only (weekly limit halved)
- claude: idle, tiny tasks only until limit renews

## Merge order
- Done in order: workbuddy-git-1, then antigravity-panel-1. Main at 108/108 tests green.
- Rule: oldest job merges first; later branches ff after each merge.

## Open prompts
- none (next up: harness adapters step - claude Stop hook + codex notify wiring)
