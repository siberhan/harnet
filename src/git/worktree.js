/**
 * Worktree + branch manager. README: Worktree Yonetimi, Profil Basina Kalici Worktree.
 *
 * Layout is fixed and never derived from anything else:
 *   .harnet/agents/<agent-id>/wt   ->  branch harnet/<agent-id>
 *
 * Rules that shape this file:
 * - Worktree is opened once per profile and lives until the profile is deleted.
 *   No temporary worktrees, no fork-on-execute.
 * - Abandon closes the tmux session only; the worktree and the transcript stay,
 *   so re-opening later reconnects to the same directory and branch.
 * - The branch base is chosen once, at open time, and never moves afterwards.
 *   No auto-rebase here; the gap is closed by git merge during delivery.
 *
 * Every command goes through one exec() path: it is logged, and a non-zero
 * exit becomes a GitError. Nothing is retried or auto-repaired.
 *
 * The runner is injectable, so tests can assert the exact command sequence
 * without touching a real repository.
 */

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * `git worktree list` prints real paths, never symlinks (on macOS /var is
 * /private/var). Comparing a symlinked root against those paths would make
 * open() believe a live worktree does not exist and try to re-add it.
 * @param {string} dir
 * @returns {string}
 */
function realRoot(dir) {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

export const AGENTS_ROOT = ".harnet/agents";

/**
 * @param {string} agentId
 * @returns {string}
 */
export function worktreePath(agentId) {
  return `${AGENTS_ROOT}/${agentId}/wt`;
}

/**
 * @param {string} agentId
 * @returns {string}
 */
export function branchName(agentId) {
  return `harnet/${agentId}`;
}

/**
 * Profile <-> tmux session is 1:1 (README). The name is derived, not stored.
 * @param {string} agentId
 * @returns {string}
 */
export function sessionName(agentId) {
  return `harnet-${agentId}`;
}

/**
 * Where the pane log and transcripts live: beside the worktree, so they
 * survive both abandon and remove.
 * @param {string} agentId
 * @returns {string}
 */
export function transcriptDir(agentId) {
  return `${AGENTS_ROOT}/${agentId}`;
}

/**
 * A command that failed. Carries everything needed to report it upstream
 * without re-running anything.
 */
export class GitError extends Error {
  /**
   * @param {string} message
   * @param {{ command: string[], code: number|null, stderr: string, cwd: string }} details
   */
  constructor(message, details) {
    super(message);
    this.name = "GitError";
    /** @type {string[]} */
    this.command = details.command;
    /** @type {number|null} */
    this.code = details.code;
    /** @type {string} */
    this.stderr = details.stderr;
    /** @type {string} */
    this.cwd = details.cwd;
  }
}

/**
 * @typedef {object} RunResult
 * @property {number|null} status
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * @typedef {(argv: string[], opts: { cwd: string }) => RunResult} Runner
 */

/**
 * @typedef {object} CommandLog
 * @property {string[]} argv
 * @property {string} cwd
 * @property {number|null} status
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} ok
 */

/**
 * @typedef {object} WorktreeInfo
 * @property {string} path
 * @property {string|null} head
 * @property {string|null} branch
 * @property {boolean} bare
 * @property {boolean} detached
 * @property {boolean} locked
 * @property {boolean} prunable
 */

/**
 * Default runner: argv straight to the process, no shell, no quoting games.
 * @type {Runner}
 */
export function spawnRunner(argv, opts) {
  if (argv.length === 0) {
    throw new GitError("empty command", { command: [], code: null, stderr: "", cwd: opts.cwd });
  }
  const res = spawnSync(argv[0], argv.slice(1), {
    cwd: opts.cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error) {
    throw new GitError(`cannot run ${argv[0]}: ${res.error.message}`, {
      command: argv,
      code: null,
      stderr: res.error.message,
      cwd: opts.cwd,
    });
  }
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/**
 * Parse `git worktree list --porcelain`.
 * @param {string} porcelain
 * @returns {WorktreeInfo[]}
 */
export function parseWorktreeList(porcelain) {
  /** @type {WorktreeInfo[]} */
  const out = [];
  /** @type {WorktreeInfo|null} */
  let current = null;
  for (const raw of porcelain.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("worktree ")) {
      current = {
        path: line.slice("worktree ".length),
        head: null,
        branch: null,
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      };
      out.push(current);
      continue;
    }
    if (current === null) continue;
    if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
    else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "bare") current.bare = true;
    else if (line === "detached") current.detached = true;
    else if (line.startsWith("locked")) current.locked = true;
    else if (line.startsWith("prunable")) current.prunable = true;
  }
  return out;
}

/**
 * @typedef {object} WorktreeManagerOptions
 * @property {string} [root] repo root; cwd of every command
 * @property {Runner} [run]
 * @property {(entry: CommandLog) => void} [onCommand]
 */

/**
 * @param {WorktreeManagerOptions} [options]
 */
export function createWorktreeManager(options = {}) {
  const root = realRoot(options.root ?? process.cwd());
  const run = options.run ?? spawnRunner;
  const onCommand = options.onCommand ?? null;

  /** @type {CommandLog[]} */
  const calls = [];

  /**
   * @param {string[]} argv
   * @param {{ allowFailure?: boolean }} [opts]
   * @returns {CommandLog}
   */
  function exec(argv, opts = {}) {
    const res = run(argv, { cwd: root });
    /** @type {CommandLog} */
    const entry = {
      argv: argv.slice(),
      cwd: root,
      status: res.status,
      stdout: res.stdout,
      stderr: res.stderr,
      ok: res.status === 0,
    };
    calls.push(entry);
    if (onCommand !== null) onCommand(entry);
    if (!entry.ok && opts.allowFailure !== true) {
      const detail = String(res.stderr).trim() || String(res.stdout).trim() || "no output";
      throw new GitError(`${argv.join(" ")} failed (exit ${res.status}): ${detail}`, {
        command: entry.argv,
        code: res.status,
        stderr: res.stderr,
        cwd: root,
      });
    }
    return entry;
  }

  /**
   * @param {string} branch
   * @returns {boolean}
   */
  function branchExists(branch) {
    return (
      exec(["git", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
        allowFailure: true,
      }).status === 0
    );
  }

  /**
   * @returns {WorktreeInfo[]}
   */
  function list() {
    return parseWorktreeList(exec(["git", "worktree", "list", "--porcelain"]).stdout);
  }

  /**
   * @param {string} agentId
   * @returns {WorktreeInfo|null}
   */
  function findRegistered(agentId) {
    const absolute = join(root, worktreePath(agentId));
    const branch = branchName(agentId);
    return list().find((w) => w.path === absolute || w.branch === branch) ?? null;
  }

  /**
   * Open the worktree of a profile. Idempotent: an already registered worktree
   * is reported back, not re-created - that is how the service reconnects to
   * sessions after a restart.
   * @param {object} spec
   * @param {string} spec.agentId
   * @param {string} [spec.base] branch the profile is cut from; root agents use main
   * @param {string} [spec.session] tmux session name override
   * @returns {{ agentId: string, path: string, branch: string, base: string, created: boolean, reusedBranch: boolean, session: string }}
   */
  function open(spec) {
    const agentId = spec.agentId;
    const base = spec.base ?? "main";
    const path = worktreePath(agentId);
    const branch = branchName(agentId);

    const existing = findRegistered(agentId);
    if (existing !== null) {
      return {
        agentId,
        path,
        branch,
        base,
        created: false,
        reusedBranch: true,
        session: spec.session ?? sessionName(agentId),
      };
    }

    const reusedBranch = branchExists(branch);
    if (reusedBranch) {
      exec(["git", "worktree", "add", path, branch]);
    } else {
      exec(["git", "worktree", "add", "-b", branch, path, base]);
    }
    return {
      agentId,
      path,
      branch,
      base,
      created: true,
      reusedBranch,
      session: spec.session ?? sessionName(agentId),
    };
  }

  /**
   * Close the agent's live session, keep everything on disk.
   * @param {object} spec
   * @param {string} spec.agentId
   * @param {string} [spec.session]
   * @returns {{ agentId: string, session: string, sessionClosed: boolean, kept: { worktree: string, transcriptDir: string } }}
   */
  function abandon(spec) {
    const agentId = spec.agentId;
    const session = spec.session ?? sessionName(agentId);
    const hasSession =
      exec(["tmux", "has-session", "-t", session], { allowFailure: true }).status === 0;
    if (hasSession) exec(["tmux", "kill-session", "-t", session]);
    return {
      agentId,
      session,
      sessionClosed: hasSession,
      kept: { worktree: worktreePath(agentId), transcriptDir: transcriptDir(agentId) },
    };
  }

  /**
   * Delete the profile's worktree. The transcript and, by default, the branch
   * survive - deleting a branch would throw away the agent's commits.
   * @param {object} spec
   * @param {string} spec.agentId
   * @param {boolean} [spec.force] remove even with modified/untracked files
   * @param {boolean} [spec.deleteBranch] also drop harnet/<agentId>
   * @returns {{ agentId: string, path: string, branch: string, removed: boolean, branchDeleted: boolean }}
   */
  function remove(spec) {
    const agentId = spec.agentId;
    const path = worktreePath(agentId);
    const branch = branchName(agentId);

    if (findRegistered(agentId) === null) {
      return { agentId, path, branch, removed: false, branchDeleted: false };
    }
    exec(spec.force === true ? ["git", "worktree", "remove", "--force", path] : ["git", "worktree", "remove", path]);

    let branchDeleted = false;
    if (spec.deleteBranch === true) {
      exec(["git", "branch", "-D", branch]);
      branchDeleted = true;
    }
    return { agentId, path, branch, removed: true, branchDeleted };
  }

  return {
    open,
    list,
    abandon,
    remove,
    branchExists,
    /** @returns {CommandLog[]} */
    calls: () => calls.slice(),
    root,
  };
}
