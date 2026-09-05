/**
 * The permission queue wired into the control service.
 *
 * test/permissions.test.js pins the queue on its own; this one pins the three
 * places it now touches the service, and pins them against the REAL claude
 * adapter and the REAL job queue (only tmux is stubbed):
 *   1. an adapter Notification becomes a pending request bound to the running job,
 *   2. dispatch holds work back while the agent waits on a human - and lets it
 *      go the moment the decision lands,
 *   3. the decision record reaches the job's report, and through it the parent's
 *      wake-up.
 *
 * The service is additive here: without a `permissions` option it behaves
 * exactly as before, and the last test in this file is what pins that.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createClaudeAdapter } from "../src/adapters/claude.js";
import { createControlService } from "../src/service/control.js";
import { createGroupRegistry } from "../src/service/jobs.js";
import { createPermissionQueue } from "../src/service/permissions.js";
import { createReportReader } from "../src/service/report.js";
import { createQueue } from "../src/service/queue.js";

/**
 * tmux stubbed to "everything worked"; every send-keys is recorded instead.
 * @param {{ withPermissions?: boolean }} [options]
 */
function wire(options = {}) {
  /** @type {string[]} */
  const written = [];
  const queue = createQueue();
  const groups = createGroupRegistry();
  const permissions = options.withPermissions === false ? null : createPermissionQueue();
  const adapter = createClaudeAdapter({
    run: () => ({ status: 0, stdout: "", stderr: "" }),
    root: "/repo",
    queue,
    // The shipping reader with no transcript on disk: the report comes from
    // the Stop payload's own copy, which is the real fallback path.
    readReport: createReportReader({
      parse: () => ({ lastMessage: null }),
      readFile: () => null,
      flushTimeoutMs: 0,
    }),
  });
  adapter.bind({ agentId: "e2e", sessionId: "sess-1" });
  // The real adapter's write() would shell out to tmux; the run stub above
  // already covers that, so this only records what was sent, in order.
  const realWrite = adapter.write;
  adapter.write = (spec) => {
    written.push(spec.text);
    return realWrite(spec);
  };
  const service = createControlService({ queue, groups, adapters: { e2e: adapter }, permissions });
  return { service, queue, groups, permissions, adapter, written };
}

/** What claude's Notification hook actually posts when it needs a human. */
const NOTIFICATION = {
  hook_event_name: "Notification",
  session_id: "sess-1",
  message: "Claude needs your permission to use Bash",
};

/** A Stop payload for the same session; the report comes from the payload. */
const STOP = {
  hook_event_name: "Stop",
  session_id: "sess-1",
  last_assistant_message: "build dir removed",
};

describe("a Notification becomes a pending permission request", () => {
  it("binds the request to the job that is waiting, and leaves the job running", () => {
    const { service, queue, permissions } = wire();
    const submitted = service.submitGroup({
      parent: null,
      jobs: [{ prompt: "clean the build dir", agent: "e2e" }],
    });
    const jobId = submitted.jobs[0].id;

    const { entry, request } = service.handleNotification({ agent: "e2e", payload: NOTIFICATION });

    assert.equal(entry.kind, "permission");
    assert.equal(request?.jobId, jobId);
    assert.equal(request?.prompt, NOTIFICATION.message);
    assert.equal(permissions?.isBlocked("e2e"), true);
    // The job is untouched: waiting is not a status.
    assert.equal(queue.get(jobId)?.status, "running");
  });

  it("a harness that says nothing still opens an answerable question", () => {
    const { service } = wire();
    service.submitGroup({ parent: null, jobs: [{ prompt: "go", agent: "e2e" }] });
    const { request } = service.handleNotification({
      agent: "e2e",
      payload: { hook_event_name: "Notification", session_id: "sess-1" },
    });

    assert.equal(request?.prompt, "e2e is waiting for a human");
  });

  it("an adapter with no notification handler is an error, not a silent drop", () => {
    const queue = createQueue();
    const service = createControlService({
      queue,
      groups: createGroupRegistry(),
      adapters: { mute: { write: () => undefined } },
      permissions: createPermissionQueue(),
    });

    assert.throws(
      () => service.handleNotification({ agent: "mute", payload: {} }),
      /adapter for mute has no notification handler/,
    );
  });
});

describe("dispatch waits while a human is needed", () => {
  it("queued work is held back, then released by the decision", () => {
    const { service, queue, permissions, written } = wire();
    service.submitGroup({
      parent: null,
      jobs: [{ prompt: "first", agent: "e2e" }, { prompt: "second", agent: "e2e" }],
    });
    assert.deepEqual(written, ["first"], "only the first job is running");

    const { request } = service.handleNotification({ agent: "e2e", payload: NOTIFICATION });

    // The first job finishes, but the agent is still on a dialog: the second
    // job must NOT be sent yet.
    service.handleSignal({ agent: "e2e", payload: STOP });
    assert.deepEqual(written, ["first"], "the blocked agent got nothing new");
    assert.equal(queue.runningJob("e2e"), null);
    assert.equal(permissions?.isBlocked("e2e"), true);

    const resolved = service.resolvePermission({
      id: request?.id ?? "",
      decision: "approve",
      by: "bedirhan",
    });

    assert.equal(resolved.request.status, "approved");
    assert.equal(resolved.next?.sent, true);
    assert.deepEqual(written, ["first", "second"], "the answer released the queue");
  });

  it("a denial releases the queue too - the agent is unblocked either way", () => {
    const { service, permissions, written } = wire();
    service.submitGroup({
      parent: null,
      jobs: [{ prompt: "first", agent: "e2e" }, { prompt: "second", agent: "e2e" }],
    });
    const { request } = service.handleNotification({ agent: "e2e", payload: NOTIFICATION });
    service.handleSignal({ agent: "e2e", payload: STOP });

    service.resolvePermission({ id: request?.id ?? "", decision: "deny", by: "bedirhan" });

    assert.equal(permissions?.isBlocked("e2e"), false);
    assert.deepEqual(written, ["first", "second"]);
  });

  it("resolving without a permission queue is an error, not a no-op", () => {
    const { service } = wire({ withPermissions: false });
    assert.throws(
      () => service.resolvePermission({ id: "perm-1", decision: "approve" }),
      /no permission queue is wired/,
    );
  });
});

