import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createQueue,
  JobStatus,
  isTerminalStatus,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_DEPTH,
} from "../src/service/queue.js";

/** @returns {{ q: ReturnType<typeof createQueue>, clock: { t: number } }} */
function queueAt(t = 1000) {
  const clock = { t };
  const q = createQueue({ now: () => clock.t });
  return { q, clock };
}

describe("queue: job ids", () => {
  it("assigns an auto id when none is given", () => {
    const { q } = queueAt();
    const a = q.enqueue({ agent: "B", prompt: "one" });
    const b = q.enqueue({ agent: "B", prompt: "two" });
    assert.ok(a.id);
    assert.notEqual(a.id, b.id);
    assert.equal(a.id, "job-1");
  });

  it("honours an explicit id and rejects duplicates", () => {
    const { q } = queueAt();
    assert.equal(q.enqueue({ id: "manual", agent: "B", prompt: "x" }).id, "manual");
    assert.throws(() => q.enqueue({ id: "manual", agent: "B", prompt: "y" }), /duplicate job id/);
  });

  it("defaults fields on a fresh job", () => {
    const { q, clock } = queueAt(500);
    const job = q.enqueue({ agent: "B", prompt: "do x", from: "A" });
    assert.equal(job.status, JobStatus.QUEUED);
    assert.equal(job.createdAt, 500);
    assert.equal(job.startedAt, null);
    assert.equal(job.endedAt, null);
    assert.equal(job.depth, 0);
    assert.equal(job.groupId, null);
    assert.equal(job.from, "A");
  });
});

describe("queue: busy state", () => {
  it("dispatch marks the job running and the agent busy", () => {
    const { q, clock } = queueAt();
    q.enqueue({ agent: "B", prompt: "do x", from: "A" });
    assert.equal(q.isBusy("B"), false);
    assert.equal(q.state("B"), "idle");

    clock.t = 2000;
    const running = q.dispatch("B");
    assert.ok(running);
    assert.equal(running.status, JobStatus.RUNNING);
    assert.equal(running.startedAt, 2000);
    assert.equal(q.isBusy("B"), true);
    assert.equal(q.state("B"), "busy");
    assert.deepEqual(q.busyAgents(), ["B"]);
    assert.equal(q.runningJob("B")?.id, running.id);
    assert.equal(q.running().length, 1);
  });

  it("queues a job for a busy agent and does not run it", () => {
    const { q } = queueAt();
    const first = q.enqueue({ agent: "B", prompt: "first", from: "A" });
    q.dispatch("B");
    const second = q.enqueue({ agent: "B", prompt: "second", from: "A" });

    assert.equal(second.status, JobStatus.QUEUED);
    assert.equal(q.dispatch("B"), null, "busy agent must not get a second job");
    assert.deepEqual(
      q.pending("B").map((j) => j.id),
      [second.id],
    );
    assert.equal(first.status, JobStatus.RUNNING);
  });

  it("keeps queues per agent", () => {
    const { q } = queueAt();
    q.enqueue({ agent: "B", prompt: "b1" });
    q.enqueue({ agent: "C", prompt: "c1" });
    assert.deepEqual(
      q.pending("B").map((j) => j.prompt),
      ["b1"],
    );
    assert.deepEqual(
      q.pending("C").map((j) => j.prompt),
      ["c1"],
    );
    assert.equal(q.pending().length, 2);
  });

  it("frees the agent on complete and runs the next job in FIFO order", () => {
    const { q } = queueAt();
    const first = q.enqueue({ agent: "B", prompt: "first" });
    const second = q.enqueue({ agent: "B", prompt: "second" });
    const third = q.enqueue({ agent: "B", prompt: "third" });

    q.dispatch("B");
    const done = q.complete({ jobId: first.id, status: JobStatus.DONE, report: "ok" });
    assert.equal(done.status, JobStatus.DONE);
    assert.equal(done.report, "ok");
    assert.equal(q.isBusy("B"), false);

    assert.equal(q.dispatch("B")?.id, second.id);
    q.complete({ jobId: second.id, status: JobStatus.ERROR, report: "boom" });
    assert.equal(q.dispatch("B")?.id, third.id);
    assert.equal(q.dispatch("B"), null, "only one job runs at a time");
  });

  it("pending() and running() only return live jobs", () => {
    const { q } = queueAt();
    const job = q.enqueue({ agent: "B", prompt: "x" });
    assert.equal(q.pending().length, 1);
    q.dispatch("B");
    assert.equal(q.pending().length, 0);
    assert.equal(q.running().length, 1);
    q.complete({ jobId: job.id, status: JobStatus.DONE, report: "" });
    assert.equal(q.pending().length, 0);
    assert.equal(q.running().length, 0);
    assert.equal(q.all().length, 1);
    assert.equal(q.get(job.id)?.status, JobStatus.DONE);
    assert.equal(q.get("nope"), null);
  });
});

describe("queue: completing jobs", () => {
  it("rejects unknown jobs, idle jobs and non-terminal statuses", () => {
    const { q } = queueAt();
    const job = q.enqueue({ agent: "B", prompt: "x" });
    assert.throws(() => q.complete({ jobId: "ghost", status: JobStatus.DONE }), /unknown job/);
    assert.throws(() => q.complete({ jobId: job.id, status: JobStatus.DONE }), /not running/);
    q.dispatch("B");
    assert.throws(() => q.complete({ jobId: job.id, status: "running" }), /not a terminal status/);
    assert.equal(isTerminalStatus("running"), false);
    assert.equal(isTerminalStatus(JobStatus.CRASHED), true);
  });

  it("accepts every failure status and records a report", () => {
    /** @type {Array<typeof JobStatus[keyof typeof JobStatus]>} */
    const statuses = ["error", "timeout", "crashed", "refused"];
    for (const status of statuses) {
      const { q } = queueAt();
      const job = q.enqueue({ agent: "B", prompt: "x" });
      q.dispatch("B");
      const ended = q.complete({ jobId: job.id, status, report: `failed: ${status}` });
      assert.equal(ended.status, status);
      assert.equal(ended.report, `failed: ${status}`);
      assert.equal(q.isBusy("B"), false, `${status} must free the agent`);
    }
  });
});

