/**
 * Ground truth from the live spike (scripts/live-spike.sh).
 *
 * Every other adapter test uses payloads we invented. These four fixtures were
 * captured from real runs on 2026-09-04 - a real `claude` 2.1.260 Stop hook, a
 * real `codex-cli` 0.153.0 notify program, and both harnesses' own jsonl - so
 * the shapes the code assumes can be checked against the shapes that actually
 * arrive.
 *
 * Two of these started as characterization tests pinning a mismatch: real codex
 * notify keys are hyphenated, and a real codex rollout nests everything under
 * `.payload`, so neither the adapter nor the reader could see a completed turn.
 * Both are fixed now (claude-codexfix-1) and the assertions are inverted, which
 * is exactly the handover the characterization was for.
 *
 * The spike script itself never runs here. It opens real TUI sessions and
 * spends tokens; `npm test` only reads what it left behind.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createClaudeAdapter } from "../src/adapters/claude.js";
import { createCodexAdapter, CODEX } from "../src/adapters/codex.js";
import { readTranscript } from "../src/observe/transcript.js";

const here = dirname(fileURLToPath(import.meta.url));

/** @param {string} name @returns {string} */
const fixture = (name) => join(here, "fixtures", name);

/** @param {string} name @returns {any} */
const readJson = (name) => JSON.parse(readFileSync(fixture(name), "utf8"));

/**
 * Minimal stand-in for src/service/queue.js (MAP.js bans the import).
 * @param {string} agent
 * @param {string} jobId
 */
function fakeQueue(agent, jobId) {
  /** @type {Array<{ jobId: string, status: string, report?: string|null, at?: number }>} */
  const completed = [];
  return {
    completed,
    /** @param {string} a */
    runningJob: (a) => (a === agent ? { id: jobId } : null),
    /** @param {{ jobId: string, status: string, report?: string|null, at?: number }} spec */
    complete: (spec) => completed.push(spec),
    markCrashed: () => {},
  };
}

const noRun = () => ({ status: 0, stdout: "", stderr: "" });

test("live claude Stop payload completes the running job", () => {
  const payload = readJson("live-claude-stop.json");
  const queue = fakeQueue("claude", "job-1");
  const adapter = createClaudeAdapter({
    run: noRun,
    queue,
    now: () => 1000,
    readReport: (ctx) => /** @type {any} */ (ctx.payload).last_assistant_message ?? null,
  });

  adapter.bind({ agentId: "claude", sessionId: payload.session_id });
  const result = adapter.handleStop(payload);

  assert.equal(result.matched, true);
  assert.equal(result.agentId, "claude");
  assert.equal(result.jobId, "job-1");
  assert.equal(result.status, "done");
  assert.equal(result.report, "HARNET-SPIKE-CLAUDE-OK");
  assert.deepEqual(queue.completed, [
    { jobId: "job-1", status: "done", report: "HARNET-SPIKE-CLAUDE-OK", at: 1000 },
  ]);
});

test("live claude Stop payload carries the keys the adapter reads", () => {
  const payload = readJson("live-claude-stop.json");
  assert.equal(payload.hook_event_name, "Stop");
  assert.equal(typeof payload.session_id, "string");
  assert.equal(typeof payload.transcript_path, "string");
  assert.equal(payload.last_assistant_message, "HARNET-SPIKE-CLAUDE-OK");
});

test("live claude transcript parses into messages and usage", async () => {
  const summary = await readTranscript(fixture("live-claude-transcript.jsonl"));

  assert.equal(summary.lines, summary.parsed + summary.skipped);
  assert.equal(summary.skipped, 0);
  assert.equal(summary.lastMessage, "HARNET-SPIKE-CLAUDE-OK");
  assert.deepEqual(
    summary.messages.map((m) => m.role),
    ["user", "assistant"],
  );
  assert.equal(summary.usage.output > 0, true);
  assert.equal(summary.usage.total, summary.usage.input + summary.usage.output +
    summary.usage.cacheWrite + summary.usage.cacheRead);
  assert.equal("cost" in summary, false);
});

