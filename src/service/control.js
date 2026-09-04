/**
 * In-memory control-service wiring. Restarting this process resets queue,
 * result-group, and wake-up state; database persistence is deliberately deferred.
 *
 * The queue owns job lifecycle and busy state, adapters own harness I/O and
 * signal parsing, and jobs.js owns result normalization and wake-up formatting.
 */

import { buildResult, createGroupRegistry, formatGroupWakeup } from "./jobs.js";
import { createQueue } from "./queue.js";
import { createReportReader } from "./report.js";
import { attachJobStore, createJobStore } from "./store.js";

/**
 * @typedef {object} JobLike
 * @property {string} id
 * @property {string} prompt
 * @property {string|null} agent
 * @property {string|null} from
 * @property {string|null} groupId
 * @property {number} depth
 * @property {string} status
 * @property {number} createdAt
 * @property {number|null} startedAt
 * @property {number|null} endedAt
 * @property {string|null} report
 * @property {string|null} refusal
 */

/**
 * @typedef {object} QueueLike
 * @property {(spec: { id?: string, prompt: string, agent?: string|null, from?: string|null, groupId?: string|null, depth?: number }) => JobLike} enqueue
 * @property {(agent: string) => JobLike|null} dispatch
 * @property {(spec: { jobId: string, status: string, report?: string|null, at?: number }) => JobLike} complete
 * @property {(spec?: { timeoutMs?: number, at?: number }) => JobLike[]} sweepTimeouts
 * @property {(spec: { agent: string, report?: string|null, at?: number }) => JobLike[]} markCrashed
 * @property {(agent: string) => JobLike|null} runningJob
 * @property {(jobId: string) => JobLike|null} get
 */

/**
 * @typedef {object} GroupLike
 * @property {string} id
 * @property {string|null} parent
 * @property {number|null} turn
 * @property {string[]} jobIds
 * @property {Map<string, import("./jobs.js").Result>} results
 */

/**
 * @typedef {object} GroupsLike
 * @property {(spec?: { parent?: string|null, turn?: number|null }) => GroupLike} open
 * @property {(groupId: string, jobId: string) => GroupLike} addJob
 * @property {(groupId: string, jobId: string, result: import("./jobs.js").Result) => { group: GroupLike, ready: boolean }} record
 * @property {(groupId: string) => import("./jobs.js").Result[]} collect
 * @property {(groupId: string) => GroupLike|null} get
 */

/**
 * @typedef {object} SignalResultLike
 * @property {boolean} matched
 * @property {string|null} [jobId]
 * @property {string|null} [status]
 * @property {string|null} [report]
 * @property {string|null} [reason]
 */

/**
 * @typedef {object} AdapterLike
 * @property {(spec: { agentId: string, text: string }) => unknown} write
 * @property {(payload: any) => SignalResultLike} [handleSignal]
 * @property {(payload: any) => SignalResultLike} [handleStop]
 * @property {(payload: any) => SignalResultLike} [handleNotify]
 * @property {() => Array<{ agentId: string }>} [sweepCrashes]
 */

/** @typedef {Record<string, AdapterLike>|Map<string, AdapterLike>} AdapterRegistry */

/**
 * @typedef {object} Wakeup
 * @property {string} groupId
 * @property {string|null} parent
 * @property {string} message
 */

/**
 * @typedef {object} DispatchOutcome
 * @property {JobLike} job
 * @property {boolean} sent
 * @property {Error|null} error
 * @property {Wakeup|null} wakeup
 * @property {DispatchOutcome|null} next
 */

/**
 * @param {{ queue: QueueLike, groups: GroupsLike, adapters: AdapterRegistry }} options
 */
