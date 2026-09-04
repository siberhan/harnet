import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createQueue, JobStatus } from "../src/service/queue.js";
import { runnerFor } from "./fake-runner.js";
import {
  CODEX,
  AdapterError,
  createCodexAdapter,
  isApprovalRequest,
  paneLogPath,
  sessionName,
  shQuote,
} from "../src/adapters/codex.js";

const ROOT = "/repo";

const ALIVE = {
  "tmux has-session": { status: 0 },
  "tmux new-session": {},
  "tmux pipe-pane": {},
  "tmux send-keys": {},
  "tmux kill-session": {},
};

/**
 * @param {Record<string, import("./fake-runner.js").FakeResponse>} [routes]
 * @param {ReturnType<typeof createQueue>|null} [queue]
 */
function setup(routes = ALIVE, queue = null) {
  /** @type {{ calls: string[] }} */
  const sink = { calls: [] };
  const live = { ...routes };
  const adapter = createCodexAdapter({ root: ROOT, run: runnerFor(live, sink), queue });
  return { adapter, sink, routes: live };
}

/**
 * @param {string} agentId
 */
function withRunningJob(agentId) {
  const queue = createQueue({ now: () => 1000 });
  const job = queue.enqueue({ agent: agentId, prompt: "do the thing", from: "A" });
  queue.dispatch(agentId);
  return { queue, job };
}

describe("codex: naming", () => {
  it("keeps the README table", () => {
    assert.equal(CODEX.spawn, "codex");
    assert.equal(CODEX.write, "tmux send-keys");
    assert.equal(CODEX.doneSignal, "notify program");
    assert.equal(CODEX.log, "rollout .jsonl");
  });

  it("matches the claude adapter layout", () => {
    assert.equal(sessionName("a1"), "harnet-a1");
    assert.equal(paneLogPath("a1"), ".harnet/agents/a1/pane.log");
    assert.equal(shQuote("/repo/a b.log"), "'/repo/a b.log'");
  });
});

describe("codex: spawn and write", () => {
  it("opens the session and attaches the byte log before output starts", () => {
    const { adapter, sink } = setup({
      "tmux has-session": { status: 1 },
      "tmux new-session": {},
      "tmux pipe-pane": {},
    });
    const info = adapter.spawn({ agentId: "b1", worktree: ".harnet/agents/b1/wt" });
    assert.equal(info.command, "codex");
    assert.equal(info.session, "harnet-b1");
    assert.equal(info.absoluteLogPath, "/repo/.harnet/agents/b1/pane.log");
    assert.deepEqual(sink.calls, [
      `${ROOT} :: tmux has-session -t harnet-b1`,
      `${ROOT} :: tmux new-session -d -s harnet-b1 -c .harnet/agents/b1/wt codex`,
      `${ROOT} :: tmux pipe-pane -t harnet-b1 -o cat >> '/repo/.harnet/agents/b1/pane.log'`,
    ]);
  });

  it("refuses a duplicate session", () => {
    const { adapter } = setup();
    assert.throws(() => adapter.spawn({ agentId: "b1", worktree: ".harnet/agents/b1/wt" }), {
      name: "AdapterError",
      message: /tmux session already exists: harnet-b1/,
    });
  });

  it("types the prompt literally and presses enter", () => {
    const { adapter, sink } = setup();
    const res = adapter.write({ agentId: "b1", text: "run the suite" });
    assert.equal(res.chars, 13);
    assert.deepEqual(sink.calls, [
      `${ROOT} :: tmux has-session -t harnet-b1`,
      `${ROOT} :: tmux send-keys -t harnet-b1 -l -- run the suite`,
      `${ROOT} :: tmux send-keys -t harnet-b1 Enter`,
    ]);
  });

  it("refuses to write to a dead session", () => {
    const { adapter } = setup({ "tmux has-session": { status: 1 } });
    assert.throws(() => adapter.write({ agentId: "b1", text: "hi" }), {
      name: "AdapterError",
      message: /tmux session is gone: harnet-b1/,
    });
  });

  it("kill closes the session", () => {
    const { adapter, routes } = setup();
    assert.equal(adapter.kill({ agentId: "b1" }), true);
    routes["tmux has-session"] = { status: 1 };
    assert.equal(adapter.kill({ agentId: "b1" }), false);
    assert.equal(adapter.isAlive("b1"), false);
  });
});

