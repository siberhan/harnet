/**
 * src/service/permissions.js - the human-approval queue.
 *
 * What is being pinned here, in order: a request blocks its agent until it is
 * resolved; the decision record says who/when/which way; that record reaches
 * the job report; and the numbers it prints agree with jobs.js.
 *
 * The integration tests at the bottom use the real claude adapter, the real
 * queue and the real result builder - only tmux is stubbed - because the point
 * of this module is where it sits between them, not its own bookkeeping.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createClaudeAdapter } from "../src/adapters/claude.js";
import { buildResult, formatElapsed } from "../src/service/jobs.js";
import {
  PermissionDecision,
  PermissionKind,
  PermissionStatus,
  createPermissionQueue,
  formatDecision,
  formatWaited,
  normalizeDecision,
} from "../src/service/permissions.js";
import { createQueue } from "../src/service/queue.js";

/** A clock the test moves by hand, so waited-times are exact, not flaky. */
function fakeClock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    /** @param {number} ms */
    advance: (ms) => {
      t += ms;
      return t;
    },
  };
}

const ASK = {
  agentId: "codex",
  kind: PermissionKind.TOOL,
  prompt: "Allow `rm -rf build/` in /repo?",
};

describe("permission requests block their agent", () => {
  it("a new request is pending, listed, and blocks", () => {
    const queue = createPermissionQueue({ now: fakeClock().now });
    const request = queue.request({ ...ASK, jobId: "job-1" });

    assert.equal(request.id, "perm-1");
    assert.equal(request.status, PermissionStatus.PENDING);
    assert.equal(request.decision, null);
    assert.equal(request.jobId, "job-1");
    assert.equal(queue.isBlocked("codex"), true);
    assert.deepEqual(queue.blockedAgents(), ["codex"]);
    assert.deepEqual(
      queue.pending().map((p) => p.id),
      ["perm-1"],
    );
    assert.equal(queue.blocking("codex")?.id, "perm-1");
  });

  it("only the asking agent is blocked", () => {
    const queue = createPermissionQueue();
    queue.request(ASK);

    assert.equal(queue.isBlocked("claude"), false);
    assert.equal(queue.blocking("claude"), null);
    assert.deepEqual(queue.pending("claude"), []);
  });

  it("resolving unblocks, cancelling unblocks, nothing else does", () => {
    const queue = createPermissionQueue();
    const approved = queue.request(ASK);
    queue.resolve(approved.id, PermissionDecision.APPROVE, { by: "bedirhan" });
    assert.equal(queue.isBlocked("codex"), false);

    const abandoned = queue.request(ASK);
    assert.equal(queue.isBlocked("codex"), true);
    queue.cancel(abandoned.id, { reason: "job timed out" });
    assert.equal(queue.isBlocked("codex"), false);
    assert.deepEqual(queue.pending(), []);
  });

  it("two questions from one agent are answered oldest first", () => {
    const queue = createPermissionQueue();
    const first = queue.request(ASK);
    const second = queue.request({ ...ASK, prompt: "Allow network access?" });

    assert.equal(queue.blocking("codex")?.id, first.id);
    queue.resolve(first.id, "approve", { by: "bedirhan" });
    // Still blocked: the second question has not been answered.
    assert.equal(queue.isBlocked("codex"), true);
    assert.equal(queue.blocking("codex")?.id, second.id);
  });

  it("refuses a request it could never put in front of a human", () => {
    const queue = createPermissionQueue();
    assert.throws(() => queue.request({ agentId: "", prompt: "x" }), /agentId/);
    assert.throws(() => queue.request({ agentId: "codex", prompt: "   " }), /prompt/);
  });

  it("hands out copies, so a caller cannot flip a decision by mutation", () => {
    const queue = createPermissionQueue();
    const request = queue.request(ASK);
    request.status = PermissionStatus.APPROVED;

    assert.equal(queue.get(request.id)?.status, PermissionStatus.PENDING);
    assert.equal(queue.isBlocked("codex"), true);
  });
});

