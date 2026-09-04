/**
 * Job queue file persistence store.
 * README: Kontrol Servisi, Is Kuyrugu ve Hatalar.
 *
 * Phase-1 rule (src/MAP.js): modules do not import each other.
 * This store is an independent persistence layer for the job queue.
 * It reads from and writes to .harnet/state/jobs.json.
 * On corrupted file, it moves the file to .bak and starts empty without crashing.
 */

import fs from "node:fs";
import path from "node:path";

export const DEFAULT_STATE_DIR = path.join(".harnet", "state");
export const DEFAULT_JOBS_FILE = "jobs.json";
export const DEFAULT_STORE_PATH = path.join(DEFAULT_STATE_DIR, DEFAULT_JOBS_FILE);

/**
 * @typedef {object} StoredJob
 * @property {string} id
 * @property {string} prompt
 * @property {string|null} [agent]
 * @property {string|null} [from]
 * @property {string|null} [groupId]
 * @property {number} [depth]
 * @property {string} status
 * @property {number} [createdAt]
 * @property {number|null} [startedAt]
 * @property {number|null} [endedAt]
 * @property {string|null} [report]
 * @property {string|null} [refusal]
 */

/**
 * @typedef {object} StoreOptions
 * @property {string} [filePath]
 * @property {string} [rootDir]
 * @property {string} [backupPath]
 * @property {boolean} [loadOnAttach]
 * @property {boolean} [autoLoad]
 * @property {boolean} [autoSave]
 */

/**
 * @typedef {object} QueueLike
 * @property {(spec: any) => any} enqueue
 * @property {(agent: string) => any} dispatch
 * @property {(spec: any) => any} complete
 * @property {(spec?: any) => any[]} sweepTimeouts
 * @property {(spec: any) => any[]} markCrashed
 * @property {() => any[]} all
 * @property {(id: string) => any} get
 * @property {(agent: string) => boolean} isBusy
 * @property {(agent: string) => any} state
 * @property {(agent: string) => any} runningJob
 * @property {() => string[]} busyAgents
 * @property {(agent?: string|null) => any[]} pending
 * @property {() => any[]} running
 * @property {(spec: any) => any} [push]
 * @property {JobStore} [store]
 */

/**
 * @typedef {object} JobStore
 * @property {string} filePath
 * @property {string} backupPath
 * @property {() => StoredJob[]} load
 * @property {(jobs?: StoredJob[]) => StoredJob[]} save
 * @property {() => StoredJob[]} all
 * @property {(jobId: string) => StoredJob|null} get
 * @property {(job: StoredJob) => StoredJob} add
 * @property {(jobId: string, patch: Record<string, any> | ((job: StoredJob) => StoredJob)) => StoredJob|null} update
 * @property {(jobId: string) => StoredJob|null} remove
 * @property {() => void} clear
 * @property {(queue: QueueLike) => QueueLike & { store: JobStore }} attach
 * @property {(queue: QueueLike) => QueueLike} restore
 */

/**
 * Resolves the store file path against a root directory if relative.
 * @param {string} [filePath]
 * @param {string} [rootDir]
 * @returns {string}
 */
export function resolveStorePath(filePath, rootDir = process.cwd()) {
  const target = filePath ?? DEFAULT_STORE_PATH;
  return path.isAbsolute(target) ? target : path.resolve(rootDir, target);
}

/**
 * Backs up a corrupted store file to a .bak file.
 * Returns the backup file path, or null if backup could not be created.
 * @param {string} filePath
 * @param {string} [backupPath]
 * @returns {string|null}
 */
export function backupCorruptFile(filePath, backupPath) {
  const dest = backupPath ?? `${filePath}.bak`;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // Attempt rename first
    try {
      fs.renameSync(filePath, dest);
      return dest;
    } catch {
      // Fallback to copy and unlink
      fs.copyFileSync(filePath, dest);
      try {
        fs.unlinkSync(filePath);
      } catch {
        // ignore unlink error
      }
      return dest;
    }
  } catch {
    return null;
  }
}

