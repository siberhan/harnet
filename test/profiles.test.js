import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  abandonProfile,
  createProfile,
  createProfileManager,
  DEFAULT_TEMPLATE,
  openProfile,
  removeProfile,
  resolveTemplate,
  TEMPLATES,
} from "../src/service/profiles.js";

/**
 * Creates an in-memory fake runner simulating git worktree, branch, and tmux commands.
 */
function makeFakeRunner() {
  /** @type {string[][]} */
  const calls = [];
  /** @type {Set<string>} */
  const branches = new Set(["main", "feature"]);
  /** @type {Set<string>} */
  const sessions = new Set();
  /** @type {Map<string, string>} path -> branch */
  const worktrees = new Map();

  /**
   * @param {string[]} cmd
   * @param {{ cwd: string }} opts
   * @returns {{ status: number, stdout: string, stderr: string }}
   */
  function runner(cmd, opts) {
    calls.push(cmd);
    const [prog, ...args] = cmd;

    if (prog === "git") {
      if (args[0] === "worktree" && args[1] === "list" && args[2] === "--porcelain") {
        let out = "";
        for (const [wtPath, branch] of worktrees.entries()) {
          out += `worktree ${wtPath}\nbranch refs/heads/${branch}\n\n`;
        }
        return { status: 0, stdout: out, stderr: "" };
      }
      if (args[0] === "show-ref" && args[1] === "--verify") {
        const ref = args[3] ?? "";
        const branch = ref.replace(/^refs\/heads\//, "");
        return { status: branches.has(branch) ? 0 : 1, stdout: "", stderr: "" };
      }
      if (args[0] === "worktree" && args[1] === "add") {
        if (args[2] === "-b") {
          const branch = args[3];
          const wtPath = args[4];
          branches.add(branch);
          worktrees.set(wtPath, branch);
          return { status: 0, stdout: "", stderr: "" };
        } else {
          const wtPath = args[2];
          const branch = args[3];
          worktrees.set(wtPath, branch);
          return { status: 0, stdout: "", stderr: "" };
        }
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        const wtPath = args[args.length - 1];
        worktrees.delete(wtPath);
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "branch" && (args[1] === "-D" || args[1] === "-d")) {
        const branch = args[2];
        branches.delete(branch);
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    }

    if (prog === "tmux") {
      if (args[0] === "has-session") {
        const sess = args[2];
        return { status: sessions.has(sess) ? 0 : 1, stdout: "", stderr: "" };
      }
      if (args[0] === "new-session") {
        const sess = args[3];
        sessions.add(sess);
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "kill-session") {
        const sess = args[2];
        sessions.delete(sess);
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "pipe-pane") {
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    }

    return { status: 0, stdout: "", stderr: "" };
  }

  return { runner, calls, branches, sessions, worktrees };
}

describe("profiles: template resolution", () => {
  it("defaults to DEFAULT_TEMPLATE when no template is passed", () => {
    const t = resolveTemplate();
    assert.deepEqual(t, DEFAULT_TEMPLATE);
    assert.equal(t.role, "general assistant");
    assert.ok(t.capabilities.includes("read"));
    assert.ok(t.capabilities.includes("write"));
    assert.ok(t.capabilities.includes("bash"));
    assert.equal(t.harness, "claude");
  });

  it("resolves built-in named templates", () => {
    const dev = resolveTemplate("developer");
    assert.equal(dev.role, "software engineer");
    assert.equal(dev.harness, "claude");
    assert.ok(dev.capabilities.includes("git"));

    const rev = resolveTemplate("reviewer");
    assert.equal(rev.role, "code reviewer");

    const codex = resolveTemplate("codex");
    assert.equal(codex.role, "codex assistant");
    assert.equal(codex.harness, "codex");
  });

  it("merges partial custom template object with defaults", () => {
    const custom = resolveTemplate({
      role: "tester",
      capabilities: ["test"],
    });
    assert.equal(custom.role, "tester");
    assert.deepEqual(custom.capabilities, ["test"]);
    assert.equal(custom.harness, "claude");
    assert.equal(custom.defaultPrompt, DEFAULT_TEMPLATE.defaultPrompt);
  });
});

describe("profiles: createProfile lifecycle", () => {
  it("creates profile: opens worktree + branch and spawns tmux session via adapter", () => {
    const { runner, calls, sessions, branches, worktrees } = makeFakeRunner();
    const mgr = createProfileManager({ root: "/test/root", run: runner });

    const profile = mgr.createProfile({ id: "agent-1" });

    assert.equal(profile.id, "agent-1");
    assert.equal(profile.worktree, ".harnet/agents/agent-1/wt");
    assert.equal(profile.branch, "harnet/agent-1");
    assert.equal(profile.session, "harnet-agent-1");
    assert.equal(profile.state, "active");
    assert.equal(profile.template.role, "general assistant");

    // Verify git worktree and branch created
    assert.ok(branches.has("harnet/agent-1"));
    assert.ok(worktrees.has(".harnet/agents/agent-1/wt"));

    // Verify tmux session created
    assert.ok(sessions.has("harnet-agent-1"));

    // Verify commands called
    const gitAdd = calls.find(
      (c) => c[0] === "git" && c[1] === "worktree" && c[2] === "add" && c[3] === "-b"
    );
    assert.ok(gitAdd);
    assert.equal(gitAdd[3], "-b");
    assert.equal(gitAdd[4], "harnet/agent-1");
    assert.equal(gitAdd[5], ".harnet/agents/agent-1/wt");
    assert.equal(gitAdd[6], "main");

    const tmuxNew = calls.find((c) => c[0] === "tmux" && c[1] === "new-session");
    assert.ok(tmuxNew);
    assert.equal(tmuxNew[4], "harnet-agent-1");
  });

  it("supports custom base branch and codex template", () => {
    const { runner, calls, sessions } = makeFakeRunner();
    const mgr = createProfileManager({ root: "/test/root", run: runner });

    const profile = mgr.createProfile({
      id: "agent-codex",
      template: "codex",
      base: "feature",
    });

    assert.equal(profile.harness, "codex");
    assert.equal(profile.template.harness, "codex");

    const gitAdd = calls.find(
      (c) => c[0] === "git" && c[1] === "worktree" && c[2] === "add" && c[3] === "-b"
    );
    assert.ok(gitAdd);
    assert.equal(gitAdd[6], "feature");

    const tmuxNew = calls.find((c) => c[0] === "tmux" && c[1] === "new-session");
    assert.ok(tmuxNew);
    assert.equal(tmuxNew[tmuxNew.length - 1], "codex");
  });

  it("throws on invalid or empty agent id", () => {
    const mgr = createProfileManager();
    assert.throws(() => mgr.createProfile(/** @type {any} */ ({ id: "" })), /non-empty string id/);
    assert.throws(() => mgr.createProfile(/** @type {any} */ ({})), /non-empty string id/);
  });
});

describe("profiles: abandonProfile and openProfile", () => {
  it("abandonProfile closes tmux session while keeping worktree and branch on disk", () => {
    const { runner, sessions, worktrees, branches } = makeFakeRunner();
    const mgr = createProfileManager({ root: "/test/root", run: runner });

    mgr.createProfile({ id: "worker" });
    assert.ok(sessions.has("harnet-worker"));

    const abandonResult = mgr.abandonProfile({ id: "worker" });
    assert.equal(abandonResult.id, "worker");
    assert.equal(abandonResult.sessionClosed, true);
    assert.equal(abandonResult.kept.worktree, ".harnet/agents/worker/wt");
    assert.equal(abandonResult.kept.branch, "harnet/worker");

    // Session is closed
    assert.equal(sessions.has("harnet-worker"), false);

    // Worktree and branch stay
    assert.ok(worktrees.has(".harnet/agents/worker/wt"));
    assert.ok(branches.has("harnet/worker"));

    const profile = mgr.getProfile("worker");
    assert.equal(profile?.state, "abandoned");
  });

  it("openProfile reconnects to abandoned profile, preserves worktree and spawns new session", () => {
    const { runner, sessions, worktrees } = makeFakeRunner();
    const mgr = createProfileManager({ root: "/test/root", run: runner });

    mgr.createProfile({ id: "worker" });
    mgr.abandonProfile({ id: "worker" });
    assert.equal(sessions.has("harnet-worker"), false);

    const reopened = mgr.openProfile({ id: "worker" });
    assert.equal(reopened.state, "active");
    assert.ok(sessions.has("harnet-worker"));
    assert.ok(worktrees.has(".harnet/agents/worker/wt"));
  });
});

describe("profiles: removeProfile", () => {
  it("removes worktree AND deletes branch by default (varsayılan dalsız silme kapalı)", () => {
    const { runner, calls, sessions, worktrees, branches } = makeFakeRunner();
    const mgr = createProfileManager({ root: "/test/root", run: runner });

    mgr.createProfile({ id: "cleanup-agent" });
    assert.ok(sessions.has("harnet-cleanup-agent"));
    assert.ok(worktrees.has(".harnet/agents/cleanup-agent/wt"));
    assert.ok(branches.has("harnet/cleanup-agent"));

    const result = mgr.removeProfile({ id: "cleanup-agent" });
    assert.equal(result.id, "cleanup-agent");
    assert.equal(result.removed, true);
    assert.equal(result.branchDeleted, true);

    // Session closed
    assert.equal(sessions.has("harnet-cleanup-agent"), false);
    // Worktree removed
    assert.equal(worktrees.has(".harnet/agents/cleanup-agent/wt"), false);
    // Branch deleted
    assert.equal(branches.has("harnet/cleanup-agent"), false);

    // Verify git commands: both worktree remove and branch -D were executed
    const wtRemove = calls.find((c) => c[0] === "git" && c[1] === "worktree" && c[2] === "remove");
    assert.ok(wtRemove);

    const branchDelete = calls.find((c) => c[0] === "git" && c[1] === "branch" && c[2] === "-D");
    assert.ok(branchDelete);
    assert.equal(branchDelete[3], "harnet/cleanup-agent");

    assert.equal(mgr.hasProfile("cleanup-agent"), false);
  });

  it("preserves branch only when deleteBranch is explicitly false", () => {
    const { runner, calls, branches } = makeFakeRunner();
    const mgr = createProfileManager({ root: "/test/root", run: runner });

    mgr.createProfile({ id: "keep-branch-agent" });
    const result = mgr.removeProfile({ id: "keep-branch-agent", deleteBranch: false });

    assert.equal(result.removed, true);
    assert.equal(result.branchDeleted, false);
    assert.ok(branches.has("harnet/keep-branch-agent"));

    const branchDelete = calls.find((c) => c[0] === "git" && c[1] === "branch" && c[2] === "-D");
    assert.equal(branchDelete, undefined);
  });
});

describe("profiles: listing and standalone helpers", () => {
  it("lists all registered profiles", () => {
    const { runner } = makeFakeRunner();
    const mgr = createProfileManager({ root: "/test/root", run: runner });

    mgr.createProfile({ id: "a1", template: "developer" });
    mgr.createProfile({ id: "a2", template: "reviewer" });

    const list = mgr.listProfiles();
    assert.equal(list.length, 2);
    assert.equal(list[0].id, "a1");
    assert.equal(list[1].id, "a2");
  });

  it("works with standalone export functions", () => {
    const { runner, sessions, worktrees, branches } = makeFakeRunner();
    const opts = { root: "/test/root", run: runner };

    const p = createProfile({ id: "standalone-agent" }, opts);
    assert.equal(p.id, "standalone-agent");
    assert.ok(sessions.has("harnet-standalone-agent"));

    const abandoned = abandonProfile({ id: "standalone-agent" }, opts);
    assert.equal(abandoned.sessionClosed, true);

    const reopened = openProfile({ id: "standalone-agent" }, opts);
    assert.equal(reopened.state, "active");

    const removed = removeProfile({ id: "standalone-agent" }, opts);
    assert.equal(removed.removed, true);
    assert.equal(removed.branchDeleted, true);
  });
});
