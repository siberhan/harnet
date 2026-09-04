import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AGENTS_ROOT,
  GitError,
  branchName,
  createWorktreeManager,
  parseWorktreeList,
  sessionName,
  transcriptDir,
  worktreePath,
} from "../src/git/worktree.js";
import { runnerFor } from "./fake-runner.js";

const ROOT = "/repo";
const PORCELAIN = [
  "worktree /repo",
  "HEAD 1111111111111111111111111111111111111111",
  "branch refs/heads/main",
  "",
  "worktree /repo/.harnet/agents/a1/wt",
  "HEAD 2222222222222222222222222222222222222222",
  "branch refs/heads/harnet/a1",
  "",
  "worktree /repo/.harnet/agents/a2/wt",
  "HEAD 3333333333333333333333333333333333333333",
  "detached",
  "",
  "worktree /repo/bare.git",
  "bare",
  "",
  "worktree /repo/.harnet/agents/a3/wt",
  "HEAD 4444444444444444444444444444444444444444",
  "branch refs/heads/harnet/a3",
  "locked",
  "prunable",
  "",
].join("\n");

/**
 * @param {Record<string, import("./fake-runner.js").FakeResponse>} routes
 */
function manager(routes) {
  /** @type {{ calls: string[] }} */
  const sink = { calls: [] };
  const m = createWorktreeManager({ root: ROOT, run: runnerFor(routes, sink) });
  return { m, sink };
}

describe("worktree: layout", () => {
  it("keeps the README layout", () => {
    assert.equal(AGENTS_ROOT, ".harnet/agents");
    assert.equal(worktreePath("a1"), ".harnet/agents/a1/wt");
    assert.equal(branchName("a1"), "harnet/a1");
    assert.equal(sessionName("a1"), "harnet-a1");
    assert.equal(transcriptDir("a1"), ".harnet/agents/a1");
  });
});

describe("worktree: list parsing", () => {
  it("parses porcelain output", () => {
    const list = parseWorktreeList(PORCELAIN);
    assert.equal(list.length, 5);
    assert.deepEqual(
      list.map((w) => w.path),
      [
        "/repo",
        "/repo/.harnet/agents/a1/wt",
        "/repo/.harnet/agents/a2/wt",
        "/repo/bare.git",
        "/repo/.harnet/agents/a3/wt",
      ],
    );
    assert.equal(list[0].branch, "main");
    assert.equal(list[0].head, "1111111111111111111111111111111111111111");
    assert.equal(list[1].branch, "harnet/a1");
    assert.equal(list[2].branch, null, "detached worktree has no branch");
    assert.equal(list[2].detached, true);
    assert.equal(list[3].bare, true);
    assert.equal(list[4].locked, true);
    assert.equal(list[4].prunable, true);
    assert.equal(list[4].head, "4444444444444444444444444444444444444444");
  });

  it("parses an empty repo", () => {
    assert.deepEqual(parseWorktreeList(""), []);
    assert.deepEqual(parseWorktreeList("worktree /repo\nHEAD abc\nbranch refs/heads/main\n"), [
      {
        path: "/repo",
        head: "abc",
        branch: "main",
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      },
    ]);
  });
});

describe("worktree: open", () => {
  it("creates the branch and the worktree for a new profile", () => {
    const { m, sink } = manager({
      "git worktree list --porcelain": {},
      "git show-ref": { status: 1 },
      "git worktree add -b": {},
    });
    const info = m.open({ agentId: "a1" });
    assert.equal(info.created, true);
    assert.equal(info.reusedBranch, false);
    assert.equal(info.path, ".harnet/agents/a1/wt");
    assert.equal(info.branch, "harnet/a1");
    assert.equal(info.base, "main");
    assert.equal(info.session, "harnet-a1");
    assert.ok(
      sink.calls?.includes(
        `${ROOT} :: git worktree add -b harnet/a1 .harnet/agents/a1/wt main`,
      ),
      sink.calls?.join("\n"),
    );
  });

  it("checks out the existing branch when the profile was abandoned before", () => {
    const { m, sink } = manager({
      "git worktree list --porcelain": {},
      "git show-ref": { status: 0 },
      "git worktree add": {},
    });
    const info = m.open({ agentId: "a1", base: "harnet/parent" });
    assert.equal(info.created, true);
    assert.equal(info.reusedBranch, true);
    assert.ok(
      sink.calls?.includes(`${ROOT} :: git worktree add .harnet/agents/a1/wt harnet/a1`),
      sink.calls?.join("\n"),
    );
    assert.ok(
      !sink.calls?.some((c) => c.includes("worktree add -b")),
      "must not recreate an existing branch",
    );
  });

  it("cuts the child branch from the parent branch, not from main", () => {
    const { m, sink } = manager({
      "git worktree list --porcelain": {},
      "git show-ref": { status: 1 },
      "git worktree add -b": {},
    });
    m.open({ agentId: "b1", base: "harnet/a1" });
    assert.ok(
      sink.calls?.includes(`${ROOT} :: git worktree add -b harnet/b1 .harnet/agents/b1/wt harnet/a1`),
      sink.calls?.join("\n"),
    );
  });

  it("is idempotent when the worktree is already registered", () => {
    const { m, sink } = manager({
      "git worktree list --porcelain": {
        stdout: "worktree /repo/.harnet/agents/a1/wt\nHEAD abc\nbranch refs/heads/harnet/a1\n",
      },
    });
    const info = m.open({ agentId: "a1" });
    assert.equal(info.created, false);
    assert.equal(info.reusedBranch, true);
    assert.ok(
      !sink.calls?.some((c) => c.includes("worktree add")),
      "an existing worktree must not be re-added",
    );
  });
});

