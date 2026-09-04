import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createQueue, JobStatus, TERMINAL_STATUSES as QUEUE_TERMINAL } from "../src/service/queue.js";
import {
  createGroupRegistry,
  buildResult,
  ResultStatus,
  TERMINAL_STATUSES as RESULT_TERMINAL,
  wakeupFor,
} from "../src/service/jobs.js";

/**
 * Wire the two service modules the way the control service will:
 * queue owns jobs and busy state, the registry owns grouping.
 * @param {number} maxDepth
 */
function service(maxDepth = 3) {
  const clock = { t: 0 };
  const q = createQueue({ now: () => clock.t, maxDepth });
  const groups = createGroupRegistry();
  return { q, groups, clock };
}

/**
 * @param {import("../src/service/queue.js").Job|null} job
 * @returns {import("../src/service/jobs.js").Result}
 */
function resultFromJob(job) {
  if (job === null) throw new Error("job is gone");
  const elapsedMs =
    job.startedAt !== null && job.endedAt !== null ? job.endedAt - job.startedAt : undefined;
  return buildResult({
    from: job.agent ?? "unknown",
    jobId: job.id,
    task: job.prompt,
    status: job.status,
    report: job.report,
    refusal: job.refusal,
    elapsedMs,
  });
}

describe("service contract", () => {
  it("queue and results agree on the terminal statuses", () => {
    assert.deepEqual([...QUEUE_TERMINAL].sort(), [...RESULT_TERMINAL].sort());
    assert.deepEqual(
      Object.values(JobStatus).sort(),
      ["crashed", "done", "error", "queued", "refused", "running", "timeout"].sort(),
    );
    assert.deepEqual(
      Object.values(ResultStatus).sort(),
      ["crashed", "done", "error", "refused", "timeout"].sort(),
    );
  });
});

describe("flow: parent spawns children in one turn", () => {
  it("wakes the parent once, only after the last child reports", () => {
    const { q, groups } = service();
    const g = groups.open({ parent: "A", turn: 1 });

    const b = q.enqueue({ agent: "B", prompt: "write tests", from: "A", groupId: g.id, depth: 1 });
    const c = q.enqueue({ agent: "C", prompt: "fix lint", from: "A", groupId: g.id, depth: 1 });
    groups.addJob(g.id, b.id);
    groups.addJob(g.id, c.id);

    q.dispatch("B");
    q.dispatch("C");
    assert.deepEqual(q.busyAgents().sort(), ["B", "C"]);

    q.complete({ jobId: b.id, status: JobStatus.DONE, report: "3 tests added" });
    const afterFirst = groups.record(g.id, b.id, resultFromJob(q.get(b.id)));
    assert.equal(afterFirst.ready, false, "parent must not be woken yet");

    q.markCrashed({ agent: "C" });
    const afterSecond = groups.record(g.id, c.id, resultFromJob(q.get(c.id)));
    assert.equal(afterSecond.ready, true);

    const msg = wakeupFor(g);
    assert.equal(msg.match(/\[harnet\] Result from/g)?.length, 2);
    assert.ok(msg.includes("Status: done"));
    assert.ok(msg.includes("Report: 3 tests added"));
    assert.ok(msg.includes("Status: crashed"));
    assert.ok(msg.includes("waking A"));
  });

  it("two children on the same agent run one after the other", () => {
    const { q, groups, clock } = service();
    const g = groups.open({ parent: "A" });
    const first = q.enqueue({ agent: "B", prompt: "one", from: "A", groupId: g.id, depth: 1 });
    const second = q.enqueue({ agent: "B", prompt: "two", from: "A", groupId: g.id, depth: 1 });
    groups.addJob(g.id, first.id);
    groups.addJob(g.id, second.id);

    assert.equal(q.dispatch("B")?.id, first.id);
    assert.equal(q.dispatch("B"), null, "busy agent queues the second job");
    assert.equal(second.status, JobStatus.QUEUED);

    clock.t = 1_000;
    q.complete({ jobId: first.id, status: JobStatus.DONE, report: "one done" });
    clock.t = 5_000;
    assert.equal(q.dispatch("B")?.id, second.id);
    clock.t = 9_000;
    q.complete({ jobId: second.id, status: JobStatus.DONE, report: "two done" });

    groups.record(g.id, first.id, resultFromJob(q.get(first.id)));
    const done = groups.record(g.id, second.id, resultFromJob(q.get(second.id)));
    assert.equal(done.ready, true);

    const msg = wakeupFor(g);
    assert.ok(msg.includes("job job-1, 1s)"));
    assert.ok(msg.includes("job job-2, 4s)"));
  });

  it("a refused child produces a result without ever running", () => {
    const { q, groups } = service(1);
    const g = groups.open({ parent: "A" });
    const ok = q.enqueue({ agent: "B", prompt: "one", from: "A", groupId: g.id, depth: 1 });
    const deep = q.enqueue({ agent: "C", prompt: "deeper", from: "A", groupId: g.id, depth: 2 });
    groups.addJob(g.id, ok.id);
    groups.addJob(g.id, deep.id);

    assert.equal(deep.status, JobStatus.REFUSED);
    assert.equal(q.isBusy("C"), false);
    groups.record(g.id, deep.id, resultFromJob(deep));
    assert.equal(groups.isReady(g.id), false);

    q.dispatch("B");
    q.complete({ jobId: ok.id, status: JobStatus.DONE, report: "ok" });
    const afterOk = groups.record(g.id, ok.id, resultFromJob(q.get(ok.id)));
    assert.equal(afterOk.ready, true);
    assert.ok(wakeupFor(g).includes("Status: refused"));
  });

  it("a timed out child produces a result via the sweeper", () => {
    const { q, groups, clock } = service();
    const g = groups.open({ parent: "A" });
    const job = q.enqueue({ agent: "B", prompt: "slow one", from: "A", groupId: g.id, depth: 1 });
    groups.addJob(g.id, job.id);

    clock.t = 0;
    q.dispatch("B");
    clock.t = 60_000;
    const [timedOut] = q.sweepTimeouts({ timeoutMs: 30_000 });
    assert.ok(timedOut);
    assert.equal(timedOut.status, JobStatus.TIMEOUT);

    const { ready } = groups.record(g.id, timedOut.id, resultFromJob(timedOut));
    assert.equal(ready, true);
    const msg = wakeupFor(g);
    assert.ok(msg.includes("Status: timeout"));
    assert.ok(msg.includes("job job-1, 1m 0s)"));
  });

  it("root job with no children: no group, no wake-up", () => {
    const { q, groups } = service();
    const g = groups.open({ parent: "A" });
    assert.equal(groups.isReady(g.id), false);
    assert.throws(() => wakeupFor(g), /not ready/);

    const root = q.enqueue({ agent: "B", prompt: "top level" });
    q.dispatch("B");
    q.complete({ jobId: root.id, status: JobStatus.DONE, report: "done" });
    assert.equal(q.get(root.id)?.status, JobStatus.DONE);
  });
});
