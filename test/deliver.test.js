import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GitError,
  createDeliveryManager,
  deliveryPlan,
  mergeMessage,
} from "../src/git/deliver.js";
import { runnerFor } from "./fake-runner.js";

const ROOT = "/repo";

/**
 * @param {Record<string, import("./fake-runner.js").FakeResponse>} routes
 */
function manager(routes) {
  /** @type {{ calls: string[] }} */
  const sink = { calls: [] };
  const m = createDeliveryManager({ root: ROOT, run: runnerFor(routes, sink) });
  return { m, sink };
}

/**
 * @param {string[]} calls
 * @param {string} needle
 */
function indexOf(calls, needle) {
  return calls.findIndex((c) => c.includes(needle));
}

/** Routes for a merge that succeeds. */
const OK_ROUTES = {
  "git show-ref": { status: 0 },
  "git rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
  "git merge --no-ff": { status: 0 },
  "git merge": { status: 0 },
  "git rev-parse HEAD": { stdout: "abc123\n" },
};

describe("deliver: plan", () => {
  it("still describes the README flow", () => {
    assert.ok(
      deliveryPlan({ childBranch: "harnet/b", parentBranch: "main" }).includes("abort"),
    );
    assert.equal(mergeMessage("harnet/b", "main"), "harnet: merge harnet/b into main");
  });
});

describe("deliver: merge", () => {
  it("merges the child into the parent with an explicit merge commit", () => {
    const { m, sink } = manager(OK_ROUTES);
    const report = m.deliver({ childBranch: "harnet/b", parentBranch: "main" });
    assert.equal(report.status, "merged");
    assert.equal(report.mergeCommit, "abc123");
    assert.deepEqual(report.conflicts, []);
    assert.equal(report.aborted, false);
    assert.equal(report.error, null);
    // argv is joined with spaces here, so the message carries no shell quotes
    assert.ok(
      sink.calls?.includes(
        `${ROOT} :: git merge --no-ff -m harnet: merge harnet/b into main harnet/b`,
      ),
      sink.calls?.join("\n"),
    );
  });

  it("does not check out when the parent branch is already HEAD", () => {
    const { m, sink } = manager(OK_ROUTES);
    m.deliver({ childBranch: "harnet/b", parentBranch: "main" });
    assert.equal(indexOf(sink.calls ?? [], "git checkout"), -1);
  });

  it("checks the parent branch out first when HEAD is elsewhere", () => {
    const { m, sink } = manager({
      ...OK_ROUTES,
      "git rev-parse --abbrev-ref HEAD": { stdout: "harnet/a\n" },
      "git checkout": {},
    });
    const report = m.deliver({ childBranch: "harnet/b", parentBranch: "main" });
    assert.equal(report.status, "merged");
    const calls = sink.calls ?? [];
    const checkout = indexOf(calls, "git checkout main");
    const merge = indexOf(calls, "git merge");
    assert.ok(checkout >= 0, calls.join("\n"));
    assert.ok(checkout < merge, "checkout must happen before the merge");
  });

  it("refuses to switch branches when autoCheckout is off", () => {
    const { m } = manager({
      ...OK_ROUTES,
      "git rev-parse --abbrev-ref HEAD": { stdout: "harnet/a\n" },
    });
    assert.throws(
      () => m.deliver({ childBranch: "harnet/b", parentBranch: "main", autoCheckout: false }),
      /parent branch main is not checked out \(HEAD is harnet\/a\)/,
    );
  });

  it("can be told to fast-forward instead", () => {
    const { m, sink } = manager(OK_ROUTES);
    m.deliver({ childBranch: "harnet/b", parentBranch: "main", noFf: false });
    assert.ok(sink.calls?.includes(`${ROOT} :: git merge -m harnet: merge harnet/b into main harnet/b`));
    assert.ok(!sink.calls?.some((c) => c.includes("--no-ff")));
  });

  it("accepts a custom merge message", () => {
    const { m, sink } = manager(OK_ROUTES);
    m.deliver({ childBranch: "harnet/b", parentBranch: "main", message: "deliver turn 3" });
    assert.ok(sink.calls?.includes(`${ROOT} :: git merge --no-ff -m deliver turn 3 harnet/b`));
  });

  it("reports already up to date without inventing a commit", () => {
    const { m, sink } = manager({
      ...OK_ROUTES,
      "git merge --no-ff": { status: 0, stdout: "Already up to date.\n" },
    });
    const report = m.deliver({ childBranch: "harnet/b", parentBranch: "main" });
    assert.equal(report.status, "up-to-date");
    assert.equal(report.mergeCommit, null);
    assert.ok(!sink.calls.some((c) => c.endsWith("git rev-parse HEAD")));
  });
});

