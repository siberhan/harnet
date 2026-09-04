/**
 * Unit cover for the two codex shape fixes (claude-codexfix-1).
 *
 * test/live-signals.test.js proves the fixes against the real captured
 * payloads. This file covers the edges a single live run could not show:
 * mixed key spellings, the cumulative-counter trap in a rollout, and the
 * boundary that decides whether a line is codex-shaped or Claude-shaped.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeNotify, isApprovalRequest, CODEX } from "../src/adapters/codex.js";
import { parseLine, parseTranscript, readCodexUsage } from "../src/observe/transcript.js";

// ------------------------------------------------------------------ notify --

test("normalizeNotify maps every hyphenated key codex was seen to send", () => {
  const out = normalizeNotify({
    type: "agent-turn-complete",
    "thread-id": "t1",
    "turn-id": "u1",
    "session-id": "s1",
    "last-assistant-message": "done",
    "input-messages": ["hi"],
  });

  assert.deepEqual(out, {
    type: "agent-turn-complete",
    thread_id: "t1",
    turn_id: "u1",
    session_id: "s1",
    last_assistant_message: "done",
    input_messages: ["hi"],
  });
});

test("normalizeNotify passes unknown keys through untouched", () => {
  const out = normalizeNotify({ client: "codex-tui", cwd: "/tmp", "some-new-key": 1 });
  assert.equal(out.client, "codex-tui");
  assert.equal(out.cwd, "/tmp");
  // Not in the alias table: kept as-is rather than guessed at.
  assert.equal(/** @type {any} */ (out)["some-new-key"], 1);
});

test("normalizeNotify lets the canonical key win over the hyphenated one", () => {
  // A build that sends both must not have its snake_case value overwritten.
  const out = normalizeNotify({ thread_id: "canonical", "thread-id": "alias" });
  assert.equal(out.thread_id, "canonical");
});

test("normalizeNotify survives junk instead of a record", () => {
  assert.deepEqual(normalizeNotify(/** @type {any} */ (null)), {});
  assert.deepEqual(normalizeNotify(/** @type {any} */ ("nope")), {});
  assert.deepEqual(normalizeNotify(/** @type {any} */ ([1, 2])), {});
});

test("isApprovalRequest reads a raw payload too", () => {
  assert.equal(isApprovalRequest({ type: CODEX.approvalType }), true);
  assert.equal(isApprovalRequest({ approval: true }), true);
  assert.equal(isApprovalRequest({ type: CODEX.turnCompleteType }), false);
});

// ----------------------------------------------------------------- usage ----

test("readCodexUsage subtracts the cached share out of the prompt", () => {
  // Codex input_tokens contains cached_input_tokens; Claude's does not. If the
  // two were simply mapped across, the cache would be counted twice.
  const usage = readCodexUsage({
    input_tokens: 1000,
    cached_input_tokens: 400,
    cache_write_input_tokens: 50,
    output_tokens: 20,
    reasoning_output_tokens: 8,
    total_tokens: 1020,
  });

  assert.deepEqual(usage, {
    input: 600,
    output: 20,
    cacheWrite: 50,
    cacheRead: 400,
    total: 1070,
  });
  // reasoning_output_tokens is already inside output_tokens - not added again.
  assert.equal(usage?.output, 20);
});

test("readCodexUsage never returns a negative input", () => {
  // Defensive: a future build could report cached >= prompt.
  const usage = readCodexUsage({ input_tokens: 100, cached_input_tokens: 250, output_tokens: 5 });
  assert.equal(usage?.input, 0);
  assert.equal(usage?.cacheRead, 250);
});

test("readCodexUsage returns null for an empty or shapeless block", () => {
  assert.equal(readCodexUsage({ input_tokens: 0, output_tokens: 0 }), null);
  assert.equal(readCodexUsage(null), null);
  assert.equal(readCodexUsage("nope"), null);
});