describe("queue: timeouts", () => {
  it("times out a running job past the limit and frees the agent", () => {
    const { q, clock } = queueAt();
    const job = q.enqueue({ agent: "B", prompt: "x" });
    q.dispatch("B");

    assert.deepEqual(q.sweepTimeouts({ timeoutMs: 5000, at: 2000 }), []);
    assert.equal(job.status, JobStatus.RUNNING);

    const out = q.sweepTimeouts({ timeoutMs: 5000, at: 7000 });
    assert.equal(out.length, 1);
    assert.equal(job.status, JobStatus.TIMEOUT);
    assert.equal(job.endedAt, 7000);
    assert.match(job.report ?? "", /no completion signal/);
    assert.equal(q.isBusy("B"), false);
  });

  it("uses the configured default timeout when none is passed", () => {
    const { q, clock } = queueAt(0);
    q.enqueue({ agent: "B", prompt: "x" });
    q.dispatch("B");
    clock.t = DEFAULT_TIMEOUT_MS - 1;
    assert.deepEqual(q.sweepTimeouts(), []);
    clock.t = DEFAULT_TIMEOUT_MS;
    assert.equal(q.sweepTimeouts().length, 1);
  });

  it("leaves queued and finished jobs alone", () => {
    const { q } = queueAt();
    const running = q.enqueue({ agent: "B", prompt: "running" });
    q.dispatch("B");
    const queued = q.enqueue({ agent: "B", prompt: "queued" });
    const out = q.sweepTimeouts({ timeoutMs: 0, at: 999999 });
    assert.deepEqual(
      out.map((j) => j.id),
      [running.id],
    );
    assert.equal(queued.status, JobStatus.QUEUED);
  });
});

describe("queue: crashes", () => {
  it("fails the running job of a dead agent", () => {
    const { q, clock } = queueAt();
    const job = q.enqueue({ agent: "B", prompt: "x" });
    q.dispatch("B");
    clock.t = 4000;
    const out = q.markCrashed({ agent: "B", report: "tmux session gone" });
    assert.equal(out.length, 1);
    assert.equal(job.status, JobStatus.CRASHED);
    assert.equal(job.report, "tmux session gone");
    assert.equal(job.endedAt, 4000);
    assert.equal(q.isBusy("B"), false);
  });

  it("is a no-op for an idle or unknown agent", () => {
    const { q } = queueAt();
    q.enqueue({ agent: "B", prompt: "x" });
    assert.deepEqual(q.markCrashed({ agent: "B" }), []);
    assert.deepEqual(q.markCrashed({ agent: "ghost" }), []);
  });

  it("a default report is filled in when the caller gives none", () => {
    const { q } = queueAt();
    const job = q.enqueue({ agent: "B", prompt: "x" });
    q.dispatch("B");
    q.markCrashed({ agent: "B" });
    assert.match(job.report ?? "", /agent session died/);
  });
});

describe("queue: refusal", () => {
  it("refuses a job deeper than maxDepth without running it", () => {
    const { q } = queueAt();
    const ok = q.enqueue({ agent: "B", prompt: "x", depth: DEFAULT_MAX_DEPTH });
    const tooDeep = q.enqueue({ agent: "C", prompt: "y", depth: DEFAULT_MAX_DEPTH + 1 });
    assert.equal(ok.status, JobStatus.QUEUED);
    assert.equal(tooDeep.status, JobStatus.REFUSED);
    assert.equal(tooDeep.endedAt, tooDeep.createdAt);
    assert.match(tooDeep.refusal ?? "", /exceeds maxDepth/);
    assert.match(tooDeep.report ?? "", /refused/);
    assert.equal(q.dispatch("C"), null);
    assert.equal(q.pending().length, 1);
    assert.equal(q.isBusy("C"), false);
  });

  it("refuses a job once a group hits its job limit", () => {
    const q = createQueue({ maxJobsPerGroup: 2, now: () => 1000 });
    const groupId = "grp-1";
    for (let i = 0; i < 2; i += 1) q.enqueue({ agent: "B", prompt: `p${i}`, groupId });
    const overflow = q.enqueue({ agent: "B", prompt: "one too many", groupId });
    assert.equal(overflow.status, JobStatus.REFUSED);
    assert.match(overflow.refusal ?? "", /already holds 2 jobs/);
  });

  it("the depth limit is configurable", () => {
    const q = createQueue({ maxDepth: 0, now: () => 1 });
    assert.equal(q.enqueue({ agent: "B", prompt: "x", depth: 1 }).status, JobStatus.REFUSED);
    assert.equal(q.enqueue({ agent: "B", prompt: "y", depth: 0 }).status, JobStatus.QUEUED);
  });

  it("a refused job is never dispatched later", () => {
    const { q } = queueAt();
    const refused = q.enqueue({ agent: "B", prompt: "x", depth: 99 });
    assert.equal(q.dispatch("B"), null);
    assert.equal(refused.status, JobStatus.REFUSED);
    assert.equal(q.running().length, 0);
  });
});
