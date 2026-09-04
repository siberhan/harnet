import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it } from "node:test";
import {
  parseState,
  parseAgentMemory,
  readAgents,
  formatTable,
  getStatusRows,
  buildStatusTable,
} from "../bin/harnet.js";

describe("harnet status CLI: unit parsing", () => {
  it("parseState extracts open jobs and board lines", () => {
    const rawState = `# STATE

## Jobs
- done: job-0 (wb) - scaffold
- open: job-1 (agy) - panel task
- open: bot-job-2 (bot) - worker task

## Board + limits
- agy: busy (job-1)
- bot: BLOCKED, limit reached
`;
    const state = parseState(rawState);
    assert.equal(state.openJobs.length, 2);
    assert.equal(state.openJobs[0].id, "job-1");
    assert.equal(state.openJobs[0].agentHint, "agy");
    assert.equal(state.openJobs[1].id, "bot-job-2");

    assert.equal(state.board.get("agy"), "busy (job-1)");
    assert.equal(state.board.get("bot"), "BLOCKED, limit reached");
  });

  it("parseAgentMemory extracts id, role, and status", () => {
    const raw = `# agent-test MEMORY\nRole: tester\nStatus: ready to test\n`;
    const parsed = parseAgentMemory(raw, "fallback");
    assert.equal(parsed.id, "agent-test");
    assert.equal(parsed.role, "tester");
    assert.equal(parsed.status, "ready to test");
  });

  it("formatTable formats columns with borders", () => {
    const table = formatTable(["Ajan", "Durum", "Açık İş"], [
      ["a1", "busy", "job-1"],
      ["a2", "idle", "-"],
    ]);
    assert.ok(table.includes("Ajan"));
    assert.ok(table.includes("Durum"));
    assert.ok(table.includes("Açık İş"));
    assert.ok(table.includes("a1"));
    assert.ok(table.includes("job-1"));
  });

  it("formatTable returns fallback text when rows are empty", () => {
    const table = formatTable(["Ajan", "Durum", "Açık İş"], []);
    assert.equal(table, "Hiç ajan bulunamadı.");
  });

  it("getStatusRows maps open jobs and board statuses", () => {
    const agents = [
      { id: "alpha", role: "worker", status: "idle" },
      { id: "beta", role: "tester", status: "turn 1 done" },
    ];
    /** @type {import("../bin/harnet.js").StateData} */
    const state = {
      openJobs: [{ id: "alpha-task-1", agentHint: "alpha", description: "do work" }],
      board: new Map([
        ["alpha", "busy (alpha-task-1)"],
        ["beta", "BLOCKED"],
      ]),
    };
    const rows = getStatusRows(agents, state);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].agent, "alpha");
    assert.equal(rows[0].status, "busy");
    assert.equal(rows[0].openJob, "alpha-task-1");

    assert.equal(rows[1].agent, "beta");
    assert.equal(rows[1].status, "BLOCKED");
    assert.equal(rows[1].openJob, "-");
  });
});

describe("harnet status CLI: subprocess execution", () => {
  const binPath = path.resolve("bin/harnet.js");

  it("runs `node bin/harnet.js status` on current workspace", () => {
    const res = spawnSync("node", [binPath, "status"], {
      encoding: "utf8",
    });
    assert.equal(res.status, 0);
    assert.ok(res.stdout.includes("Ajan"));
    assert.ok(res.stdout.includes("Durum"));
    assert.ok(res.stdout.includes("Açık İş"));
    assert.ok(res.stdout.includes("antigravity"));
    assert.ok(res.stdout.includes("workbuddy"));
  });

  it("runs `node bin/harnet.js status` in custom mock repository", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harnet-cli-test-"));
    try {
      const stateContent = `# STATE\n\n## Jobs\n- open: test-job-99 (mock-agent) - task\n\n## Board + limits\n- mock-agent: busy\n- idle-agent: idle\n`;
      fs.writeFileSync(path.join(tmp, "STATE.md"), stateContent);

      const agentsDir = path.join(tmp, ".harnet", "agents");
      const mockDir = path.join(agentsDir, "mock-agent");
      const idleDir = path.join(agentsDir, "idle-agent");
      fs.mkdirSync(mockDir, { recursive: true });
      fs.mkdirSync(idleDir, { recursive: true });

      fs.writeFileSync(path.join(mockDir, "MEMORY.md"), "# mock-agent MEMORY\nRole: mock\nStatus: busy\n");
      fs.writeFileSync(path.join(idleDir, "MEMORY.md"), "# idle-agent MEMORY\nRole: idle\nStatus: idle\n");

      const res = spawnSync("node", [binPath, "status"], {
        encoding: "utf8",
        env: { ...process.env, HARNET_ROOT: tmp },
      });

      assert.equal(res.status, 0);
      assert.ok(res.stdout.includes("mock-agent"));
      assert.ok(res.stdout.includes("test-job-99"));
      assert.ok(res.stdout.includes("idle-agent"));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("shows usage on no arguments or --help", () => {
    const resNoArg = spawnSync("node", [binPath], { encoding: "utf8" });
    assert.equal(resNoArg.status, 0);
    assert.ok(resNoArg.stdout.includes("Kullanım: node bin/harnet.js"));

    const resHelp = spawnSync("node", [binPath, "--help"], { encoding: "utf8" });
    assert.equal(resHelp.status, 0);
    assert.ok(resHelp.stdout.includes("Kullanım: node bin/harnet.js"));
  });

  it("fails with exit code 1 on unknown command", () => {
    const res = spawnSync("node", [binPath, "unknown-command"], { encoding: "utf8" });
    assert.equal(res.status, 1);
    assert.ok(res.stderr.includes("Bilinmeyen komut: unknown-command"));
  });
});
