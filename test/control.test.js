import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createClaudeAdapter } from "../src/adapters/claude.js";
import { createControlService } from "../src/service/control.js";
import { createGroupRegistry } from "../src/service/jobs.js";
import { createQueue, JobStatus } from "../src/service/queue.js";

/**
 * @param {{ failWrites?: boolean }} [options]
 */
function fakeAdapter(options = {}) {
  /** @type {Array<{ agentId: string, text: string }>} */
  const writes = [];
  /** @type {Array<{ agentId: string }>} */
  let crashes = [];
  return {
    writes,
    /** @param {{ agentId: string, text: string }} spec */
    write(spec) {
      if (options.failWrites) throw new Error("fake write failure");
      writes.push(spec);
    },
    /** @param {{ matched?: boolean, jobId?: string|null, status?: string|null, report?: string|null, reason?: string|null }} payload */
    handleSignal(payload) {
      return {
        matched: payload.matched ?? true,
        jobId: payload.jobId ?? null,
        status: payload.status ?? JobStatus.DONE,
        report: payload.report ?? null,
        reason: payload.reason ?? null,
      };
    },
    sweepCrashes() {
      const out = crashes;
      crashes = [];
      return out;
    },
    /** @param {string} agentId */
    crash(agentId) {
      crashes.push({ agentId });
    },
  };
}

/**
 * @param {{ maxDepth?: number, now?: () => number }} [options]
 */
function setup(options = {}) {
  const queue = createQueue({ maxDepth: options.maxDepth, now: options.now });
  const groups = createGroupRegistry();
  const parent = fakeAdapter();
  const child = fakeAdapter();
  const other = fakeAdapter();
  const service = createControlService({
    queue,
    groups,
    adapters: { A: parent, B: child, C: other },
  });
  return { queue, groups, parent, child, other, service };
}

describe("control: accept and dispatch", () => {
  it("accepts a job, marks the agent busy, and writes through its adapter", () => {
    const { queue, child, service } = setup();
    const accepted = service.submit({ agent: "B", prompt: "do the work", from: "A" });

    assert.equal(accepted.job.status, JobStatus.RUNNING);
    assert.equal(accepted.dispatched?.sent, true);
    assert.equal(queue.isBusy("B"), true);
    assert.deepEqual(child.writes, [{ agentId: "B", text: "do the work" }]);
  });

  it("leaves a second job queued until the first completion signal", () => {
    const { queue, child, service } = setup();
    const first = service.submit({ agent: "B", prompt: "one" }).job;
    const second = service.submit({ agent: "B", prompt: "two" }).job;
    assert.equal(second.status, JobStatus.QUEUED);
    assert.equal(child.writes.length, 1);

    const ended = service.handleSignal({ agent: "B", payload: { report: "one done" } });
    assert.equal(ended.job?.id, first.id);
    assert.equal(ended.job?.status, JobStatus.DONE);
    assert.equal(ended.next?.job.id, second.id);
    assert.equal(second.status, JobStatus.RUNNING);
    assert.deepEqual(child.writes.map((write) => write.text), ["one", "two"]);
    assert.equal(queue.runningJob("B")?.id, second.id);
  });

  it("turns an adapter write failure into an error and continues the queue", () => {
    const queue = createQueue();
    const groups = createGroupRegistry();
    const broken = fakeAdapter({ failWrites: true });
    const service = createControlService({ queue, groups, adapters: { B: broken } });

    const submitted = service.submit({ agent: "B", prompt: "cannot send" });
    assert.equal(submitted.job.status, JobStatus.ERROR);
    assert.match(submitted.job.report ?? "", /fake write failure/);
    assert.equal(queue.isBusy("B"), false);
  });

  it("accepts a real adapter that completes the injected queue itself", () => {
    const queue = createQueue();
    const groups = createGroupRegistry();
    const adapter = createClaudeAdapter({
      queue,
      run: () => ({ status: 0, stdout: "", stderr: "" }),
    });
    adapter.bind({ agentId: "B", sessionId: "session-b" });
    const service = createControlService({ queue, groups, adapters: { B: adapter } });

    const job = service.submit({ agent: "B", prompt: "real contract" }).job;
    const ended = service.handleSignal({
      agent: "B",
      payload: { session_id: "session-b" },
    });

    assert.equal(ended.job?.id, job.id);
    assert.equal(ended.job?.status, JobStatus.DONE);
    assert.equal(queue.isBusy("B"), false);
  });
});