describe("codex: notify", () => {
  it("completes the running job with the last assistant message", () => {
    const { queue, job } = withRunningJob("b1");
    const { adapter } = setup(ALIVE, queue);
    adapter.bind({ agentId: "b1", sessionId: "thread-9" });

    const result = adapter.handleNotify({
      type: "agent-turn-complete",
      thread_id: "thread-9",
      last_assistant_message: "all tests pass",
    });

    assert.equal(result.matched, true);
    assert.equal(result.agentId, "b1");
    assert.equal(result.jobId, job.id);
    assert.equal(result.status, "done");
    assert.equal(result.report, "all tests pass", "notify carries the report itself");
    assert.equal(queue.get(job.id)?.status, JobStatus.DONE);
    assert.equal(queue.isBusy("b1"), false);
  });

  it("accepts session_id as an alias for thread_id", () => {
    const { queue, job } = withRunningJob("b1");
    const { adapter } = setup(ALIVE, queue);
    adapter.bind({ agentId: "b1", sessionId: "thread-9" });
    const result = adapter.handleNotify({
      type: "agent-turn-complete",
      session_id: "thread-9",
      last_assistant_message: "done",
    });
    assert.equal(result.matched, true);
    assert.equal(queue.get(job.id)?.status, JobStatus.DONE);
  });

  it("completes as error only when the payload says so", () => {
    const { queue, job } = withRunningJob("b1");
    const { adapter } = setup(ALIVE, queue);
    adapter.bind({ agentId: "b1", sessionId: "thread-9" });
    const result = adapter.handleNotify({
      type: "agent-turn-complete",
      thread_id: "thread-9",
      status: "error",
    });
    assert.equal(result.status, "error");
    assert.equal(queue.get(job.id)?.status, JobStatus.ERROR);
  });

  it("falls back to the injected reader when notify carries no message", () => {
    const { queue, job } = withRunningJob("b1");
    const adapter = createCodexAdapter({
      root: ROOT,
      run: runnerFor(ALIVE),
      queue,
      readReport: ({ agentId }) => `rollout of ${agentId}`,
    });
    adapter.bind({ agentId: "b1", sessionId: "thread-9" });
    const result = adapter.handleNotify({ type: "agent-turn-complete", thread_id: "thread-9" });
    assert.equal(result.report, "rollout of b1");
    assert.equal(queue.get(job.id)?.report, "rollout of b1");
  });

  it("ignores anything that is not a turn-complete notification", () => {
    const { queue, job } = withRunningJob("b1");
    const { adapter } = setup(ALIVE, queue);
    adapter.bind({ agentId: "b1", sessionId: "thread-9" });
    const result = adapter.handleNotify({ type: "something-else", thread_id: "thread-9" });
    assert.equal(result.matched, false);
    assert.match(result.reason ?? "", /not a turn-complete signal: something-else/);
    assert.equal(queue.get(job.id)?.status, JobStatus.RUNNING);
  });

  it("ignores an unknown thread and an idle agent", () => {
    const { queue, job } = withRunningJob("b1");
    const { adapter } = setup(ALIVE, queue);
    assert.match(
      adapter.handleNotify({ type: "agent-turn-complete", thread_id: "nope" }).reason ?? "",
      /unknown thread id: nope/,
    );
    adapter.bind({ agentId: "idle", sessionId: "thread-0" });
    assert.match(
      adapter.handleNotify({ type: "agent-turn-complete", thread_id: "thread-0" }).reason ?? "",
      /no running job for idle/,
    );
    assert.equal(queue.get(job.id)?.status, JobStatus.RUNNING);
  });

  it("reports when no queue is wired", () => {
    const { adapter } = setup();
    adapter.bind({ agentId: "b1", sessionId: "thread-9" });
    assert.match(
      adapter.handleNotify({ type: "agent-turn-complete", thread_id: "thread-9" }).reason ?? "",
      /no queue wired/,
    );
  });
});

describe("codex: approvals", () => {
  it("recognises an approval request", () => {
    assert.equal(isApprovalRequest({ type: "approval-required" }), true);
    assert.equal(isApprovalRequest({ approval: true }), true);
    assert.equal(isApprovalRequest({ type: "agent-turn-complete" }), false);
  });

  it("a permission request becomes its own queue entry, not a job result", () => {
    const { queue, job } = withRunningJob("b1");
    /** @type {string[]} */
    const seen = [];
    const adapter = createCodexAdapter({
      root: ROOT,
      run: runnerFor(ALIVE),
      queue,
      onNotification: (entry) => seen.push(entry.message),
    });
    adapter.bind({ agentId: "b1", sessionId: "thread-9" });

    const entry = adapter.handleNotification({
      type: "approval-required",
      thread_id: "thread-9",
      message: "Codex wants to run: rm -rf node_modules",
    });

    assert.equal(entry.kind, "permission");
    assert.equal(entry.agentId, "b1");
    assert.equal(entry.sessionId, "thread-9");
    assert.deepEqual(seen, ["Codex wants to run: rm -rf node_modules"]);
    assert.equal(queue.get(job.id)?.status, JobStatus.RUNNING, "job keeps running");
    assert.equal(queue.isBusy("b1"), true);
  });
});

describe("codex: crashes", () => {
  it("turns a dead session into a crashed job, once", () => {
    const { queue, job } = withRunningJob("b1");
    const routes = { ...ALIVE, "tmux has-session": { status: 1 } };
    const adapter = createCodexAdapter({ root: ROOT, run: runnerFor(routes), queue });
    adapter.spawn({ agentId: "b1", worktree: ".harnet/agents/b1/wt" });

    routes["tmux has-session"] = { status: 1 };
    const first = adapter.sweepCrashes();
    assert.equal(first.length, 1);
    assert.equal(first[0].agentId, "b1");
    assert.equal(queue.get(job.id)?.status, JobStatus.CRASHED);
    assert.match(queue.get(job.id)?.report ?? "", /tmux session harnet-b1 is gone/);
    assert.deepEqual(adapter.sweepCrashes(), []);
  });

  it("logs every command with cwd and status", () => {
    const { adapter } = setup();
    adapter.write({ agentId: "b1", text: "hi" });
    const calls = adapter.calls();
    assert.equal(calls.length, 3);
    assert.ok(calls.every((c) => c.cwd === ROOT && c.ok));
    assert.deepEqual(calls[0].argv, ["tmux", "has-session", "-t", "harnet-b1"]);
  });
});
