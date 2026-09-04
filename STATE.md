# STATE (updated by orchestrator every turn)

## Jobs
- done: scaffold (orchestrator, main) - node skeleton + 5 smoke tests
- done: workbuddy-queue-1 (wb) - queue, busy, result groups, 48 tests
- done: workbuddy-git-1 (wb) - worktree manager + delivery merge, 89 tests
- done: antigravity-panel-1 (agy) - read-only panel, 67 tests
- open: opencode-service-1 (opencode) - control service wiring, branch harnet/opencode
- open: claude-transcript-1 (claude) - real jsonl reader, branch harnet/claude
- open: antigravity-bin-1 (agy lane 1) - bin/harnet status CLI, branch harnet/antigravity
- review: chatgpt-adapters-1 (gpt) - PR #3, adapters done 156/156
- review: antigravity-ci-1 (agy) - PR #1, CI workflow
- review: antigravity-docs-1 (agy lane 2) - PR #2, docs only

## Board + limits
- workbuddy: BLOCKED, limit hit (was thought unlimited, it is limited)
- opencode: busy (opencode-service-1)
- antigravity: lane 1 busy (antigravity-bin-1) after PR #1 merges, lane 2 review (PR #2)
- chatgpt: review (PR #3), quota spared otherwise
- claude: busy (claude-transcript-1), limit renewed

## Merge order
- PR per job. Independent jobs = separate PRs to main, either order.
- PR #1 (ci) open, waiting human merge in web UI.
- Dependent chain = one stack via gh stack (max depth 3), merge bottom-up in one click.
- Orchestrator submits, human merges in web UI.

## Open prompts
- workbuddy-adapters-1 and antigravity-ci-1 texts are with the human (chat)
