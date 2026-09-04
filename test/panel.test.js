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
