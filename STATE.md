# STATE (updated by orchestrator every turn)

## Jobs
- done: scaffold (orchestrator, main) - node skeleton + 5 smoke tests
- done: workbuddy-queue-1 (wb) - queue, busy, result groups, 48 tests
- done: workbuddy-git-1 (wb) - worktree manager + delivery merge, 89 tests
- done: antigravity-panel-1 (agy) - read-only panel, 67 tests
- open: workbuddy-adapters-1 (wb) - harness adapters, branch harnet/workbuddy
- open: antigravity-ci-1 (agy) - github CI workflow, branch harnet/antigravity

## Board + limits
- workbuddy: busy (workbuddy-adapters-1)
- antigravity: busy (antigravity-ci-1)
- chatgpt: idle, RESERVED expert only (weekly limit halved)
- claude: idle, tiny tasks only until limit renews

## Merge order
- PR per job. Independent jobs = separate PRs to main, either order.
- Dependent chain = one stack via gh stack (max depth 3), merge bottom-up in one click.
- Orchestrator submits, human merges in web UI.

## Open prompts
- workbuddy-adapters-1 and antigravity-ci-1 texts are with the human (chat)
