/**
 * Permission requests: the agent asks, a human answers, the job waits.
 *
 * README: Insan Onayi. An agent that hits a permission prompt is not done and
 * not broken - it is stuck on a question only a person can answer. Both
 * adapters already surface that moment as a NotificationEntry with
 * `kind: "permission"` (src/adapters/claude.js handleNotification, from the
 * Notification hook; src/adapters/codex.js handleNotification, from an
 * approval-required notify). What neither of them has is somewhere to put the
 * question and somewhere to get the answer from. That is this file.
 *
 * The three rules it exists to keep:
 *   1. A pending request BLOCKS. `isBlocked(agentId)` is true from `request`
 *      until `resolve`, so nothing dispatches a second job into an agent that
 *      is sitting on a dialog. The job itself is untouched - it stays running,
 *      exactly as the adapters' comments promise.
 *   2. Every decision is RECORDED: who decided, when, which way, and how long
 *      the agent waited. A silent approval is indistinguishable from a bug.
 *   3. The record REACHES THE REPORT. `reportLineFor(jobId)` renders those
 *      records as one line per decision, for a caller to append to the job's
 *      report before it goes through jobs.js buildResult - so "done" never
 *      hides the fact that a human had to unblock it, and a denial says who
 *      said no.
 *
 * Phase-1 rule (src/MAP.js): no cross-imports between modules. The clock and
 * the id factory are injected, and the elapsed formatter is duplicated rather
 * than imported from jobs.js - same reason ResultStatus is duplicated there.
 *
 * In memory only, like the rest of src/service: a restart loses pending
 * requests. That is deliberate for phase 1 - a request that outlives the
 * process would outlive the tmux session it belongs to anyway.
 */

/** What the requester is asking for. Free-form: the harnesses phrase it. */
export const PermissionKind = Object.freeze({
  /** A tool/command wants to run: bash, edit, web fetch. */
  TOOL: "tool",
  /** The agent asked the human a question and is waiting on the answer. */
  QUESTION: "question",
  /** Anything we could not classify; the prompt still carries the detail. */
  OTHER: "other",
});

export const PermissionDecision = Object.freeze({
  APPROVE: "approve",
  DENY: "deny",
});

export const PermissionStatus = Object.freeze({
  PENDING: "pending",
  APPROVED: "approved",
  DENIED: "denied",
  CANCELLED: "cancelled",
});

/**
 * Decisions a resolve() may carry, mapped to the status they produce.
 * @type {Record<string, string>}
 */
const STATUS_FOR_DECISION = Object.freeze({
  [PermissionDecision.APPROVE]: PermissionStatus.APPROVED,
  [PermissionDecision.DENY]: PermissionStatus.DENIED,
});

/**
 * Spellings a caller (or a panel keypress) may plausibly send.
 * @type {Record<string, string>}
 */
const DECISION_ALIASES = Object.freeze({
  approve: PermissionDecision.APPROVE,
  approved: PermissionDecision.APPROVE,
  allow: PermissionDecision.APPROVE,
  yes: PermissionDecision.APPROVE,
  deny: PermissionDecision.DENY,
  denied: PermissionDecision.DENY,
  reject: PermissionDecision.DENY,
  no: PermissionDecision.DENY,
});

/**
 * @param {unknown} decision
 * @returns {string} one of PermissionDecision
 */
export function normalizeDecision(decision) {
  const key = typeof decision === "string" ? decision.trim().toLowerCase() : "";
  const normalized = DECISION_ALIASES[key];
  if (normalized === undefined) throw new Error(`unknown permission decision: ${decision}`);
  return normalized;
}

/**
 * Seconds-granularity elapsed, same shape as jobs.js formatElapsed. Duplicated
 * on purpose (phase-1 rule); test/permissions.test.js pins the two together.
 * @param {number} ms
 * @returns {string}
 */
