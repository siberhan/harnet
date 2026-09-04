# STATE (updated by orchestrator every turn)

## Jobs
- done: scaffold (orchestrator, main) - node skeleton + 5 smoke tests
- done: workbuddy-queue-1 (wb) - queue, busy, result groups, 48 tests
- done: workbuddy-git-1 (wb) - worktree manager + delivery merge, 89 tests
- done: antigravity-panel-1 (agy) - read-only panel, 67 tests
- done: chatgpt-adapters-1 (gpt) - PR #3, adapters 156/156
- done: chatgpt-service-1 (gpt) - PR #4 merged, control service
- done: claude-transcript-1 (claude) - PR #6 merged, jsonl reader
- done: antigravity-bin-1 (agy lane 1) - PR #5 merged, status CLI
- done: claude-e2e-1 (claude) - PR #11 merged, live e2e
- done: antigravity-daemon-1 (agy lane 1) - PR #12 merged, file store
- done: claude-codexe2e-1 (claude) - PR #17 merged, codex live
- done: antigravity-profiles-1 (agy lane 1) - PR #18 merged, profiles
- done: antigravity-launchd-1 (agy lane 2) - PR #19 merged, plist + docs
- done: claude-cleanup-1 (claude) - PR #14 merged
- done: antigravity-up-1 (agy lane 1) - PR #15 merged
- done: antigravity-docs-3 (agy lane 2) - PR #16 merged
- done: claude-readreport-1 (claude) - PR #13 merged, race reader
- done: claude-spike-1 + codexfix-1 (claude) - PR #8 merged, live proof + codex fix
- done: antigravity-panelwire-1 (agy lane 1) - PR #9 merged
- done: antigravity-docs-2 (agy lane 2) - PR #10 merged
- done: claude-costcut-1/2 (claude) - PR #7 merged, cost fully removed
- done: antigravity-ci-1 (agy) - PR #1 merged
- done: antigravity-docs-1 (agy lane 2) - PR #2 merged

## Board + limits
- workbuddy: BLOCKED, limit hit (was thought unlimited, it is limited)
- antigravity: lane 1 idle, lane 2 idle
- chatgpt: idle, quota spared
- claude: idle

## Merge order
- PR per job. Independent jobs = separate PRs to main, either order.
- PR #1 (ci) open, waiting human merge in web UI.
- Dependent chain = one stack via gh stack (max depth 3), merge bottom-up in one click.
- Orchestrator submits, human merges in web UI.

## Open prompts
- workbuddy-adapters-1 and antigravity-ci-1 texts are with the human (chat)
