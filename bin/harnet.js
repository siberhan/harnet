#!/usr/bin/env node

/**
 * Harnet CLI.
 * README: Kontrol Paneli & Durum Göstergesi.
 *
 * Usage:
 *   node bin/harnet.js status
 *
 * Reads STATE.md and .harnet/agents/*\/MEMORY.md (read-only) and outputs
 * a formatted status table with columns: Ajan, Durum, Açık İş.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupControlService } from "../src/service/control.js";
import { parseTranscript } from "../src/observe/transcript.js";
import { start as startPanel } from "../src/panel/server.js";

/**
 * @typedef {object} AgentMemory
 * @property {string} id
 * @property {string} role
 * @property {string} status
 */

/**
 * @typedef {object} OpenJob
 * @property {string} id
 * @property {string|null} agentHint
 * @property {string} description
 */

/**
 * @typedef {object} StateData
 * @property {OpenJob[]} openJobs
 * @property {Map<string, string>} board
 */

/**
 * @typedef {object} AgentStatusRow
 * @property {string} agent
 * @property {string} status
 * @property {string} openJob
 */

/**
 * @typedef {object} RootResolution
 * @property {string} root
 * @property {string} stateFile
 * @property {string} agentsDir
 */

/**
 * Resolves repository root, STATE.md file, and agents directory.
 * @param {string} [baseDir]
 * @returns {RootResolution}
 */
export function resolvePaths(baseDir = process.cwd()) {
  if (process.env.HARNET_ROOT) {
    const root = path.resolve(process.env.HARNET_ROOT);
    return {
      root,
      stateFile: path.join(root, "STATE.md"),
      agentsDir: path.join(root, ".harnet", "agents"),
    };
  }

  // 1. If cwd is inside .harnet/agents/<id>/wt, check parent repo root first
  const parentRoot = path.resolve(baseDir, "..", "..", "..");
  if (
    fs.existsSync(path.join(parentRoot, "STATE.md")) &&
    fs.existsSync(path.join(parentRoot, ".harnet", "agents"))
  ) {
    return {
      root: parentRoot,
      stateFile: path.join(parentRoot, "STATE.md"),
      agentsDir: path.join(parentRoot, ".harnet", "agents"),
    };
  }

  // 2. Local check in baseDir
  if (
    fs.existsSync(path.join(baseDir, "STATE.md")) ||
    fs.existsSync(path.join(baseDir, ".harnet", "agents"))
  ) {
    return {
      root: baseDir,
      stateFile: path.join(baseDir, "STATE.md"),
      agentsDir: path.join(baseDir, ".harnet", "agents"),
    };
  }

  // 3. Search upwards
  let curr = path.resolve(baseDir);
  while (true) {
    if (
      fs.existsSync(path.join(curr, "STATE.md")) ||
      fs.existsSync(path.join(curr, ".harnet", "agents"))
    ) {
      return {
        root: curr,
        stateFile: path.join(curr, "STATE.md"),
        agentsDir: path.join(curr, ".harnet", "agents"),
      };
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }

  return {
    root: baseDir,
    stateFile: path.join(baseDir, "STATE.md"),
    agentsDir: path.join(baseDir, ".harnet", "agents"),
  };
}

/**
 * Parses STATE.md content to extract open jobs and board status.
 * @param {string} content
 * @returns {StateData}
 */
export function parseState(content) {
  /** @type {OpenJob[]} */
  const openJobs = [];
  /** @type {Map<string, string>} */
  const board = new Map();

  const lines = content.split(/\r?\n/);
  let section = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("## ")) {
      section = trimmed.slice(3).toLowerCase();
      continue;
    }

    if (section.startsWith("jobs") && trimmed.startsWith("- open:")) {
      const rest = trimmed.slice("- open:".length).trim();
      const match = rest.match(/^([^\s(]+)(?:\s*\(([^)]+)\))?\s*(?:-\s*(.*))?$/);
      if (match) {
        openJobs.push({
          id: match[1],
          agentHint: match[2] ?? null,
          description: match[3] ?? "",
        });
      } else {
        const id = rest.split(/\s+/)[0];
        openJobs.push({ id, agentHint: null, description: rest });
      }
    } else if (section.startsWith("board") && trimmed.startsWith("- ")) {
      const match = trimmed.slice(2).match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (match) {
        board.set(match[1], match[2].trim());
      }
    }
  }

  return { openJobs, board };
}

/**
 * Parses a single MEMORY.md content.
 * @param {string} content
 * @param {string} fallbackId
 * @returns {AgentMemory}
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
 * Reads memory files for all agents in agentsDir.
 * @param {string} agentsDir
 * @returns {AgentMemory[]}
 */
