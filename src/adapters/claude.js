/**
 * Claude Code adapter. README: Ajanla Konusmak + Gozlem ve Tamamlanma.
 *
 * One agent = one live TUI in one tmux session. Harnet never wraps the harness:
 * it opens it (`new-session`), attaches the byte log (`pipe-pane`) before any
 * output exists, and writes to it with `send-keys` exactly like a keyboard.
 * There is no second writer and no pty shim in between.
 *
 * Completion does not come from the screen: the `Stop` hook tells us the turn
 * ended, and this adapter turns that signal into queue.complete(jobId, done).
 * The `Notification` hook means the agent is waiting for a human - it becomes
 * its own queue entry, never a job result.
 *
 * src/MAP.js bans cross-imports, so queue.js is not imported: the queue is
 * injected and described by a structural type (QueueLike). DECISIONS.md accepts
 * this duplication; test/adapters-contract.test.js keeps the shapes honest and
 * tsc checks the real queue against QueueLike at the call site.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";

export const CLAUDE = Object.freeze({
  spawn: "claude",
  write: "tmux send-keys",
  doneSignal: "Stop hook",
  log: "transcript .jsonl",
  harness: "claude",
  hookEvent: "Stop",
  notificationEvent: "Notification",
});

/** Statuses this adapter can hand to the queue. Mirrors queue.js JobStatus. */
export const DONE_STATUS = "done";
export const ERROR_STATUS = "error";

/**
 * A command that failed, or an adapter invariant that was violated.
 */
