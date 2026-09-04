/**
 * Web panel with read-only view and live terminal attachment.
 * README: Web Arayuzu (Phase 1: read-only slice + transcript view; Phase 2: live xterm.js attach).
 *
 * Endpoints:
 * - GET /api/health: { status: "ok" }
 * - GET /api/agents: [{ id, role, status, lastMessage }, ...] from .harnet/agents/<id>/MEMORY.md
 * - GET /api/agents/<id>/tail: last N lines parsed JSON (lastMessage + usage + skipped)
 * - GET /api/queue: [] (or injected queue state)
 * - GET /: single HTML page showing agent list (with last message & connect button) + queue
 * - WS /api/agents/<id>/term: live tmux terminal attach (pipe-pane tail + send-keys relay)
 *
 * Dependencies: Node builtins (http, fs, path, child_process) + ws for terminal WebSocket.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { WebSocketServer, WebSocket } from "ws";
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
 * @typedef {(argv: string[], opts?: { cwd?: string }) => { status: number|null, stdout: string, stderr: string }} CommandRunner
 */

/**
 * @typedef {object} ServerOptions
 * @property {string} [agentsDir]
 * @property {QueueItem[] | (() => QueueItem[])} [queue]
 * @property {number} [port]
 * @property {string} [host]
 * @property {Record<string, string>} [transcripts]
 * @property {(agentId: string) => string|null} [getTranscriptPath]
 * @property {Record<string, string>} [paneLogs]
 * @property {(agentId: string) => string|null} [getPaneLogPath]
 * @property {(agentId: string) => string} [sessionName]
 * @property {CommandRunner} [runner]
 * @property {CommandRunner} [run]
 * @property {number} [tailPollIntervalMs]
 */

/**
 * Default runner executing process via spawnSync.
 * @type {CommandRunner}
 */
export function spawnRunner(argv, opts = {}) {
  if (!argv || argv.length === 0) {
    return { status: 1, stdout: "", stderr: "empty command" };
  }
  const cwd = opts.cwd ?? process.cwd();
  try {
    const res = spawnSync(argv[0], argv.slice(1), {
      cwd,
      encoding: "utf8",
    });
    return {
      status: res.status,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? (res.error ? res.error.message : ""),
    };
  } catch (err) {
    return { status: 1, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Resolves standard tmux session name for an agent.
 * @param {string} agentId
 * @returns {string}
 */
export function sessionName(agentId) {
  return `harnet-${agentId}`;
}

/**
 * Sends keystrokes to a tmux session via send-keys.
 * Supports string literals, key sequences (Enter, BSpace, Up, Down, Left, Right, C-c, C-d),
 * and structured JSON envelopes.
 *
 * @param {string} session
 * @param {unknown} data
 * @param {CommandRunner} [runner]
 * @returns {void}
 */
export function sendTmuxKeys(session, data, runner = spawnRunner) {
  if (data === undefined || data === null) return;
  let text = typeof data === "string" ? data : String(data);

  // Check for structured JSON payload
  if (text.startsWith("{") && text.endsWith("}")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed.args)) {
        runner(["tmux", "send-keys", "-t", session, ...parsed.args]);
        return;
      }
      if (typeof parsed.keys === "string") {
        text = parsed.keys;
      } else if (typeof parsed.input === "string") {
        text = parsed.input;
      } else if (typeof parsed.data === "string") {
        text = parsed.data;
      }
    } catch {
      // Treat as raw text
    }
  }

  if (text.length === 0) return;

  // Single key / control code shortcuts
  if (text === "\r" || text === "\n" || text === "\r\n") {
    runner(["tmux", "send-keys", "-t", session, "Enter"]);
    return;
  }
  if (text === "\x7f" || text === "\x08") {
    runner(["tmux", "send-keys", "-t", session, "BSpace"]);
    return;
  }
  if (text === "\x1b[A") {
    runner(["tmux", "send-keys", "-t", session, "Up"]);
    return;
  }
  if (text === "\x1b[B") {
    runner(["tmux", "send-keys", "-t", session, "Down"]);
    return;
  }
  if (text === "\x1b[C") {
    runner(["tmux", "send-keys", "-t", session, "Right"]);
    return;
  }
  if (text === "\x1b[D") {
    runner(["tmux", "send-keys", "-t", session, "Left"]);
    return;
  }
  if (text === "\x03") {
    runner(["tmux", "send-keys", "-t", session, "C-c"]);
    return;
  }
  if (text === "\x04") {
    runner(["tmux", "send-keys", "-t", session, "C-d"]);
    return;
  }

  // If text ends with Enter / newline, type the text then press Enter
  if (text.endsWith("\r") || text.endsWith("\n")) {
    const trimmed = text.replace(/[\r\n]+$/, "");
    if (trimmed.length > 0) {
      runner(["tmux", "send-keys", "-t", session, "-l", "--", trimmed]);
    }
    runner(["tmux", "send-keys", "-t", session, "Enter"]);
    return;
  }

  // Literal send
  runner(["tmux", "send-keys", "-t", session, "-l", "--", text]);
}

