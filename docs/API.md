# Harnet Modül API Özeti

### queue (`src/service/queue.js`)
`createQueue(opts)`: `{ enqueue(spec), dispatch(agent), complete(spec), sweepTimeouts(spec?), markCrashed(spec), isBusy(agent), runningJob(agent), pending(agent?), running(), all(), get(id) }`
`JobStatus`: `QUEUED | RUNNING | DONE | ERROR | TIMEOUT | CRASHED | REFUSED`; `isTerminalStatus(status): boolean`
Ajan meşguliyet durumlarını, çağrı derinliği sınırını ve zaman aşımlarını takip eden bellek-içi iş kuyruğu sağlar.

### jobs (`src/service/jobs.js`)
`createGroupRegistry(opts)`: `{ open(spec?), addJob(groupId, jobId), record(groupId, jobId, result), isReady(groupId), collect(groupId), pendingJobs(groupId), get(groupId) }`
`buildResult(spec): Result`, `formatResult(res): string`, `wakeupFor(group): string`, `formatGroupWakeup(opts): string`, `formatElapsed(ms): string`
`ResultStatus`: `DONE | ERROR | TIMEOUT | CRASHED | REFUSED`; `isTerminalStatus(status): boolean`
Bir turdaki çocuk işleri sonuç gruplarında toplar ve tümü tamamlandığında ebeveyn ajana tek bir uyandırma mesajı oluşturur.

### store (`src/service/store.js`)
`createJobStore(opts)`: `{ load(), save(jobs?), all(), get(id), add(job), update(id, patch), remove(id), clear(), attach(queue), restore(queue), filePath, backupPath }`
`attachJobStore(queue, opts)` / `createPersistentQueue(queue, opts)`, `loadJobs(path, opts)`, `saveJobs(path, jobs, opts)`, `restoreJobs(queue, storedJobs)`
İş kuyruğunu `.harnet/state/jobs.json` üzerinde atomik olarak kalıcılaştırır, bozulma anında yedekler (`.bak`) ve kuyruk mutasyonlarını otomatik senkronize eder.

### control (`src/service/control.js`)
`createControlService({ queue, groups, adapters })`: `{ submit(spec), submitGroup(spec), dispatch(agent), complete(spec), handleSignal(spec), sweepTimeouts(spec?), markCrashed(spec), sweepCrashes(), wakeups() }`
Kuyruk, sonuç grupları ve adaptörleri birbirine bağlayarak iş dağıtımını, tamamlama sinyallerini ve ebeveyn uyandırma akışını koordine eder.

### report (`src/service/report.js`)
`createReportReader({ parse, readFile?, flushTimeoutMs?, pollMs?, now?, sleep?, onAttempt? })`: `(ctx: { transcriptPath, agentId?, payload? }) => string|null`
`lastMessageFromPayload(payload): string|null`, `readFileOrNull(path): string|null`, `DEFAULT_FLUSH_TIMEOUT_MS = 2000`, `DEFAULT_POLL_MS = 50`
Stop sinyali sonrası diske henüz yazılmamış transcriptleri kısa süreli yoklar (polling) ve gerektiğinde sinyal yükündeki son mesaj yedeğiyle iş raporunu üretir.

### worktree (`src/git/worktree.js`)
`createWorktreeManager(opts)`: `{ open({ agentId, base?, session? }), list(), abandon({ agentId, session? }), remove({ agentId, force?, deleteBranch? }), branchExists(branch) }`
`worktreePath(agentId)`, `branchName(agentId)`, `sessionName(agentId)`, `transcriptDir(agentId)`, `parseWorktreeList(porcelain)`
Her profil için `.harnet/agents/<id>/wt` altında kalıcı git worktree ve `harnet/<id>` dalı açar, oturumları sonlandırır veya temizler.

### deliver (`src/git/deliver.js`)
`createDeliveryManager(opts)`: `{ deliver({ childBranch, parentBranch, message?, noFf?, autoCheckout? }), abortMerge(), currentBranch(), branchExists(branch), conflictFiles() }`
`deliveryPlan({ childBranch, parentBranch }): string`, `mergeMessage(childBranch, parentBranch): string`
Çocuk dalı ebeveyne `git merge` ile teslim eder; çakışma durumunda dosyaları kaydedip birleşmeyi iptal (`merge --abort`) ederek raporlar.

### adapters (`src/adapters/claude.js`, `src/adapters/codex.js`)
`createClaudeAdapter(opts)` / `createCodexAdapter(opts)`: `{ spawn(spec), write(spec), kill(spec), isAlive(agent), sweepCrashes(), bind(spec), handleStop(p) | handleNotify(p), handleNotification(p) }`
`CLAUDE`: `{ spawn: "claude", write: "tmux send-keys", doneSignal: "Stop hook", log: "transcript .jsonl" }`; `CODEX`: `{ spawn: "codex", ... }`
Ajanları izole tmux oturumlarında çalıştırır, `send-keys` ile yazar ve harness sinyallerini (`Stop` hook veya `notify`) iş sonucuna dönüştürür.

### transcript (`src/observe/transcript.js`)
`readTranscript(filePath): Promise<TranscriptSummary>`, `parseTranscript(text): TranscriptSummary`, `parseLine(raw, line?)`, `summarizeUsage(blocks)`
`TranscriptSummary`: `{ messages, toolCalls, toolCounts, usage: { input, output, cacheWrite, cacheRead, total }, lines, parsed, skipped, sessionId, lastMessage }`
Harness transcript jsonl kayıtlarını satır satır okuyup mesaj, araç kullanımı ve maliyetsiz (sadece token sayaçları) kullanım özetini çıkarır.

### panel (`src/panel/server.js`)
`createServer(opts): http.Server` (rotalar: `GET /`, `GET /api/health`, `GET /api/agents`, `GET /api/queue`)
`start(opts): Promise<{ server, port, close }>` (varsayılan port 3000), `readAgents(agentsDir)`, `renderHtml(agents, queue)`, `findAgentsDir(baseDir)`
Sıfır dış bağımlılıkla yerleşik HTTP sunucusu üzerinden ajan belleklerini ve iş kuyruğunu salt-okunur web arayüzünde sunar.

### CLI (`bin/harnet.js`)
`run(argv?): number`, `buildStatusTable(opts?): string`, `parseState(content)`, `readAgents(agentsDir)`, `getStatusRows(agents, state)`
Komut: `node bin/harnet.js status`
`STATE.md` ve ajan `MEMORY.md` dosyalarını salt-okunur okuyarak aktif ajanları ve açık işleri terminalde kutu çizimli tablo olarak listeler.

### live-spike (`scripts/live-spike.sh`)
Kullanım: `scripts/live-spike.sh [claude|codex]` (seçenekler: `KEEP=1`, `BOOT_TIMEOUT=45`, `SIGNAL_TIMEOUT=120`)
İzole tmux soketinde (`-L harnet-spike`) canlı TUI açarak send-keys -> Stop/notify -> jsonl zincirini uçtan uca doğrulayan manuel spike betiği.
