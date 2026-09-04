import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  PANEL_ROUTE,
  createServer,
  start,
  parseAgentMemory,
  readAgents,
  findAgentsDir,
  renderHtml,
  readTranscriptTail,
  findTranscriptPath,
} from "../src/panel/server.js";

describe("panel: memory parser and reader", () => {
  it("parses valid MEMORY.md content", () => {
    const raw = `# worker-1 MEMORY\n\nRole: database optimization\nBranch: harnet/worker-1\nStatus: busy working on index\nLog: none\n`;
    const parsed = parseAgentMemory(raw, "fallback-id");
    assert.equal(parsed.id, "worker-1");
    assert.equal(parsed.role, "database optimization");
    assert.equal(parsed.status, "busy working on index");
  });

  it("uses fallback id when header is missing or custom", () => {
    const raw = `Role: reviewer\nStatus: idle\n`;
    const parsed = parseAgentMemory(raw, "custom-id");
    assert.equal(parsed.id, "custom-id");
    assert.equal(parsed.role, "reviewer");
    assert.equal(parsed.status, "idle");
  });

  it("handles missing role and status gracefully", () => {
    const raw = `# minimal MEMORY\n\nJust text here.`;
    const parsed = parseAgentMemory(raw, "fallback");
    assert.equal(parsed.id, "minimal");
    assert.equal(parsed.role, "");
    assert.equal(parsed.status, "");
  });

  it("readAgents returns sorted agents from directory", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harnet-panel-test-"));
    try {
      const bDir = path.join(tmp, "beta");
      const aDir = path.join(tmp, "alpha");
      const emptyDir = path.join(tmp, "empty");
      fs.mkdirSync(bDir);
      fs.mkdirSync(aDir);
      fs.mkdirSync(emptyDir);

      fs.writeFileSync(path.join(bDir, "MEMORY.md"), "# beta MEMORY\nRole: tester\nStatus: idle\n");
      fs.writeFileSync(path.join(aDir, "MEMORY.md"), "# alpha MEMORY\nRole: builder\nStatus: busy\n");

      const agents = readAgents(tmp);
      assert.equal(agents.length, 2);
      assert.equal(agents[0].id, "alpha");
      assert.equal(agents[0].role, "builder");
      assert.equal(agents[1].id, "beta");
      assert.equal(agents[1].role, "tester");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("readAgents returns empty array for non-existent directory", () => {
    const agents = readAgents("/non/existent/path/for/agents");
    assert.deepEqual(agents, []);
  });

  it("findAgentsDir resolves existing directory or fallback", () => {
    const resolved = findAgentsDir();
    assert.ok(typeof resolved === "string");
    assert.ok(resolved.length > 0);
  });
});

describe("panel: transcript reader & resolver", () => {
  it("readTranscriptTail returns empty summary for missing file", () => {
    const tail = readTranscriptTail("/non/existent/file.jsonl");
    assert.equal(tail.lastMessage, null);
    assert.equal(tail.skipped, 0);
    assert.equal(tail.lines, 0);
  });

  it("readTranscriptTail parses tail lines and extracts lastMessage, usage, skipped", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harnet-tail-test-"));
    try {
      const filePath = path.join(tmp, "transcript.jsonl");
      const lines = [
        JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "first reply" }],
            usage: { input_tokens: 100, output_tokens: 20 },
          },
        }),
        "invalid json line",
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "second reply" }],
            usage: { input_tokens: 200, output_tokens: 40 },
          },
        }),
      ].join("\n");
      fs.writeFileSync(filePath, lines);

      const all = readTranscriptTail(filePath, 10);
      assert.equal(all.lastMessage, "second reply");
      assert.equal(all.usage.input, 300);
      assert.equal(all.usage.output, 60);
      assert.equal(all.skipped, 1);
      assert.equal(all.lines, 4);

      // Limiting to last 1 line
      const tail1 = readTranscriptTail(filePath, 1);
      assert.equal(tail1.lastMessage, "second reply");
      assert.equal(tail1.usage.input, 200);
      assert.equal(tail1.skipped, 0);
      assert.equal(tail1.lines, 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("findTranscriptPath locates transcript files", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harnet-find-test-"));
    try {
      const agentDir = path.join(tmp, "alpha");
      fs.mkdirSync(agentDir);
      assert.equal(findTranscriptPath(tmp, "alpha"), null);

      const transcriptFile = path.join(agentDir, "transcript.jsonl");
      fs.writeFileSync(transcriptFile, "{}\n");
      assert.equal(findTranscriptPath(tmp, "alpha"), transcriptFile);

      // Custom option
      assert.equal(
        findTranscriptPath(tmp, "custom", { transcripts: { custom: transcriptFile } }),
        transcriptFile
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("panel: HTML rendering", () => {
  it("renders empty state when no agents or queue items", () => {
    const html = renderHtml([], []);
    assert.ok(html.includes("Harnet Kontrol Paneli"));
    assert.ok(html.includes("Henüz kayıtlı ajan bulunmuyor."));
    assert.ok(html.includes("Kuyruk boş"));
  });

  it("renders agent cards and queue table with proper escaping", () => {
    const agents = [
      { id: "agent<1>", role: "role & task", status: "idle" },
    ];
    const queue = [
      { id: "job-101", agent: "agent<1>", status: "running", prompt: "check <alert>" },
    ];
    const html = renderHtml(agents, queue);
    assert.ok(html.includes("agent&lt;1&gt;"));
    assert.ok(html.includes("role &amp; task"));
    assert.ok(html.includes("job-101"));
    assert.ok(html.includes("check &lt;alert&gt;"));
    assert.ok(html.includes("Son Mesaj:"));
  });

  it("renders lastMessage when available on agent card", () => {
    const agents = [
      { id: "agent-1", role: "worker", status: "busy", lastMessage: "Task completed successfully" },
    ];
    const html = renderHtml(agents, []);
    assert.ok(html.includes("Son Mesaj:"));
    assert.ok(html.includes("Task completed successfully"));
  });
});

describe("panel: HTTP server on real port", () => {
  it("exposes PANEL_ROUTE as root", () => {
    assert.equal(PANEL_ROUTE, "/");
  });

  it("serves GET /api/health", async () => {
    const { port, close } = await start({ port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
      const data = await res.json();
      assert.deepEqual(data, { status: "ok" });
    } finally {
      await close();
    }
  });

  it("serves HEAD /api/health without body", async () => {
    const { port, close } = await start({ port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { method: "HEAD" });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
      const text = await res.text();
      assert.equal(text, "");
    } finally {
      await close();
    }
  });

  it("serves GET /api/agents reading live agent memories", async () => {
    const { port, close } = await start({ port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/agents`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
      /** @type {Array<{ id: string, role: string, status: string }>} */
      const data = await res.json();
      assert.ok(Array.isArray(data));
      assert.ok(data.length >= 1);
      const agentIds = data.map((a) => a.id);
      assert.ok(agentIds.includes("antigravity"));
      for (const item of data) {
        assert.ok(typeof item.id === "string");
        assert.ok(typeof item.role === "string");
        assert.ok(typeof item.status === "string");
      }
    } finally {
      await close();
    }
  });

  it("serves GET /api/agents with custom agentsDir", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harnet-agents-test-"));
    try {
      const agentDir = path.join(tmp, "bot-x");
      fs.mkdirSync(agentDir);
      fs.writeFileSync(
        path.join(agentDir, "MEMORY.md"),
        "# bot-x MEMORY\nRole: search agent\nStatus: active\n"
      );

      const { port, close } = await start({ port: 0, agentsDir: tmp });
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/agents`);
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.deepEqual(data, [
          { id: "bot-x", role: "search agent", status: "active" },
        ]);
      } finally {
        await close();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("serves GET /api/agents/:id/tail with lastMessage, usage, skipped", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harnet-tail-server-"));
    try {
      const agentDir = path.join(tmp, "bot-y");
      fs.mkdirSync(agentDir);
      fs.writeFileSync(
        path.join(agentDir, "MEMORY.md"),
        "# bot-y MEMORY\nRole: bot\nStatus: busy\n"
      );
      const transcriptLines = [
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Done with task" }],
            usage: { input_tokens: 50, output_tokens: 25 },
          },
        }),
      ].join("\n");
      fs.writeFileSync(path.join(agentDir, "transcript.jsonl"), transcriptLines);

      const { port, close } = await start({ port: 0, agentsDir: tmp });
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/agents/bot-y/tail`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
        const data = await res.json();
        assert.equal(data.agent, "bot-y");
        assert.equal(data.lastMessage, "Done with task");
        assert.equal(data.usage.total, 75);
        assert.equal(data.skipped, 0);

        // HEAD request
        const headRes = await fetch(`http://127.0.0.1:${port}/api/agents/bot-y/tail`, { method: "HEAD" });
        assert.equal(headRes.status, 200);
        const headText = await headRes.text();
        assert.equal(headText, "");

        // Tail with n query
        const nRes = await fetch(`http://127.0.0.1:${port}/api/agents/bot-y/tail?n=10`);
        assert.equal(nRes.status, 200);
        const nData = await nRes.json();
        assert.equal(nData.lastMessage, "Done with task");
      } finally {
        await close();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns 404 with explanatory body when transcript does not exist", async () => {
    const { port, close } = await start({ port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/agents/non-existent-agent-xyz/tail`);
      assert.equal(res.status, 404);
      assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
      const data = await res.json();
      assert.equal(data.error, "Transcript not found");
      assert.ok(data.message.includes("non-existent-agent-xyz"));
    } finally {
      await close();
    }
  });

  it("returns 405 for POST /api/agents/:id/tail", async () => {
    const { port, close } = await start({ port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/agents/any-agent/tail`, { method: "POST" });
      assert.equal(res.status, 405);
      assert.equal(res.headers.get("allow"), "GET, HEAD");
    } finally {
      await close();
    }
  });

  it("serves GET / showing 'Son Mesaj' on agent cards", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harnet-card-msg-"));
    try {
      const agentDir = path.join(tmp, "bot-z");
      fs.mkdirSync(agentDir);
      fs.writeFileSync(path.join(agentDir, "MEMORY.md"), "# bot-z MEMORY\nRole: worker\nStatus: idle\n");
      fs.writeFileSync(
        path.join(agentDir, "transcript.jsonl"),
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "Ajan hazır" }] },
        }) + "\n"
      );

      const { port, close } = await start({ port: 0, agentsDir: tmp });
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`);
        assert.equal(res.status, 200);
        const html = await res.text();
        assert.ok(html.includes("Son Mesaj:"));
        assert.ok(html.includes("Ajan hazır"));
      } finally {
        await close();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("serves GET /api/queue (empty array by default)", async () => {
    const { port, close } = await start({ port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/queue`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
      const data = await res.json();
      assert.deepEqual(data, []);
    } finally {
      await close();
    }
  });

  it("serves GET /api/queue with injected queue provider", async () => {
    const sampleQueue = [
      { id: "job-1", agent: "antigravity", status: "queued", prompt: "build panel" },
    ];
    const { port, close } = await start({
      port: 0,
      queue: () => sampleQueue,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/queue`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.deepEqual(data, sampleQueue);
    } finally {
      await close();
    }
  });

  it("serves GET / HTML page showing agents and queue", async () => {
    const { port, close } = await start({ port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
      const html = await res.text();
      assert.ok(html.includes("<!DOCTYPE html>"));
      assert.ok(html.includes("Harnet Kontrol Paneli"));
      assert.ok(html.includes("antigravity"));
      assert.ok(html.includes("İş Kuyruğu"));
      assert.ok(html.includes("Son Mesaj:"));
    } finally {
      await close();
    }
  });

  it("serves GET /index.html same as root", async () => {
    const { port, close } = await start({ port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/index.html`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
      const html = await res.text();
      assert.ok(html.includes("Harnet Kontrol Paneli"));
      assert.ok(html.includes("Son Mesaj:"));
    } finally {
      await close();
    }
  });

  it("returns 405 Method Not Allowed for non-GET/HEAD methods", async () => {
    const { port, close } = await start({ port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        method: "POST",
        body: JSON.stringify({ test: 1 }),
      });
      assert.equal(res.status, 405);
      assert.equal(res.headers.get("allow"), "GET, HEAD");
      const data = await res.json();
      assert.equal(data.error, "Method Not Allowed");
    } finally {
      await close();
    }
  });

  it("returns 404 for unknown endpoints", async () => {
    const { port, close } = await start({ port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/non-existent`);
      assert.equal(res.status, 404);
      const data = await res.json();
      assert.equal(data.error, "Not Found");
    } finally {
      await close();
    }
  });
});
