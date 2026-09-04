/**
 * Job queue + per-agent busy state.
 * README: Kontrol Servisi, Mesguliyet, Is Kuyrugu ve Hatalar.
 *
 * Phase-1 rule (src/MAP.js): modules do not import each other. This file owns
 * job ids, queueing and busy state. Result grouping and result formatting live
 * in src/service/jobs.js; the caller (control service) wires them together.
 *
 * Returned job objects are live references: completing or timing a job out
 * mutates the same object you already hold.
 */

/** @typedef {"queued"|"running"|"done"|"error"|"timeout"|"crashed"|"refused"} JobStatusName */
/** @typedef {"idle"|"busy"} AgentStateName */

export const JobStatus = Object.freeze({
  QUEUED: "queued",
  RUNNING: "running",
  DONE: "done",
  ERROR: "error",
  TIMEOUT: "timeout",
  CRASHED: "crashed",
  REFUSED: "refused",
});

/** Statuses that end a job. Every one of them must produce a result upstream. */
export const TERMINAL_STATUSES = Object.freeze([
  JobStatus.DONE,
  JobStatus.ERROR,
  JobStatus.TIMEOUT,
  JobStatus.CRASHED,
  JobStatus.REFUSED,
]);

/** MVP depth check is a single constant upper bound (README: Is Kuyrugu ve Hatalar). */
export const DEFAULT_MAX_DEPTH = 3;
export const DEFAULT_MAX_JOBS_PER_GROUP = 8;
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

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
 * @typedef {object} Job
 * @property {string} id
 * @property {string} prompt
 * @property {string|null} agent target agent; null = unassigned
 * @property {string|null} from calling agent; null = human/root
 * @property {string|null} groupId result group this job belongs to
 * @property {number} depth call depth; 0 = root job
 * @property {JobStatusName} status
 * @property {number} createdAt
 * @property {number|null} startedAt
 * @property {number|null} endedAt
 * @property {string|null} report
 * @property {string|null} refusal why the job was refused, else null
 */

/**
 * @typedef {object} EnqueueSpec
 * @property {string} [id] normally omitted; the queue assigns it
 * @property {string} prompt
 * @property {string|null} [agent]
 * @property {string|null} [from]
 * @property {string|null} [groupId]
 * @property {number} [depth]
 */

/**
 * @typedef {object} CompleteSpec
 * @property {string} jobId
 * @property {string} status must be terminal
 * @property {string|null} [report]
 * @property {number} [at]
 */

/**
 * @typedef {object} QueueOptions
 * @property {number} [maxDepth]
 * @property {number} [maxJobsPerGroup]
 * @property {number} [defaultTimeoutMs]
 * @property {() => number} [now]
 * @property {(seq: number) => string} [idFactory]
 */

/**
 * @param {QueueOptions} [options]
 */
