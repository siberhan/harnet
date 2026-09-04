import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createControlService } from "../src/service/control.js";
import { createGroupRegistry } from "../src/service/jobs.js";
import { createQueue, JobStatus } from "../src/service/queue.js";
import {
  attachJobStore,
  backupCorruptFile,
  createJobStore,
  createPersistentQueue,
  DEFAULT_JOBS_FILE,
  DEFAULT_STATE_DIR,
  DEFAULT_STORE_PATH,
  loadJobs,
  resolveStorePath,
  restoreJobs,
  saveJobs,
} from "../src/service/store.js";

/**
 * Creates a unique isolated temporary directory for a test.
 * @returns {string}
 */
function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "harnet-store-test-"));
}

/**
 * Removes a directory and all its contents safely.
 * @param {string} dir
 */
function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

describe("store: path resolution & file defaults", () => {
  it("exports expected default paths", () => {
    assert.equal(DEFAULT_STATE_DIR, path.join(".harnet", "state"));
    assert.equal(DEFAULT_JOBS_FILE, "jobs.json");
    assert.equal(DEFAULT_STORE_PATH, path.join(".harnet", "state", "jobs.json"));
  });

  it("resolves relative and absolute store paths", () => {
    const root = "/fake/root";
    const resolvedDefault = resolveStorePath(undefined, root);
    assert.equal(resolvedDefault, path.resolve(root, DEFAULT_STORE_PATH));

    const customRelative = resolveStorePath("custom/jobs.json", root);
    assert.equal(customRelative, path.resolve(root, "custom/jobs.json"));

    const customAbsolute = resolveStorePath("/absolute/path/jobs.json", root);
    assert.equal(customAbsolute, "/absolute/path/jobs.json");
  });
});

describe("store: file loading, saving and backup", () => {
  it("loadJobs returns empty array when file does not exist", () => {
    const dir = makeTempDir();
    try {
      const storeFile = path.join(dir, "jobs.json");
      const loaded = loadJobs(storeFile);
      assert.deepEqual(loaded, []);
      assert.equal(fs.existsSync(`${storeFile}.bak`), false);
    } finally {
      removeDir(dir);
    }
  });

  it("saveJobs writes formatted JSON and creates parent directory recursively", () => {
    const dir = makeTempDir();
    try {
      const storeFile = path.join(dir, ".harnet", "state", "jobs.json");
      /** @type {import("../src/service/store.js").StoredJob[]} */
      const jobs = [
        { id: "job-1", prompt: "test prompt", agent: "agent-1", status: "queued", depth: 0 },
      ];

      const saved = saveJobs(storeFile, jobs);
      assert.deepEqual(saved, jobs);
      assert.equal(fs.existsSync(storeFile), true);

      const raw = fs.readFileSync(storeFile, "utf8");
      const parsed = JSON.parse(raw);
      assert.deepEqual(parsed, jobs);
    } finally {
      removeDir(dir);
    }
  });

  it("loadJobs on corrupted JSON backs up to .bak and returns empty array without throwing", () => {
    const dir = makeTempDir();
    try {
      const storeFile = path.join(dir, "jobs.json");
      fs.writeFileSync(storeFile, "{ corrupt json content: not valid [", "utf8");

      const loaded = loadJobs(storeFile);
      assert.deepEqual(loaded, []);

      // Verify .bak file exists and contains the corrupted content
      const bakFile = `${storeFile}.bak`;
      assert.equal(fs.existsSync(bakFile), true);
      assert.equal(fs.readFileSync(bakFile, "utf8"), "{ corrupt json content: not valid [");
    } finally {
      removeDir(dir);
    }
  });

  it("loadJobs on non-array JSON backs up to .bak and returns empty array", () => {
    const dir = makeTempDir();
    try {
      const storeFile = path.join(dir, "jobs.json");
      fs.writeFileSync(storeFile, JSON.stringify({ not: "an array" }), "utf8");

      const loaded = loadJobs(storeFile);
      assert.deepEqual(loaded, []);

      const bakFile = `${storeFile}.bak`;
      assert.equal(fs.existsSync(bakFile), true);
    } finally {
      removeDir(dir);
    }
  });

  it("loadJobs on blank or whitespace-only file returns empty array", () => {
    const dir = makeTempDir();
    try {
      const storeFile = path.join(dir, "jobs.json");
      fs.writeFileSync(storeFile, "   \n\t  ", "utf8");

      const loaded = loadJobs(storeFile);
      assert.deepEqual(loaded, []);
    } finally {
      removeDir(dir);
    }
  });

  it("backupCorruptFile safely renames or copies to .bak destination", () => {
    const dir = makeTempDir();
    try {
      const src = path.join(dir, "test.json");
      fs.writeFileSync(src, "bad data", "utf8");

      const dest = backupCorruptFile(src);
      assert.equal(dest, `${src}.bak`);
      assert.equal(fs.existsSync(dest), true);
      assert.equal(fs.readFileSync(dest, "utf8"), "bad data");
    } finally {
      removeDir(dir);
    }
  });
});

