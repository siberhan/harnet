import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createQueue, JobStatus } from "../src/service/queue.js";
import { runnerFor } from "./fake-runner.js";
import {
  CLAUDE,
  AdapterError,
  createClaudeAdapter,
  paneLogPath,
  sessionName,
  shQuote,
} from "../src/adapters/claude.js";

const ROOT = "/repo";

/** Routes used by most tests: the session exists. */
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
  // clone: tests mutate routes to flip session liveness, and ALIVE is shared
  const live = { ...routes };
  const adapter = createClaudeAdapter({
    root: ROOT,
    run: runnerFor(live, sink),
    queue,
  });
  return { adapter, sink, routes: live };
}

/**
 * A queue with one running job for `agentId`.
 * @param {string} agentId
 */
function withRunningJob(agentId) {
  const queue = createQueue({ now: () => 1000 });
  const job = queue.enqueue({ agent: agentId, prompt: "do the thing", from: "A" });
  queue.dispatch(agentId);
  return { queue, job };
}

describe("claude: naming", () => {
  it("keeps the README table", () => {
    assert.equal(CLAUDE.spawn, "claude");
    assert.equal(CLAUDE.write, "tmux send-keys");
    assert.equal(CLAUDE.doneSignal, "Stop hook");
    assert.equal(CLAUDE.log, "transcript .jsonl");
  });

  it("derives session name and log path from the agent id", () => {
    assert.equal(sessionName("a1"), "harnet-a1");
    assert.equal(paneLogPath("a1"), ".harnet/agents/a1/pane.log");
  });

  it("quotes the log path for the tmux shell", () => {
    assert.equal(shQuote("/repo/plain.log"), "'/repo/plain.log'");
    assert.equal(shQuote("/repo/with space/pane.log"), "'/repo/with space/pane.log'");
    assert.equal(shQuote("/repo/it's.log"), "'/repo/it'\\''s.log'");
  });
});

describe("claude: spawn", () => {
  it("opens the session and attaches the byte log before output starts", () => {
    const { adapter, sink } = setup({
      "tmux has-session": { status: 1 },
      "tmux new-session": {},
      "tmux pipe-pane": {},
    });
    const info = adapter.spawn({ agentId: "a1", worktree: ".harnet/agents/a1/wt" });

    assert.equal(info.agentId, "a1");
    assert.equal(info.session, "harnet-a1");
    assert.equal(info.command, "claude");
    assert.equal(info.logPath, ".harnet/agents/a1/pane.log");
    assert.equal(info.absoluteLogPath, "/repo/.harnet/agents/a1/pane.log");
    assert.equal(info.dead, false);

    assert.deepEqual(sink.calls, [
      `${ROOT} :: tmux has-session -t harnet-a1`,
      `${ROOT} :: tmux new-session -d -s harnet-a1 -c .harnet/agents/a1/wt claude`,
      `${ROOT} :: tmux pipe-pane -t harnet-a1 -o cat >> '/repo/.harnet/agents/a1/pane.log'`,
    ]);
  });

  it("registers the session so crashes can be swept later", () => {
    const { adapter } = setup({
      "tmux has-session": { status: 1 },
      "tmux new-session": {},
      "tmux pipe-pane": {},
    });
    adapter.spawn({ agentId: "a1", worktree: ".harnet/agents/a1/wt" });
    assert.equal(adapter.sessions().length, 1);
    assert.equal(adapter.sessions()[0].session, "harnet-a1");
  });

  it("refuses a second session: there is only ever one writer", () => {
    const { adapter, sink } = setup();
    assert.throws(() => adapter.spawn({ agentId: "a1", worktree: ".harnet/agents/a1/wt" }), {
      name: "AdapterError",
      message: /tmux session already exists: harnet-a1/,
    });
    assert.deepEqual(sink.calls, [`${ROOT} :: tmux has-session -t harnet-a1`]);
  });

  it("turns a spawn failure into an AdapterError and registers nothing", () => {
    const { adapter } = setup({
      "tmux has-session": { status: 1 },
      "tmux new-session": { status: 1, stderr: "no server running on /tmp/tmux-501/default" },
    });
    let caught = null;
    try {
      adapter.spawn({ agentId: "a1", worktree: ".harnet/agents/a1/wt" });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof AdapterError);
    assert.equal(caught.code, 1);
    assert.equal(caught.cwd, ROOT);
    assert.match(caught.message, /no server running/);
    assert.match(caught.stderr, /no server running/);
    assert.equal(adapter.sessions().length, 0);
  });
});

