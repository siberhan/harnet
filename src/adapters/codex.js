/**
 * Codex adapter. README: Ajanla Konusmak + Gozlem ve Tamamlanma.
 *
 * Same shape as the Claude adapter - one agent, one live TUI in one tmux
 * session, written to with send-keys - but completion arrives differently:
 * Codex calls a `notify` program instead of firing a hook, and that
 * notification already carries the last assistant message, so no transcript
 * read is needed to produce a report.
 *
 * Key style: a real codex-cli 0.153.0 notify payload hyphenates its keys
 * (`thread-id`, `last-assistant-message`, `turn-id`, `input-messages`) - this
 * was measured by scripts/live-spike.sh, not assumed. This adapter used to read
 * only the snake_case spelling, so no live turn ever matched and every codex job
 * hung forever. Everything now goes through normalizeNotify() at the entry
 * point, which accepts both spellings; the rest of the file keeps reading
 * snake_case only.
 *
 * src/MAP.js bans cross-imports, so queue.js is not imported: the queue is
 * injected and described by a structural type (QueueLike). DECISIONS.md accepts
 * this duplication; test/adapters-contract.test.js keeps the shapes honest and
 * tsc checks the real queue against QueueLike at the call site.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";

export const CODEX = Object.freeze({
  spawn: "codex",
  write: "tmux send-keys",
  doneSignal: "notify program",
  log: "rollout .jsonl",
  harness: "codex",
  turnCompleteType: "agent-turn-complete",
  approvalType: "approval-required",
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
 * A notify payload after normalizeNotify(): snake_case only.
 * @typedef {object} NotifyPayload
 * @property {string} [type]
 * @property {string} [thread_id] codex thread id; `session_id` is accepted too
 * @property {string} [session_id]
 * @property {string} [turn_id]
 * @property {string[]} [input_messages]
 * @property {string} [cwd]
 * @property {string} [client] e.g. "codex-tui"
 * @property {string} [last_assistant_message] the report, carried by notify
 * @property {string} [status] "error" turns the completion into an error
 * @property {string} [message] approval/permission text
 * @property {boolean} [approval] alternate approval-request marker
 * @property {string} [agentId] explicit agent, when the notify config carries it
 */

/**
 * What codex actually writes: the same record with hyphenated keys. Kept as its
 * own type so the boundary between "what arrives" and "what we read" is visible.
 * @typedef {Record<string, unknown>} RawNotifyPayload
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
 * Hyphenated key -> the snake_case name the rest of this file reads.
 * Only the keys codex was observed to send; anything else is passed through.
 */
const NOTIFY_KEY_ALIASES = Object.freeze({
  "thread-id": "thread_id",
  "turn-id": "turn_id",
  "last-assistant-message": "last_assistant_message",
  "input-messages": "input_messages",
  "session-id": "session_id",
});

/**
 * Fold a raw notify record into the snake_case shape. Both spellings are
 * accepted because codex has shipped both and Harnet cannot pick the version
 * the user has installed; an already-snake_case key always wins, so a payload
 * carrying both never loses the canonical value.
 * @param {RawNotifyPayload|NotifyPayload} raw
 * @returns {NotifyPayload}
 */
export function normalizeNotify(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const alias = /** @type {Record<string, string>} */ (NOTIFY_KEY_ALIASES)[key];
    if (alias === undefined) {
      out[key] = value;
      continue;
    }
    // Never let the alias overwrite a canonical key that is already there.
    if (!Object.prototype.hasOwnProperty.call(raw, alias)) out[alias] = value;
  }
  return /** @type {NotifyPayload} */ (out);
}

/**
 * Whether a notify payload is an approval request rather than a turn result.
 * Accepts a raw payload: it normalises first, like the handlers do.
 * @param {RawNotifyPayload|NotifyPayload} raw
 * @returns {boolean}
 */
export function isApprovalRequest(raw) {
  const payload = normalizeNotify(raw);
  return payload.type === CODEX.approvalType || payload.approval === true;
}

