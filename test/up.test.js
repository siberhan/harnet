import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { startUp } from "../bin/harnet.js";
import { parseTranscript } from "../src/observe/transcript.js";
import { setupControlService } from "../src/service/control.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const binPath = path.resolve(__dirname, "../bin/harnet.js");

/**
 * Creates an isolated temp directory.
 * @returns {string}
 */
function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "harnet-up-test-"));
}

/**
 * Removes directory safely.
 * @param {string} dir
 */
function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

describe("harnet up: setupControlService wiring", () => {
  it("initializes queue, store, report reader, and control service", () => {
    const dir = makeTempDir();
    try {
      const storePath = path.join(dir, ".harnet", "state", "jobs.json");
      const ctx = setupControlService({
        rootDir: dir,
        storePath,
        parse: parseTranscript,
      });

      assert.ok(ctx.service);
      assert.ok(ctx.queue);
      assert.ok(ctx.store);
      assert.ok(ctx.groups);
      assert.equal(typeof ctx.reportReader, "function");

      // Verify queue is persistent and loads empty initially
      assert.deepEqual(ctx.queue.all(), []);

      // Verify enqueueing persists to disk
      ctx.queue.enqueue({ prompt: "first task", agent: "test-agent" });
      assert.equal(fs.existsSync(storePath), true);
      const saved = JSON.parse(fs.readFileSync(storePath, "utf8"));
      assert.equal(saved.length, 1);
      assert.equal(saved[0].prompt, "first task");
    } finally {
      removeDir(dir);
    }
  });

  it("loads existing jobs from store file on setup", () => {
    const dir = makeTempDir();
    try {
      const storeDir = path.join(dir, ".harnet", "state");
      fs.mkdirSync(storeDir, { recursive: true });
      const storePath = path.join(storeDir, "jobs.json");
      const existing = [
        { id: "job-10", prompt: "persisted task", agent: "agy", status: "queued", depth: 0 },
      ];
      fs.writeFileSync(storePath, JSON.stringify(existing), "utf8");

      const ctx = setupControlService({
        rootDir: dir,
        storePath,
        parse: parseTranscript,
      });

      assert.equal(ctx.queue.all().length, 1);
      assert.equal(ctx.queue.get("job-10")?.prompt, "persisted task");
    } finally {
      removeDir(dir);
    }
  });

  it("reportReader parses transcript content correctly via parseTranscript", () => {
    const dir = makeTempDir();
    try {
      const transcriptPath = path.join(dir, "transcript.jsonl");
      const line1 = JSON.stringify({
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Report from agent: task completed" }],
      }) + "\n";
      fs.writeFileSync(transcriptPath, line1, "utf8");

      const ctx = setupControlService({
        rootDir: dir,
        parse: parseTranscript,
        reportReaderOptions: { flushTimeoutMs: 100 },
      });

      const report = ctx.reportReader({ transcriptPath, agentId: "agy" });
      assert.equal(report, "Report from agent: task completed");
    } finally {
      removeDir(dir);
    }
  });
});

describe("harnet up: startUp in-process", () => {
  it("starts control service and panel, exposes /api/health 200, and stops cleanly", async () => {
    const dir = makeTempDir();
    try {
      const storePath = path.join(dir, ".harnet", "state", "jobs.json");
      const daemon = await startUp({
        root: dir,
        storePath,
        port: 0,
        parse: parseTranscript,
      });

      assert.ok(daemon.panel.port > 0);
      assert.ok(daemon.service);
      assert.ok(daemon.queue);
      assert.ok(daemon.store);

      // Verify /api/health returns 200 with status "ok"
      const res = await fetch(`http://127.0.0.1:${daemon.panel.port}/api/health`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.deepEqual(data, { status: "ok" });

      // Verify /api/queue returns empty array initially
      const queueRes = await fetch(`http://127.0.0.1:${daemon.panel.port}/api/queue`);
      assert.equal(queueRes.status, 200);
      const queueData = await queueRes.json();
      assert.deepEqual(queueData, []);

      // Enqueue a job and check /api/queue updates live
      daemon.queue.enqueue({ prompt: "live test", agent: "agent-1" });
      const queueRes2 = await fetch(`http://127.0.0.1:${daemon.panel.port}/api/queue`);
      const queueData2 = await queueRes2.json();
      assert.equal(queueData2.length, 1);
      assert.equal(queueData2[0].prompt, "live test");

      // Stop daemon and verify store is saved
      await daemon.stop();

      assert.equal(fs.existsSync(storePath), true);
      const stored = JSON.parse(fs.readFileSync(storePath, "utf8"));
      assert.equal(stored.length, 1);
      assert.equal(stored[0].prompt, "live test");
    } finally {
      removeDir(dir);
    }
  });
});

describe("harnet up: CLI subprocess execution and Ctrl-C shutdown", () => {
  it("launches node bin/harnet.js up, responds to /api/health, and shuts down cleanly on SIGINT", async () => {
    const dir = makeTempDir();
    const env = { ...process.env, HARNET_ROOT: dir, PORT: "0" };

    const child = spawn("node", [binPath, "up", "--port", "0"], {
      cwd: dir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    try {
      let stdoutBuffer = "";

      /** @type {Promise<number>} */
      const portPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Timeout waiting for server port. stdout: ${stdoutBuffer}`));
        }, 8000);

        child.stdout.on("data", (chunk) => {
          stdoutBuffer += chunk.toString();
          const match = stdoutBuffer.match(/http:\/\/127\.0\.0\.1:(\d+)/);
          if (match) {
            clearTimeout(timer);
            resolve(parseInt(match[1], 10));
          }
        });

        child.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });

        child.on("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`Child exited early with code ${code}. stdout: ${stdoutBuffer}`));
        });
      });

      const assignedPort = await portPromise;
      assert.ok(assignedPort > 0, `Expected valid port, got ${assignedPort}`);

      // Query /api/health on running subprocess
      const res = await fetch(`http://127.0.0.1:${assignedPort}/api/health`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.deepEqual(data, { status: "ok" });

      // Send SIGINT (Ctrl-C)
      const exitPromise = new Promise((resolve) => {
        child.on("exit", (code, signal) => {
          resolve({ code, signal });
        });
      });

      child.kill("SIGINT");
      const { code } = await exitPromise;
      assert.equal(code, 0);

      // Verify store was saved
      const storePath = path.join(dir, ".harnet", "state", "jobs.json");
      assert.equal(fs.existsSync(storePath), true);
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      removeDir(dir);
    }
  });
});