describe("the decision record", () => {
  it("records who decided, when, which way, and how long the agent waited", () => {
    const clock = fakeClock();
    const queue = createPermissionQueue({ now: clock.now });
    const request = queue.request(ASK);
    clock.advance(12_000);
    const decided = queue.resolve(request.id, PermissionDecision.DENY, {
      by: "bedirhan",
      note: "not on a shared repo",
    });

    assert.equal(decided.status, PermissionStatus.DENIED);
    assert.equal(decided.decision, PermissionDecision.DENY);
    assert.equal(decided.decidedBy, "bedirhan");
    assert.equal(decided.decidedAt, request.requestedAt + 12_000);
    assert.equal(decided.waitedMs, 12_000);
    assert.equal(decided.note, "not on a shared repo");
    // The question survives the answer: a log of decisions with no prompts is
    // not a log of anything.
    assert.equal(decided.prompt, ASK.prompt);
  });

  it("a decision is terminal - a second one throws instead of overwriting it", () => {
    const queue = createPermissionQueue();
    const request = queue.request(ASK);
    queue.resolve(request.id, "approve", { by: "bedirhan" });

    assert.throws(() => queue.resolve(request.id, "deny", { by: "someone-else" }), /already approved/);
    assert.throws(() => queue.cancel(request.id), /already approved/);
    assert.equal(queue.get(request.id)?.decidedBy, "bedirhan");
  });

  it("cancelled is not approved", () => {
    const queue = createPermissionQueue();
    const request = queue.request(ASK);
    const cancelled = queue.cancel(request.id, { by: "harnet", reason: "session crashed" });

    assert.equal(cancelled.status, PermissionStatus.CANCELLED);
    assert.equal(cancelled.decision, null);
    assert.match(formatDecision(cancelled), /cancelled before anyone answered - session crashed/);
  });

  it("accepts the spellings a panel keypress would send, and nothing else", () => {
    assert.equal(normalizeDecision("Allow"), PermissionDecision.APPROVE);
    assert.equal(normalizeDecision("yes"), PermissionDecision.APPROVE);
    assert.equal(normalizeDecision(" DENIED "), PermissionDecision.DENY);
    assert.throws(() => normalizeDecision("maybe"), /unknown permission decision: maybe/);
    assert.throws(() => normalizeDecision(undefined), /unknown permission decision/);
  });

  it("unknown ids are an error, not a silent no-op", () => {
    const queue = createPermissionQueue();
    assert.throws(() => queue.resolve("perm-99", "approve"), /unknown permission request: perm-99/);
    assert.equal(queue.get("perm-99"), null);
  });

  it("history keeps every request, filtered by agent, job or status", () => {
    const queue = createPermissionQueue();
    const a = queue.request({ ...ASK, jobId: "job-1" });
    queue.request({ ...ASK, agentId: "claude", jobId: "job-2" });
    queue.resolve(a.id, "approve", { by: "bedirhan" });

    assert.equal(queue.history().length, 2);
    assert.deepEqual(
      queue.history({ agentId: "claude" }).map((r) => r.jobId),
      ["job-2"],
    );
    assert.deepEqual(
      queue.history({ status: PermissionStatus.PENDING }).map((r) => r.agentId),
      ["claude"],
    );
    assert.deepEqual(
      queue.forJob("job-1").map((r) => r.id),
      [a.id],
    );
  });
});

