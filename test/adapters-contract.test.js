/**
 * Contract tests between the two adapters and the modules they touch but may
 * not import (src/MAP.js bans cross-imports):
 * - the real queue is injected here, so tsc checks every adapter's structural
 *   QueueLike against the real createQueue() at compile time;
 * - the status literals the adapters hand over are checked against JobStatus;
 * - session/log naming is checked against src/git/worktree.js.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createQueue, JobStatus } from "../src/service/queue.js";
import { sessionName as worktreeSessionName, transcriptDir } from "../src/git/worktree.js";
import {
  DONE_STATUS as CLAUDE_DONE,
  ERROR_STATUS as CLAUDE_ERROR,
  createClaudeAdapter,
  paneLogPath as claudeLogPath,
  sessionName as claudeSessionName,
} from "../src/adapters/claude.js";
import {
  DONE_STATUS as CODEX_DONE,
  ERROR_STATUS as CODEX_ERROR,
  createCodexAdapter,
  paneLogPath as codexLogPath,
  sessionName as codexSessionName,
} from "../src/adapters/codex.js";

const ROOT = "/repo";

/**
 * A tmux stand-in whose liveness the test can flip.
 * @param {{ alive: boolean }} state
 * @returns {import("../src/adapters/claude.js").Runner}
 */
function tmuxRun(state) {
  return (argv) => {
    const key = argv.join(" ");
    if (key.startsWith("tmux has-session")) {
      return { status: state.alive ? 0 : 1, stdout: "", stderr: "" };
    }
    if (key.startsWith("tmux new-session")) state.alive = true;
    if (key.startsWith("tmux kill-session")) state.alive = false;
    return { status: 0, stdout: "", stderr: "" };
  };
}

describe("adapter contract: shared shapes", () => {
  it("status literals match the queue", () => {
    assert.equal(CLAUDE_DONE, JobStatus.DONE);
    assert.equal(CLAUDE_ERROR, JobStatus.ERROR);
    assert.equal(CODEX_DONE, JobStatus.DONE);
    assert.equal(CODEX_ERROR, JobStatus.ERROR);
  });

  it("naming agrees with the worktree manager", () => {
    assert.equal(claudeSessionName("a1"), worktreeSessionName("a1"));
    assert.equal(codexSessionName("a1"), worktreeSessionName("a1"));
    assert.equal(claudeLogPath("a1"), `${transcriptDir("a1")}/pane.log`);
    assert.equal(codexLogPath("a1"), `${transcriptDir("a1")}/pane.log`);
  });

  it("both adapters expose the same surface", () => {
    const state = { alive: false };
    const claude = createClaudeAdapter({ root: ROOT, run: tmuxRun(state) });
    const codex = createCodexAdapter({ root: ROOT, run: tmuxRun(state) });
    const methods = /** @type {const} */ ([
      "bind",
      "calls",
      "handleNotification",
      "isAlive",
      "kill",
      "notifications",
      "sessions",
      "spawn",
      "sweepCrashes",
      "write",
    ]);
    for (const key of methods) {
      assert.equal(typeof claude[key], "function", `claude is missing ${key}`);
      assert.equal(typeof codex[key], "function", `codex is missing ${key}`);
    }
    assert.equal(typeof claude.handleStop, "function", "claude owns the Stop hook");
    assert.equal(typeof codex.handleNotify, "function", "codex owns the notify program");
    assert.equal(claude.harness, "claude");
    assert.equal(codex.harness, "codex");
  });
});

