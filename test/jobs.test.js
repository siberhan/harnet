import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ResultStatus,
  TERMINAL_STATUSES,
  isTerminalStatus,
  formatElapsed,
  formatResult,
  defaultReportFor,
  buildResult,
  createGroupRegistry,
  formatGroupWakeup,
  wakeupFor,
} from "../src/service/jobs.js";

/**
 * @param {string} status
 * @param {{ from?: string, jobId?: string, task?: string }} [over]
 */
function result(status, over = {}) {
  return buildResult({
    from: over.from ?? "B",
    jobId: over.jobId ?? "job-1",
    task: over.task ?? "do x",
    status,
    report: null,
  });
}

describe("jobs: result format", () => {
  it("renders the README block", () => {
    const out = formatResult({
      from: "B",
      jobId: "4f21",
      elapsed: "4m 12s",
      task: "do x",
      status: "done",
      report: "did x",
    });
    assert.equal(
      out,
      [
        "[harnet] Result from B (job 4f21, 4m 12s)",
        "Task you sent: do x",
        "Status: done",
        "Report: did x",
      ].join("\n"),
    );
  });

  it("formats elapsed time", () => {
    assert.equal(formatElapsed(0), "0s");
    assert.equal(formatElapsed(12_000), "12s");
    assert.equal(formatElapsed(252_000), "4m 12s");
    assert.equal(formatElapsed(3_723_000), "1h 2m 3s");
    assert.equal(formatElapsed(-5), "0s");
  });
});