describe("store: createJobStore standalone API", () => {
  it("supports add, update, remove, clear with automatic file persistence", () => {
    const dir = makeTempDir();
    try {
      const filePath = path.join(dir, ".harnet", "state", "jobs.json");
      const store = createJobStore({ filePath });

      assert.deepEqual(store.all(), []);

      // Add
      store.add({ id: "job-1", prompt: "p1", status: "queued" });
      assert.equal(store.all().length, 1);
      assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).length, 1);

      // Get
      assert.equal(store.get("job-1")?.prompt, "p1");
      assert.equal(store.get("unknown"), null);

      // Update
      const updated = store.update("job-1", { status: "running" });
      assert.equal(updated?.status, "running");
      assert.equal(store.get("job-1")?.status, "running");
      assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8"))[0].status, "running");

      // Remove
      const removed = store.remove("job-1");
      assert.equal(removed?.id, "job-1");
      assert.equal(store.all().length, 0);
      assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).length, 0);

      // Clear
      store.add({ id: "job-2", prompt: "p2", status: "queued" });
      assert.equal(store.all().length, 1);
      store.clear();
      assert.equal(store.all().length, 0);
      assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).length, 0);
    } finally {
      removeDir(dir);
    }
  });
});

describe("store: queue file persistence (attachJobStore)", () => {
  it("persists to jobs.json on every mutation: enqueue, dispatch, complete", () => {
    const dir = makeTempDir();
    try {
      const filePath = path.join(dir, ".harnet", "state", "jobs.json");
      const baseQueue = createQueue();
      const queue = attachJobStore(baseQueue, { filePath });

      // 1. Enqueue writes to file
      const job1 = queue.enqueue({ prompt: "task 1", agent: "agent-1" });
      assert.equal(fs.existsSync(filePath), true);
      let fileJobs = JSON.parse(fs.readFileSync(filePath, "utf8"));
      assert.equal(fileJobs.length, 1);
      assert.equal(fileJobs[0].id, job1.id);
      assert.equal(fileJobs[0].status, "queued");

      // 2. Dispatch writes to file
      const dispatched = queue.dispatch("agent-1");
      assert.equal(dispatched?.id, job1.id);
      fileJobs = JSON.parse(fs.readFileSync(filePath, "utf8"));
      assert.equal(fileJobs.length, 1);
      assert.equal(fileJobs[0].status, "running");
      assert.equal(typeof fileJobs[0].startedAt, "number");

      // 3. Complete writes to file
      const completed = queue.complete({
        jobId: job1.id,
        status: "done",
        report: "finished successfully",
      });
      assert.equal(completed.status, "done");
      fileJobs = JSON.parse(fs.readFileSync(filePath, "utf8"));
      assert.equal(fileJobs.length, 1);
      assert.equal(fileJobs[0].status, "done");
      assert.equal(fileJobs[0].report, "finished successfully");
      assert.equal(typeof fileJobs[0].endedAt, "number");
    } finally {
      removeDir(dir);
    }
  });

  it("persists on sweepTimeouts and markCrashed", () => {
    const dir = makeTempDir();
    try {
      const filePath = path.join(dir, "jobs.json");
      let fakeTime = 1000;
      const baseQueue = createQueue({ now: () => fakeTime });
      const queue = attachJobStore(baseQueue, { filePath });

      fakeTime = 1000;
      const j1 = queue.enqueue({ prompt: "timeout task", agent: "agent-1" });
      queue.dispatch("agent-1");

      // j2 starts later at 200000
      fakeTime = 200000;
      const j2 = queue.enqueue({ prompt: "crashed task", agent: "agent-2" });
      queue.dispatch("agent-2");

      // Sweep timeouts at 1000 + 30m + 1s (j1 is >30m, j2 is only ~11m)
      fakeTime = 1000 + 30 * 60 * 1000 + 1000;
      const timedOut = queue.sweepTimeouts({ timeoutMs: 30 * 60 * 1000, at: fakeTime });
      assert.equal(timedOut.length, 1);
      assert.equal(timedOut[0].id, j1.id);

      let fileJobs = JSON.parse(fs.readFileSync(filePath, "utf8"));
      assert.equal(fileJobs.find((/** @type {{ id: string }} */ j) => j.id === j1.id)?.status, "timeout");

      // Mark crashed
      const crashed = queue.markCrashed({ agent: "agent-2", report: "session died" });
      assert.equal(crashed.length, 1);
      assert.equal(crashed[0].id, j2.id);

      fileJobs = JSON.parse(fs.readFileSync(filePath, "utf8"));
      assert.equal(fileJobs.find((/** @type {{ id: string }} */ j) => j.id === j2.id)?.status, "crashed");
    } finally {
      removeDir(dir);
    }
  });

  it("restores queue state after restart (açılışta oku)", () => {
    const dir = makeTempDir();
    try {
      const filePath = path.join(dir, "jobs.json");

      // Phase 1: Run some jobs and leave one running, one queued, one completed
      {
        const q1 = attachJobStore(createQueue(), { filePath });
        const j1 = q1.enqueue({ prompt: "completed job", agent: "agent-a" });
        q1.dispatch("agent-a");
        q1.complete({ jobId: j1.id, status: "done", report: "done report" });

        const j2 = q1.enqueue({ prompt: "running job", agent: "agent-b" });
        q1.dispatch("agent-b");

        const j3 = q1.enqueue({ prompt: "queued job", agent: "agent-b" });
        assert.equal(j3.status, "queued");
      }

      // Phase 2: Simulate restart - new createQueue() with same store file
      {
        const q2 = attachJobStore(createQueue(), { filePath });
        const allJobs = q2.all();
        assert.equal(allJobs.length, 3);

        const restoredDone = q2.get("job-1");
        assert.equal(restoredDone?.status, "done");
        assert.equal(restoredDone?.report, "done report");

        const restoredRunning = q2.get("job-2");
        assert.equal(restoredRunning?.status, "running");
        assert.equal(restoredRunning?.agent, "agent-b");

        const restoredQueued = q2.get("job-3");
        assert.equal(restoredQueued?.status, "queued");
        assert.equal(restoredQueued?.agent, "agent-b");

        // Agent state check
        assert.equal(q2.isBusy("agent-a"), false);
        assert.equal(q2.isBusy("agent-b"), true);
        assert.equal(q2.runningJob("agent-b")?.id, "job-2");
        assert.equal(q2.pending("agent-b").length, 1);
        assert.equal(q2.pending("agent-b")[0].id, "job-3");

        // Now complete the running job on restarted queue
        q2.complete({ jobId: "job-2", status: "done", report: "done after restart" });
        assert.equal(q2.isBusy("agent-b"), false);

        // Next queued job can now be dispatched
        const nextDispatched = q2.dispatch("agent-b");
        assert.equal(nextDispatched?.id, "job-3");
        assert.equal(q2.isBusy("agent-b"), true);

        // Enqueueing a new job automatically picks non-colliding ID
        const newJob = q2.enqueue({ prompt: "brand new job", agent: "agent-a" });
        assert.equal(newJob.id, "job-4");

        const fileJobs = JSON.parse(fs.readFileSync(filePath, "utf8"));
        assert.equal(fileJobs.length, 4);
      }
    } finally {
      removeDir(dir);
    }
  });

  it("handles corrupted file on queue attach by backing up and starting empty", () => {
    const dir = makeTempDir();
    try {
      const filePath = path.join(dir, "jobs.json");
      fs.writeFileSync(filePath, "BROKEN_JSON_DATA", "utf8");

      const queue = attachJobStore(createQueue(), { filePath });
      assert.deepEqual(queue.all(), []);

      // Verify .bak file created
      assert.equal(fs.existsSync(`${filePath}.bak`), true);
      assert.equal(fs.readFileSync(`${filePath}.bak`, "utf8"), "BROKEN_JSON_DATA");

      // Queue remains fully functional
      const job = queue.enqueue({ prompt: "fresh job" });
      assert.equal(queue.all().length, 1);
      assert.equal(job.id, "job-1");
    } finally {
      removeDir(dir);
    }
  });

  it("works with createPersistentQueue helper", () => {
    const dir = makeTempDir();
    try {
      const filePath = path.join(dir, "jobs.json");
      const queue = createPersistentQueue(createQueue(), { filePath });
      queue.enqueue({ prompt: "p", agent: "agy" });

      const fileJobs = JSON.parse(fs.readFileSync(filePath, "utf8"));
      assert.equal(fileJobs.length, 1);
      assert.equal(fileJobs[0].agent, "agy");
    } finally {
      removeDir(dir);
    }
  });
});