/**
 * @param {AdapterOptions} [options]
 */
export function createCodexAdapter(options = {}) {
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
  /** @type {Map<string, string>} codex thread id -> agent id */
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
   * @param {string} [spec.command] defaults to `codex`
   * @returns {SessionInfo}
   */
  function spawn(spec) {
    const agentId = spec.agentId;
    const session = sessionName(agentId);
    const command = spec.command ?? CODEX.spawn;
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
   * Remember which codex thread belongs to which agent. notify only carries the
   * thread id, so this is how a signal finds its job.
   * @param {object} spec
   * @param {string} spec.agentId
   * @param {string} spec.sessionId codex thread id
   * @returns {void}
   */
  function bind(spec) {
    bindings.set(spec.sessionId, spec.agentId);
  }

  /**
   * @param {NotifyPayload} payload
   * @returns {string|null}
   */
  function resolveAgent(payload) {
    const threadId = payload.thread_id ?? payload.session_id ?? null;
    if (threadId !== null && bindings.has(threadId)) {
      return bindings.get(threadId) ?? null;
    }
    if (typeof payload.agentId === "string" && payload.agentId.length > 0) {
      return payload.agentId;
    }
    return null;
  }

  /**
   * notify already carries the last assistant message (README: "son mesaji
   * iceren bir bildirim"); the transcript read is only a fallback.
   * @param {NotifyPayload} payload
   * @param {string} agentId
   * @returns {string|null}
   */
  function reportFrom(payload, agentId) {
    if (typeof payload.last_assistant_message === "string" && payload.last_assistant_message.length > 0) {
      return payload.last_assistant_message;
    }
    if (readReport !== null) {
      return readReport({ transcriptPath: null, agentId, payload });
    }
    return null;
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
   * Anything that is not a turn-complete notification is ignored on purpose.
   * @param {RawNotifyPayload|NotifyPayload} raw
   * @returns {SignalResult}
   */
  function handleNotify(raw) {
    const payload = normalizeNotify(raw);
    if (payload.type !== CODEX.turnCompleteType) {
      return unmatched(null, `not a turn-complete signal: ${payload.type ?? "(no type)"}`);
    }
    const agentId = resolveAgent(payload);
    if (agentId === null) {
      return unmatched(null, `unknown thread id: ${payload.thread_id ?? "(none)"}`);
    }
    if (queue === null) return unmatched(agentId, "no queue wired");

    const job = queue.runningJob(agentId);
    if (job === null) return unmatched(agentId, `no running job for ${agentId}`);

    const status = payload.status === ERROR_STATUS ? ERROR_STATUS : DONE_STATUS;
    const report = reportFrom(payload, agentId);
    queue.complete({ jobId: job.id, status, report, at: now() });
    return { matched: true, reason: null, agentId, jobId: job.id, status, report };
  }

  /**
   * The agent is waiting for a human. This is an explicit "human needed" entry,
   * not a silent wait and not a job result - the job stays running.
   * @param {RawNotifyPayload|NotifyPayload} raw
   * @returns {NotificationEntry}
   */
  function handleNotification(raw) {
    const payload = normalizeNotify(raw);
    const sessionId = payload.thread_id ?? payload.session_id ?? null;
    const agentId = resolveAgent(payload);
    /** @type {NotificationEntry} */
    const entry = {
      kind: "permission",
      agentId,
      sessionId,
      message: payload.message ?? "",
      at: now(),
      // The raw record, not the normalised one: the panel shows what codex
      // actually sent, and normalisation is only for the keys we read.
      payload: raw,
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
    handleNotify,
    handleNotification,
    /** @returns {SessionInfo[]} */
    sessions: () => [...sessions.values()].map((s) => ({ ...s })),
    /** @returns {NotificationEntry[]} */
    notifications: () => notifications.slice(),
    /** @returns {CommandLog[]} */
    calls: () => calls.slice(),
    harness: CODEX.spawn,
    root,
  };
}