describe("jobs: every outcome produces a result", () => {
  it("all five statuses are terminal", () => {
    assert.deepEqual([...TERMINAL_STATUSES], ["done", "error", "timeout", "crashed", "refused"]);
    for (const status of TERMINAL_STATUSES) assert.equal(isTerminalStatus(status), true);
    assert.equal(isTerminalStatus("running"), false);
    assert.equal(isTerminalStatus("queued"), false);
  });

  it("fills in a report when the job gave none", () => {
    assert.equal(result(ResultStatus.DONE).report, "(no report)");
    assert.equal(result(ResultStatus.ERROR).report, "agent turn ended with an error");
    assert.equal(result(ResultStatus.TIMEOUT).report, "no completion signal arrived in time");
    assert.equal(result(ResultStatus.CRASHED).report, "agent session died");
    assert.match(result(ResultStatus.REFUSED).report, /refused/);
  });

  it("keeps a real report and prefers a refusal reason", () => {
    const withReport = buildResult({
      from: "B",
      jobId: "job-2",
      task: "x",
      status: ResultStatus.DONE,
      report: "did x",
    });
    assert.equal(withReport.report, "did x");

    const refused = buildResult({
      from: "B",
      jobId: "job-3",
      task: "x",
      status: ResultStatus.REFUSED,
      report: null,
      refusal: "call depth 4 exceeds maxDepth 3",
    });
    assert.equal(refused.report, "refused: call depth 4 exceeds maxDepth 3");
  });

  it("computes elapsed from milliseconds", () => {
    const r = buildResult({
      from: "B",
      jobId: "job-1",
      task: "x",
      status: ResultStatus.DONE,
      elapsedMs: 252_000,
    });
    assert.equal(r.elapsed, "4m 12s");
    const unknown = buildResult({ from: "B", jobId: "job-1", task: "x", status: "done" });
    assert.equal(unknown.elapsed, "unknown");
  });

  it("refuses to build a result for a job that is still alive", () => {
    assert.throws(() => result("running"), /not a terminal status/);
    assert.throws(() => result("queued"), /not a terminal status/);
  });

  it("every status renders a full block", () => {
    for (const status of TERMINAL_STATUSES) {
      const block = formatResult(result(status));
      assert.match(block, /^\[harnet\] Result from B \(job job-1, /);
      assert.ok(block.includes(`Status: ${status}`));
      assert.ok(block.split("\n")[3].startsWith("Report: "));
      assert.ok(block.split("\n")[3].length > "Report: ".length);
    }
  });

  it("defaultReportFor covers unknown statuses too", () => {
    assert.match(defaultReportFor("weird"), /unknown status/);
  });
});

describe("jobs: result groups", () => {
  it("opens a group and tracks expected jobs", () => {
    const groups = createGroupRegistry();
    const g = groups.open({ parent: "A", turn: 3 });
    assert.equal(g.id, "grp-1");
    assert.equal(g.parent, "A");
    assert.equal(g.turn, 3);
    assert.deepEqual(groups.pendingJobs(g.id), []);

    groups.addJob(g.id, "job-1");
    groups.addJob(g.id, "job-2");
    groups.addJob(g.id, "job-2"); // idempotent
    assert.equal(g.jobIds.length, 2);
    assert.deepEqual(groups.pendingJobs(g.id), ["job-1", "job-2"]);
    assert.equal(groups.isReady(g.id), false);
  });

  it("is not ready until every child has reported", () => {
    const groups = createGroupRegistry();
    const g = groups.open({ parent: "A" });
    groups.addJob(g.id, "job-1");
    groups.addJob(g.id, "job-2");

    const first = groups.record(g.id, "job-1", result(ResultStatus.DONE, { jobId: "job-1" }));
    assert.equal(first.ready, false, "one of two is not enough");
    assert.deepEqual(groups.pendingJobs(g.id), ["job-2"]);
    assert.throws(() => groups.collect(g.id), /not ready \(1\/2 results\)/);
    assert.throws(() => wakeupFor(g), /not ready/);

    const second = groups.record(
      g.id,
      "job-2",
      result(ResultStatus.CRASHED, { jobId: "job-2", from: "C" }),
    );
    assert.equal(second.ready, true);
    assert.deepEqual(groups.pendingJobs(g.id), []);
    assert.equal(groups.collect(g.id).length, 2);
  });

  it("collects results in registration order, not arrival order", () => {
    const groups = createGroupRegistry();
    const g = groups.open({ parent: "A" });
    groups.addJob(g.id, "job-1");
    groups.addJob(g.id, "job-2");
    groups.record(g.id, "job-2", result(ResultStatus.DONE, { jobId: "job-2" }));
    groups.record(g.id, "job-1", result(ResultStatus.DONE, { jobId: "job-1" }));
    assert.deepEqual(
      groups.collect(g.id).map((r) => r.jobId),
      ["job-1", "job-2"],
    );
  });

  it("an empty group is never ready", () => {
    const groups = createGroupRegistry();
    const g = groups.open({ parent: "A" });
    assert.equal(groups.isReady(g.id), false);
  });

  it("rejects unknown groups and foreign jobs", () => {
    const groups = createGroupRegistry();
    const g = groups.open({ parent: "A" });
    assert.throws(() => groups.addJob("grp-404", "job-1"), /unknown group/);
    assert.throws(
      () => groups.record(g.id, "job-404", result(ResultStatus.DONE)),
      /does not belong to group/,
    );
    assert.equal(groups.get("grp-404"), null);
    assert.equal(groups.get(g.id)?.id, g.id);
  });

  it("a failing child still counts towards the group", () => {
    const groups = createGroupRegistry();
    const g = groups.open({ parent: "A" });
    groups.addJob(g.id, "job-1");
    const { ready } = groups.record(
      g.id,
      "job-1",
      result(ResultStatus.TIMEOUT, { jobId: "job-1" }),
    );
    assert.equal(ready, true);
    assert.ok(wakeupFor(g).includes("Status: timeout"));
  });
});

describe("jobs: single wake-up", () => {
  it("carries every child result in one message", () => {
    const groups = createGroupRegistry();
    const g = groups.open({ parent: "A" });
    groups.addJob(g.id, "job-1");
    groups.addJob(g.id, "job-2");
    groups.record(g.id, "job-1", result(ResultStatus.DONE, { jobId: "job-1", from: "B" }));
    groups.record(g.id, "job-2", result(ResultStatus.ERROR, { jobId: "job-2", from: "C" }));

    const msg = wakeupFor(g);
    assert.equal(msg.match(/\[harnet\] Result from/g)?.length, 2);
    assert.ok(msg.startsWith("[harnet] Group complete (grp-1, 2 jobs, waking A)"));
    assert.ok(msg.includes("Status: done"));
    assert.ok(msg.includes("Status: error"));
  });
});

describe("jobs: wake-up formatting", () => {
  it("handles a single result and no parent", () => {
    const out = formatGroupWakeup({
      groupId: "grp-9",
      parent: null,
      results: [result(ResultStatus.DONE)],
    });
    assert.ok(out.startsWith("[harnet] Group complete (grp-9, 1 job)"));
  });
});