describe("store: control service integration", () => {
  it("automatically saves queue changes when control service executes jobs", () => {
    const dir = makeTempDir();
    try {
      const filePath = path.join(dir, ".harnet", "state", "jobs.json");
      const queue = attachJobStore(createQueue(), { filePath });
      const groups = createGroupRegistry();

      /** @type {Array<{ agentId: string, text: string }>} */
      const writes = [];
      const adapter = {
        /** @param {{ agentId: string, text: string }} spec */
        write(spec) {
          writes.push(spec);
        },
      };

      const service = createControlService({
        queue: /** @type {import("../src/service/control.js").QueueLike} */ (/** @type {unknown} */ (queue)),
        groups,
        adapters: { agy: adapter },
      });

      // Submit job
      const { job } = service.submit({ prompt: "run task", agent: "agy" });
      assert.equal(writes.length, 1);

      let fileJobs = JSON.parse(fs.readFileSync(filePath, "utf8"));
      assert.equal(fileJobs.length, 1);
      assert.equal(fileJobs[0].id, job.id);
      assert.equal(fileJobs[0].status, "running");

      // Complete job
      service.complete({ jobId: job.id, status: "done", report: "all green" });

      fileJobs = JSON.parse(fs.readFileSync(filePath, "utf8"));
      assert.equal(fileJobs.length, 1);
      assert.equal(fileJobs[0].status, "done");
      assert.equal(fileJobs[0].report, "all green");
    } finally {
      removeDir(dir);
    }
  });
});