/**
 * Resolves the path to an agent's pane.log file.
 * @param {string} agentsDir
 * @param {string} agentId
 * @param {ServerOptions} [options]
 * @returns {string}
 */
export function findPaneLogPath(agentsDir, agentId, options = {}) {
  if (typeof options.getPaneLogPath === "function") {
    const custom = options.getPaneLogPath(agentId);
    if (custom) return custom;
  }
  if (options.paneLogs && typeof options.paneLogs[agentId] === "string") {
    return options.paneLogs[agentId];
  }

  const agentDir = path.join(agentsDir, agentId);
  const direct = path.join(agentDir, "pane.log");
  if (fs.existsSync(direct)) return direct;

  const wtDirect = path.join(agentDir, "wt", "pane.log");
  if (fs.existsSync(wtDirect)) return wtDirect;

  return direct;
}

/**
 * Tails a pane log file and pipes chunks to a WebSocket client.
 * @param {string} filePath
 * @param {WebSocket} ws
 * @param {number} [pollIntervalMs=50]
 * @returns {() => void} cleanup function
 */
export function attachPaneTail(filePath, ws, pollIntervalMs = 50) {
  let offset = 0;
  let closed = false;
  /** @type {fs.FSWatcher|null} */
  let watcher = null;

  function readNewBytes() {
    if (closed || ws.readyState !== WebSocket.OPEN) return;
    try {
      if (!fs.existsSync(filePath)) return;
      const stat = fs.statSync(filePath);
      if (stat.size > offset) {
        const stream = fs.createReadStream(filePath, { start: offset, end: stat.size - 1 });
        offset = stat.size;
        stream.on("data", (chunk) => {
          if (!closed && ws.readyState === WebSocket.OPEN) {
            ws.send(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
          }
        });
      } else if (stat.size < offset) {
        // File was truncated
        offset = 0;
        const stream = fs.createReadStream(filePath, { start: 0, end: stat.size - 1 });
        offset = stat.size;
        stream.on("data", (chunk) => {
          if (!closed && ws.readyState === WebSocket.OPEN) {
            ws.send(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
          }
        });
      }

      if (!watcher && fs.existsSync(filePath)) {
        try {
          watcher = fs.watch(filePath, () => readNewBytes());
        } catch {
          // Ignored if platform does not support fs.watch
        }
      }
    } catch {
      // Ignore transient file read errors
    }
  }

  // Initial read of existing bytes
  readNewBytes();

  // Polling fallback ensures updates are caught reliably
  const interval = setInterval(readNewBytes, pollIntervalMs);

  function cleanup() {
    closed = true;
    clearInterval(interval);
    if (watcher) {
      try {
        watcher.close();
      } catch {}
      watcher = null;
    }
  }

  ws.on("close", cleanup);
  ws.on("error", cleanup);

  return cleanup;
}

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
 * Renders the single-page HTML for agents (with xterm.js attach) and queue.
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
              <div class="agent-title-row">
                <span class="agent-id">${escapeHtml(a.id)}</span>
                <span class="agent-status">${escapeHtml(a.status || "bilinmiyor")}</span>
              </div>
              <button class="btn-attach" data-agent-id="${escapeHtml(a.id)}" onclick="toggleTerminal('${escapeHtml(a.id)}')">Bağlan</button>
            </div>
            <div class="agent-role">${escapeHtml(a.role || "-")}</div>
            <div class="agent-last-message">
              <span class="meta-label">Son Mesaj:</span>
              <span class="message-text">${escapeHtml(a.lastMessage || "-")}</span>
            </div>
            <div class="terminal-container" id="terminal-container-${escapeHtml(a.id)}" style="display: none;">
              <div class="terminal-toolbar">
                <span class="terminal-title">Canlı Terminal: <code>${escapeHtml(a.id)}</code></span>
                <div class="terminal-actions">
                  <span class="term-status" id="term-status-${escapeHtml(a.id)}">Bağlantı bekleniyor...</span>
                  <button class="btn-close-term" onclick="closeTerminal('${escapeHtml(a.id)}')">Kapat</button>
                </div>
              </div>
              <div class="xterm-box" id="xterm-${escapeHtml(a.id)}"></div>
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
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.min.css" />
  <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"></script>
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
      align-items: center;
      margin-bottom: 0.5rem;
    }
    .agent-title-row {
      display: flex;
      align-items: baseline;
      gap: 0.5rem;
    }
    .agent-id { font-size: 1.1rem; font-weight: 600; color: var(--accent); }
    .agent-status {
      font-size: 0.8rem;
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.08);
      color: #cbd5e1;
    }
    .btn-attach {
      background: #0284c7;
      color: #ffffff;
      border: 1px solid #0369a1;
      padding: 0.3rem 0.75rem;
      border-radius: 4px;
      font-size: 0.8rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s ease-in-out;
    }
    .btn-attach:hover {
      background: #0369a1;
    }
    .btn-attach:focus {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
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
    .terminal-container {
      margin-top: 0.75rem;
      background: #090d16;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 0.75rem;
      overflow: hidden;
    }
    .terminal-toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 0.5rem;
      margin-bottom: 0.5rem;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      font-size: 0.8rem;
    }
    .terminal-title {
      font-weight: 600;
      color: var(--accent);
    }
    .terminal-actions {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .term-status {
      font-size: 0.75rem;
      color: var(--text-muted);
    }
    .btn-close-term {
      background: #dc2626;
      color: #fff;
      border: none;
      border-radius: 3px;
      padding: 0.15rem 0.45rem;
      font-size: 0.75rem;
      cursor: pointer;
    }
    .btn-close-term:hover {
      background: #b91c1c;
    }
    .xterm-box {
      width: 100%;
      min-height: 200px;
      background: #090d16;
      border-radius: 4px;
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

  <script>
    const activeTerminals = {};

    function toggleTerminal(agentId) {
      const container = document.getElementById("terminal-container-" + agentId);
      const btn = document.querySelector('.btn-attach[data-agent-id="' + agentId + '"]');
      if (!container) return;
      if (container.style.display === "none" || !container.style.display) {
        container.style.display = "block";
        if (btn) btn.textContent = "Bağlantıyı Kes";
        openTerminal(agentId);
      } else {
        closeTerminal(agentId);
      }
    }

    function openTerminal(agentId) {
      if (activeTerminals[agentId]) return;
      const statusEl = document.getElementById("term-status-" + agentId);
      const boxEl = document.getElementById("xterm-" + agentId);
      if (!boxEl) return;
      boxEl.innerHTML = "";

      if (typeof Terminal === "undefined") {
        if (statusEl) {
          statusEl.textContent = "Hata: xterm.js CDN yüklenemedi";
          statusEl.style.color = "#f87171";
        }
        return;
      }

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        theme: {
          background: "#090d16",
          foreground: "#f8fafc"
        }
      });

      term.open(boxEl);

      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = proto + "//" + location.host + "/api/agents/" + encodeURIComponent(agentId) + "/term";
      const ws = new WebSocket(wsUrl);

      activeTerminals[agentId] = { term: term, ws: ws };

      ws.onopen = function () {
        if (statusEl) {
          statusEl.textContent = "Bağlandı";
          statusEl.style.color = "#4ade80";
        }
        term.focus();
      };

      ws.onmessage = function (ev) {
        term.write(ev.data);
      };

      term.onData(function (data) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });

      ws.onerror = function () {
        if (statusEl) {
          statusEl.textContent = "Bağlantı hatası";
          statusEl.style.color = "#f87171";
        }
      };

      ws.onclose = function () {
        if (statusEl) {
          statusEl.textContent = "Bağlantı kapandı";
          statusEl.style.color = "#94a3b8";
        }
        term.write("\\r\\n\\x1b[33m[Bağlantı kapandı]\\x1b[0m\\r\\n");
        delete activeTerminals[agentId];
        const btn = document.querySelector('.btn-attach[data-agent-id="' + agentId + '"]');
        if (btn) btn.textContent = "Bağlan";
      };
    }

    function closeTerminal(agentId) {
      const session = activeTerminals[agentId];
      if (session) {
        if (session.ws) session.ws.close();
        if (session.term) session.term.dispose();
        delete activeTerminals[agentId];
      }
      const container = document.getElementById("terminal-container-" + agentId);
      if (container) container.style.display = "none";
      const btn = document.querySelector('.btn-attach[data-agent-id="' + agentId + '"]');
      if (btn) btn.textContent = "Bağlan";
    }
  </script>