describe("the decision reaches the report", () => {
  it("an approved job's report carries who unblocked it", () => {
    const { service, permissions } = wire();
    service.submitGroup({ parent: null, jobs: [{ prompt: "clean the build dir", agent: "e2e" }] });
    const { request } = service.handleNotification({ agent: "e2e", payload: NOTIFICATION });
    permissions?.resolve(request?.id ?? "", "approve", { by: "bedirhan", note: "build dir only" });

    const handled = service.handleSignal({ agent: "e2e", payload: STOP });

    assert.equal(handled.job?.status, "done");
    // The job's own report survives; the decision is added to it.
    assert.match(handled.wakeup?.message ?? "", /Report: build dir removed/);
    assert.match(
      handled.wakeup?.message ?? "",
      /permission \(permission\): approved by bedirhan after 0s - build dir only/,
    );
  });

  it("a job that ended with its question unanswered says so, and stays blocking", () => {
    const { service, permissions } = wire();
    service.submitGroup({ parent: null, jobs: [{ prompt: "clean the build dir", agent: "e2e" }] });
    const { request } = service.handleNotification({ agent: "e2e", payload: NOTIFICATION });

    // Nobody answers; the turn ends anyway. The dialog is still on screen.
    const handled = service.handleSignal({ agent: "e2e", payload: STOP });

    assert.match(handled.wakeup?.message ?? "", /still waiting for a human/);
    assert.equal(permissions?.get(request?.id ?? "")?.status, "pending");
    assert.equal(permissions?.isBlocked("e2e"), true);
  });

  it("a timed-out job leaves the question standing - a stuck agent is usually stuck ON it", () => {
    const { service, permissions } = wire();
    service.submitGroup({ parent: null, jobs: [{ prompt: "clean the build dir", agent: "e2e" }] });
    service.handleNotification({ agent: "e2e", payload: NOTIFICATION });

    const swept = service.sweepTimeouts({ timeoutMs: 0 });

    assert.equal(swept.jobs[0].status, "timeout");
    assert.equal(permissions?.isBlocked("e2e"), true);
    assert.match(swept.wakeups[0].message ?? "", /still waiting for a human/);
  });

  it("a dead session cancels the question - the pane took the dialog with it", () => {
    const { service, permissions, written } = wire();
    service.submitGroup({
      parent: null,
      jobs: [{ prompt: "first", agent: "e2e" }, { prompt: "second", agent: "e2e" }],
    });
    const { request } = service.handleNotification({ agent: "e2e", payload: NOTIFICATION });

    const crashed = service.markCrashed({ agent: "e2e" });

    assert.equal(crashed.jobs[0].status, "crashed");
    assert.equal(permissions?.get(request?.id ?? "")?.status, "cancelled");
    assert.equal(permissions?.isBlocked("e2e"), false);
    // Unblocked, so the queue moves again - the second job goes out.
    assert.deepEqual(written, ["first", "second"]);
    // The group is only ready once that second job lands; the cancelled
    // question is in the crashed job's result, inside the group's one wake-up.
    const handled = service.handleSignal({ agent: "e2e", payload: STOP });
    assert.match(
      handled.wakeup?.message ?? "",
      /cancelled before anyone answered - agent session crashed/,
    );
  });
});

describe("without a permission queue nothing changes", () => {
  it("dispatch, signals and reports behave exactly as before", () => {
    const { service, written } = wire({ withPermissions: false });
    service.submitGroup({
      parent: null,
      jobs: [{ prompt: "first", agent: "e2e" }, { prompt: "second", agent: "e2e" }],
    });
    const handled = service.handleSignal({ agent: "e2e", payload: STOP });

    assert.equal(handled.job?.status, "done");
    assert.equal(handled.job?.report, "build dir removed");
    assert.deepEqual(written, ["first", "second"]);
  });

  it("a Notification is still delivered to the adapter, just not tracked", () => {
    const { service, adapter } = wire({ withPermissions: false });
    service.submitGroup({ parent: null, jobs: [{ prompt: "go", agent: "e2e" }] });

    const { entry, request } = service.handleNotification({ agent: "e2e", payload: NOTIFICATION });

    assert.equal(request, null);
    assert.equal(entry.message, NOTIFICATION.message);
    assert.equal(adapter.notifications().length, 1);
  });
});