export function createQueue(options = {}) {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxJobsPerGroup = options.maxJobsPerGroup ?? DEFAULT_MAX_JOBS_PER_GROUP;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (/** @returns {number} */ () => Date.now());
  const idFactory = options.idFactory ?? (/** @param {number} seq */ (seq) => `job-${seq}`);

  /** @type {Job[]} */
  const jobs = [];
  /** @type {Map<string, Job>} */
  const byId = new Map();
  /** @type {Map<string, string>} agent -> id of its running job */
  const runningByAgent = new Map();
  let seq = 0;

  /**
   * @param {EnqueueSpec} spec
   * @returns {Job}
   */
  function enqueue(spec) {
    const groupId = spec.groupId ?? null;
    const depth = spec.depth ?? 0;
    const createdAt = now();
    const id = spec.id ?? idFactory(++seq);
    if (byId.has(id)) throw new Error(`duplicate job id: ${id}`);

    let refusal = null;
    if (depth > maxDepth) {
      refusal = `call depth ${depth} exceeds maxDepth ${maxDepth}`;
    } else if (groupId !== null && countAcceptedInGroup(groupId) >= maxJobsPerGroup) {
      refusal = `group ${groupId} already holds ${maxJobsPerGroup} jobs`;
    }

    /** @type {Job} */
    const job = {
      id,
      prompt: spec.prompt,
      agent: spec.agent ?? null,
      from: spec.from ?? null,
      groupId,
      depth,
      status: refusal === null ? JobStatus.QUEUED : JobStatus.REFUSED,
      createdAt,
      startedAt: null,
      endedAt: refusal === null ? null : createdAt,
      report: refusal === null ? null : `refused: ${refusal}`,
      refusal,
    };
    jobs.push(job);
    byId.set(id, job);
    return job;
  }

  /**
   * @param {string} groupId
   * @returns {number}
   */
  function countAcceptedInGroup(groupId) {
    return jobs.filter((j) => j.groupId === groupId && j.status !== JobStatus.REFUSED).length;
  }

  /**
   * Hand the agent its next job and mark it busy.
   * Returns null when the agent is busy or has nothing queued.
   * @param {string} agent
   * @returns {Job|null}
   */
  function dispatch(agent) {
    if (isBusy(agent)) return null;
    const job = jobs.find((j) => j.status === JobStatus.QUEUED && j.agent === agent) ?? null;
    if (job === null) return null;
    job.status = JobStatus.RUNNING;
    job.startedAt = now();
    runningByAgent.set(agent, job.id);
    return job;
  }

  /**
   * End a running job, free the agent. The caller then dispatches the next one.
   * @param {CompleteSpec} spec
   * @returns {Job}
   */
  function complete(spec) {
    const job = byId.get(spec.jobId);
    if (job === undefined) throw new Error(`unknown job: ${spec.jobId}`);
    if (job.status !== JobStatus.RUNNING) {
      throw new Error(`job ${spec.jobId} is not running (status: ${job.status})`);
    }
    if (!isTerminalStatus(spec.status)) {
      throw new Error(`not a terminal status: ${spec.status}`);
    }
    job.status = /** @type {JobStatusName} */ (spec.status);
    job.endedAt = spec.at ?? now();
    job.report = spec.report ?? null;
    release(job);
    return job;
  }

  /**
   * Time out every running job that has been running for at least `timeoutMs`.
   * @param {object} [spec]
   * @param {number} [spec.timeoutMs]
   * @param {number} [spec.at]
   * @returns {Job[]} the jobs that timed out
   */
  function sweepTimeouts(spec = {}) {
    const limit = spec.timeoutMs ?? defaultTimeoutMs;
    const at = spec.at ?? now();
    /** @type {Job[]} */
    const out = [];
    for (const job of jobs) {
      if (job.status !== JobStatus.RUNNING || job.startedAt === null) continue;
      if (at - job.startedAt < limit) continue;
      job.status = JobStatus.TIMEOUT;
      job.endedAt = at;
      job.report = job.report ?? `no completion signal within ${limit}ms`;
      release(job);
      out.push(job);
    }
    return out;
  }

  /**
   * The tmux session died: fail whatever that agent was running.
   * Idempotent - returns an empty list when the agent was idle.
   * @param {object} spec
   * @param {string} spec.agent
   * @param {string|null} [spec.report]
   * @param {number} [spec.at]
   * @returns {Job[]}
   */
  function markCrashed(spec) {
    const jobId = runningByAgent.get(spec.agent);
    const job = jobId === undefined ? undefined : byId.get(jobId);
    if (job === undefined) return [];
    job.status = JobStatus.CRASHED;
    job.endedAt = spec.at ?? now();
    job.report = spec.report ?? `agent session died: ${spec.agent}`;
    release(job);
    return [job];
  }

  /**
   * @param {Job} job
   * @returns {void}
   */
  function release(job) {
    if (job.agent !== null && runningByAgent.get(job.agent) === job.id) {
      runningByAgent.delete(job.agent);
    }
  }

  /**
   * @param {string} agent
   * @returns {boolean}
   */
  function isBusy(agent) {
    return runningByAgent.has(agent);
  }

  /**
   * @param {string} agent
   * @returns {AgentStateName}
   */
  function state(agent) {
    return isBusy(agent) ? "busy" : "idle";
  }

  /**
   * @param {string} agent
   * @returns {Job|null}
   */
  function runningJob(agent) {
    const jobId = runningByAgent.get(agent);
    if (jobId === undefined) return null;
    return byId.get(jobId) ?? null;
  }

  /**
   * @returns {string[]}
   */
  function busyAgents() {
    return [...runningByAgent.keys()];
  }

  /**
   * Queued jobs, oldest first. Omit `agent` for every agent.
   * @param {string|null} [agent]
   * @returns {Job[]}
   */
  function pending(agent) {
    return jobs.filter(
      (j) => j.status === JobStatus.QUEUED && (agent === undefined || j.agent === agent),
    );
  }

  /**
   * @returns {Job[]}
   */
  function running() {
    return jobs.filter((j) => j.status === JobStatus.RUNNING);
  }

  /**
   * @returns {Job[]}
   */
  function all() {
    return jobs.slice();
  }

  /**
   * @param {string} jobId
   * @returns {Job|null}
   */
  function get(jobId) {
    return byId.get(jobId) ?? null;
  }

  return {
    enqueue,
    /** Legacy alias, kept for the scaffold smoke test. @param {EnqueueSpec} job */
    push: (job) => enqueue(job),
    dispatch,
    complete,
    sweepTimeouts,
    markCrashed,
    isBusy,
    state,
    runningJob,
    busyAgents,
    pending,
    running,
    all,
    get,
  };
}
