# STATE (updated by orchestrator every turn)

## Jobs
- done: scaffold (orchestrator, main) - node skeleton + 5 smoke tests
- done: workbuddy-queue-1 (wb) - queue, busy, result groups, 48 tests
- done: workbuddy-git-1 (wb) - worktree manager + delivery merge, 89 tests
- done: antigravity-panel-1 (agy) - read-only panel, 67 tests
- done: chatgpt-adapters-1 (gpt) - PR #3, adapters 156/156
- open: chatgpt-service-1 (gpt) - control service wiring, branch harnet/chatgpt-service
- open: claude-transcript-1 (claude) - real jsonl reader, branch harnet/claude
- open: antigravity-bin-1 (agy lane 1) - bin/harnet status CLI, branch harnet/antigravity
- done: antigravity-ci-1 (agy) - PR #1 merged
- done: antigravity-docs-1 (agy lane 2) - PR #2 merged

## Board + limits
- workbuddy: BLOCKED, limit hit (was thought unlimited, it is limited)
- antigravity: lane 1 busy (antigravity-bin-1), lane 2 idle
- chatgpt: busy (chatgpt-service-1)
- claude: busy (claude-transcript-1), limit renewed

## Merge order
- PR per job. Independent jobs = separate PRs to main, either order.
- PR #1 (ci) open, waiting human merge in web UI.
- Dependent chain = one stack via gh stack (max depth 3), merge bottom-up in one click.
- Orchestrator submits, human merges in web UI.

## Open prompts
- workbuddy-adapters-1 and antigravity-ci-1 texts are with the human (chat)