// -------------------------------------------------------------- dispatch ----

test("a rollout envelope is read as codex, not as a Claude line", () => {
  const entry = parseLine(
    JSON.stringify({
      timestamp: "2026-09-04T15:32:48.422Z",
      ordinal: 11,
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
    }),
    7,
  );

  assert.equal(entry?.type, "response_item");
  assert.equal(entry?.role, "assistant");
  assert.equal(entry?.text, "hi");
  assert.equal(entry?.timestamp, "2026-09-04T15:32:48.422Z");
});

test("a Claude line that happens to carry a payload key stays Claude-shaped", () => {
  const entry = parseLine(
    JSON.stringify({
      type: "assistant",
      payload: { note: "not a rollout envelope" },
      message: { role: "assistant", content: [{ type: "text", text: "claude" }] },
    }),
    1,
  );

  assert.equal(entry?.role, "assistant");
  assert.equal(entry?.text, "claude");
});

test("an unknown envelope type is not treated as a rollout record", () => {
  // `payload` alone is not the tell; the type has to be one codex writes.
  const entry = parseLine(JSON.stringify({ type: "something_else", payload: { a: 1 } }), 1);
  assert.equal(entry?.type, "something_else");
  assert.equal(entry?.role, null);
  assert.equal(entry?.text, "");
});

// ------------------------------------------------------------ accumulation --

test("only the per-response usage block is folded in", () => {
  // turn_token_usage and thread_token_usage are running totals. Folding them
  // would multiply the real number by three.
  const line = JSON.stringify({
    type: "token_usage_record",
    payload: {
      thread_id: "t1",
      usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 },
      turn_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 },
      thread_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 },
    },
  });

  const summary = parseTranscript(line);
  assert.equal(summary.usage.total, 110);
});

test("usage adds up across two turns of one rollout", () => {
  const text = [
    JSON.stringify({
      type: "token_usage_record",
      payload: { usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 } },
    }),
    JSON.stringify({
      type: "token_usage_record",
      payload: { usage: { input_tokens: 200, cached_input_tokens: 150, output_tokens: 5 } },
    }),
  ].join("\n");

  const summary = parseTranscript(text);
  assert.deepEqual(summary.usage, {
    input: 60 + 50,
    output: 15,
    cacheWrite: 0,
    cacheRead: 190,
    total: 315,
  });
});

test("task_complete sets lastMessage without adding a message", () => {
  const text = [
    JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ANSWER" }] },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "u1", last_agent_message: "ANSWER" },
    }),
  ].join("\n");

  const summary = parseTranscript(text);
  assert.equal(summary.lastMessage, "ANSWER");
  assert.equal(summary.messages.length, 1);
});

test("records we ignore are parsed, not skipped", () => {
  // `skipped` means "this line was broken". A turn_context or a cumulative
  // token_count is perfectly valid, we just fold nothing from it - counting
  // those as skipped would make a healthy rollout look damaged.
  const text = [
    JSON.stringify({ type: "turn_context", payload: { turn_id: "u1", cwd: "/tmp" } }),
    JSON.stringify({ type: "world_state", payload: { full: true } }),
    JSON.stringify({
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: { input_tokens: 999 } } },
    }),
  ].join("\n");

  const summary = parseTranscript(text);
  assert.equal(summary.lines, 3);
  assert.equal(summary.parsed, 3);
  assert.equal(summary.skipped, 0);
  assert.equal(summary.lines, summary.parsed + summary.skipped);
  // The cumulative token_count is deliberately not read.
  assert.equal(summary.usage.total, 0);
});

test("a broken rollout line is still skipped, not fatal", () => {
  const text = [
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [] } }),
    '{"type":"response_item","payload":{"type":"mess',
  ].join("\n");

  const summary = parseTranscript(text);
  assert.equal(summary.lines, 2);
  assert.equal(summary.parsed, 1);
  assert.equal(summary.skipped, 1);
});