describe("deliver: conflicts", () => {
  const CONFLICT_ROUTES = {
    "git show-ref": { status: 0 },
    "git rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
    "git merge": { status: 1, stderr: "CONFLICT (content): Merge conflict in a.txt\n" },
    "git diff --name-only": { stdout: "a.txt\nb.txt\n" },
    "git rev-parse --verify --quiet MERGE_HEAD": { status: 0 },
    "git merge --abort": { status: 0 },
  };

  it("collects the conflicted files, then aborts, and never resolves", () => {
    const { m, sink } = manager(CONFLICT_ROUTES);
    const report = m.deliver({ childBranch: "harnet/b", parentBranch: "main" });
    assert.equal(report.status, "conflict");
    assert.deepEqual(report.conflicts, ["a.txt", "b.txt"]);
    assert.equal(report.aborted, true);
    assert.equal(report.mergeCommit, null);
    assert.equal(report.error, null);

    const calls = sink.calls ?? [];
    const merge = indexOf(calls, "git merge --no-ff");
    const readConflicts = indexOf(calls, "git diff --name-only --diff-filter=U");
    const abort = indexOf(calls, "git merge --abort");
    assert.ok(merge < readConflicts, "conflicts must be read before aborting");
    assert.ok(readConflicts < abort, "abort must come after reading the conflicts");
    assert.equal(
      calls.filter((c) => c.includes("git checkout") || c.includes("-X ") || c.includes("-s "))
        .length,
      0,
      "no strategy options: Harnet never auto-resolves",
    );
  });

  it("throws with the conflict list when the abort itself fails", () => {
    const { m } = manager({
      ...CONFLICT_ROUTES,
      "git merge --abort": { status: 128, stderr: "fatal: could not abort" },
    });
    let caught = null;
    try {
      m.deliver({ childBranch: "harnet/b", parentBranch: "main" });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof GitError, `expected GitError, got ${String(caught)}`);
    assert.deepEqual(caught.conflicts, ["a.txt", "b.txt"]);
    assert.match(caught.message, /left mid-merge/);
  });

  it("distinguishes a plain failure from a conflict", () => {
    const { m, sink } = manager({
      "git show-ref": { status: 0 },
      "git rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
      "git merge": { status: 1, stderr: "error: Your local changes would be overwritten" },
      "git diff --name-only": { stdout: "" },
      "git rev-parse --verify --quiet MERGE_HEAD": { status: 1 },
    });
    const report = m.deliver({ childBranch: "harnet/b", parentBranch: "main" });
    assert.equal(report.status, "failed");
    assert.deepEqual(report.conflicts, []);
    assert.equal(report.aborted, false);
    assert.match(report.error ?? "", /local changes would be overwritten/);
    assert.ok(!sink.calls?.some((c) => c.includes("merge --abort")), "no merge to abort");
  });

  it("can clean up a merge left behind by someone else", () => {
    const { m } = manager({
      "git rev-parse --verify --quiet MERGE_HEAD": { status: 0 },
      "git merge --abort": { status: 0 },
    });
    assert.equal(m.mergeInProgress(), true);
    assert.equal(m.abortMerge(), true);
  });

  it("abortMerge is a no-op when no merge is running", () => {
    const { m, sink } = manager({ "git rev-parse --verify --quiet MERGE_HEAD": { status: 1 } });
    assert.equal(m.mergeInProgress(), false);
    assert.equal(m.abortMerge(), false);
    assert.ok(!sink.calls?.some((c) => c.includes("merge --abort")));
  });
});

describe("deliver: guards and logging", () => {
  it("refuses a child branch that does not exist", () => {
    const { m, sink } = manager({
      "git show-ref --verify --quiet refs/heads/harnet/b": { status: 1 },
      "git show-ref": { status: 0 },
    });
    let caught = null;
    try {
      m.deliver({ childBranch: "harnet/b", parentBranch: "main" });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof GitError);
    assert.match(caught.message, /child branch does not exist: harnet\/b/);
    assert.ok(!sink.calls?.some((c) => c.includes("git merge")));
  });

  it("refuses a parent branch that does not exist", () => {
    const { m } = manager({
      "git show-ref --verify --quiet refs/heads/main": { status: 1 },
      "git show-ref": { status: 0 },
    });
    assert.throws(
      () => m.deliver({ childBranch: "harnet/b", parentBranch: "main" }),
      /parent branch does not exist: main/,
    );
  });

  it("logs every command with its status", () => {
    const { m } = manager(OK_ROUTES);
    m.deliver({ childBranch: "harnet/b", parentBranch: "main" });
    const calls = m.calls();
    assert.deepEqual(
      calls.map((c) => c.argv.join(" ")),
      [
        "git show-ref --verify --quiet refs/heads/harnet/b",
        "git show-ref --verify --quiet refs/heads/main",
        "git rev-parse --abbrev-ref HEAD",
        "git merge --no-ff -m harnet: merge harnet/b into main harnet/b",
        "git rev-parse HEAD",
      ],
    );
    assert.ok(calls.every((c) => c.cwd === ROOT && c.ok));
    assert.equal(calls[3].stdout, "");
  });
});
