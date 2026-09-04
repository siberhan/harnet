/**
 * Read-only web panel.
 * README: Web Arayuzu (Phase 1: read-only slice + transcript view).
 *
 * Endpoints:
 * - GET /api/health: { status: "ok" }
 * - GET /api/agents: [{ id, role, status, lastMessage }, ...] from .harnet/agents/<id>/MEMORY.md
 * - GET /api/agents/<id>/tail: last N lines parsed JSON (lastMessage + usage + skipped)
 * - GET /api/queue: [] (or injected queue state)
 * - GET /: simple single HTML page showing agent list (with last message) + queue
 *
 * Zero external dependencies: Node http/fs/path only.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { emptySummary, parseLine, addEntry } from "../observe/transcript.js";

export const PANEL_ROUTE = "/";

/**
 * @typedef {object} AgentInfo
 * @property {string} id
 * @property {string} role
 * @property {string} status
 * @property {string|null} [lastMessage]
 */

/**
 * @typedef {object} QueueItem
 * @property {string} id
 * @property {string} [prompt]
 * @property {string} [agent]
 * @property {string} [status]
 * @property {number} [createdAt]
 */

/**
 * @typedef {object} ServerOptions
 * @property {string} [agentsDir]
 * @property {QueueItem[] | (() => QueueItem[])} [queue]
 * @property {number} [port]
 * @property {string} [host]
 * @property {Record<string, string>} [transcripts]
 * @property {(agentId: string) => string|null} [getTranscriptPath]
 */

/**
 * Parses an agent's MEMORY.md file content.
 * @param {string} content
 * @param {string} fallbackId
 * @returns {AgentInfo}
 */
export function parseAgentMemory(content, fallbackId) {
  let id = fallbackId;
  let role = "";
  let status = "";

  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!id || id === fallbackId) {
      const headerMatch = trimmed.match(/^#\s+([A-Za-z0-9_-]+)\s+MEMORY/i);
      if (headerMatch) {
        id = headerMatch[1];
      }
    }
    const roleMatch = trimmed.match(/^Role:\s*(.*)$/i);
    if (roleMatch && !role) {
      role = roleMatch[1].trim();
    }
    const statusMatch = trimmed.match(/^Status:\s*(.*)$/i);
    if (statusMatch && !status) {
      status = statusMatch[1].trim();
    }
  }

  return { id, role, status };
}

/**
 * Resolves the directory holding agent subdirectories (.harnet/agents).
 * Checks explicit env var, worktree parent structure, or walks up from baseDir.
 * @param {string} [baseDir]
 * @returns {string}
 */
export function findAgentsDir(baseDir = process.cwd()) {
  if (process.env.HARNET_AGENTS_DIR) {
    return path.resolve(process.env.HARNET_AGENTS_DIR);
  }

  // 1. When cwd is inside a worktree: .harnet/agents/<id>/wt -> ../.. is .harnet/agents
  const parentAgents = path.resolve(baseDir, "..", "..");
  if (
    path.basename(parentAgents) === "agents" &&
    path.basename(path.resolve(parentAgents, "..")) === ".harnet" &&
    fs.existsSync(parentAgents)
  ) {
    return parentAgents;
  }

  // 2. Direct local .harnet/agents
  const localAgents = path.resolve(baseDir, ".harnet", "agents");
  if (fs.existsSync(localAgents)) {
    return localAgents;
  }

  // 3. Search upwards
  let curr = path.resolve(baseDir);
  while (true) {
    const candidate = path.join(curr, ".harnet", "agents");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }

  return localAgents;
}

/**
 * Resolves the path to an agent's transcript jsonl file.
 * @param {string} agentsDir
 * @param {string} agentId
 * @param {ServerOptions} [options]
 * @returns {string|null}
 */
