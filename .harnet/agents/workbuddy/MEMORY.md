# workbuddy MEMORY

Role: core engine. Control service, queue, busy state, worktree/branch manager, Stop/notify signals.
Branch: harnet/workbuddy. Dir: .harnet/agents/workbuddy/wt.
Status: turn 2 done. Waiting for the orchestrator. NOT pushed — commits sit on harnet/workbuddy only.
Note: turn 1 was merged into main by the human (499503e). Main has moved; rebase only if told.

## Turn 1 — job workbuddy-queue-1 (control service, queue + results)

Task: turn the src/service stubs into a real implementation.
Commit: 06503df "feat: job queue, busy state, result groups" (branch harnet/workbuddy, untracked by push).

What changed:
- src/service/queue.js — auto job ids (`job-1`, `job-2`, ...; injectable idFactory),
  per-agent busy/idle tracking, FIFO dispatch, busy agent => job queued not run,
  sweepTimeouts(), markCrashed(), refusal on depth > maxDepth or group over
  maxJobsPerGroup. Constants: DEFAULT_MAX_DEPTH=3, DEFAULT_MAX_JOBS_PER_GROUP=8,
  DEFAULT_TIMEOUT_MS=30min. `push()` kept as alias for the scaffold smoke test.
- src/service/jobs.js — createGroupRegistry (open/addJob/record/isReady/pendingJobs/
  collect), buildResult (normalizes done/error/timeout/crashed/refused into a Result
  with a never-empty report), formatResult (README block, untouched), formatElapsed,
  formatGroupWakeup, wakeupFor (throws until the group is ready = no early wake-up).

Files:
- src/service/queue.js (rewritten)
- src/service/jobs.js (rewritten)
- test/queue.test.js (new)
- test/jobs.test.js (new)
- test/service-flow.test.js (new)

Verification: npm test 48/48 pass, npm run check (tsc strict + checkJs) clean.
Verified tsc really checks: injecting a bad type into test/ produced TS2322.

Design decisions worth remembering:
- src/MAP.js says "no cross-imports", so queue.js and jobs.js stay independent and
  each defines its own status set. test/service-flow.test.js is the contract test
  that fails if they drift apart. Do NOT merge them without updating MAP.js.
- Queue returns live job references — completing a job mutates the object you hold.
- Busy starts at dispatch() (the send-keys moment) and ends at complete() /
  sweepTimeouts() / markCrashed(). Nothing else sets it.

What is left (not in this task, not started):
- Step 2 worktree/branch manager and step 4 harness adapters (claude Stop hook,
  codex notify) are what actually call dispatch/complete — the queue has no
  signal source yet. Stop-hook -> complete(), notify -> complete(),
  session death -> markCrashed(), timer -> sweepTimeouts().
- Persistence: the queue is in-memory only. README wants a DB so the service can
  restart and resume jobs.
- Profile -> tmux session / session_id map, permission-question queue, web panel.
- Group semantics are caller-driven: the caller must addJob() for every child.
  Auto-grouping per turn has no home yet (needs the turn signal from adapters).

## Turn 2 — job workbuddy-git-1 (worktree manager + delivery)

Task: turn the src/git stubs into a real implementation.
Commit: d248354 "feat: worktree/branch manager + delivery merge" (branch harnet/workbuddy, not pushed).

What changed:
- src/git/worktree.js — createWorktreeManager({root, run, onCommand}) with
  open() (git worktree add; `-b` only when the branch does not exist yet, so an
  abandoned profile re-attaches instead of recreating the branch; idempotent when
  the worktree is already registered = reconnect after a service restart),
  list() + parseWorktreeList() (porcelain), abandon() (tmux kill-session only,
  worktree and transcript stay), remove() (optional --force, optional branch -D;
  branch survives by default so the agent's commits are not thrown away).
  Helpers kept/added: worktreePath, branchName, sessionName (`harnet-<id>`),
  transcriptDir (`.harnet/agents/<id>`).
- src/git/deliver.js — createDeliveryManager({root, run, onCommand}) with deliver()
  (checks both branches exist, checks out the parent if needed, `git merge --no-ff
  -m "harnet: merge <child> into <parent>" <child>`), plus abortMerge(),
  conflictFiles(), mergeInProgress(), currentBranch(). deliveryPlan() kept for the
  scaffold smoke test.

Files:
- src/git/worktree.js (rewritten), src/git/deliver.js (rewritten)
- test/worktree.test.js, test/deliver.test.js, test/git-integration.test.js (new)
- test/fake-runner.js (new, shared test helper: injectable runner, longest-prefix
  routing, throws on any command the test did not route)

Verification: npm test 89/89 green (ran 3x, stable), npm run check clean.
Integration tests use real git in a throwaway repo under os.tmpdir() and clean up
after themselves; no tmux session is ever created.

Design decisions worth remembering:
- One exec() path per module: argv+cwd+status logged, non-zero exit becomes a
  GitError carrying {command, code, stderr, cwd}. Failures are logged too, so a
  crash dump shows the command that died last.
- Conflict order is load-bearing: read unmerged files (git diff --name-only
  --diff-filter=U) BEFORE `git merge --abort`, because the index is wiped by the
  abort. No strategy options, no auto-resolution — ever.
- Three delivery outcomes besides "merged": "up-to-date" (nothing to do),
  "conflict" (aborted + file list), "failed" (merge died for another reason, e.g.
  dirty worktree; no abort is attempted because there is no merge in progress).
- --no-ff is the default so every delivery is visible in history; `noFf: false`
  opts into fast-forward.
- Manager roots are normalised with realpath: git prints real paths and on macOS
  /var is /private/var, so a symlinked root would otherwise make open() re-add a
  live worktree. Found by the integration test, not by reasoning.
- src/MAP.js "no cross-imports" holds, so GitError is defined in both git modules
  (same shape, same name). Deliberately duplicated — do not "fix" without MAP.js.

What is left (not in this task, not started):
- Nothing wires the pieces together yet. The control service still has to call
  worktree.open() when a profile is created, queue.dispatch() when it writes the
  prompt, and deliver() during the parent's wake-up turn.
- Step 4 harness adapters (claude Stop hook, codex notify) are the missing signal
  source: Stop -> queue.complete(), session death -> queue.markCrashed(),
  timer -> queue.sweepTimeouts().
- tmux session *creation* (spawn TUI + pipe-pane) is not implemented anywhere yet;
  worktree.abandon() only kills an existing session.
- Persistence: queue and groups are in-memory. README wants a DB.
- Delivery does not commit the agent's turn (README: "her ajan turu otomatik bir
  commit ile biter") — that belongs to the adapter/turn layer.
