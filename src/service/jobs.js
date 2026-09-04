/**
 * Result groups + result formatting.
 * README: Calistirma Sonuclari ve Grup Bekleme, Sonuc Formati, Is Kuyrugu ve Hatalar.
 *
 * Phase-1 rule (src/MAP.js): modules do not import each other. The status set
 * here mirrors src/service/queue.js JobStatus on purpose - a contract test in
 * test/service-flow.test.js fails if the two ever drift apart.
 *
 * Group rule (README): every child job an agent starts in one turn belongs to
 * the same result group; the parent is woken exactly once, when the last result
 * of the group has landed.
 */

export const ResultStatus = Object.freeze({
  DONE: "done",
  ERROR: "error",
  TIMEOUT: "timeout",
  CRASHED: "crashed",
  REFUSED: "refused",
});

export const TERMINAL_STATUSES = Object.freeze([
  ResultStatus.DONE,
  ResultStatus.ERROR,
  ResultStatus.TIMEOUT,
  ResultStatus.CRASHED,
  ResultStatus.REFUSED,
]);

/** @type {Set<string>} */
const TERMINAL = new Set(TERMINAL_STATUSES);

/**
 * @param {string} status
 * @returns {boolean}
 */
export function isTerminalStatus(status) {
  return TERMINAL.has(status);
}

/**
 * @typedef {object} Result
 * @property {string} from agent that did the work
 * @property {string} jobId
 * @property {string} elapsed human readable, e.g. "4m 12s"
 * @property {string} task prompt the parent sent
 * @property {string} status one of TERMINAL_STATUSES
 * @property {string} report never empty - a failed job still reports something
 */

/**
 * @param {number} ms
 * @returns {string}
 */
export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Fallback report per status, so a job never wakes its parent empty-handed.
 * @param {string} status
 * @param {{ refusal?: string|null }} [ctx]
 * @returns {string}
 */
export function defaultReportFor(status, ctx = {}) {
  switch (status) {
    case ResultStatus.DONE:
      return "(no report)";
    case ResultStatus.ERROR:
      return "agent turn ended with an error";
    case ResultStatus.TIMEOUT:
      return "no completion signal arrived in time";
    case ResultStatus.CRASHED:
      return "agent session died";
    case ResultStatus.REFUSED:
      return ctx.refusal ? `refused: ${ctx.refusal}` : "refused: depth or job limit exceeded";
    default:
      return `unknown status: ${status}`;
  }
}

/**
 * The README result block. Pure formatting: pass it an already normalized
 * Result (see buildResult).
 * @param {{ from: string, jobId: string, elapsed: string, task: string, status: string, report: string }} args
 * @returns {string}
 */
export function formatResult({ from, jobId, elapsed, task, status, report }) {
  return [
    `[harnet] Result from ${from} (job ${jobId}, ${elapsed})`,
    `Task you sent: ${task}`,
    `Status: ${status}`,
    `Report: ${report}`,
  ].join("\n");
}

/**
 * Normalize whatever the queue knows about a job into a Result with a
 * non-empty report. Throws on a non-terminal status - a running job has no
 * result yet.
 * @param {object} spec
 * @param {string} spec.from
 * @param {string} spec.jobId
 * @param {string} spec.task
 * @param {string} spec.status
 * @param {string|null} [spec.report]
 * @param {number} [spec.elapsedMs]
 * @param {string} [spec.elapsed]
 * @param {string|null} [spec.refusal]
 * @returns {Result}
 */
export function buildResult(spec) {
  if (!isTerminalStatus(spec.status)) {
    throw new Error(`not a terminal status: ${spec.status}`);
  }
  const elapsed =
    spec.elapsed ?? (typeof spec.elapsedMs === "number" ? formatElapsed(spec.elapsedMs) : "unknown");
  const report =
    spec.report !== null && spec.report !== undefined && spec.report.trim() !== ""
      ? spec.report
      : defaultReportFor(spec.status, { refusal: spec.refusal });
  return {
    from: spec.from,
    jobId: spec.jobId,
    elapsed,
    task: spec.task,
    status: spec.status,
    report,
  };
}

/**
 * @typedef {object} ResultGroup
 * @property {string} id
 * @property {string|null} parent agent to wake when the group completes
 * @property {number|null} turn turn of the parent that opened this group
 * @property {string[]} jobIds expected child jobs, in registration order
 * @property {Map<string, Result>} results
 */

/**
 * @param {{ idFactory?: (seq: number) => string }} [options]
 */