export function findTranscriptPath(agentsDir, agentId, options = {}) {
  if (typeof options.getTranscriptPath === "function") {
    const custom = options.getTranscriptPath(agentId);
    if (custom && fs.existsSync(custom)) return custom;
  }
  if (options.transcripts && typeof options.transcripts[agentId] === "string") {
    const custom = options.transcripts[agentId];
    if (fs.existsSync(custom)) return custom;
  }

  const agentDir = path.join(agentsDir, agentId);
  if (!fs.existsSync(agentDir)) return null;

  // 1. Direct transcript.jsonl
  const direct = path.join(agentDir, "transcript.jsonl");
  if (fs.existsSync(direct)) return direct;

  // 2. Any .jsonl in the agent directory
  try {
    const files = fs.readdirSync(agentDir);
    const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));
    if (jsonlFiles.length > 0) {
      const preferred = jsonlFiles.find((f) => f === "transcript.jsonl") ?? jsonlFiles[0];
      return path.join(agentDir, preferred);
    }
  } catch {
    // Ignore read errors
  }

  // 3. In agent's wt/ directory if present
  const wtDirect = path.join(agentDir, "wt", "transcript.jsonl");
  if (fs.existsSync(wtDirect)) return wtDirect;

  return null;
}

/**
 * Reads and parses the last N non-empty lines from a transcript file.
 * @param {string} filePath
 * @param {number} [n=50]
 * @returns {{ lastMessage: string|null, usage: import("../observe/transcript.js").Usage, skipped: number, lines: number, parsed: number }}
 */
export function readTranscriptTail(filePath, n = 50) {
  const summary = emptySummary();
  if (!fs.existsSync(filePath)) {
    return {
      lastMessage: null,
      usage: summary.usage,
      skipped: 0,
      lines: 0,
      parsed: 0,
    };
  }

  const content = fs.readFileSync(filePath, "utf8");
  const rawLines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const limit = Math.max(1, n);
  const tail = rawLines.slice(-limit);

  for (const [idx, raw] of tail.entries()) {
    summary.lines += 1;
    const entry = parseLine(raw, idx + 1);
    if (entry === null) {
      summary.skipped += 1;
    } else {
      addEntry(summary, entry);
    }
  }

  return {
    lastMessage: summary.lastMessage,
    usage: summary.usage,
    skipped: summary.skipped,
    lines: summary.lines,
    parsed: summary.parsed,
  };
}

/**
 * Reads agent memory files from agents directory.
 * @param {string} agentsDir
 * @returns {AgentInfo[]}
 */
export function readAgents(agentsDir) {
  if (!fs.existsSync(agentsDir)) {
    return [];
  }
  const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  /** @type {AgentInfo[]} */
  const agents = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const memoryPath = path.join(agentsDir, entry.name, "MEMORY.md");
    if (fs.existsSync(memoryPath)) {
      try {
        const content = fs.readFileSync(memoryPath, "utf8");
        agents.push(parseAgentMemory(content, entry.name));
      } catch {
        // Skip unreadable files
      }
    }
  }

  return agents.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * @param {string} [str]
 * @returns {string}
 */
function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Renders the single-page HTML for agents and queue.
 * @param {AgentInfo[]} agents
 * @param {QueueItem[]} queue
 * @returns {string}
 */