export function createControlService({ queue, groups, adapters }) {
  /** Jobs and groups are recorded/emitted once even if a signal is replayed. */
  const recordedJobs = new Set();
  const emittedGroups = new Set();
  /** @type {Wakeup[]} */
  const wakeupLog = [];

  /**
   * @param {string} agent
   * @returns {AdapterLike}
   */
  function adapterFor(agent) {
    const adapter = adapters instanceof Map ? adapters.get(agent) : adapters[agent];
    if (adapter === undefined) throw new Error(`no adapter for agent: ${agent}`);
    return adapter;
  }

  /**
   * @param {JobLike} job
   * @returns {import("./jobs.js").Result}
   */
  function resultFromJob(job) {
    const elapsedMs =
      job.startedAt !== null && job.endedAt !== null ? job.endedAt - job.startedAt : undefined;
    return buildResult({
      from: job.agent ?? "unknown",
      jobId: job.id,
      task: job.prompt,
      status: job.status,
      report: job.report,
      refusal: job.refusal,
      elapsedMs,
    });
  }

  /**
   * Record a terminal job and emit its group's only wake-up when ready.
   * @param {JobLike} job
   * @returns {Wakeup|null}
   */
  function recordTerminal(job) {
    if (recordedJobs.has(job.id) || job.groupId === null) return null;
    recordedJobs.add(job.id);
    const recorded = groups.record(job.groupId, job.id, resultFromJob(job));
    if (!recorded.ready || emittedGroups.has(job.groupId)) return null;

    const message = formatGroupWakeup({
      groupId: job.groupId,
      parent: recorded.group.parent,
      results: groups.collect(job.groupId),
    });
    /** @type {Wakeup} */
    const wakeup = { groupId: job.groupId, parent: recorded.group.parent, message };
    emittedGroups.add(job.groupId);
    wakeupLog.push(wakeup);
    if (wakeup.parent !== null) {
      adapterFor(wakeup.parent).write({ agentId: wakeup.parent, text: message });
    }
    return wakeup;
  }

  /**
   * Dispatch one queued job for an idle agent and send it through the adapter.
   * A write failure becomes an error result so the agent cannot remain busy forever.
   * @param {string} agent
   * @returns {DispatchOutcome|null}
   */
  function dispatch(agent) {
    const job = queue.dispatch(agent);
    if (job === null) return null;
    try {
      adapterFor(agent).write({ agentId: agent, text: job.prompt });
      return { job, sent: true, error: null, wakeup: null, next: null };
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      queue.complete({ jobId: job.id, status: "error", report: `adapter write failed: ${error.message}` });
      const wakeup = recordTerminal(job);
      const next = dispatch(agent);
      return { job, sent: false, error, wakeup, next };
    }
  }

  /**
   * Accept one job, register it with its existing group, and dispatch if possible.
   * Use submitGroup when the service must create a multi-job group atomically.
   * @param {{ id?: string, prompt: string, agent?: string|null, from?: string|null, groupId?: string|null, depth?: number }} spec
   */
  function submit(spec) {
    const job = queue.enqueue(spec);
    if (job.groupId !== null) groups.addJob(job.groupId, job.id);
    const wakeup = job.status === "refused" ? recordTerminal(job) : null;
    const dispatched = job.agent === null || job.status === "refused" ? null : dispatch(job.agent);
    return { job, dispatched, wakeup };
  }

  /**
   * Open a result group and register every expected child before recording
   * refusals or dispatching. This prevents an early wake-up from a partial group.
   * @param {object} spec
   * @param {string|null} [spec.parent]
   * @param {number|null} [spec.turn]
   * @param {Array<{ id?: string, prompt: string, agent?: string|null, from?: string|null, depth?: number }>} spec.jobs
   */
  function submitGroup(spec) {
    const group = groups.open({ parent: spec.parent ?? null, turn: spec.turn ?? null });
    const jobs = spec.jobs.map((child) =>
      queue.enqueue({ ...child, from: child.from ?? group.parent, groupId: group.id }),
    );
    for (const job of jobs) groups.addJob(group.id, job.id);

    /** @type {Wakeup[]} */
    const wakeups = [];
    for (const job of jobs) {
      if (job.status !== "refused") continue;
      const wakeup = recordTerminal(job);
      if (wakeup !== null) wakeups.push(wakeup);
    }

    /** @type {DispatchOutcome[]} */
    const dispatched = [];
    const agents = new Set(jobs.map((job) => job.agent).filter((agent) => agent !== null));
    for (const agent of agents) {
      const outcome = dispatch(agent);
      if (outcome !== null) dispatched.push(outcome);
    }
    return { group, jobs, dispatched, wakeups };
  }

  /**
   * Complete a running job, record its result, wake a ready parent, then send
   * the target agent its next queued job.
   * @param {{ jobId: string, status: string, report?: string|null, at?: number }} spec
   */
  function complete(spec) {
    const job = queue.complete(spec);
    const wakeup = recordTerminal(job);
    const next = job.agent === null ? null : dispatch(job.agent);
    return { job, wakeup, next };
  }

  /**
   * Let the target adapter parse a completion signal. Adapters wired directly
   * to the queue may already complete the job; injected adapters may return a
   * status for this service to complete.
   * @param {{ agent: string, payload: any }} spec
   */
  function handleSignal(spec) {
    const running = queue.runningJob(spec.agent);
    if (running === null) {
      return { signal: null, job: null, wakeup: null, next: null };
    }
    const adapter = adapterFor(spec.agent);
    const handler = adapter.handleSignal ?? adapter.handleStop ?? adapter.handleNotify;
    if (handler === undefined) throw new Error(`adapter for ${spec.agent} has no signal handler`);
    const signal = handler(spec.payload);
    if (!signal.matched) return { signal, job: running, wakeup: null, next: null };
    if (signal.jobId !== null && signal.jobId !== undefined && signal.jobId !== running.id) {
      throw new Error(`signal completed ${signal.jobId}, expected ${running.id}`);
    }

    let job = queue.get(running.id);
    if (job !== null && job.status === "running") {
      if (signal.status === null || signal.status === undefined) {
        throw new Error(`matched signal for ${spec.agent} has no terminal status`);
      }
      job = queue.complete({ jobId: job.id, status: signal.status, report: signal.report ?? null });
    }
    if (job === null) throw new Error(`completed job disappeared: ${running.id}`);
    const wakeup = recordTerminal(job);
    const next = dispatch(spec.agent);
    return { signal, job, wakeup, next };
  }

  /**
   * @param {{ timeoutMs?: number, at?: number }} [spec]
   */
  function sweepTimeouts(spec = {}) {
    const jobs = queue.sweepTimeouts(spec);
    const wakeups = jobs.map(recordTerminal).filter((wakeup) => wakeup !== null);
    const dispatched = jobs
      .map((job) => (job.agent === null ? null : dispatch(job.agent)))
      .filter((outcome) => outcome !== null);
    return { jobs, wakeups, dispatched };
  }

  /**
   * @param {{ agent: string, report?: string|null, at?: number }} spec
   */
  function markCrashed(spec) {
    const jobs = queue.markCrashed(spec);
    const wakeups = jobs.map(recordTerminal).filter((wakeup) => wakeup !== null);
    const dispatched = jobs
      .map((job) => (job.agent === null ? null : dispatch(job.agent)))
      .filter((outcome) => outcome !== null);
    return { jobs, wakeups, dispatched };
  }

  /** Sweep every distinct adapter and normalize its crashed jobs. */
  function sweepCrashes() {
    const entries = adapters instanceof Map ? [...adapters.entries()] : Object.entries(adapters);
    /** @type {Map<AdapterLike, string[]>} */
    const agentsByAdapter = new Map();
    for (const [agent, adapter] of entries) {
      const agents = agentsByAdapter.get(adapter) ?? [];
      agents.push(agent);
      agentsByAdapter.set(adapter, agents);
    }
    /** @type {Array<{ agentId: string }>} */
    const crashes = [];
    /** @type {JobLike[]} */
    const jobs = [];
    for (const [adapter, agents] of agentsByAdapter) {
      if (adapter.sweepCrashes === undefined) continue;
      const runningBefore = new Map(
        agents.map((agent) => [agent, queue.runningJob(agent)]),
      );
      for (const crash of adapter.sweepCrashes()) {
        crashes.push(crash);
        const running = runningBefore.get(crash.agentId) ?? queue.runningJob(crash.agentId);
        if (running !== null && running.status === "running") {
          queue.markCrashed({ agent: crash.agentId });
        }
        const job = running === null ? null : queue.get(running.id);
        if (job !== null) jobs.push(job);
      }
    }
    const wakeups = jobs.map(recordTerminal).filter((wakeup) => wakeup !== null);
    const dispatched = jobs
      .map((job) => (job.agent === null ? null : dispatch(job.agent)))
      .filter((outcome) => outcome !== null);
    return { crashes, jobs, wakeups, dispatched };
  }

  return {
    submit,
    submitGroup,
    dispatch,
    complete,
    handleSignal,
    sweepTimeouts,
    markCrashed,
    sweepCrashes,
    /** @returns {Wakeup[]} */
    wakeups: () => wakeupLog.slice(),
  };
}