test("live codex notify says agent-turn-complete but hyphenates its keys", () => {
  const payload = readJson("live-codex-notify.json");

  // The type matches what the adapter waits for...
  assert.equal(payload.type, CODEX.turnCompleteType);
  // ...but the identifiers do not. Real codex writes `thread-id` and
  // `last-assistant-message`; src/adapters/codex.js reads `thread_id` and
  // `last_assistant_message`, so neither is found.
  assert.equal(payload["thread-id"], "01a06d0c-f4f1-7ec1-8b74-9b455f57d909");
  assert.equal(payload["last-assistant-message"], "HARNET-SPIKE-CODEX-OK");
  assert.equal(payload.thread_id, undefined);
  assert.equal(payload.last_assistant_message, undefined);
});

test("codex adapter completes the job from the live notify payload", () => {
  const payload = readJson("live-codex-notify.json");
  const queue = fakeQueue("codex", "job-2");
  const adapter = createCodexAdapter({ run: noRun, queue, now: () => 2000 });

  // Bound with the id codex actually sent, and handed the payload exactly as
  // the notify program wrote it - hyphens and all. No caller-side massaging.
  adapter.bind({ agentId: "codex", sessionId: payload["thread-id"] });
  const result = adapter.handleNotify(payload);

  assert.equal(result.matched, true);
  assert.equal(result.agentId, "codex");
  assert.equal(result.jobId, "job-2");
  assert.equal(result.status, "done");
  assert.equal(result.report, "HARNET-SPIKE-CODEX-OK");
  assert.deepEqual(queue.completed, [
    { jobId: "job-2", status: "done", report: "HARNET-SPIKE-CODEX-OK", at: 2000 },
  ]);
});

test("codex adapter still matches an already snake_case notify payload", () => {
  const raw = readJson("live-codex-notify.json");
  // An older codex build, or anything that normalised before us.
  const payload = {
    type: raw.type,
    thread_id: raw["thread-id"],
    last_assistant_message: raw["last-assistant-message"],
  };
  const queue = fakeQueue("codex", "job-2");
  const adapter = createCodexAdapter({ run: noRun, queue, now: () => 2000 });

  adapter.bind({ agentId: "codex", sessionId: payload.thread_id });
  const result = adapter.handleNotify(payload);

  assert.equal(result.matched, true);
  assert.equal(result.jobId, "job-2");
  assert.equal(result.report, "HARNET-SPIKE-CODEX-OK");
});

test("live codex rollout parses into messages and usage", async () => {
  const summary = await readTranscript(fixture("live-codex-rollout.jsonl"));

  assert.equal(summary.lines, 5);
  assert.equal(summary.parsed, 5);
  assert.equal(summary.skipped, 0);

  assert.equal(summary.sessionId, "01a06d0c-f4f1-7ec1-8b74-9b455f57d909");
  assert.equal(summary.lastMessage, "HARNET-SPIKE-CODEX-OK");
  assert.deepEqual(
    summary.messages.map((m) => m.role),
    ["user", "assistant"],
  );
  // task_complete repeats the assistant answer; it must not become a third
  // message, only refresh lastMessage.
  assert.equal(summary.messages.filter((m) => m.role === "assistant").length, 1);

  // Real numbers from the captured run: prompt 16933 of which 11776 cached,
  // 15 output. The cached share is not counted twice, so the total is codex's
  // own total_tokens.
  assert.deepEqual(summary.usage, {
    input: 5157,
    output: 15,
    cacheWrite: 0,
    cacheRead: 11776,
    total: 16948,
  });
  assert.equal("cost" in summary, false);
});

test("codex rollout does hold the message and usage, one level down", () => {
  const lines = readFileSync(fixture("live-codex-rollout.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

  const assistant = lines.find(
    (l) => l.type === "response_item" && l.payload.role === "assistant",
  );
  assert.equal(assistant.payload.content[0].text, "HARNET-SPIKE-CODEX-OK");

  const done = lines.find(
    (l) => l.type === "event_msg" && l.payload.type === "task_complete",
  );
  assert.equal(done.payload.last_agent_message, "HARNET-SPIKE-CODEX-OK");

  const usage = lines.find((l) => l.type === "token_usage_record");
  assert.equal(typeof usage.payload.thread_id, "string");
});
