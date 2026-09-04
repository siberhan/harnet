# STATE (updated by orchestrator every turn)

## Jobs
- done: scaffold (orchestrator, main) - node skeleton + 5 smoke tests
- done: workbuddy-queue-1 (wb) - queue, busy, result groups, 48 tests
- done: workbuddy-git-1 (wb) - worktree manager + delivery merge, 89 tests
- done: antigravity-panel-1 (agy) - read-only panel, 67 tests
- open: workbuddy-adapters-1 (wb) - WIP commit 886e559 on harnet/workbuddy, 147/156 tests, tsc errors open, wb limit hit
- review: antigravity-ci-1 (agy) - PR #1, CI workflow
- open: antigravity-docs-1 (agy lane 2) - docs/, branch harnet/antigravity-2

## Board + limits
- workbuddy: BLOCKED, limit hit (was thought unlimited, it is limited)
- antigravity: lane 1 review (PR #1), lane 2 busy (antigravity-docs-1)
- chatgpt: idle, candidate to finish adapters (reserve exception, weekly limit halved)
- claude: idle, tiny tasks only until limit renews

## Merge order
- PR per job. Independent jobs = separate PRs to main, either order.
- PR #1 (ci) open, waiting human merge in web UI.
- Dependent chain = one stack via gh stack (max depth 3), merge bottom-up in one click.
- Orchestrator submits, human merges in web UI.

## Open prompts
- workbuddy-adapters-1 and antigravity-ci-1 texts are with the human (chat)