describe("control: result groups", () => {
  it("records all children and writes exactly one formatted wake-up to the parent", () => {
    const { parent, child, other, service } = setup();
    const batch = service.submitGroup({
      parent: "A",
      turn: 7,
      jobs: [
        { agent: "B", prompt: "tests", depth: 1 },
        { agent: "C", prompt: "lint", depth: 1 },
      ],
    });
    assert.equal(batch.dispatched.length, 2);

    const first = service.handleSignal({ agent: "B", payload: { report: "tests done" } });
    assert.equal(first.wakeup, null);
    assert.equal(parent.writes.length, 0);

    const second = service.handleSignal({
      agent: "C",
      payload: { status: JobStatus.ERROR, report: "lint failed" },
    });
    assert.ok(second.wakeup);
    assert.equal(parent.writes.length, 1);
    assert.equal(service.wakeups().length, 1);
    assert.equal(parent.writes[0].agentId, "A");
    assert.match(parent.writes[0].text, new RegExp(`Group complete \\(${batch.group.id}, 2 jobs, waking A\\)`));
    assert.equal(parent.writes[0].text.match(/\[harnet\] Result from/g)?.length, 2);
    assert.ok(parent.writes[0].text.includes("Report: tests done"));
    assert.ok(parent.writes[0].text.includes("Status: error"));
    assert.deepEqual(child.writes.map((write) => write.text), ["tests"]);
    assert.deepEqual(other.writes.map((write) => write.text), ["lint"]);
  });

  it("registers all jobs before refusals and wakes once when the batch is terminal", () => {
    const { parent, service } = setup({ maxDepth: 0 });
    const batch = service.submitGroup({
      parent: "A",
      jobs: [
        { agent: "B", prompt: "too deep", depth: 1 },
        { agent: "C", prompt: "also deep", depth: 2 },
      ],
    });

    assert.ok(batch.jobs.every((job) => job.status === JobStatus.REFUSED));
    assert.equal(batch.wakeups.length, 1);
    assert.equal(parent.writes.length, 1);
    assert.equal(parent.writes[0].text.match(/Status: refused/g)?.length, 2);
  });
});

describe("control: terminal sweepers", () => {
  it("times out a job, records it, and dispatches the next queued job", () => {
    const clock = { now: 0 };
    const { child, service } = setup({ now: () => clock.now });
    service.submit({ agent: "B", prompt: "slow" });
    service.submit({ agent: "B", prompt: "next" });
    clock.now = 10_000;

    const swept = service.sweepTimeouts({ timeoutMs: 5_000, at: clock.now });
    assert.equal(swept.jobs[0].status, JobStatus.TIMEOUT);
    assert.equal(swept.dispatched[0].job.prompt, "next");
    assert.deepEqual(child.writes.map((write) => write.text), ["slow", "next"]);
  });

  it("normalizes a direct crash and an adapter crash sweep", () => {
    const { queue, child, service } = setup();
    const direct = service.submit({ agent: "B", prompt: "first" }).job;
    assert.equal(service.markCrashed({ agent: "B", report: "gone" }).jobs[0].id, direct.id);
    assert.equal(direct.status, JobStatus.CRASHED);

    const sweptJob = service.submit({ agent: "B", prompt: "second" }).job;
    child.crash("B");
    const swept = service.sweepCrashes();
    assert.equal(swept.jobs[0].id, sweptJob.id);
    assert.equal(sweptJob.status, JobStatus.CRASHED);
    assert.equal(queue.isBusy("B"), false);
    assert.deepEqual(service.sweepCrashes().jobs, [], "a reported crash is consumed once");
  });
});