</body>
</html>`;
}

/**
 * Creates the HTTP and WebSocket server instance.
 * @param {ServerOptions} [options]
 * @returns {http.Server}
 */
export function createServer(options = {}) {
  const agentsDir = options.agentsDir ?? findAgentsDir();
  const runner = options.runner ?? options.run ?? spawnRunner;
  const pollIntervalMs = options.tailPollIntervalMs ?? 50;

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

  // WebSocket Server setup
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const parsedUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const termMatch = parsedUrl.pathname.match(/^\/api\/agents\/([A-Za-z0-9_-]+)\/term\/?$/);
    if (!termMatch) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    const agentId = termMatch[1];
    wss.handleUpgrade(req, socket, head, (/** @type {WebSocket} */ ws) => {
      wss.emit("connection", ws, req, agentId);
    });
  });

  wss.on("connection", (/** @type {WebSocket} */ ws, /** @type {http.IncomingMessage} */ _req, /** @type {unknown} */ agentId) => {
    const targetAgentId = typeof agentId === "string" ? agentId : "default";
    const logPath = findPaneLogPath(agentsDir, targetAgentId, options);
    const session = options.sessionName ? options.sessionName(targetAgentId) : sessionName(targetAgentId);

    // Stream pane log tail
    attachPaneTail(logPath, ws, pollIntervalMs);

    // Relay incoming keys via send-keys
    ws.on("message", (/** @type {any} */ data) => {
      try {
        sendTmuxKeys(session, data, runner);
      } catch {
        // Runner failure (e.g. session not found) should not crash the server
      }
    });
  });

  /** @type {any} */ (server).wss = wss;

  server.on("close", () => {
    for (const client of wss.clients) {
      try {
        client.terminate();
      } catch {}
    }
    wss.close();
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
          /** @type {any} */
          const wss = /** @type {any} */ (server).wss;
          if (wss) {
            for (const client of wss.clients) {
              try {
                client.terminate();
              } catch {}
            }
            wss.close(() => {
              server.close((err) => (err ? rej(err) : res()));
            });
          } else {
            server.close((err) => (err ? rej(err) : res()));
          }
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
