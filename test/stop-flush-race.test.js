/**
 * The Stop hook can land before the transcript is flushed.
 *
 * Measured during the live e2e run (scripts/live-e2e.sh, 2026-09-04): one run
 * in four fired its Stop hook while the transcript still stopped one line short
 * of the assistant turn. The reader was right - there was no message yet - but
 * a service that reads only the transcript stored an empty report for a job
 * that had a perfectly good answer.
 *
 * These tests pin the two facts the e2e driver relies on to survive that race:
 * a transcript without the assistant turn yields `lastMessage === null`, and
 * the Stop payload carries its own copy of the answer to fall back on.
 *
 * Fixtures are real captures (test/fixtures/live-claude-*), not hand-written.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { parseTranscript } from "../src/observe/transcript.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const transcriptText = readFileSync(join(FIXTURES, "live-claude-transcript.jsonl"), "utf8");
const stopPayload = JSON.parse(readFileSync(join(FIXTURES, "live-claude-stop.json"), "utf8"));

/** Everything the harness had written when the Stop hook fired mid-flush. */
function truncatedBeforeAssistant() {
  const lines = transcriptText.trim().split("\n");
  const assistantAt = lines.findIndex((line) => JSON.parse(line).type === "assistant");
  assert.ok(assistantAt > 0, "fixture must carry an assistant turn after a user turn");
  return `${lines.slice(0, assistantAt).join("\n")}\n`;
}

test("a transcript flushed short of the assistant turn has no lastMessage", () => {
  const summary = parseTranscript(truncatedBeforeAssistant());
  assert.equal(summary.skipped, 0, "the short file is not broken, only incomplete");
  assert.equal(summary.lastMessage, null);
  assert.notEqual(summary.sessionId, null, "the session id is already there");
});

test("the full transcript does carry the answer", () => {
  const summary = parseTranscript(transcriptText);
  assert.equal(typeof summary.lastMessage, "string");
  assert.notEqual(summary.lastMessage, "");
});

test("the Stop payload carries the same answer, so a fallback is available", () => {
  const summary = parseTranscript(transcriptText);
  assert.equal(typeof stopPayload.last_assistant_message, "string");
  assert.notEqual(stopPayload.last_assistant_message, "");
  assert.equal(stopPayload.last_assistant_message, summary.lastMessage);
});