describe("the record reaches the job report", () => {
  it("reportLineFor renders one line per decision the job hit", () => {
    const clock = fakeClock();
    const queue = createPermissionQueue({ now: clock.now });
    const first = queue.request({ ...ASK, jobId: "job-1" });
    clock.advance(12_000);
    queue.resolve(first.id, "approve", { by: "bedirhan", note: "build dir only" });
    const second = queue.request({ ...ASK, jobId: "job-1", prompt: "Allow network access?" });
    clock.advance(90_000);
    queue.resolve(second.id, "deny", { by: "bedirhan" });

    assert.equal(
      queue.reportLineFor("job-1"),
      [
        "permission (tool): approved by bedirhan after 12s - build dir only",
        "permission (tool): denied by bedirhan after 1m 30s",
      ].join("\n"),
    );
    assert.equal(queue.reportLineFor("job-2"), null, "a job that asked nothing says nothing");
  });

  it("a still-pending request says so rather than reading as approved", () => {
    const queue = createPermissionQueue();
    queue.request({ ...ASK, jobId: "job-1" });

    assert.equal(
      queue.reportLineFor("job-1"),
      "permission (tool): still waiting for a human - Allow `rm -rf build/` in /repo?",
    );
  });

  it("an anonymous decision is recorded as unknown, not as nobody", () => {
    const queue = createPermissionQueue();
    const request = queue.request(ASK);
    const decided = queue.resolve(request.id, "approve");

    assert.match(formatDecision(decided), /^permission \(tool\): approved by unknown after 0s$/);
  });

  it("waited times read the same as jobs.js elapsed times", () => {
    for (const ms of [0, 999, 1000, 61_000, 3_601_000]) {
      assert.equal(formatWaited(ms), formatElapsed(ms));
    }
  });

  it("the line survives into a real Result", () => {
    const clock = fakeClock();
    const permissions = createPermissionQueue({ now: clock.now });
    const request = permissions.request({ ...ASK, jobId: "job-1" });
    clock.advance(5000);
    permissions.resolve(request.id, "deny", { by: "bedirhan" });

    const result = buildResult({
      from: "codex",
      jobId: "job-1",
      task: "clean the build dir",
      status: "done",
      report: ["nothing removed", permissions.reportLineFor("job-1")].join("\n"),
      elapsedMs: 30_000,
    });

    assert.match(result.report, /nothing removed/);
    assert.match(result.report, /permission \(tool\): denied by bedirhan after 5s/);
  });

  it("a job whose only story is the denial still reports it", () => {
    const permissions = createPermissionQueue();
    const request = permissions.request({ ...ASK, jobId: "job-1" });
    permissions.resolve(request.id, "deny", { by: "bedirhan", note: "too broad" });

    const result = buildResult({
      from: "codex",
      jobId: "job-1",
      task: "clean the build dir",
      status: "done",
      report: permissions.reportLineFor("job-1"),
      elapsedMs: 1000,
    });

    // Without the permission line this would have been the "(no report)"
    // default - a job that looks like it just did nothing.
    assert.notEqual(result.report, "(no report)");
    assert.match(result.report, /denied by bedirhan/);
  });
});

describe("wired to a real adapter and a real job queue", () => {
  /** tmux stubbed to "everything worked"; nothing else is faked. */
  const noRun = () => ({ status: 0, stdout: "", stderr: "" });

  it("a claude Notification becomes a pending request that blocks dispatch", () => {
    const jobs = createQueue();
    const permissions = createPermissionQueue();
    const adapter = createClaudeAdapter({
      run: noRun,
      root: "/repo",
      queue: jobs,
      // The adapter already calls this on every Notification hook; all the
      // caller has to do is turn the entry into a request.
      onNotification: (entry) =>
        permissions.request({
          agentId: entry.agentId ?? "unknown",
          kind: PermissionKind.TOOL,
          prompt: entry.message,
          jobId: jobs.runningJob(entry.agentId ?? "")?.id ?? null,
          payload: entry.payload,
        }),
    });
    adapter.bind({ agentId: "e2e", sessionId: "sess-1" });

    jobs.enqueue({ prompt: "clean the build dir", agent: "e2e" });
    const running = jobs.dispatch("e2e");
    assert.notEqual(running, null);

    adapter.handleNotification({
      hook_event_name: "Notification",
      session_id: "sess-1",
      message: "Claude needs your permission to use Bash",
    });

    const blocking = permissions.blocking("e2e");
    assert.notEqual(blocking, null);
    assert.equal(blocking?.jobId, running?.id);
    assert.equal(blocking?.prompt, "Claude needs your permission to use Bash");

    // The job is NOT touched - it is running, waiting, exactly as the adapter
    // promises. Only the dispatcher's gate changed.
    assert.equal(jobs.get(running?.id ?? "")?.status, "running");
    assert.equal(permissions.isBlocked("e2e"), true);

    permissions.resolve(blocking?.id ?? "", "approve", { by: "bedirhan" });
    assert.equal(permissions.isBlocked("e2e"), false);
    assert.equal(jobs.get(running?.id ?? "")?.status, "running");
  });

  it("the decision lands in the report of the job that was waiting", () => {
    const jobs = createQueue({ now: () => 1000 });
    const permissions = createPermissionQueue({ now: () => 1000 });
    jobs.enqueue({ prompt: "clean the build dir", agent: "e2e" });
    const running = jobs.dispatch("e2e");
    const jobId = running?.id ?? "";

    const request = permissions.request({
      agentId: "e2e",
      kind: PermissionKind.TOOL,
      prompt: "Allow `rm -rf build/`?",
      jobId,
    });
    permissions.resolve(request.id, "approve", { by: "bedirhan" });

    const done = jobs.complete({
      jobId,
      status: "done",
      report: ["removed build/", permissions.reportLineFor(jobId)].join("\n"),
    });

    assert.equal(done.status, "done");
    assert.match(done.report ?? "", /permission \(tool\): approved by bedirhan/);
  });
});