/**
 * Sets up a control service with queue, persistence store,
 * result groups, and report reader.
 *
 * @param {object} [options]
 * @param {string} [options.rootDir]
 * @param {string} [options.storePath]
 * @param {QueueLike} [options.queue]
 * @param {GroupsLike} [options.groups]
 * @param {AdapterRegistry} [options.adapters]
 * @param {(text: string) => import("./report.js").ParsedTranscript} [options.parse]
 * @param {(ctx: { transcriptPath: string|null, agentId?: string, payload?: unknown }) => string|null} [options.reportReader]
 * @param {Partial<import("./report.js").ReportReaderOptions>} [options.reportReaderOptions]
 * @returns {{
 *   service: ReturnType<typeof createControlService>,
 *   queue: import("./store.js").QueueLike,
 *   store: import("./store.js").JobStore,
 *   groups: GroupsLike,
 *   reportReader: (ctx: { transcriptPath: string|null, agentId?: string, payload?: unknown }) => string|null
 * }}
 */
export function setupControlService(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const queue =
    options.queue ??
    /** @type {any} */ (attachJobStore(createQueue(), {
      filePath: options.storePath,
      rootDir,
    }));
  const groups = options.groups ?? createGroupRegistry();
  const adapters = options.adapters ?? {};
  const service = createControlService({ queue, groups, adapters });

  let reportReader = options.reportReader;
  if (!reportReader && options.parse) {
    reportReader = createReportReader({
      parse: options.parse,
      ...options.reportReaderOptions,
    });
  }

  const store =
    queue.store ??
    createJobStore({
      filePath: options.storePath,
      rootDir,
    });

  return {
    service,
    queue,
    store,
    groups,
    reportReader: reportReader ?? (() => null),
  };
}