/**
 * Reads and parses stored jobs from disk.
 * If the file does not exist, returns an empty array.
 * If the file is corrupted (invalid JSON or not an array), backs it up to .bak and returns an empty array.
 *
 * @param {string} [filePath]
 * @param {{ rootDir?: string, backupPath?: string }} [options]
 * @returns {StoredJob[]}
 */
export function loadJobs(filePath, options = {}) {
  const resolved = resolveStorePath(filePath, options.rootDir);
  if (!fs.existsSync(resolved)) {
    return [];
  }

  let content;
  try {
    content = fs.readFileSync(resolved, "utf8");
  } catch {
    return [];
  }

  if (!content.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) {
      backupCorruptFile(resolved, options.backupPath);
      return [];
    }
    return parsed;
  } catch {
    backupCorruptFile(resolved, options.backupPath);
    return [];
  }
}

/**
 * Atomically writes jobs to disk as formatted JSON.
 * Ensures target directory exists.
 *
 * @param {string} [filePath]
 * @param {StoredJob[]} [jobs]
 * @param {{ rootDir?: string }} [options]
 * @returns {StoredJob[]}
 */
export function saveJobs(filePath, jobs = [], options = {}) {
  const resolved = resolveStorePath(filePath, options.rootDir);
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });

  const data = JSON.stringify(jobs ?? [], null, 2) + "\n";
  const tmpPath = `${resolved}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;

  try {
    fs.writeFileSync(tmpPath, data, "utf8");
    fs.renameSync(tmpPath, resolved);
  } catch {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // ignore
    }
    fs.writeFileSync(resolved, data, "utf8");
  }

  return jobs;
}

/**
 * Restores stored jobs into an in-memory queue.
 * @param {QueueLike} queue
 * @param {StoredJob[]} storedJobs
 * @returns {QueueLike}
 */
export function restoreJobs(queue, storedJobs) {
  if (!Array.isArray(storedJobs) || storedJobs.length === 0) {
    return queue;
  }

  for (const job of storedJobs) {
    if (!job || typeof job.id !== "string") continue;

    // If already exists in queue, skip
    if (queue.get(job.id)) continue;

    // Enqueue with exact ID and spec
    queue.enqueue({
      id: job.id,
      prompt: job.prompt ?? "",
      agent: job.agent ?? null,
      from: job.from ?? null,
      groupId: job.groupId ?? null,
      depth: job.depth ?? 0,
    });

    const live = queue.get(job.id);
    if (!live) continue;

    if (job.status === "running") {
      if (job.agent) {
        queue.dispatch(job.agent);
      } else {
        live.status = "running";
      }
    } else if (job.status !== "queued") {
      // Terminal status (done, error, timeout, crashed, refused)
      if (job.agent && live.status === "queued") {
        queue.dispatch(job.agent);
      }
      try {
        queue.complete({
          jobId: job.id,
          status: job.status,
          report: job.report ?? null,
          at: job.endedAt ?? undefined,
        });
      } catch {
        live.status = job.status;
      }
    }

    // Sync all properties to match stored record exactly
    if (typeof job.createdAt === "number") live.createdAt = job.createdAt;
    if (job.startedAt !== undefined) live.startedAt = job.startedAt;
    if (job.endedAt !== undefined) live.endedAt = job.endedAt;
    if (job.status !== undefined) live.status = job.status;
    if (job.report !== undefined) live.report = job.report;
    if (job.refusal !== undefined) live.refusal = job.refusal;
  }

  return queue;
}

/**
 * Attaches file persistence to an existing job queue.
 * Reads jobs on startup (starts empty if missing or backs up if corrupted).
 * Saves jobs on every mutating queue method.
 *
 * @param {QueueLike} queue
 * @param {StoreOptions} [options]
 * @returns {QueueLike & { store: JobStore }}
 */
export function attachJobStore(queue, options = {}) {
  const store = createJobStore(options);

  if (options.loadOnAttach ?? true) {
    const loaded = store.load();
    restoreJobs(queue, loaded);
  }

  // Intercept ID generation to prevent duplicate ID collisions with restored jobs
  function nextAvailableId() {
    let maxId = 0;
    for (const j of queue.all()) {
      if (typeof j.id === "string") {
        const match = j.id.match(/^job-(\d+)$/);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num > maxId) maxId = num;
        }
      }
    }
    return `job-${maxId + 1}`;
  }

  const origEnqueue = queue.enqueue.bind(queue);
  queue.enqueue = function persistentEnqueue(spec) {
    const withId = spec.id ? spec : { ...spec, id: nextAvailableId() };
    const job = origEnqueue(withId);
    store.save(queue.all());
    return job;
  };

  if (typeof queue.push === "function") {
    queue.push = function persistentPush(spec) {
      return queue.enqueue(spec);
    };
  }

  const origDispatch = queue.dispatch.bind(queue);
  queue.dispatch = function persistentDispatch(agent) {
    const job = origDispatch(agent);
    if (job !== null) {
      store.save(queue.all());
    }
    return job;
  };

  const origComplete = queue.complete.bind(queue);
  queue.complete = function persistentComplete(spec) {
    const job = origComplete(spec);
    store.save(queue.all());
    return job;
  };

  const origSweepTimeouts = queue.sweepTimeouts.bind(queue);
  queue.sweepTimeouts = function persistentSweepTimeouts(spec) {
    const timedOut = origSweepTimeouts(spec);
    if (timedOut.length > 0) {
      store.save(queue.all());
    }
    return timedOut;
  };

  const origMarkCrashed = queue.markCrashed.bind(queue);
  queue.markCrashed = function persistentMarkCrashed(spec) {
    const crashed = origMarkCrashed(spec);
    if (crashed.length > 0) {
      store.save(queue.all());
    }
    return crashed;
  };

  // Attach store reference to the queue
  Object.defineProperty(queue, "store", {
    value: store,
    writable: false,
    enumerable: false,
    configurable: true,
  });

  return /** @type {QueueLike & { store: JobStore }} */ (queue);
}

/**
 * Creates a standalone JobStore object.
 *
 * @param {StoreOptions} [options]
 * @returns {JobStore}
 */
export function createJobStore(options = {}) {
  const filePath = resolveStorePath(options.filePath, options.rootDir);
  const backupPath = options.backupPath ?? `${filePath}.bak`;
  /** @type {StoredJob[]} */
  let jobs = [];

  function load() {
    jobs = loadJobs(filePath, { rootDir: options.rootDir, backupPath });
    return jobs.slice();
  }

  /**
   * @param {StoredJob[]} [newJobs]
   * @returns {StoredJob[]}
   */
  function save(newJobs) {
    if (newJobs !== undefined) {
      jobs = newJobs.slice();
    }
    saveJobs(filePath, jobs, { rootDir: options.rootDir });
    return jobs.slice();
  }

  // Load on creation
  if (options.autoLoad ?? true) {
    load();
  }

  return {
    filePath,
    backupPath,
    load,
    save,
    all() {
      return jobs.slice();
    },
    get(jobId) {
      return jobs.find((j) => j.id === jobId) ?? null;
    },
    add(job) {
      jobs.push(job);
      save();
      return job;
    },
    update(jobId, patch) {
      const idx = jobs.findIndex((j) => j.id === jobId);
      if (idx === -1) return null;
      const current = jobs[idx];
      const updated = typeof patch === "function" ? patch(current) : { ...current, ...patch };
      jobs[idx] = updated;
      save();
      return updated;
    },
    remove(jobId) {
      const idx = jobs.findIndex((j) => j.id === jobId);
      if (idx === -1) return null;
      const [removed] = jobs.splice(idx, 1);
      save();
      return removed;
    },
    clear() {
      jobs = [];
      save();
    },
    attach(queue) {
      return attachJobStore(queue, { filePath, rootDir: options.rootDir, backupPath });
    },
    restore(queue) {
      return restoreJobs(queue, jobs);
    },
  };
}

/**
 * Helper to create a persistent queue by attaching a store.
 * @param {QueueLike} queue
 * @param {StoreOptions} [options]
 * @returns {QueueLike & { store: JobStore }}
 */
export function createPersistentQueue(queue, options = {}) {
  return attachJobStore(queue, options);
}
