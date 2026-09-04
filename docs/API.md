# Harnet Modül API Özeti

### queue (`src/service/queue.js`)
`createQueue(opts)`: `{ enqueue(spec), dispatch(agent), complete(id, status, report), timeout(id, now), sweepTimeouts(now), markCrashed(agent, report), isBusy(agent), get(id), pending(), running(), list() }`
`JobStatus`: `QUEUED | RUNNING | DONE | ERROR | TIMEOUT | CRASHED | REFUSED`; `isTerminalStatus(status): boolean`

### jobs (`src/service/jobs.js`)
`createGroupRegistry(opts)`: `{ open(groupId, expected), record(groupId, result), isReady(groupId), collect(groupId), pendingJobs(groupId) }`
`buildResult(spec): Result`, `formatResult(res): string`, `wakeupFor(group): string`, `formatGroupWakeup(opts): string`, `formatElapsed(ms): string`
`ResultStatus`: `DONE | ERROR | TIMEOUT | CRASHED | REFUSED`; `isTerminalStatus(status): boolean`

### worktree (`src/git/worktree.js`)
`createWorktreeManager(opts)`: `{ open({ agentId, base? }), list(), abandon({ agentId, session? }), remove({ agentId, force?, deleteBranch? }), branchExists(branch) }`
`worktreePath(agentId)`, `branchName(agentId)`, `sessionName(agentId)`, `transcriptDir(agentId)`, `parseWorktreeList(porcelain)`

### deliver (`src/git/deliver.js`)
`createDeliveryManager(opts)`: `{ deliver({ childBranch, parentBranch, message? }), abortMerge(), currentBranch(), branchExists(branch), conflictFiles() }`
`deliveryPlan({ childBranch, parentBranch }): string`, `mergeMessage(childBranch, parentBranch): string`

### adapters (`src/adapters/claude.js`, `src/adapters/codex.js`)
`CLAUDE`: `{ spawn: "claude", write: "tmux send-keys", doneSignal: "Stop hook", log: "transcript .jsonl" }`
`CODEX`: `{ spawn: "codex", write: "tmux send-keys", doneSignal: "notify program", log: "rollout .jsonl" }`

### transcript (`src/observe/transcript.js`)
`summarizeUsage(blocks: Array<{ tokens?: number }>): { tokens: number }`

### panel (`src/panel/server.js`)
`createServer(opts): http.Server` (rotalar: `GET /`, `GET /api/health`, `GET /api/agents`, `GET /api/queue`)
`start(opts): Promise<{ server, port, close }>` (varsayılan port 3000), `readAgents(agentsDir)`, `renderHtml(agents, queue)`, `PANEL_ROUTE = "/"`
