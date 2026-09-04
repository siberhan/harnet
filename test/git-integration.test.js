/**
 * Integration tests: these run real git in a throwaway repository under the
 * system temp dir. No tmux session is ever created - the abandon path is
 * exercised with a session that does not exist.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createWorktreeManager } from "../src/git/worktree.js";
import { createDeliveryManager } from "../src/git/deliver.js";

/** @type {string[]} */
const tempRepos = [];

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 */
function git(cwd, args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${res.status}): ${res.stderr}`);
  }
  return res.stdout;
}

/** @returns {string} a fresh repo with one commit on main */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "harnet-git-"));
  tempRepos.push(dir);
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "harnet@example.com"]);
  git(dir, ["config", "user.name", "harnet"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "seed"]);
  return dir;
}

/**
 * @param {string} cwd
 * @param {string} file
 * @param {string} content
 */
function commitFile(cwd, file, content) {
  writeFileSync(join(cwd, file), content);
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", `edit ${file}`]);
}

/**
 * @param {string} cwd
 * @param {string} message
 */
function commitAll(cwd, message) {
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", message]);
}

afterEach(() => {
  while (tempRepos.length > 0) {
    const dir = tempRepos.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("git integration: worktree lifecycle", () => {
  it("opens a worktree on harnet/<id>", () => {
    const dir = makeRepo();
    const wt = createWorktreeManager({ root: dir });

    const info = wt.open({ agentId: "a1" });
    assert.equal(info.created, true);
    assert.equal(info.reusedBranch, false);
    assert.ok(existsSync(join(dir, ".harnet/agents/a1/wt")), "worktree dir on disk");
    assert.ok(existsSync(join(dir, ".harnet/agents/a1/wt", "seed.txt")), "worktree has the tree");

    const list = wt.list();
    assert.equal(list.length, 2);
    const entry = list.find((w) => w.branch === "harnet/a1");
    assert.ok(entry);
    // git prints real paths; the manager normalises its root the same way
    assert.equal(entry.path, join(wt.root, ".harnet/agents/a1/wt"));
    assert.equal(entry.path, realpathSync(join(dir, ".harnet/agents/a1/wt")));
    assert.match(entry.head ?? "", /^[0-9a-f]{40}$/);

    assert.equal(wt.open({ agentId: "a1" }).created, false, "re-open is a reconnect");
  });

  it("cuts a child branch from a parent branch, not from main", () => {
    const dir = makeRepo();
    const wt = createWorktreeManager({ root: dir });
    wt.open({ agentId: "a1" });

    const childDir = join(dir, ".harnet/agents/a1/wt");
    commitFile(childDir, "parent-work.txt", "in a1\n");

    const child = wt.open({ agentId: "b1", base: "harnet/a1" });
    assert.equal(child.base, "harnet/a1");
    const grandChildDir = join(dir, child.path);
    assert.ok(
      existsSync(join(grandChildDir, "parent-work.txt")),
      "child sees the parent's unmerged work",
    );
  });

  it("abandon keeps worktree and transcript, remove deletes it", () => {
    const dir = makeRepo();
    const wt = createWorktreeManager({ root: dir });
    wt.open({ agentId: "a1" });
    const wtDir = join(dir, ".harnet/agents/a1/wt");

    const abandoned = wt.abandon({ agentId: "a1" });
    assert.equal(abandoned.sessionClosed, false, "no tmux session exists in this test");
    assert.ok(existsSync(wtDir), "abandon must keep the worktree");
    assert.ok(existsSync(join(wtDir, ".git")), "still a worktree after abandon");
    assert.equal(wt.open({ agentId: "a1" }).created, false, "reconnect after abandon");

    const removed = wt.remove({ agentId: "a1" });
    assert.equal(removed.removed, true);
    assert.equal(removed.branchDeleted, false);
    assert.equal(existsSync(wtDir), false);
    assert.equal(wt.list().length, 1);
    assert.ok(wt.branchExists("harnet/a1"), "commits survive the worktree");

    const again = wt.open({ agentId: "a1" });
    assert.equal(again.created, true);
    assert.equal(again.reusedBranch, true, "existing branch is re-checked-out, not recreated");

    wt.remove({ agentId: "a1", deleteBranch: true });
    assert.equal(wt.branchExists("harnet/a1"), false);
  });

  it("remove refuses a dirty worktree unless forced", () => {
    const dir = makeRepo();
    const wt = createWorktreeManager({ root: dir });
    const info = wt.open({ agentId: "a1" });
    const wtDir = join(dir, info.path);

    writeFileSync(join(wtDir, "seed.txt"), "locally modified\n");
    writeFileSync(join(wtDir, "scratch.txt"), "untracked\n");

    assert.throws(() => wt.remove({ agentId: "a1" }), /modified or untracked/);
    assert.ok(existsSync(wtDir), "failed remove must leave the worktree alone");

    const res = wt.remove({ agentId: "a1", force: true });
    assert.equal(res.removed, true);
    assert.equal(existsSync(wtDir), false);
  });
});

describe("git integration: delivery", () => {
  it("merges a child branch into the parent", () => {
    const dir = makeRepo();
    const wt = createWorktreeManager({ root: dir });
    const child = wt.open({ agentId: "a1" });
    commitFile(join(dir, child.path), "feature.txt", "from a1\n");

    const delivery = createDeliveryManager({ root: dir });
    const report = delivery.deliver({ childBranch: "harnet/a1", parentBranch: "main" });

    assert.equal(report.status, "merged");
    assert.match(report.mergeCommit ?? "", /^[0-9a-f]{40}$/);
    assert.deepEqual(report.conflicts, []);
    assert.equal(readFileSync(join(dir, "feature.txt"), "utf8"), "from a1\n");
    assert.equal(git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "main");

    const parents = git(dir, ["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(" ");
    assert.equal(parents.length, 3, "--no-ff keeps an explicit delivery commit");
    assert.ok(wt.branchExists("harnet/a1"), "delivery does not delete the child branch");
  });

  it("reports already up to date on a second delivery", () => {
    const dir = makeRepo();
    const wt = createWorktreeManager({ root: dir });
    const child = wt.open({ agentId: "a1" });
    commitFile(join(dir, child.path), "feature.txt", "from a1\n");

    const delivery = createDeliveryManager({ root: dir });
    delivery.deliver({ childBranch: "harnet/a1", parentBranch: "main" });
    const second = delivery.deliver({ childBranch: "harnet/a1", parentBranch: "main" });
    assert.equal(second.status, "up-to-date");
    assert.equal(second.mergeCommit, null);
  });

  it("aborts on conflict and hands the file list back", () => {
    const dir = makeRepo();
    const wt = createWorktreeManager({ root: dir });
    commitFile(dir, "shared.txt", "base\n");

    const child = wt.open({ agentId: "a1" });
    commitFile(join(dir, child.path), "shared.txt", "child version\n");
    commitFile(dir, "shared.txt", "parent version\n");

    const delivery = createDeliveryManager({ root: dir });
    const report = delivery.deliver({ childBranch: "harnet/a1", parentBranch: "main" });

    assert.equal(report.status, "conflict");
    assert.deepEqual(report.conflicts, ["shared.txt"]);
    assert.equal(report.aborted, true);
    assert.equal(report.mergeCommit, null);

    // nothing half-merged is left behind
    assert.equal(delivery.mergeInProgress(), false);
    assert.equal(git(dir, ["status", "--porcelain"]).trim(), "", "worktree is clean again");
    assert.equal(
      readFileSync(join(dir, "shared.txt"), "utf8"),
      "parent version\n",
      "parent content untouched - no auto-resolution",
    );
    assert.equal(
      readFileSync(join(dir, child.path, "shared.txt"), "utf8"),
      "child version\n",
      "child keeps its own version",
    );
    assert.ok(
      !readFileSync(join(dir, "shared.txt"), "utf8").includes("<<<<<<<"),
      "no conflict markers written",
    );
  });

  it("the parent can still deliver after resolving a conflict", () => {
    const dir = makeRepo();
    const wt = createWorktreeManager({ root: dir });
    commitFile(dir, "shared.txt", "base\n");

    const child = wt.open({ agentId: "a1" });
    commitFile(join(dir, child.path), "shared.txt", "child version\n");
    commitFile(dir, "shared.txt", "parent version\n");

    const delivery = createDeliveryManager({ root: dir });
    const conflicted = delivery.deliver({ childBranch: "harnet/a1", parentBranch: "main" });
    assert.equal(conflicted.status, "conflict");

    // nothing was auto-resolved behind our back: the same conflict comes back
    const retry = delivery.deliver({ childBranch: "harnet/a1", parentBranch: "main" });
    assert.equal(retry.status, "conflict");
    assert.deepEqual(retry.conflicts, ["shared.txt"]);

    // what the parent agent does with the conflict list: resolve, then merge again
    git(dir, ["checkout", "harnet/a1", "--", "shared.txt"]);
    commitAll(dir, "resolve conflict: take the child version");
    const resolved = delivery.deliver({ childBranch: "harnet/a1", parentBranch: "main" });

    assert.equal(resolved.status, "merged");
    assert.deepEqual(resolved.conflicts, []);
    assert.match(resolved.mergeCommit ?? "", /^[0-9a-f]{40}$/);
    assert.equal(readFileSync(join(dir, "shared.txt"), "utf8"), "child version\n");
    assert.equal(delivery.mergeInProgress(), false);
    assert.equal(git(dir, ["status", "--porcelain"]).trim(), "");
  });
});