export function renderHtml(agents, queue) {
  const agentsHtml = agents.length === 0
    ? `<div class="empty-state">Henüz kayıtlı ajan bulunmuyor.</div>`
    : `<div class="card-list">
        ${agents.map((a) => `
          <div class="card" data-agent-id="${escapeHtml(a.id)}">
            <div class="card-header">
              <span class="agent-id">${escapeHtml(a.id)}</span>
              <span class="agent-status">${escapeHtml(a.status || "bilinmiyor")}</span>
            </div>
            <div class="agent-role">${escapeHtml(a.role || "-")}</div>
            <div class="agent-last-message">
              <span class="meta-label">Son Mesaj:</span>
              <span class="message-text">${escapeHtml(a.lastMessage || "-")}</span>
            </div>
          </div>
        `).join("")}
      </div>`;

  const queueHtml = queue.length === 0
    ? `<div class="empty-state">Kuyruk boş (0 iş bekliyor).</div>`
    : `<table class="queue-table">
        <thead>
          <tr>
            <th>İş ID</th>
            <th>Hedef Ajan</th>
            <th>Durum</th>
            <th>İstem</th>
          </tr>
        </thead>
        <tbody>
          ${queue.map((q) => `
            <tr>
              <td><code>${escapeHtml(q.id)}</code></td>
              <td>${escapeHtml(q.agent ?? "-")}</td>
              <td><span class="badge badge-sm">${escapeHtml(q.status ?? "queued")}</span></td>
              <td>${escapeHtml(q.prompt ?? "-")}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>`;

  return `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Harnet Kontrol Paneli</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --border: #334155;
      --accent: #38bdf8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      padding: 2rem;
    }
    .container { max-width: 960px; margin: 0 auto; }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2rem;
      border-bottom: 1px solid var(--border);
      padding-bottom: 1rem;
    }
    h1 { font-size: 1.5rem; font-weight: 700; color: var(--accent); }
    .badge {
      display: inline-block;
      padding: 0.25rem 0.6rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 600;
      background: #0284c7;
      color: #fff;
    }
    .badge-sm { padding: 0.15rem 0.4rem; font-size: 0.7rem; background: #334155; }
    section { margin-bottom: 2.5rem; }
    h2 { font-size: 1.2rem; margin-bottom: 1rem; color: var(--text); }
    .card-list { display: grid; gap: 0.75rem; }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      padding: 1rem 1.25rem;
    }
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      margin-bottom: 0.5rem;
    }
    .agent-id { font-size: 1.1rem; font-weight: 600; color: var(--accent); }
    .agent-status {
      font-size: 0.8rem;
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.08);
      color: #cbd5e1;
    }
    .agent-role { color: var(--text-muted); font-size: 0.9rem; }
    .agent-last-message {
      margin-top: 0.5rem;
      padding-top: 0.5rem;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
      font-size: 0.85rem;
      color: var(--text-muted);
    }
    .meta-label {
      font-weight: 600;
      color: #cbd5e1;
      margin-right: 0.35rem;
    }
    .message-text {
      color: #e2e8f0;
      word-break: break-word;
    }
    .empty-state {
      background: var(--card-bg);
      border: 1px dashed var(--border);
      border-radius: 0.5rem;
      padding: 2rem;
      text-align: center;
      color: var(--text-muted);
      font-size: 0.95rem;
    }
    .queue-table {
      width: 100%;
      border-collapse: collapse;
      background: var(--card-bg);
      border-radius: 0.5rem;
      overflow: hidden;
      border: 1px solid var(--border);
    }
    .queue-table th, .queue-table td {
      padding: 0.75rem 1rem;
      text-align: left;
      border-bottom: 1px solid var(--border);
      font-size: 0.9rem;
    }
    .queue-table th { background: rgba(0,0,0,0.25); color: var(--text-muted); font-weight: 600; }
    code { font-family: monospace; font-size: 0.85rem; background: rgba(0,0,0,0.3); padding: 0.1rem 0.3rem; border-radius: 3px; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Harnet Kontrol Paneli</h1>
      <span class="badge">Salt-okunur (Faz 1)</span>
    </header>

    <section id="agents-section">
      <h2>Ajanlar (${agents.length})</h2>
      ${agentsHtml}
    </section>

    <section id="queue-section">
      <h2>İş Kuyruğu (${queue.length})</h2>
      ${queueHtml}
    </section>
  </div>
</body>
</html>`;
}

/**
 * Creates the HTTP server instance.
 * @param {ServerOptions} [options]
 * @returns {http.Server}
 */
export function createServer(options = {}) {
  const agentsDir = options.agentsDir ?? findAgentsDir();

  /** @returns {QueueItem[]} */
  function getQueueState() {
    if (typeof options.queue === "function") {
      return options.queue();
    }
    if (Array.isArray(options.queue)) {
      return options.queue;
    }
    return [];
  }

  const server = http.createServer((req, res) => {
    const method = req.method ?? "GET";
    const parsedUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = parsedUrl.pathname;

    if (method !== "GET" && method !== "HEAD") {
      const payload = JSON.stringify({ error: "Method Not Allowed" });
      res.writeHead(405, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(payload),
        "Allow": "GET, HEAD",
      });
      res.end(payload);
      return;
    }

    if (pathname === "/api/health") {
      const payload = JSON.stringify({ status: "ok" });
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(payload),
      });
      if (method === "HEAD") {
        res.end();
      } else {
        res.end(payload);
      }
      return;
    }

    if (pathname === "/api/agents") {
      const agents = readAgents(agentsDir);
      const payload = JSON.stringify(agents);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(payload),
      });
      if (method === "HEAD") {
        res.end();
      } else {
        res.end(payload);
      }
      return;
    }

    // GET /api/agents/<id>/tail
    const tailMatch = pathname.match(/^\/api\/agents\/([A-Za-z0-9_-]+)\/tail$/);
    if (tailMatch) {
      const agentId = tailMatch[1];
      const transcriptPath = findTranscriptPath(agentsDir, agentId, options);
      if (!transcriptPath || !fs.existsSync(transcriptPath)) {
        const payload = JSON.stringify({
          error: "Transcript not found",
          agent: agentId,
          message: `Transcript jsonl file not found for agent '${agentId}'`,
        });
        res.writeHead(404, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(payload),
        });
        if (method === "HEAD") {
          res.end();
        } else {
          res.end(payload);
        }
        return;
      }

      const nParam = parsedUrl.searchParams.get("n") ?? parsedUrl.searchParams.get("lines");
      const n = nParam ? parseInt(nParam, 10) : 50;
      const limit = Number.isFinite(n) && n > 0 ? n : 50;

      const tail = readTranscriptTail(transcriptPath, limit);
      const payload = JSON.stringify({
        agent: agentId,
        lastMessage: tail.lastMessage,
        usage: tail.usage,
        skipped: tail.skipped,
        lines: tail.lines,
        parsed: tail.parsed,
      });
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(payload),
      });
      if (method === "HEAD") {
        res.end();
      } else {
        res.end(payload);
      }
      return;
    }

    if (pathname === "/api/queue") {
      const queue = getQueueState();
      const payload = JSON.stringify(queue);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(payload),
      });
      if (method === "HEAD") {
        res.end();
      } else {
        res.end(payload);
      }
      return;
    }

    if (pathname === "/" || pathname === "/index.html") {
      const agents = readAgents(agentsDir);
      const enrichedAgents = agents.map((agent) => {
        const transcriptPath = findTranscriptPath(agentsDir, agent.id, options);
        let lastMessage = null;
        if (transcriptPath && fs.existsSync(transcriptPath)) {
          const tail = readTranscriptTail(transcriptPath, 50);
          lastMessage = tail.lastMessage;
        }
        return { ...agent, lastMessage };
      });
      const queue = getQueueState();
      const html = renderHtml(enrichedAgents, queue);
      const payload = Buffer.from(html, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": payload.length,
      });
      if (method === "HEAD") {
        res.end();
      } else {
        res.end(payload);
      }
      return;
    }

    const payload = JSON.stringify({ error: "Not Found" });
    res.writeHead(404, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload),
    });
    if (method === "HEAD") {
      res.end();
    } else {
      res.end(payload);
    }
  });

  return server;
}

/**
 * Starts the server on the configured port and host.
 * @param {ServerOptions} [options]
 * @returns {Promise<{ server: http.Server, port: number, close: () => Promise<void> }>}
 */
export function start(options = {}) {
  const port = options.port ?? (process.env.PORT ? parseInt(process.env.PORT, 10) : 3000);
  const host = options.host ?? "127.0.0.1";
  const server = createServer(options);

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr !== null ? addr.port : port;
      /** @returns {Promise<void>} */
      const close = () =>
        new Promise((res, rej) => {
          server.close((err) => (err ? rej(err) : res()));
        });
      resolve({ server, port: actualPort, close });
    });
  });
}

// Direct execution entry point
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  start()
    .then(({ port }) => {
      console.log(`[harnet-panel] Listening on http://127.0.0.1:${port}`);
    })
    .catch((err) => {
      console.error("[harnet-panel] Failed to start:", err);
      process.exit(1);
    });
}