export function formatWaited(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * @typedef {object} PermissionRequest
 * @property {string} id
 * @property {string} agentId agent that is blocked while this is pending
 * @property {string} kind PermissionKind, or whatever the harness called it
 * @property {string} prompt what is being asked, verbatim
 * @property {string|null} jobId job the agent was running, if known
 * @property {unknown} payload the raw notification, kept for the panel
 * @property {string} status PermissionStatus
 * @property {number} requestedAt
 * @property {string|null} decision PermissionDecision, once resolved
 * @property {string|null} decidedBy who answered
 * @property {number|null} decidedAt
 * @property {number|null} waitedMs how long the agent was blocked
 * @property {string|null} note free-text reason the decider gave
 */

/**
 * @typedef {object} PermissionQueueOptions
 * @property {() => number} [now]
 * @property {(seq: number) => string} [idFactory]
 * @property {(request: PermissionRequest) => void} [onRequest] fires on a new pending request
 * @property {(request: PermissionRequest) => void} [onResolve] fires on approve/deny/cancel
 */

/**
 * @param {PermissionRequest} request
 * @returns {PermissionRequest} a copy; callers never hold the live record
 */
function snapshot(request) {
  return { ...request };
}

/**
 * One line of decision record, for a job report.
 *
 * "permission (tool): approved by bedirhan after 12s - rm is fine here"
 * A pending one says so rather than pretending it was answered.
 *
 * @param {PermissionRequest} request
 * @returns {string}
 */
export function formatDecision(request) {
  const head = `permission (${request.kind})`;
  if (request.status === PermissionStatus.PENDING) {
    return `${head}: still waiting for a human - ${request.prompt}`;
  }
  if (request.status === PermissionStatus.CANCELLED) {
    const why = request.note !== null && request.note !== "" ? ` - ${request.note}` : "";
    return `${head}: cancelled before anyone answered${why}`;
  }
  const by = request.decidedBy !== null && request.decidedBy !== "" ? request.decidedBy : "unknown";
  const waited = request.waitedMs === null ? "" : ` after ${formatWaited(request.waitedMs)}`;
  const note = request.note !== null && request.note !== "" ? ` - ${request.note}` : "";
  return `${head}: ${request.status} by ${by}${waited}${note}`;
}

/**
 * The queue of "a human is needed here" moments.
 *
 * @param {PermissionQueueOptions} [options]
 */
export function createPermissionQueue(options = {}) {
  const now = options.now ?? (() => Date.now());
  const idFactory = options.idFactory ?? (/** @param {number} n */ (n) => `perm-${n}`);
  const onRequest = options.onRequest ?? null;
  const onResolve = options.onResolve ?? null;

  /** @type {Map<string, PermissionRequest>} Insertion order IS the queue order. */
  const requests = new Map();
  let seq = 0;

  /**
   * @param {string} id
   * @returns {PermissionRequest}
   */
  function requireRequest(id) {
    const request = requests.get(id);
    if (request === undefined) throw new Error(`unknown permission request: ${id}`);
    return request;
  }

  /**
   * Open a request and block its agent.
   *
   * @param {object} spec
   * @param {string} spec.agentId
   * @param {string} [spec.kind] PermissionKind; defaults to "other"
   * @param {string} spec.prompt what the human is being asked
   * @param {string|null} [spec.jobId] the job that is now waiting
   * @param {unknown} [spec.payload] the raw notification entry
   * @param {number} [spec.at]
   * @returns {PermissionRequest}
   */
  function request(spec) {
    const agentId = spec?.agentId;
    if (typeof agentId !== "string" || agentId === "") {
      throw new Error("a permission request needs an agentId");
    }
    const prompt = spec?.prompt;
    if (typeof prompt !== "string" || prompt.trim() === "") {
      // An empty prompt would put an unanswerable question in front of a human.
      throw new Error("a permission request needs a prompt");
    }
    seq += 1;
    /** @type {PermissionRequest} */
    const entry = {
      id: idFactory(seq),
      agentId,
      kind: spec.kind ?? PermissionKind.OTHER,
      prompt,
      jobId: spec.jobId ?? null,
      payload: spec.payload ?? null,
      status: PermissionStatus.PENDING,
      requestedAt: spec.at ?? now(),
      decision: null,
      decidedBy: null,
      decidedAt: null,
      waitedMs: null,
      note: null,
    };
    requests.set(entry.id, entry);
    if (onRequest !== null) onRequest(snapshot(entry));
    return snapshot(entry);
  }

  /**
   * Close a pending request. Terminal: a second resolve throws rather than
   * quietly overwriting who decided what.
   *
   * @param {string} id
   * @param {string} decision "approve" or "deny" (aliases accepted)
   * @param {object} [ctx]
   * @param {string} [ctx.by] who answered; recorded verbatim
   * @param {string} [ctx.note] why
   * @param {number} [ctx.at]
   * @returns {PermissionRequest}
   */
  function resolve(id, decision, ctx = {}) {
    const entry = requireRequest(id);
    if (entry.status !== PermissionStatus.PENDING) {
      throw new Error(`permission request ${id} is already ${entry.status}`);
    }
    const normalized = normalizeDecision(decision);
    const at = ctx.at ?? now();
    entry.decision = normalized;
    entry.status = STATUS_FOR_DECISION[normalized];
    entry.decidedBy = ctx.by ?? null;
    entry.decidedAt = at;
    entry.waitedMs = Math.max(0, at - entry.requestedAt);
    entry.note = ctx.note ?? null;
    if (onResolve !== null) onResolve(snapshot(entry));
    return snapshot(entry);
  }

  /**
   * Drop a request nobody will ever answer - the job timed out, the session
   * crashed, the run was abandoned. Unblocks the agent without inventing a
   * decision: cancelled is not approved.
   *
   * @param {string} id
   * @param {{ by?: string, reason?: string, at?: number }} [ctx]
   * @returns {PermissionRequest}
   */
  function cancel(id, ctx = {}) {
    const entry = requireRequest(id);
    if (entry.status !== PermissionStatus.PENDING) {
      throw new Error(`permission request ${id} is already ${entry.status}`);
    }
    const at = ctx.at ?? now();
    entry.status = PermissionStatus.CANCELLED;
    entry.decidedBy = ctx.by ?? null;
    entry.decidedAt = at;
    entry.waitedMs = Math.max(0, at - entry.requestedAt);
    entry.note = ctx.reason ?? null;
    if (onResolve !== null) onResolve(snapshot(entry));
    return snapshot(entry);
  }

  /**
   * Everything still waiting on a human, oldest first.
   * @param {string} [agentId] narrow to one agent
   * @returns {PermissionRequest[]}
   */
  function pending(agentId) {
    /** @type {PermissionRequest[]} */
    const out = [];
    for (const entry of requests.values()) {
      if (entry.status !== PermissionStatus.PENDING) continue;
      if (agentId !== undefined && entry.agentId !== agentId) continue;
      out.push(snapshot(entry));
    }
    return out;
  }

  /**
   * The request an agent is stuck on, or null. The oldest one wins: a harness
   * that asks twice is answered in the order it asked.
   * @param {string} agentId
   * @returns {PermissionRequest|null}
   */
  function blocking(agentId) {
    for (const entry of requests.values()) {
      if (entry.status === PermissionStatus.PENDING && entry.agentId === agentId) {
        return snapshot(entry);
      }
    }
    return null;
  }

  /**
   * The one question a dispatcher needs to ask before sending work.
   * @param {string} agentId
   * @returns {boolean}
   */
  function isBlocked(agentId) {
    return blocking(agentId) !== null;
  }

  /** @returns {string[]} every agent currently waiting on a human */
  function blockedAgents() {
    /** @type {string[]} */
    const out = [];
    for (const entry of requests.values()) {
      if (entry.status === PermissionStatus.PENDING && !out.includes(entry.agentId)) {
        out.push(entry.agentId);
      }
    }
    return out;
  }

  /**
   * @param {string} id
   * @returns {PermissionRequest|null}
   */
  function get(id) {
    const entry = requests.get(id);
    return entry === undefined ? null : snapshot(entry);
  }

  /**
   * Every request ever opened, in order. The decision log.
   * @param {{ agentId?: string, jobId?: string, status?: string }} [filter]
   * @returns {PermissionRequest[]}
   */
  function history(filter = {}) {
    /** @type {PermissionRequest[]} */
    const out = [];
    for (const entry of requests.values()) {
      if (filter.agentId !== undefined && entry.agentId !== filter.agentId) continue;
      if (filter.jobId !== undefined && entry.jobId !== filter.jobId) continue;
      if (filter.status !== undefined && entry.status !== filter.status) continue;
      out.push(snapshot(entry));
    }
    return out;
  }

  /**
   * Requests a job hit, in order.
   * @param {string} jobId
   * @returns {PermissionRequest[]}
   */
  function forJob(jobId) {
    return history({ jobId });
  }

  /**
   * The decision record as report text: one line per request the job hit, or
   * null when it hit none. Meant to be appended to the job's own report before
   * jobs.js buildResult runs, so the parent sees who unblocked its child.
   * @param {string} jobId
   * @returns {string|null}
   */
  function reportLineFor(jobId) {
    const lines = forJob(jobId).map(formatDecision);
    return lines.length === 0 ? null : lines.join("\n");
  }

  return {
    request,
    resolve,
    cancel,
    pending,
    blocking,
    isBlocked,
    blockedAgents,
    get,
    history,
    forJob,
    reportLineFor,
  };
}