describe("claude: write", () => {
  it("types the prompt literally and presses enter", () => {
    const { adapter, sink } = setup();
    const res = adapter.write({ agentId: "a1", text: "fix the tests\nrm -rf /" });
    assert.deepEqual(res, { agentId: "a1", session: "harnet-a1", chars: 21 });
    assert.deepEqual(sink.calls, [
      `${ROOT} :: tmux has-session -t harnet-a1`,
      `${ROOT} :: tmux send-keys -t harnet-a1 -l -- fix the tests\nrm -rf /`,
      `${ROOT} :: tmux send-keys -t harnet-a1 Enter`,
    ]);
  });

  it("refuses to write to a dead session", () => {
    const { adapter } = setup({ "tmux has-session": { status: 1 } });
    assert.throws(() => adapter.write({ agentId: "a1", text: "hello" }), {
      name: "AdapterError",
      message: /tmux session is gone: harnet-a1/,
    });
  });

  it("isAlive and kill report the session state", () => {
    const { adapter, routes } = setup();
    assert.equal(adapter.isAlive("a1"), true);
    assert.equal(adapter.kill({ agentId: "a1" }), true);
    routes["tmux has-session"] = { status: 1 };
    assert.equal(adapter.isAlive("a1"), false);
    assert.equal(adapter.kill({ agentId: "a1" }), false, "killing a dead session is a no-op");
  });
});

describe("claude: Stop hook", () => {
  it("completes the running job as done", () => {
    const { queue, job } = withRunningJob("a1");
    const { adapter } = setup(ALIVE, queue);
    adapter.bind({ agentId: "a1", sessionId: "sess-abc" });

    const result = adapter.handleStop({
      hook_event_name: "Stop",
      session_id: "sess-abc",
      transcript_path: "/repo/.harnet/agents/a1/transcript.jsonl",
    });

    assert.equal(result.matched, true);
    assert.equal(result.agentId, "a1");
    assert.equal(result.jobId, job.id);
    assert.equal(result.status, "done");
    assert.equal(queue.get(job.id)?.status, JobStatus.DONE);
    assert.equal(queue.isBusy("a1"), false, "Stop frees the agent");
  });

  it("completes as error only when the payload says so", () => {
    const { queue, job } = withRunningJob("a1");
    const { adapter } = setup(ALIVE, queue);
    adapter.bind({ agentId: "a1", sessionId: "sess-abc" });

    const result = adapter.handleStop({ session_id: "sess-abc", status: "error" });
    assert.equal(result.status, "error");
    assert.equal(queue.get(job.id)?.status, JobStatus.ERROR);
  });

  it("uses the injected transcript reader for the report", () => {
    const { queue, job } = withRunningJob("a1");
    const adapter = createClaudeAdapter({
      root: ROOT,
      run: runnerFor(ALIVE),
      queue,
      readReport: ({ transcriptPath, agentId }) => `read ${transcriptPath} for ${agentId}`,
    });
    adapter.bind({ agentId: "a1", sessionId: "sess-abc" });
    const result = adapter.handleStop({
      session_id: "sess-abc",
      transcript_path: "/repo/t.jsonl",
    });
    assert.equal(result.report, "read /repo/t.jsonl for a1");
    assert.equal(queue.get(job.id)?.report, "read /repo/t.jsonl for a1");
  });

  it("ignores a signal from an unknown session", () => {
    const { queue, job } = withRunningJob("a1");
    const { adapter } = setup(ALIVE, queue);
    const result = adapter.handleStop({ session_id: "sess-unknown" });
    assert.equal(result.matched, false);
    assert.match(result.reason ?? "", /unknown session id: sess-unknown/);
    assert.equal(queue.get(job.id)?.status, JobStatus.RUNNING, "job untouched");
  });

  it("ignores a signal when the agent has no running job", () => {
    const queue = createQueue({ now: () => 1 });
    const { adapter } = setup(ALIVE, queue);
    adapter.bind({ agentId: "a1", sessionId: "sess-abc" });
    const result = adapter.handleStop({ session_id: "sess-abc" });
    assert.equal(result.matched, false);
    assert.match(result.reason ?? "", /no running job for a1/);
  });

  it("reports when no queue is wired", () => {
    const { adapter } = setup();
    adapter.bind({ agentId: "a1", sessionId: "sess-abc" });
    const result = adapter.handleStop({ session_id: "sess-abc" });
    assert.equal(result.matched, false);
    assert.match(result.reason ?? "", /no queue wired/);
  });

  it("accepts an explicit agentId when the hook config carries one", () => {
    const { queue, job } = withRunningJob("a1");
    const { adapter } = setup(ALIVE, queue);
    const result = adapter.handleStop({ agentId: "a1" });
    assert.equal(result.matched, true);
    assert.equal(queue.get(job.id)?.status, JobStatus.DONE);
  });
});