export function createGroupRegistry(options = {}) {
  /** @type {Map<string, ResultGroup>} */
  const groups = new Map();
  let seq = 0;
  const idFactory = options.idFactory ?? (/** @param {number} n */ (n) => `grp-${n}`);

  /**
   * @param {object} [spec]
   * @param {string|null} [spec.parent]
   * @param {number|null} [spec.turn]
   * @returns {ResultGroup}
   */
  function open(spec = {}) {
    seq += 1;
    /** @type {ResultGroup} */
    const group = {
      id: idFactory(seq),
      parent: spec.parent ?? null,
      turn: spec.turn ?? null,
      jobIds: [],
      results: new Map(),
    };
    groups.set(group.id, group);
    return group;
  }

  /**
   * @param {string} groupId
   * @returns {ResultGroup}
   */
  function requireGroup(groupId) {
    const group = groups.get(groupId);
    if (group === undefined) throw new Error(`unknown group: ${groupId}`);
    return group;
  }

  /**
   * Register an expected child job. Idempotent.
   * @param {string} groupId
   * @param {string} jobId
   * @returns {ResultGroup}
   */
  function addJob(groupId, jobId) {
    const group = requireGroup(groupId);
    if (!group.jobIds.includes(jobId)) group.jobIds.push(jobId);
    return group;
  }

  /**
   * Record one child result.
   * @param {string} groupId
   * @param {string} jobId
   * @param {Result} result
   * @returns {{ group: ResultGroup, ready: boolean }}
   */
  function record(groupId, jobId, result) {
    const group = requireGroup(groupId);
    if (!group.jobIds.includes(jobId)) {
      throw new Error(`job ${jobId} does not belong to group ${groupId}`);
    }
    group.results.set(jobId, result);
    return { group, ready: isReady(groupId) };
  }

  /**
   * True only when every expected job has a result.
   * @param {string} groupId
   * @returns {boolean}
   */
  function isReady(groupId) {
    const group = requireGroup(groupId);
    return group.jobIds.length > 0 && group.jobIds.every((id) => group.results.has(id));
  }

  /**
   * @param {string} groupId
   * @returns {string[]} expected job ids still without a result
   */
  function pendingJobs(groupId) {
    const group = requireGroup(groupId);
    return group.jobIds.filter((id) => !group.results.has(id));
  }

  /**
   * Results in job registration order. Throws until the group is ready.
   * @param {string} groupId
   * @returns {Result[]}
   */
  function collect(groupId) {
    const group = requireGroup(groupId);
    if (!isReady(groupId)) {
      throw new Error(
        `group ${groupId} is not ready (${group.results.size}/${group.jobIds.length} results)`,
      );
    }
    return resultsInOrder(group);
  }

  /**
   * @param {string} groupId
   * @returns {ResultGroup|null}
   */
  function get(groupId) {
    return groups.get(groupId) ?? null;
  }

  return { open, addJob, record, isReady, pendingJobs, collect, get };
}

/**
 * @param {ResultGroup} group
 * @returns {Result[]}
 */
export function resultsInOrder(group) {
  /** @type {Result[]} */
  const out = [];
  for (const jobId of group.jobIds) {
    const result = group.results.get(jobId);
    if (result !== undefined) out.push(result);
  }
  return out;
}

/**
 * @param {ResultGroup} group
 * @returns {boolean}
 */
export function isGroupReady(group) {
  return group.jobIds.length > 0 && group.jobIds.every((id) => group.results.has(id));
}

/**
 * One wake-up message carrying every result of the group.
 * @param {object} spec
 * @param {string} spec.groupId
 * @param {Result[]} spec.results
 * @param {string|null} [spec.parent]
 * @returns {string}
 */
export function formatGroupWakeup({ groupId, results, parent = null }) {
  const count = `${results.length} job${results.length === 1 ? "" : "s"}`;
  const target = parent === null ? "" : `, waking ${parent}`;
  const head = `[harnet] Group complete (${groupId}, ${count}${target})`;
  return [head, ...results.map((r) => formatResult(r))].join("\n\n");
}

/**
 * The message that goes back to the parent agent. Throws while any child
 * result is missing - that is the whole point: no early wake-up.
 * @param {ResultGroup} group
 * @returns {string}
 */
export function wakeupFor(group) {
  if (!isGroupReady(group)) {
    throw new Error(
      `group ${group.id} is not ready (${group.results.size}/${group.jobIds.length} results)`,
    );
  }
  return formatGroupWakeup({
    groupId: group.id,
    parent: group.parent,
    results: resultsInOrder(group),
  });
}