export function readAgents(agentsDir) {
  if (!fs.existsSync(agentsDir)) {
    return [];
  }
  const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  /** @type {AgentMemory[]} */
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
 * Matches an open job to an agent id.
 * @param {OpenJob} job
 * @param {string} agentId
 * @param {string[]} allAgentIds
 * @returns {boolean}
 */
function jobMatchesAgent(job, agentId, allAgentIds) {
  const hint = (job.agentHint ?? "").toLowerCase();

  // Direct match in hint
  if (hint && (hint === agentId.toLowerCase() || hint.includes(agentId.toLowerCase()))) {
    return true;
  }

  // Alias checks
  if (agentId === "antigravity-2" && (hint.includes("lane 2") || hint.includes("agy lane 2") || hint.includes("antigravity-2"))) {
    return true;
  }
  if (agentId === "antigravity" && (hint === "agy" || hint.includes("lane 1") || hint.includes("agy lane 1"))) {
    return true;
  }
  if (agentId === "chatgpt" && (hint === "gpt" || hint.includes("chatgpt"))) {
    return true;
  }
  if (agentId === "workbuddy" && (hint === "wb" || hint.includes("workbuddy"))) {
    return true;
  }
  if (agentId === "claude" && hint.includes("claude")) {
    return true;
  }
  if (agentId === "opencode" && hint.includes("opencode")) {
    return true;
  }

  // Exact or prefix match by job id (sorting longer agent ids first)
  const sortedIds = [...allAgentIds].sort((a, b) => b.length - a.length);
  for (const cand of sortedIds) {
    if (job.id.startsWith(cand + "-") || job.id === cand) {
      return cand === agentId;
    }
  }

  return false;
}

/**
 * Extracts a concise status string from board and memory states.
 * @param {string|undefined} boardStatus
 * @param {string|undefined} memoryStatus
 * @param {string} openJob
 * @returns {string}
 */
function resolveStatus(boardStatus, memoryStatus, openJob) {
  if (boardStatus) {
    const b = boardStatus.trim();
    if (/^blocked\b/i.test(b) || /\bblocked\b/i.test(b)) return "BLOCKED";
    if (/^busy\b/i.test(b) || /\bbusy\b/i.test(b)) return "busy";
    if (/^review\b/i.test(b) || /\breview\b/i.test(b)) return "review";
    if (/^idle\b/i.test(b) || /\bidle\b/i.test(b)) return "idle";
    if (b.length <= 25) return b;
  }
  if (openJob !== "-") return "busy";
  if (memoryStatus) {
    const m = memoryStatus.trim();
    const firstPart = m.split(/[,.\n]/)[0].trim();
    return firstPart || m;
  }
  return "idle";
}

/**
 * Correlates agents, state, and memory into table rows.
 * @param {AgentMemory[]} agents
 * @param {StateData} state
 * @returns {AgentStatusRow[]}
 */
export function getStatusRows(agents, state) {
  /** @type {Set<string>} */
  const allIds = new Set(agents.map((a) => a.id));
  for (const agent of state.board.keys()) {
    allIds.add(agent);
  }

  const sortedIds = Array.from(allIds).sort((a, b) => a.localeCompare(b));
  /** @type {AgentStatusRow[]} */
  const rows = [];

  for (const id of sortedIds) {
    const mem = agents.find((a) => a.id === id);
    const boardStatus = state.board.get(id);

    // Find any open job matching this agent
    const matchingJobs = state.openJobs.filter((j) => jobMatchesAgent(j, id, sortedIds));
    const openJob = matchingJobs.length > 0 ? matchingJobs.map((j) => j.id).join(", ") : "-";

    const status = resolveStatus(boardStatus, mem?.status, openJob);
    rows.push({
      agent: id,
      status,
      openJob,
    });
  }

  return rows;
}

/**
 * Formats data rows into a Unicode box-drawing table.
 * @param {string[]} headers
 * @param {string[][]} rows
 * @returns {string}
 */
export function formatTable(headers, rows) {
  if (rows.length === 0) {
    return "Hiç ajan bulunamadı.";
  }

  const colWidths = headers.map((h, i) => {
    let max = h.length;
    for (const r of rows) {
      const len = (r[i] ?? "").length;
      if (len > max) max = len;
    }
    return max;
  });

  const sepTop = "┌" + colWidths.map((w) => "─".repeat(w + 2)).join("┬") + "┐";
  const headerRow = "│ " + headers.map((h, i) => h.padEnd(colWidths[i])).join(" │ ") + " │";
  const sepMid = "├" + colWidths.map((w) => "─".repeat(w + 2)).join("┼") + "┤";
  const bodyRows = rows.map(
    (r) => "│ " + r.map((cell, i) => (cell ?? "").padEnd(colWidths[i])).join(" │ ") + " │"
  );
  const sepBottom = "└" + colWidths.map((w) => "─".repeat(w + 2)).join("┴") + "┘";

  return [sepTop, headerRow, sepMid, ...bodyRows, sepBottom].join("\n");
}

/**
 * Loads data from disk and builds the formatted status table string.
 * @param {{ root?: string }} [options]
 * @returns {string}
 */
export function buildStatusTable(options = {}) {
  const paths = resolvePaths(options.root);
  const stateContent = fs.existsSync(paths.stateFile)
    ? fs.readFileSync(paths.stateFile, "utf8")
    : "";
  const stateData = parseState(stateContent);
  const agents = readAgents(paths.agentsDir);
  const rows = getStatusRows(agents, stateData);

  const headers = ["Ajan", "Durum", "Açık İş"];
  const tableData = rows.map((r) => [r.agent, r.status, r.openJob]);

  return formatTable(headers, tableData);
}

/**
 * Starts the control service and panel server.
 *
 * @param {object} [options]
 * @param {string} [options.root]
 * @param {string} [options.agentsDir]
 * @param {string} [options.storePath]
 * @param {number} [options.port]
 * @param {string} [options.host]
 * @param {import("../src/service/control.js").AdapterRegistry} [options.adapters]
 * @param {(text: string) => import("../src/service/report.js").ParsedTranscript} [options.parse]
 * @returns {Promise<{
 *   service: ReturnType<typeof import("../src/service/control.js").createControlService>,
 *   queue: import("../src/service/store.js").QueueLike,
 *   store: import("../src/service/store.js").JobStore,
 *   groups: any,
 *   reportReader: (ctx: { transcriptPath: string|null, agentId?: string, payload?: unknown }) => string|null,
 *   panel: { server: import("node:http").Server, port: number, close: () => Promise<void> },
 *   stop: () => Promise<void>
 * }>}
 */
export async function startUp(options = {}) {
  const paths = resolvePaths(options.root);
  const root = paths.root;
  const agentsDir = options.agentsDir ?? paths.agentsDir;
  const storePath = options.storePath ?? path.join(root, ".harnet", "state", "jobs.json");
  const port = options.port ?? (process.env.PORT ? parseInt(process.env.PORT, 10) : 3000);
  const host = options.host ?? (process.env.HOST ?? "127.0.0.1");

  // 1. Setup control service: queue + store (loads from file) + report reader + groups + service
  const serviceContext = setupControlService({
    rootDir: root,
    storePath,
    parse: options.parse ?? parseTranscript,
    adapters: options.adapters ?? {},
  });

  // 2. Start panel server
  const panel = await startPanel({
    port,
    host,
    agentsDir,
    queue: () => serviceContext.queue.all(),
  });

  // 3. Clean shutdown helper
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (serviceContext.store && typeof serviceContext.store.save === "function") {
      serviceContext.store.save(serviceContext.queue.all());
    }
    await panel.close();
  };

  return {
    ...serviceContext,
    panel,
    stop,
  };
}

