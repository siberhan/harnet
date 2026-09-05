# antigravity MEMORY

Role: scaffold + web panel + tests + docs. Fast, simple tasks first.
Branch: harnet/antigravity. Dir: .harnet/agents/antigravity/wt.
Status: turn 8 done. Waiting for the orchestrator. NOT pushed — commit sits on harnet/antigravity only.

## Turn 1 — job antigravity-panel-1 (read-only web panel, agents + queue)

Task: read-only panel first slice, zero new dependencies (node http only).
Commit: 2249009 "feat: read-only web panel (agents, queue, health)" (branch harnet/antigravity, untracked by push).

What changed:
- src/panel/server.js — implemented read-only HTTP server with endpoints:
  GET /api/health (status: "ok"),
  GET /api/agents (extracts id, role, status from .harnet/agents/*/MEMORY.md),
  GET /api/queue (currently returns empty array, supports injected queue state),
  GET / (single HTML page rendering agent list and queue).
  Handles HEAD, 404 for unknown routes, 405 Method Not Allowed for non-GET methods.
  Zero new dependencies: node:http, node:fs, node:path, node:url only.
- test/panel.test.js — 19 unit & integration tests on real OS-assigned port. Tests
  all endpoints, parsing of MEMORY.md, HTML escaping, custom queue provider, 404/405.
- Tests & checks: npm test (67/67 passing), npm run check (tsc strict checkJs) clean.

Files:
- src/panel/server.js
- test/panel.test.js

Left:
- Phase 1 step 5 follow-up: connect real control service queue to GET /api/queue and panel.
- Phase 2: WebSocket, xterm.js attach to live tmux sessions, permission question queue.

## Turn 2 — job antigravity-ci-1 (GitHub Actions CI workflow)

Task: write .github/workflows/ci.yml with Node 18 20 22 matrix running npm test and npm run check.
Commit: 1d30c9b "ci: add GitHub Actions workflow for Node 18, 20, 22 matrix" (branch harnet/antigravity, untracked by push).

What changed:
- .github/workflows/ci.yml — matrix workflow covering Node 18, 20, and 22 on ubuntu-latest.
  Triggers on push/pull_request to main and workflow_dispatch. Runs actions/checkout@v4, actions/setup-node@v4 (with npm cache),
  npm ci, npm test, and npm run check. Double checked visually and verified with YAML parser; 'on' key quoted to avoid YAML 1.1 bool issue.
- Only .github/ touched, zero code changes.

Files:
- .github/workflows/ci.yml

Left:
- Phase 1 step 5 follow-up: connect real control service queue to GET /api/queue and panel.
- Phase 2: WebSocket, xterm.js attach to live tmux sessions, permission question queue.

## Turn 3 — job antigravity-bin-1 (bin/harnet status CLI, reconstructed)
Commit ff5c054, PR #5 merged. bin/harnet.js status reads STATE.md + agent MEMORYs, prints table. test/status-cli.test.js 9 tests. 165/165 green.

## Turn 4 — job antigravity-panelwire-1 (panel transcript tail, reconstructed)
Commit c3fd0d5, PR #9 merged. GET /api/agents/<id>/tail + last-message on cards. 8 new tests in test/panel.test.js. 204/204 green on branch.

## Turn 5 — job antigravity-daemon-1 (job queue file persistence, src/service/store.js)

Task: add file persistence to job queue via src/service/store.js (.harnet/state/jobs.json, .bak on corrupt, zero touches to queue.js / jobs.js).
Commit: 81f0433 "feat(service): add job queue file persistence store" (branch harnet/antigravity, untracked by push).

What changed:
- src/service/store.js:
  - Default path .harnet/state/jobs.json with recursive dir creation.
  - loadJobs() reads on startup: returns [] if file does not exist.
  - If corrupted or invalid JSON, backs up file to .bak and starts empty without throwing/crashing.
  - saveJobs() atomically writes formatted JSON (via temp file and atomic rename).
  - attachJobStore(queue, options) / createPersistentQueue(queue, options):
    - Replays/restores existing jobs into queue upon restart (restores queued, running, terminal jobs and agent busy states).
    - Prevents ID collision on restored jobs by auto-incrementing beyond existing numeric IDs.
    - Wraps mutating methods (enqueue, push, dispatch, complete, sweepTimeouts, markCrashed) to persist state to disk on every change.
  - createJobStore(options) standalone store API (add, update, remove, clear, load, save, attach, restore).
  - MAP rule respected: zero cross-imports to queue.js or jobs.js (accepts queue interface).
- test/store.test.js:
  - 12 comprehensive unit and integration tests in isolated temp directories.
  - Covers default paths, missing files, corrupted JSON backup (.bak), whitespace, standalone API, enqueue/dispatch/complete/sweepTimeouts/markCrashed persistence, process restart & state restoration, and controlService integration.
- Tests & checks: npm test (243/243 passing, 39 new assertions), npm run check (tsc strict checkJs) clean.

Files:
- src/service/store.js
- test/store.test.js

Left:
- Phase 1 step 5 follow-up: connect real control service queue to GET /api/queue and panel.
- Phase 2: WebSocket, xterm.js attach to live tmux sessions, permission question queue.

## Turn 6 — job antigravity-up-1 (node bin/harnet.js up, control service + panel daemon skeleton)

Task: implement node bin/harnet.js up command setting up queue, store, report reader, control service, and panel server with graceful Ctrl-C shutdown.
Commit: ebcc266 "feat(bin): add harnet up command for control service and web panel" (branch harnet/antigravity, untracked by push).

What changed:
- src/service/control.js:
  - Added setupControlService(options) wiring createQueue(), attachJobStore(), createReportReader(), createGroupRegistry(), and createControlService().
  - Preserved all existing function signatures and zero external/cross-layer import restrictions.
- bin/harnet.js:
  - Added startUp(options) helper configuring paths, setupControlService with parseTranscript, and startPanel({ queue: () => queue.all() }).
  - Added up command in CLI dispatcher with --port / -p option and graceful SIGINT / SIGTERM handler that saves the store and stops cleanly.
  - Updated help message and CLI execution wrapper.
- test/up.test.js:
  - 5 unit, in-process integration, and subprocess tests verifying service setup, existing jobs loading, transcript parsing via parseTranscript, GET /api/health (200 { status: "ok" }), live /api/queue updates, and SIGINT shutdown saving store to disk.
- Tests & checks: npm test (268/268 passing), npm run check (tsc strict checkJs) clean.

Files:
- bin/harnet.js
- src/service/control.js
- test/up.test.js

Left:
- Phase 1 step 5 follow-up: wire live agent adapters (Claude/Codex) into the control service when ready.
- Phase 2: WebSocket, xterm.js attach to live tmux sessions, permission question queue.

## Turn 7 — job antigravity-profiles-1 (agent templates and profiles manager, src/service/profiles.js)

Task: implement src/service/profiles.js managing agent templates and profiles (worktree + branch + tmux adapter spawn, abandon keeps worktree, remove drops worktree and branch by default).
Commit: dfa040a "feat(service): add agent profiles and templates manager" (branch harnet/antigravity, untracked by push).

What changed:
- src/service/profiles.js:
  - Added template definitions (DEFAULT_TEMPLATE, TEMPLATES: default, developer, reviewer, codex) defining role, defaultPrompt, capabilities, and harness ("claude" | "codex").
  - Implemented resolveTemplate() resolving template by name or partial object, defaulting to DEFAULT_TEMPLATE if omitted.
  - Implemented createProfileManager(options) accepting injected root and runner for mocking/tests without real git or tmux.
  - Implemented createProfile({ id, template, base }): opens worktree (.harnet/agents/<id>/wt) on branch (harnet/<id>) and spawns tmux session (harnet-<id>) via adapter.
  - Implemented openProfile({ id, template, base }): reconnects/ensures worktree and spawns a new session if dead.
  - Implemented abandonProfile({ id }): closes tmux session, preserves worktree and branch on disk, transitions state to "abandoned".
  - Implemented removeProfile({ id, force, deleteBranch }): closes session if alive, removes worktree and deletes branch by default (deleteBranch defaults to true, "varsayılan dalsız silme kapalı").
  - Exported standalone helper functions: createProfile, openProfile, abandonProfile, removeProfile.
- test/profiles.test.js:
  - 12 unit tests using in-memory fake runner testing template resolution, createProfile, custom base branch, codex template, abandonProfile session closure & worktree preservation, removeProfile worktree and branch deletion, deleteBranch override, profile listing, and standalone helper functions.
- Tests & checks: npm test (280/280 passing), npm run check (tsc strict checkJs) clean.

Files:
- src/service/profiles.js
- test/profiles.test.js

Left:
- Phase 1 step 5 follow-up: wire live agent adapters (Claude/Codex) into the control service when ready.
- Phase 2: WebSocket, xterm.js attach to live tmux sessions, permission question queue.

## Turn 8 — job antigravity-attach-1 (live terminal WebSocket attach, xterm.js UI)

Task: add live terminal attach to web panel: npm install ws (approved exception), WS /api/agents/<id>/term streaming pipe-pane tail and relaying keys via send-keys, "Bağlan" button on each agent card with xterm.js via CDN.
Commit: 9d87c77 "feat(panel): add live terminal WebSocket attach and xterm.js UI" (branch harnet/antigravity, untracked by push).

What changed:
- package.json & package-lock.json:
  - Added `ws` dependency (approved exception for panel) and `@types/ws` in devDependencies to maintain strict JSDoc/tsc check without errors.
- src/panel/server.js:
  - Added WebSocket server support on HTTP server upgrade event.
  - Added WS endpoint `/api/agents/<id>/term` streaming live `pane.log` output via `attachPaneTail` (polling fallback + fs.watch) and relaying incoming keystrokes to `harnet-<id>` tmux session via `sendTmuxKeys`.
  - Handled special keys (Enter, Backspace, arrows, Ctrl-C, Ctrl-D) and structured JSON envelopes in `sendTmuxKeys`.
  - Added `findPaneLogPath` helper with options override for test isolation.
  - Updated `renderHtml` to load xterm.js from CDN (CSS + JS script tags, zero npm package).
  - Added "Bağlan" toggle button on each agent card and expandable terminal container with live bidirectional WebSocket session.
- test/term.test.js:
  - 13 comprehensive unit and integration tests on real OS-assigned port.
  - Tested helper functions (`sessionName`, `findPaneLogPath`, `sendTmuxKeys`, `spawnRunner`), CDN script tags and "Bağlan" UI rendering, WebSocket handshake, initial pane.log streaming, real-time appended bytes streaming, `send-keys` relay via fake runner, late pane.log creation, 404 on invalid WS paths, and error handling without crashes.
- Tests & checks: npm test (298/298 passing, 18 new assertions), npm run check (tsc strict checkJs) clean.

Files:
- package.json
- package-lock.json
- src/panel/server.js
- test/term.test.js

Left:
- Phase 1 step 5 follow-up: wire live agent adapters (Claude/Codex) into the control service when ready.
- Phase 2 follow-up: permission question queue in panel.

