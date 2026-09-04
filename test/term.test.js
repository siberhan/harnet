import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { WebSocket } from "ws";
import {
  start,
  createServer,
  sendTmuxKeys,
  sessionName,
  findPaneLogPath,
  renderHtml,
  spawnRunner,
} from "../src/panel/server.js";

/**
 * Helper to wait for a WebSocket client to open.
 * @param {WebSocket} ws
 * @returns {Promise<void>}
 */
function waitForOpen(ws) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

/**
 * Helper to collect messages from a WebSocket until a condition is met or timeout.
 * @param {WebSocket} ws
 * @param {(received: string) => boolean} condition
 * @param {number} [timeoutMs=3000]
 * @returns {Promise<string>}
 */
function waitForMessage(ws, condition, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let accumulated = "";
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for condition. Accumulated: "${accumulated}"`));
    }, timeoutMs);

    function onMessage(/** @type {any} */ data) {
      accumulated += data.toString("utf8");
      if (condition(accumulated)) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(accumulated);
      }
    }

    ws.on("message", onMessage);
  });
}

describe("panel terminal: helpers & command parsing", () => {
  it("sessionName generates harnet-<id>", () => {
    assert.equal(sessionName("agent-1"), "harnet-agent-1");
    assert.equal(sessionName("bot"), "harnet-bot");
  });

  it("findPaneLogPath finds pane.log in agent directory or options override", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harnet-pane-test-"));
    try {
      const agentDir = path.join(tmp, "bot-a");
      fs.mkdirSync(agentDir);
      const logFile = path.join(agentDir, "pane.log");
      fs.writeFileSync(logFile, "pane output\n");

      const resolved = findPaneLogPath(tmp, "bot-a");
      assert.equal(resolved, logFile);

      // Options override
      const customPath = path.join(tmp, "custom.log");
      const fromOptions = findPaneLogPath(tmp, "bot-a", { paneLogs: { "bot-a": customPath } });
      assert.equal(fromOptions, customPath);

      // Function override
      const fromFn = findPaneLogPath(tmp, "bot-a", { getPaneLogPath: (id) => `/custom/${id}.log` });
      assert.equal(fromFn, "/custom/bot-a.log");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("sendTmuxKeys translates single characters, special keys, and newlines", () => {
    /** @type {string[][]} */
    const calls = [];
    /** @type {import("../src/panel/server.js").CommandRunner} */
    const fakeRunner = (argv) => {
      calls.push(argv);
      return { status: 0, stdout: "", stderr: "" };
    };

    // Literal string
    sendTmuxKeys("harnet-a1", "hello", fakeRunner);
    assert.deepEqual(calls[0], ["tmux", "send-keys", "-t", "harnet-a1", "-l", "--", "hello"]);

    // Enter / newline
    sendTmuxKeys("harnet-a1", "\r", fakeRunner);
    assert.deepEqual(calls[1], ["tmux", "send-keys", "-t", "harnet-a1", "Enter"]);

    sendTmuxKeys("harnet-a1", "\n", fakeRunner);
    assert.deepEqual(calls[2], ["tmux", "send-keys", "-t", "harnet-a1", "Enter"]);

    // Backspace
    sendTmuxKeys("harnet-a1", "\x7f", fakeRunner);
    assert.deepEqual(calls[3], ["tmux", "send-keys", "-t", "harnet-a1", "BSpace"]);

    // Arrow keys
    sendTmuxKeys("harnet-a1", "\x1b[A", fakeRunner);
    assert.deepEqual(calls[4], ["tmux", "send-keys", "-t", "harnet-a1", "Up"]);

    sendTmuxKeys("harnet-a1", "\x1b[B", fakeRunner);
    assert.deepEqual(calls[5], ["tmux", "send-keys", "-t", "harnet-a1", "Down"]);

    // Control codes
    sendTmuxKeys("harnet-a1", "\x03", fakeRunner);
    assert.deepEqual(calls[6], ["tmux", "send-keys", "-t", "harnet-a1", "C-c"]);

    // String ending with newline
    sendTmuxKeys("harnet-a1", "ls -la\n", fakeRunner);
    assert.deepEqual(calls[7], ["tmux", "send-keys", "-t", "harnet-a1", "-l", "--", "ls -la"]);
    assert.deepEqual(calls[8], ["tmux", "send-keys", "-t", "harnet-a1", "Enter"]);

    // Structured JSON
    sendTmuxKeys("harnet-a1", JSON.stringify({ keys: "clear" }), fakeRunner);
    assert.deepEqual(calls[9], ["tmux", "send-keys", "-t", "harnet-a1", "-l", "--", "clear"]);

    // Structured JSON with raw args
    sendTmuxKeys("harnet-a1", JSON.stringify({ args: ["PageUp"] }), fakeRunner);
    assert.deepEqual(calls[10], ["tmux", "send-keys", "-t", "harnet-a1", "PageUp"]);
  });

  it("sendTmuxKeys handles null or empty input gracefully", () => {
    /** @type {string[][]} */
    const calls = [];
    /** @type {import("../src/panel/server.js").CommandRunner} */
    const fakeRunner = (argv) => {
      calls.push(argv);
      return { status: 0, stdout: "", stderr: "" };
    };

    sendTmuxKeys("harnet-a1", "", fakeRunner);
    sendTmuxKeys("harnet-a1", null, fakeRunner);
    sendTmuxKeys("harnet-a1", undefined, fakeRunner);
    assert.equal(calls.length, 0);
  });

  it("spawnRunner handles empty command and process execution", () => {
    const resEmpty = spawnRunner([]);
    assert.equal(resEmpty.status, 1);
    assert.equal(resEmpty.stderr, "empty command");

    const res = spawnRunner(["node", "-e", "console.log('runner ok')"]);
    assert.equal(res.status, 0);
    assert.ok(res.stdout.includes("runner ok"));
  });
});

describe("panel terminal: HTML rendering with xterm.js CDN and connect button", () => {
  it("renders xterm.js CDN links in <head>", () => {
    const html = renderHtml([], []);
    assert.ok(html.includes("xterm.min.css"));
    assert.ok(html.includes("xterm.min.js"));
    assert.ok(html.includes("https://cdn.jsdelivr.net/npm/xterm"));
  });

  it("renders 'Bağlan' button and terminal container for each agent", () => {
    const agents = [
      { id: "agent-alpha", role: "developer", status: "idle", lastMessage: "Ready" },
      { id: "agent-beta", role: "tester", status: "busy", lastMessage: "Testing" },
    ];
    const html = renderHtml(agents, []);
    assert.ok(html.includes("Bağlan"));
    assert.ok(html.includes('data-agent-id="agent-alpha"'));
    assert.ok(html.includes('data-agent-id="agent-beta"'));
    assert.ok(html.includes('id="terminal-container-agent-alpha"'));
    assert.ok(html.includes('id="terminal-container-agent-beta"'));
    assert.ok(html.includes('id="xterm-agent-alpha"'));
    assert.ok(html.includes("toggleTerminal('agent-alpha')"));
  });
});

describe("panel terminal: WebSocket live attach on real port", () => {
  it("establishes WebSocket handshake and streams existing pane.log content", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harnet-ws-test-"));
    const agentDir = path.join(tmp, "worker");
    fs.mkdirSync(agentDir);
    const logPath = path.join(agentDir, "pane.log");
    fs.writeFileSync(logPath, "Initial agent TUI banner\nWelcome to Harnet session\n");

    const { port, close } = await start({
      port: 0,
      agentsDir: tmp,
      tailPollIntervalMs: 20,
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/agents/worker/term`);

    try {
      await waitForOpen(ws);
      assert.equal(ws.readyState, WebSocket.OPEN);

      const received = await waitForMessage(ws, (acc) =>
        acc.includes("Initial agent TUI banner") && acc.includes("Welcome to Harnet session")
      );
      assert.ok(received.includes("Initial agent TUI banner"));
    } finally {
      ws.close();
      await close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("streams live appended bytes in real time", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harnet-ws-append-"));
    const agentDir = path.join(tmp, "streamer");
    fs.mkdirSync(agentDir);
    const logPath = path.join(agentDir, "pane.log");
    fs.writeFileSync(logPath, "line 1\n");

    const { port, close } = await start({
      port: 0,
      agentsDir: tmp,
      tailPollIntervalMs: 20,
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/agents/streamer/term`);

    try {
      await waitForOpen(ws);
      await waitForMessage(ws, (acc) => acc.includes("line 1"));

      // Append new bytes while connected
      fs.appendFileSync(logPath, "line 2 appended live\n");

      const streamResult = await waitForMessage(ws, (acc) => acc.includes("line 2 appended live"));
      assert.ok(streamResult.includes("line 2 appended live"));
    } finally {
      ws.close();
      await close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("relays incoming keystrokes via send-keys using injected runner", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harnet-ws-keys-"));
    const agentDir = path.join(tmp, "actor");
    fs.mkdirSync(agentDir);
    fs.writeFileSync(path.join(agentDir, "pane.log"), "ready for input\n");

    /** @type {string[][]} */
    const executedCommands = [];
    /** @type {import("../src/panel/server.js").CommandRunner} */
    const testRunner = (argv) => {
      executedCommands.push(argv);
      return { status: 0, stdout: "", stderr: "" };
    };

    const { port, close } = await start({
      port: 0,
      agentsDir: tmp,
      runner: testRunner,
      tailPollIntervalMs: 20,
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/agents/actor/term`);

    try {
      await waitForOpen(ws);
      await waitForMessage(ws, (acc) => acc.includes("ready for input"));

      // Send keystrokes over WebSocket
      ws.send("npm test\r");

      // Wait a short moment for message processing
      await new Promise((r) => setTimeout(r, 80));

      assert.ok(executedCommands.length >= 2);
      assert.deepEqual(executedCommands[0], [
        "tmux",
        "send-keys",
        "-t",
        "harnet-actor",
        "-l",
        "--",
        "npm test",
      ]);
      assert.deepEqual(executedCommands[1], [
        "tmux",
        "send-keys",
        "-t",
        "harnet-actor",
        "Enter",
      ]);

      // Send special key
      ws.send("\x03"); // Ctrl-C
      await new Promise((r) => setTimeout(r, 80));

      const lastCmd = executedCommands[executedCommands.length - 1];
      assert.deepEqual(lastCmd, ["tmux", "send-keys", "-t", "harnet-actor", "C-c"]);
    } finally {
      ws.close();
      await close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("handles log created after connection starts", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harnet-ws-delayed-"));
    const agentDir = path.join(tmp, "late-agent");
    fs.mkdirSync(agentDir);
    const logPath = path.join(agentDir, "pane.log");
    // Do not create pane.log yet

    const { port, close } = await start({
      port: 0,
      agentsDir: tmp,
      tailPollIntervalMs: 20,
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/agents/late-agent/term`);

    try {
      await waitForOpen(ws);

      // Now create and populate the log
      await new Promise((r) => setTimeout(r, 50));
      fs.writeFileSync(logPath, "delayed terminal output\n");

      const received = await waitForMessage(ws, (acc) => acc.includes("delayed terminal output"));
      assert.ok(received.includes("delayed terminal output"));
    } finally {
      ws.close();
      await close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects upgrade requests to invalid or unknown WebSocket paths", async () => {
    const { port, close } = await start({ port: 0 });

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/unknown/route`);
      await new Promise((resolve) => {
        ws.on("error", () => {
          resolve(null);
        });
        ws.on("open", () => {
          assert.fail("Should not open on invalid route");
        });
      });
    } finally {
      await close();
    }
  });

  it("survives runner throwing error without disconnecting or crashing", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harnet-ws-error-"));
    const agentDir = path.join(tmp, "err-agent");
    fs.mkdirSync(agentDir);
    fs.writeFileSync(path.join(agentDir, "pane.log"), "banner\n");

    const { port, close } = await start({
      port: 0,
      agentsDir: tmp,
      runner: () => {
        throw new Error("tmux server not running");
      },
      tailPollIntervalMs: 20,
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/agents/err-agent/term`);

    try {
      await waitForOpen(ws);
      await waitForMessage(ws, (acc) => acc.includes("banner"));

      // Sending keys triggers runner error internally, which is caught safely
      ws.send("test input");
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(ws.readyState, WebSocket.OPEN);
    } finally {
      ws.close();
      await close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