/**
 * Main CLI dispatcher.
 * @param {string[]} argv
 * @returns {Promise<number>|number} exit code
 */
export function run(argv = process.argv.slice(2)) {
  const command = argv[0];

  if (command === "status") {
    const table = buildStatusTable();
    console.log(table);
    return 0;
  }

  if (command === "up") {
    let port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
    for (let i = 1; i < argv.length; i++) {
      if ((argv[i] === "--port" || argv[i] === "-p") && argv[i + 1]) {
        port = parseInt(argv[i + 1], 10);
        i++;
      }
    }

    return startUp({ port }).then((daemon) => {
      console.log(`[harnet] Control service and panel started on http://127.0.0.1:${daemon.panel.port}`);
      console.log("[harnet] Press Ctrl-C to shut down.");

      /** @type {(signal: string) => Promise<void>} */
      const cleanup = async (signal) => {
        console.log(`\n[harnet] Caught ${signal}. Shutting down... Saving store.`);
        await daemon.stop();
        console.log("[harnet] Store saved. Exiting.");
        process.exit(0);
      };

      process.once("SIGINT", () => cleanup("SIGINT"));
      process.once("SIGTERM", () => cleanup("SIGTERM"));

      return new Promise(() => {});
    });
  }

  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log("Kullanım: node bin/harnet.js <komut>\n");
    console.log("Komutlar:");
    console.log("  status    Ajanların durumunu ve açık işlerini gösterir");
    console.log("  up        Kontrol servisi ve paneli başlatır");
    return 0;
  }

  console.error(`Bilinmeyen komut: ${command}`);
  console.error("Kullanım: node bin/harnet.js status");
  return 1;
}

// Direct execution entry
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  Promise.resolve(run())
    .then((code) => {
      if (typeof code === "number" && code !== 0) {
        process.exit(code);
      }
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