describe("claude: Notification hook", () => {
  it("records a permission entry without ending the job", () => {
    const { queue, job } = withRunningJob("a1");
    const { adapter } = setup(ALIVE, queue);
    adapter.bind({ agentId: "a1", sessionId: "sess-abc" });
    const entry = adapter.handleNotification({
      hook_event_name: "Notification",
      session_id: "sess-abc",
      message: "Claude needs permission to run: npm test",
    });

    assert.equal(entry.kind, "permission");
    assert.equal(entry.agentId, "a1");
    assert.equal(entry.sessionId, "sess-abc");
    assert.equal(entry.message, "Claude needs permission to run: npm test");
    assert.equal(queue.get(job.id)?.status, JobStatus.RUNNING, "job keeps running");
    assert.equal(queue.isBusy("a1"), true);
    assert.equal(adapter.notifications().length, 1);
  });

  it("calls the notification hook when one is wired", () => {
    const { queue } = withRunningJob("a1");
    /** @type {string[]} */
    const seen = [];
    const adapter = createClaudeAdapter({
      root: ROOT,
      run: runnerFor(ALIVE),
      queue,
      onNotification: (entry) => seen.push(entry.message),
    });
    adapter.handleNotification({ session_id: "sess-abc", message: "needs approval" });
    assert.deepEqual(seen, ["needs approval"]);
  });
});

describe("claude: crashes", () => {
  it("turns a dead session into a crashed job, once", () => {
    const { queue, job } = withRunningJob("a1");
    const routes = { ...ALIVE, "tmux has-session": { status: 1 } };
    const adapter = createClaudeAdapter({ root: ROOT, run: runnerFor(routes), queue });

    // session comes up, job runs, then the tmux session dies
    routes["tmux has-session"] = { status: 0 };
    adapter.spawn({ agentId: "a1", worktree: ".harnet/agents/a1/wt" });
    routes["tmux has-session"] = { status: 1 };

    const first = adapter.sweepCrashes();
    assert.equal(first.length, 1);
    assert.equal(first[0].agentId, "a1");
    assert.equal(queue.get(job.id)?.status, JobStatus.CRASHED);
    assert.match(queue.get(job.id)?.report ?? "", /tmux session harnet-a1 is gone/);
    assert.equal(queue.isBusy("a1"), false);

    assert.deepEqual(adapter.sweepCrashes(), [], "a dead session is reported once");
  });

  it("does nothing while every session is alive", () => {
    const { queue } = withRunningJob("a1");
    const adapter = createClaudeAdapter({ root: ROOT, run: runnerFor(ALIVE), queue });
    assert.deepEqual(adapter.sweepCrashes(), [], "no sessions registered yet");
    adapter.spawn({ agentId: "a1", worktree: ".harnet/agents/a1/wt" });
    assert.deepEqual(adapter.sweepCrashes(), [], "session is alive");
  });

  it("logs every command, including failed ones", () => {
    const { adapter } = setup({ "tmux has-session": { status: 1 } });
    assert.throws(() => adapter.write({ agentId: "a1", text: "hi" }));
    const calls = adapter.calls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].ok, true, "the has-session probe itself succeeded");
    assert.deepEqual(calls[0].argv, ["tmux", "has-session", "-t", "harnet-a1"]);
    assert.equal(calls[0].cwd, ROOT);
  });
});
