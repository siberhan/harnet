/**
 * Delivery. README: Teslimat + Cakisma Yonetimi.
 *
 * Code flows bottom-up through the call tree: a child delivers to the agent
 * that called it, only the root agent delivers to main. Delivery is a plain
 * git merge done during the parent's wake-up turn.
 *
 * Hard rule: Harnet never resolves a conflict. On conflict it collects the
 * conflicted file list FIRST (the index still holds it), then runs
 * `git merge --abort`, and hands the list to the parent agent. The parent
 * resolves it in one integration turn.
 *
 * The runner is injectable, so tests can assert the exact command sequence.
 * Note: src/MAP.js keeps phase-1 modules import-free, so GitError is defined
 * here as well rather than shared with src/git/worktree.js.
 */

import { spawnSync } from "node:child_process";

/**
 * A command that failed.
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
    /** @type {string[]} conflicted files, when the failure is a merge conflict */
    this.conflicts = [];
  }
}

/**
 * Human readable plan, kept from the scaffold (README: Teslimat).
 * @param {{ childBranch: string, parentBranch: string }} args
 * @returns {string}
 */
export function deliveryPlan({ childBranch, parentBranch }) {
  return `merge ${childBranch} into ${parentBranch}; on conflict: git merge --abort, report file list`;
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
 * @typedef {"merged"|"up-to-date"|"conflict"|"failed"} DeliveryStatus
 */

/**
 * @typedef {object} DeliveryReport
 * @property {string} childBranch
 * @property {string} parentBranch
 * @property {DeliveryStatus} status
 * @property {string|null} mergeCommit null unless a merge commit was created
 * @property {string[]} conflicts conflicted files, in git's order
 * @property {boolean} aborted whether `git merge --abort` ran successfully
 * @property {string|null} error stderr of the merge, for non-conflict failures
 */

/** @type {Runner} */
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
 * @param {string} childBranch
 * @param {string} parentBranch
 * @returns {string}
 */
export function mergeMessage(childBranch, parentBranch) {
  return `harnet: merge ${childBranch} into ${parentBranch}`;
}

/**
 * @typedef {object} DeliveryOptions
 * @property {string} [root] repo root; cwd of every command
 * @property {Runner} [run]
 * @property {(entry: CommandLog) => void} [onCommand]
 */

/**
 * @param {DeliveryOptions} [options]
 */
export function createDeliveryManager(options = {}) {
  const root = options.root ?? process.cwd();
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
   * @returns {string}
   */
  function currentBranch() {
    return exec(["git", "rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  }

  /**
   * @returns {boolean}
   */
  function mergeInProgress() {
    return (
      exec(["git", "rev-parse", "--verify", "--quiet", "MERGE_HEAD"], { allowFailure: true })
        .status === 0
    );
  }

  /**
   * Unmerged paths in the index. Only meaningful while a merge is in progress.
   * @returns {string[]}
   */
  function conflictFiles() {
    const out = exec(["git", "diff", "--name-only", "--diff-filter=U"], { allowFailure: true })
      .stdout;
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  /**
   * Merge a child branch into its parent branch.
   * @param {object} spec
   * @param {string} spec.childBranch
   * @param {string} spec.parentBranch
   * @param {string} [spec.message]
   * @param {boolean} [spec.noFf] keep an explicit merge commit (default true)
   * @param {boolean} [spec.autoCheckout] switch to the parent branch if needed (default true)
   * @returns {DeliveryReport}
   */
  function deliver(spec) {
    const childBranch = spec.childBranch;
    const parentBranch = spec.parentBranch;

    if (!branchExists(childBranch)) {
      throw new GitError(`child branch does not exist: ${childBranch}`, {
        command: ["git", "show-ref", "--verify", "--quiet", `refs/heads/${childBranch}`],
        code: 1,
        stderr: "",
        cwd: root,
      });
    }
    if (!branchExists(parentBranch)) {
      throw new GitError(`parent branch does not exist: ${parentBranch}`, {
        command: ["git", "show-ref", "--verify", "--quiet", `refs/heads/${parentBranch}`],
        code: 1,
        stderr: "",
        cwd: root,
      });
    }

    const head = currentBranch();
    if (head !== parentBranch) {
      if (spec.autoCheckout === false) {
        throw new GitError(
          `parent branch ${parentBranch} is not checked out (HEAD is ${head})`,
          { command: ["git", "rev-parse", "--abbrev-ref", "HEAD"], code: 0, stderr: "", cwd: root },
        );
      }
      exec(["git", "checkout", parentBranch]);
    }

    const message = spec.message ?? mergeMessage(childBranch, parentBranch);
    const noFf = spec.noFf !== false;
    const argv = noFf
      ? ["git", "merge", "--no-ff", "-m", message, childBranch]
      : ["git", "merge", "-m", message, childBranch];
    const merge = exec(argv, { allowFailure: true });

    if (merge.status === 0) {
      if (/already up[- ]to[- ]date/i.test(merge.stdout)) {
        return {
          childBranch,
          parentBranch,
          status: "up-to-date",
          mergeCommit: null,
          conflicts: [],
          aborted: false,
          error: null,
        };
      }
      return {
        childBranch,
        parentBranch,
        status: "merged",
        mergeCommit: exec(["git", "rev-parse", "HEAD"]).stdout.trim(),
        conflicts: [],
        aborted: false,
        error: null,
      };
    }

    // Read the conflicted files before aborting: the index still holds them,
    // and after --abort there is nothing left to read.
    const conflicts = conflictFiles();
    let aborted = false;
    if (mergeInProgress()) {
      const abort = exec(["git", "merge", "--abort"], { allowFailure: true });
      aborted = abort.status === 0;
      if (!aborted) {
        const err = new GitError(
          `git merge --abort failed, repository is left mid-merge: ${abort.stderr.trim()}`,
          { command: abort.argv, code: abort.status, stderr: abort.stderr, cwd: root },
        );
        err.conflicts = conflicts;
        throw err;
      }
    }

    return {
      childBranch,
      parentBranch,
      status: conflicts.length > 0 ? "conflict" : "failed",
      mergeCommit: null,
      conflicts,
      aborted,
      error: conflicts.length > 0 ? null : merge.stderr.trim(),
    };
  }

  /**
   * Abort a merge someone else left behind. Used for recovery, not delivery.
   * @returns {boolean} whether an abort was needed and succeeded
   */
  function abortMerge() {
    if (!mergeInProgress()) return false;
    return exec(["git", "merge", "--abort"], { allowFailure: true }).status === 0;
  }

  return {
    deliver,
    abortMerge,
    currentBranch,
    branchExists,
    conflictFiles,
    mergeInProgress,
    /** @returns {CommandLog[]} */
    calls: () => calls.slice(),
    root,
  };
}