describe("worktree: abandon", () => {
  it("closes the session and keeps the worktree and transcript", () => {
    const { m, sink } = manager({
      "tmux has-session": { status: 0 },
      "tmux kill-session": {},
    });
    const res = m.abandon({ agentId: "a1" });
    assert.equal(res.sessionClosed, true);
    assert.deepEqual(res.kept, {
      worktree: ".harnet/agents/a1/wt",
      transcriptDir: ".harnet/agents/a1",
    });
    assert.ok(sink.calls?.includes(`${ROOT} :: tmux kill-session -t harnet-a1`));
    assert.ok(
      !sink.calls?.some((c) => c.includes("worktree remove")),
      "abandon must never delete the worktree",
    );
  });

  it("is fine when the session is already gone", () => {
    const { m, sink } = manager({ "tmux has-session": { status: 1 } });
    const res = m.abandon({ agentId: "a1" });
    assert.equal(res.sessionClosed, false);
    assert.ok(!sink.calls?.some((c) => c.includes("kill-session")));
  });

  it("accepts a custom session name", () => {
    const { m, sink } = manager({
      "tmux has-session": { status: 0 },
      "tmux kill-session": {},
    });
    m.abandon({ agentId: "a1", session: "custom-session" });
    assert.ok(sink.calls?.includes(`${ROOT} :: tmux has-session -t custom-session`));
  });
});

describe("worktree: remove", () => {
  it("removes the worktree and keeps the branch by default", () => {
    const { m, sink } = manager({
      "git worktree list --porcelain": {
        stdout: "worktree /repo/.harnet/agents/a1/wt\nHEAD abc\nbranch refs/heads/harnet/a1\n",
      },
      "git worktree remove": {},
    });
    const res = m.remove({ agentId: "a1" });
    assert.equal(res.removed, true);
    assert.equal(res.branchDeleted, false);
    assert.ok(sink.calls?.includes(`${ROOT} :: git worktree remove .harnet/agents/a1/wt`));
    assert.ok(!sink.calls?.some((c) => c.includes("branch -D")));
  });

  it("supports --force and branch deletion", () => {
    const { m, sink } = manager({
      "git worktree list --porcelain": {
        stdout: "worktree /repo/.harnet/agents/a1/wt\nHEAD abc\nbranch refs/heads/harnet/a1\n",
      },
      "git worktree remove": {},
      "git branch -D": {},
    });
    const res = m.remove({ agentId: "a1", force: true, deleteBranch: true });
    assert.equal(res.removed, true);
    assert.equal(res.branchDeleted, true);
    assert.ok(sink.calls?.includes(`${ROOT} :: git worktree remove --force .harnet/agents/a1/wt`));
    assert.ok(sink.calls?.includes(`${ROOT} :: git branch -D harnet/a1`));
  });

  it("does nothing when the worktree is not registered", () => {
    const { m, sink } = manager({ "git worktree list --porcelain": {} });
    const res = m.remove({ agentId: "ghost" });
    assert.equal(res.removed, false);
    assert.deepEqual(sink.calls, [`${ROOT} :: git worktree list --porcelain`]);
  });
});

describe("worktree: errors and logging", () => {
  it("turns a non-zero exit into a GitError", () => {
    const { m } = manager({
      "git worktree list --porcelain": {},
      "git show-ref": { status: 1 },
      "git worktree add -b": {
        status: 128,
        stderr: "fatal: 'nope' is not a valid branch name",
      },
    });
    let caught = null;
    try {
      m.open({ agentId: "a1", base: "nope" });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof GitError, `expected GitError, got ${String(caught)}`);
    assert.ok(caught instanceof Error);
    assert.equal(caught.code, 128);
    assert.equal(caught.cwd, ROOT);
    assert.deepEqual(caught.command, [
      "git",
      "worktree",
      "add",
      "-b",
      "harnet/a1",
      ".harnet/agents/a1/wt",
      "nope",
    ]);
    assert.match(caught.message, /not a valid branch name/);
    assert.match(caught.stderr, /not a valid branch name/);
  });

  it("logs failed commands too", () => {
    const { m } = manager({
      "git worktree list --porcelain": { status: 128, stderr: "fatal: not a repository" },
    });
    assert.throws(() => m.list(), /not a repository/);
    assert.equal(m.calls().length, 1);
    assert.equal(m.calls()[0].ok, false);
    assert.equal(m.calls()[0].status, 128);
    assert.deepEqual(m.calls()[0].argv, ["git", "worktree", "list", "--porcelain"]);
    assert.equal(m.calls()[0].cwd, ROOT);
  });

  it("reports every command to the logger hook", () => {
    /** @type {string[]} */
    const seen = [];
    const m = createWorktreeManager({
      root: ROOT,
      run: runnerFor({
        "git worktree list --porcelain": {},
        "git show-ref": { status: 1 },
        "git worktree add -b": {},
      }),
      onCommand: (entry) => seen.push(entry.argv.join(" ")),
    });
    m.open({ agentId: "a1" });
    assert.deepEqual(seen, [
      "git worktree list --porcelain",
      "git show-ref --verify --quiet refs/heads/harnet/a1",
      "git worktree add -b harnet/a1 .harnet/agents/a1/wt main",
    ]);
  });

  it("an unexpected command fails the test loudly", () => {
    const { m } = manager({ "git worktree list --porcelain": {} });
    assert.throws(() => m.abandon({ agentId: "a1" }), /unexpected command: tmux has-session/);
  });
});