export class AdapterError extends Error {
  /**
   * @param {string} message
   * @param {{ command: string[], code: number|null, stderr: string, cwd: string }} details
   */
  constructor(message, details) {
    super(message);
    this.name = "AdapterError";
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
 * Profile <-> tmux session is 1:1. Same derivation as src/git/worktree.js.
 * @param {string} agentId
 * @returns {string}
 */
export function sessionName(agentId) {
  return `harnet-${agentId}`;
}

/**
 * Raw byte log for humans. README: "Gorsel: pane.log'daki ham bayt akisi".
 * Harnet never makes decisions from this file.
 * @param {string} agentId
 * @returns {string}
 */
export function paneLogPath(agentId) {
  return `.harnet/agents/${agentId}/pane.log`;
}

/**
 * tmux runs the pipe command through a shell, so the path has to be quoted.
 * @param {string} value
 * @returns {string}
 */
export function shQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * @typedef {object} RunResult
 * @property {number|null} status
 * @property {string} stdout
 * @property {string} stderr
 */

/** @typedef {(argv: string[], opts: { cwd: string }) => RunResult} Runner */

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
 * Structural description of src/service/queue.js. Nothing imports it, so the
 * contract lives here and is checked by tsc where a real queue is injected.
 * @typedef {object} QueueLike
 * @property {(agent: string) => { id: string }|null} runningJob
 * @property {(spec: { jobId: string, status: string, report?: string|null, at?: number }) => unknown} complete
 * @property {(spec: { agent: string, report?: string|null, at?: number }) => unknown} markCrashed
 */

/**
 * @typedef {object} SessionInfo
 * @property {string} agentId
 * @property {string} session
 * @property {string} worktree
 * @property {string} command
 * @property {string} logPath
 * @property {string} absoluteLogPath
 * @property {number} spawnedAt
 * @property {boolean} dead
 */

/**
 * @typedef {object} SignalResult
 * @property {boolean} matched
 * @property {string|null} reason set when matched is false
 * @property {string|null} agentId
 * @property {string|null} jobId
 * @property {string|null} status "done" or "error"
 * @property {string|null} report
 */

/**
 * @typedef {object} NotificationEntry
 * @property {"permission"} kind
 * @property {string|null} agentId
 * @property {string|null} sessionId
 * @property {string} message
 * @property {number} at
 * @property {unknown} payload
 */

/**
 * @typedef {object} StopPayload
 * @property {string} [hook_event_name]
 * @property {string} [session_id]
 * @property {string} [transcript_path]
 * @property {string} [cwd]
 * @property {boolean} [stop_hook_active]
 * @property {string} [status] "error" turns the completion into an error
 * @property {string} [agentId] explicit agent, when the hook config carries it
 */

/**
 * @typedef {object} AdapterOptions
 * @property {Runner} [run]
 * @property {string} [root] repo root; cwd of every command
 * @property {QueueLike|null} [queue]
 * @property {() => number} [now]
 * @property {(entry: NotificationEntry) => void} [onNotification]
 * @property {(ctx: { transcriptPath: string|null, agentId: string, payload: unknown }) => string|null} [readReport]
 */

/** @type {Runner} */
export function spawnRunner(argv, opts) {
  if (argv.length === 0) {
    throw new AdapterError("empty command", {
      command: [],
      code: null,
      stderr: "",
      cwd: opts.cwd,
    });
  }
  const res = spawnSync(argv[0], argv.slice(1), {
    cwd: opts.cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error) {
    throw new AdapterError(`cannot run ${argv[0]}: ${res.error.message}`, {
      command: argv,
      code: null,
      stderr: res.error.message,
      cwd: opts.cwd,
    });
  }
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/**
 * @param {AdapterOptions} [options]
 */
export function createClaudeAdapter(options = {}) {
  const run = options.run ?? spawnRunner;
  const root = options.root ?? process.cwd();
  const queue = options.queue ?? null;
  const now = options.now ?? (() => Date.now());
  const onNotification = options.onNotification ?? null;
  const readReport = options.readReport ?? null;

  /** @type {CommandLog[]} */
  const calls = [];
  /** @type {Map<string, SessionInfo>} */
  const sessions = new Map();
  /** @type {Map<string, string>} harness session id -> agent id */
  const bindings = new Map();
  /** @type {NotificationEntry[]} */
  const notifications = [];

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
    if (!entry.ok && opts.allowFailure !== true) {
      const detail = String(res.stderr).trim() || String(res.stdout).trim() || "no output";
      throw new AdapterError(`${argv.join(" ")} failed (exit ${res.status}): ${detail}`, {
        command: entry.argv,
        code: res.status,
        stderr: res.stderr,
        cwd: root,
      });
    }
    return entry;
  }

  /**
   * @param {string} agentId
   * @returns {boolean}
   */
  function isAlive(agentId) {
    return (
      exec(["tmux", "has-session", "-t", sessionName(agentId)], { allowFailure: true }).status === 0
    );
  }

  /**
   * Open the harness in its tmux session and attach the byte log before the
   * first byte is written. Order matters: new-session, then pipe-pane.
   * @param {object} spec
   * @param {string} spec.agentId
   * @param {string} spec.worktree directory the session starts in
   * @param {string} [spec.command] defaults to `claude`
   * @returns {SessionInfo}
   */
  function spawn(spec) {
    const agentId = spec.agentId;
    const session = sessionName(agentId);
    const command = spec.command ?? CLAUDE.spawn;
    const logPath = paneLogPath(agentId);
    const absoluteLogPath = join(root, logPath);

    if (isAlive(agentId)) {
      throw new AdapterError(`tmux session already exists: ${session}`, {
        command: ["tmux", "has-session", "-t", session],
        code: 0,
        stderr: "",
        cwd: root,
      });
    }

    exec(["tmux", "new-session", "-d", "-s", session, "-c", spec.worktree, command]);
    // Right after creation, before the TUI has printed anything: that is what
    // makes pane.log the single source for both "history" and "live stream".
    exec(["tmux", "pipe-pane", "-t", session, "-o", `cat >> ${shQuote(absoluteLogPath)}`]);

    /** @type {SessionInfo} */
    const info = {
      agentId,
      session,
      worktree: spec.worktree,
      command,
      logPath,
      absoluteLogPath,
      spawnedAt: now(),
      dead: false,
    };
    sessions.set(agentId, info);
    return info;
  }

  /**
   * Write to the agent the way a keyboard would. Literal mode (-l) so prompt
   * text is never read as key names.
   * @param {object} spec
   * @param {string} spec.agentId
   * @param {string} spec.text
   * @returns {{ agentId: string, session: string, chars: number }}
   */
  function write(spec) {
    const agentId = spec.agentId;
    const session = sessionName(agentId);
    if (!isAlive(agentId)) {
      throw new AdapterError(`tmux session is gone: ${session}`, {
        command: ["tmux", "has-session", "-t", session],
        code: 1,
        stderr: "",
        cwd: root,
      });
    }
    exec(["tmux", "send-keys", "-t", session, "-l", "--", spec.text]);
    exec(["tmux", "send-keys", "-t", session, "Enter"]);
    return { agentId, session, chars: spec.text.length };
  }

  /**
   * Close the session. Used for cleanup and for abandon; the worktree and the
   * byte log stay on disk.
   * @param {object} spec
   * @param {string} spec.agentId
   * @returns {boolean} whether a session was actually killed
   */
  function kill(spec) {
    const agentId = spec.agentId;
    if (!isAlive(agentId)) {
      const known = sessions.get(agentId);
      if (known !== undefined) known.dead = true;
      return false;
    }
    exec(["tmux", "kill-session", "-t", sessionName(agentId)]);
    const known = sessions.get(agentId);
    if (known !== undefined) known.dead = true;
    return true;
  }

  /**
   * Turn every session that died into a crashed job. Idempotent: a dead session
   * is reported once.
   * @returns {Array<{ agentId: string, session: string, crashedAt: number }>}
   */
  function sweepCrashes() {
    /** @type {Array<{ agentId: string, session: string, crashedAt: number }>} */
    const out = [];
    for (const info of sessions.values()) {
      if (info.dead) continue;
      if (isAlive(info.agentId)) continue;
      info.dead = true;
      const crashedAt = now();
      if (queue !== null) {
        queue.markCrashed({
          agent: info.agentId,
          report: `tmux session ${info.session} is gone`,
          at: crashedAt,
        });
      }
      out.push({ agentId: info.agentId, session: info.session, crashedAt });
    }
    return out;
  }

  /**
   * Remember which harness session belongs to which agent. The Stop hook only
   * carries Claude's session id, so this is how a signal finds its job.
   * @param {object} spec
   * @param {string} spec.agentId
   * @param {string} spec.sessionId
   * @returns {void}
   */
  function bind(spec) {
    bindings.set(spec.sessionId, spec.agentId);
  }

  /**
   * @param {StopPayload} payload
   * @returns {string|null}
   */
  function resolveAgent(payload) {
    const sessionId = payload.session_id ?? null;
    if (sessionId !== null && bindings.has(sessionId)) {
      return bindings.get(sessionId) ?? null;
    }
    if (typeof payload.agentId === "string" && payload.agentId.length > 0) {
      return payload.agentId;
    }
    return null;
  }

  /**
   * @param {string|null} transcriptPath
   * @param {string} agentId
   * @param {unknown} payload
   * @returns {string|null}
   */
  function reportFrom(transcriptPath, agentId, payload) {
    if (readReport === null) return null;
    return readReport({ transcriptPath, agentId, payload });
  }

  /**
   * @param {string|null} agentId
   * @param {string} reason
   * @returns {SignalResult}
   */
  function unmatched(agentId, reason) {
    return { matched: false, reason, agentId, jobId: null, status: null, report: null };
  }

  /**
   * The turn ended. Match the signal to the running job and complete it.
   * @param {StopPayload} payload
   * @returns {SignalResult}
   */
  function handleStop(payload) {
    const agentId = resolveAgent(payload);
    if (agentId === null) {
      return unmatched(null, `unknown session id: ${payload.session_id ?? "(none)"}`);
    }
    if (queue === null) return unmatched(agentId, "no queue wired");

    const job = queue.runningJob(agentId);
    if (job === null) return unmatched(agentId, `no running job for ${agentId}`);

    const status = payload.status === ERROR_STATUS ? ERROR_STATUS : DONE_STATUS;
    const report = reportFrom(payload.transcript_path ?? null, agentId, payload);
    queue.complete({ jobId: job.id, status, report, at: now() });
    return { matched: true, reason: null, agentId, jobId: job.id, status, report };
  }

  /**
   * The agent is waiting for a human (permission prompt, question). This is an
   * explicit "human needed" entry, not a silent wait and not a job result -
   * the job stays running.
   * @param {StopPayload} payload
   * @returns {NotificationEntry}
   */
  function handleNotification(payload) {
    const sessionId = payload.session_id ?? null;
    const agentId = resolveAgent(payload);
    /** @type {NotificationEntry} */
    const entry = {
      kind: "permission",
      agentId,
      sessionId,
      message: payload.message ?? "",
      at: now(),
      payload,
    };
    notifications.push(entry);
    if (onNotification !== null) onNotification(entry);
    return entry;
  }

  return {
    spawn,
    write,
    kill,
    isAlive,
    sweepCrashes,
    bind,
    handleStop,
    handleNotification,
    /** @returns {SessionInfo[]} */
    sessions: () => [...sessions.values()].map((s) => ({ ...s })),
    /** @returns {NotificationEntry[]} */
    notifications: () => notifications.slice(),
    /** @returns {CommandLog[]} */
    calls: () => calls.slice(),
    harness: CLAUDE.spawn,
    root,
  };
}