describe("adapter contract: full turn on the real queue", () => {
  it("spawn, write, then Stop completes the job and frees the agent", () => {
    const state = { alive: false };
    const queue = createQueue({ now: () => 500 });
    const adapter = createClaudeAdapter({ root: ROOT, run: tmuxRun(state), queue });

    const job = queue.enqueue({ agent: "a1", prompt: "first", from: "A" });
    queue.enqueue({ agent: "a1", prompt: "second", from: "A" });
    queue.dispatch("a1");

    const info = adapter.spawn({ agentId: "a1", worktree: ".harnet/agents/a1/wt" });
    assert.equal(info.session, "harnet-a1");
    adapter.write({ agentId: "a1", text: job.prompt });
    adapter.bind({ agentId: "a1", sessionId: "sess-1" });
    assert.equal(queue.isBusy("a1"), true);

    const stopped = adapter.handleStop({ session_id: "sess-1", transcript_path: "/repo/t.jsonl" });
    assert.equal(stopped.matched, true);
    assert.equal(queue.get(job.id)?.status, JobStatus.DONE);

    // the queued second job can start now
    const next = queue.dispatch("a1");
    assert.ok(next);
    assert.equal(next.prompt, "second");
    assert.equal(queue.isBusy("a1"), true);
  });

  it("spawn, write, then notify completes the job", () => {
    const state = { alive: false };
    const queue = createQueue({ now: () => 500 });
    const adapter = createCodexAdapter({ root: ROOT, run: tmuxRun(state), queue });

    const job = queue.enqueue({ agent: "b1", prompt: "first" });
    queue.dispatch("b1");
    adapter.spawn({ agentId: "b1", worktree: ".harnet/agents/b1/wt" });
    adapter.write({ agentId: "b1", text: job.prompt });
    adapter.bind({ agentId: "b1", sessionId: "thread-1" });

    const done = adapter.handleNotify({
      type: "agent-turn-complete",
      thread_id: "thread-1",
      last_assistant_message: "shipped",
    });
    assert.equal(done.matched, true);
    assert.equal(queue.get(job.id)?.report, "shipped");
    assert.equal(queue.isBusy("b1"), false);
  });

  it("both harnesses crash the same way", () => {
    const claudeState = { alive: false };
    const codexState = { alive: false };
    const queue = createQueue({ now: () => 500 });
    const claude = createClaudeAdapter({ root: ROOT, run: tmuxRun(claudeState), queue });
    const codex = createCodexAdapter({ root: ROOT, run: tmuxRun(codexState), queue });

    const claudeJob = queue.enqueue({ agent: "a1", prompt: "x" });
    const codexJob = queue.enqueue({ agent: "b1", prompt: "y" });
    queue.dispatch("a1");
    queue.dispatch("b1");
    claude.spawn({ agentId: "a1", worktree: ".harnet/agents/a1/wt" });
    codex.spawn({ agentId: "b1", worktree: ".harnet/agents/b1/wt" });

    claudeState.alive = false;
    codexState.alive = false;
    assert.equal(claude.sweepCrashes().length, 1);
    assert.equal(codex.sweepCrashes().length, 1);
    assert.equal(queue.get(claudeJob.id)?.status, JobStatus.CRASHED);
    assert.equal(queue.get(codexJob.id)?.status, JobStatus.CRASHED);
    assert.deepEqual(queue.busyAgents(), []);
  });

  it("a permission prompt is a queue entry, not a job result, for both", () => {
    const state = { alive: true };
    const queue = createQueue({ now: () => 500 });
    const claude = createClaudeAdapter({ root: ROOT, run: tmuxRun(state), queue });
    const codex = createCodexAdapter({ root: ROOT, run: tmuxRun(state), queue });

    const claudeJob = queue.enqueue({ agent: "a1", prompt: "x" });
    const codexJob = queue.enqueue({ agent: "b1", prompt: "y" });
    queue.dispatch("a1");
    queue.dispatch("b1");
    claude.bind({ agentId: "a1", sessionId: "sess-1" });
    codex.bind({ agentId: "b1", sessionId: "thread-1" });

    claude.handleNotification({ session_id: "sess-1", message: "needs permission" });
    codex.handleNotification({ thread_id: "thread-1", message: "needs approval" });

    assert.equal(queue.get(claudeJob.id)?.status, JobStatus.RUNNING);
    assert.equal(queue.get(codexJob.id)?.status, JobStatus.RUNNING);
    assert.deepEqual(queue.busyAgents().sort(), ["a1", "b1"]);
    assert.equal(claude.notifications().length, 1);
    assert.equal(codex.notifications().length, 1);
    assert.equal(claude.notifications()[0].kind, "permission");
    assert.equal(codex.notifications()[0].kind, "permission");
  });

  it("a turn that ends in error still produces a result", () => {
    const state = { alive: true };
    const queue = createQueue({ now: () => 500 });
    const claude = createClaudeAdapter({ root: ROOT, run: tmuxRun(state), queue });
    const claudeJob = queue.enqueue({ agent: "a1", prompt: "x" });
    queue.dispatch("a1");
    claude.bind({ agentId: "a1", sessionId: "sess-1" });

    const result = claude.handleStop({ session_id: "sess-1", status: "error" });
    assert.equal(result.status, JobStatus.ERROR);
    assert.equal(queue.get(claudeJob.id)?.status, JobStatus.ERROR);
    assert.equal(queue.isBusy("a1"), false);
  });
});
