/**
 * Transcript observer. README: Gozlem ve Tamamlanma.
 *
 * Structural channel only: the harness writes one JSON object per line into its
 * own transcript jsonl (messages, tool_use blocks, usage counters). Harnet reads
 * job state and reporting from here.
 *
 * Two shapes, one reader. Claude writes a flat record (`message`, `usage` at the
 * top level). Codex writes a rollout envelope instead: every record is
 * `{timestamp, ordinal, type, payload}` and the interesting part is one level
 * down. Both were captured live by scripts/live-spike.sh; parseLine sniffs the
 * envelope and dispatches, so a caller never has to know which harness wrote the
 * file. Before this, a codex rollout parsed cleanly and produced nothing at all -
 * zero messages, zero tokens, `skipped` still 0 - which is the worst possible
 * failure: a transcript that looks read and is empty.
 *
 * No cost: this module reports token counters only. Money is deliberately out of
 * scope - it was estimated once (a placeholder price table), then narrowed to the
 * harness-written costUSD, and is now gone entirely. Whoever needs a figure reads
 * `usage` and applies their own price sheet.
 *
 * The visual channel (pane.log) is a raw byte stream for the human to watch.
 * It is never opened by this module and never feeds a decision. Nothing in this
 * file touches it on purpose.
 *
 * Phase-1 rule (src/MAP.js): no cross-imports between modules.
 *
 * Robustness rule: a transcript is written by another process while we read it,
 * so the last line can be half-written and older harness versions emit shapes we
 * do not know. A bad line is never fatal - it is skipped and counted, and the
 * caller gets the `skipped` counter back so a broken transcript is visible
 * instead of silently producing a short-looking summary.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/**
 * @typedef {object} Usage
 * @property {number} input
 * @property {number} output
 * @property {number} cacheWrite
 * @property {number} cacheRead
 * @property {number} total
 */

/**
 * @typedef {object} ToolCall
 * @property {string} id
 * @property {string} name
 * @property {number} line
 * @property {unknown} input
 */

/**
 * @typedef {object} Message
 * @property {string} role
 * @property {string|null} model
 * @property {string} text
 * @property {number} line
 * @property {string|null} timestamp
 */

/**
 * @typedef {object} TranscriptSummary
 * @property {Message[]} messages
 * @property {ToolCall[]} toolCalls
 * @property {Record<string, number>} toolCounts
 * @property {Usage} usage
 * @property {number} lines number of non-empty lines seen
 * @property {number} parsed number of lines turned into an entry
 * @property {number} skipped number of lines that were unusable
 * @property {string|null} sessionId
 * @property {string|null} lastMessage last assistant text, the Stop-hook report body
 */

/** @returns {Usage} */
function emptyUsage() {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 };
}

/** @returns {TranscriptSummary} */
export function emptySummary() {
  return {
    messages: [],
    toolCalls: [],
    toolCounts: {},
    usage: emptyUsage(),
    lines: 0,
    parsed: 0,
    skipped: 0,
    sessionId: null,
    lastMessage: null,
  };
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function str(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Read a usage block in either the flat or the message-nested shape.
 * @param {unknown} raw
 * @returns {Usage|null}
 */
export function readUsage(raw) {
  if (!isRecord(raw)) return null;
  const input = num(raw.input_tokens ?? raw.inputTokens ?? raw.prompt_tokens);
  const output = num(raw.output_tokens ?? raw.outputTokens ?? raw.completion_tokens);
  const cacheWrite = num(raw.cache_creation_input_tokens ?? raw.cacheCreationInputTokens);
  const cacheRead = num(raw.cache_read_input_tokens ?? raw.cacheReadInputTokens);
  if (input === 0 && output === 0 && cacheWrite === 0 && cacheRead === 0) return null;
  return { input, output, cacheWrite, cacheRead, total: input + output + cacheWrite + cacheRead };
}

/**
 * Read a codex usage block.
 *
 * The counters do NOT mean the same thing as Claude's. Codex `input_tokens` is
 * the whole prompt and already contains `cached_input_tokens`, while Claude's
 * `input_tokens` excludes the cached part. Adding them straight would count the
 * cache twice, so the cached share is subtracted out here. The result satisfies
 * both invariants at once: `total` is still the sum of the four fields, and it
 * equals the `total_tokens` codex reports (16933 + 15 = 16948 on the captured
 * fixture).
 * @param {unknown} raw
 * @returns {Usage|null}
 */
export function readCodexUsage(raw) {
  if (!isRecord(raw)) return null;
  const prompt = num(raw.input_tokens);
  const cacheRead = num(raw.cached_input_tokens);
  const cacheWrite = num(raw.cache_write_input_tokens);
  // `output_tokens` already includes reasoning_output_tokens; adding that
  // separately would inflate the count.
  const output = num(raw.output_tokens);
  const input = Math.max(prompt - cacheRead, 0);
  if (input === 0 && output === 0 && cacheWrite === 0 && cacheRead === 0) return null;
  return { input, output, cacheWrite, cacheRead, total: input + output + cacheWrite + cacheRead };
}

/**
 * Flatten a content array into plain text, ignoring non-text blocks.
 * @param {unknown} content
 * @returns {string}
 */
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!isRecord(block) || typeof block.text !== "string") continue;
    // "text" is Claude's block type; codex writes "output_text" for what the
    // model said and "input_text" for what was sent to it.
    if (block.type === "text" || block.type === "output_text" || block.type === "input_text") {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

/**
 * Pull tool_use blocks out of a content array.
 * @param {unknown} content
 * @param {number} line
 * @returns {ToolCall[]}
 */
function toolCallsOf(content, line) {
  if (!Array.isArray(content)) return [];
  /** @type {ToolCall[]} */
  const calls = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "tool_use") continue;
    const name = str(block.name);
    if (!name) continue;
    calls.push({ id: str(block.id) ?? "", name, line, input: block.input ?? null });
  }
  return calls;
}

/**
 * @typedef {object} TranscriptEntry
 * @property {number} line
 * @property {string} type
 * @property {string|null} role
 * @property {string|null} model
 * @property {string} text
 * @property {ToolCall[]} toolCalls
 * @property {Usage|null} usage
 * @property {string|null} sessionId
 * @property {string|null} timestamp
 * @property {boolean} finalMessage the harness declared this the turn's answer
 */

/** Codex rollout envelope record types we know how to read. */
const ROLLOUT_TYPES = new Set([
  "session_meta",
  "response_item",
  "event_msg",
  "token_usage_record",
  "turn_context",
  "world_state",
  "compacted",
]);

/**
 * Whether a record is a codex rollout envelope rather than a Claude line.
 *
 * The tell is structural: codex wraps everything in `{type, payload}` and never
 * puts a `message` at the top level, which is exactly what Claude does put
 * there. Checked against the known type list too, so an unrelated harness that
 * happens to have a `payload` key is not silently read as codex.
 * @param {Record<string, unknown>} value
 * @returns {boolean}
 */
function isRolloutEnvelope(value) {
  if (!isRecord(value.payload)) return false;
  if (isRecord(value.message)) return false;
  const type = str(value.type);
  return type !== null && ROLLOUT_TYPES.has(type);
}

/**
 * Parse one codex rollout line.
 *
 * Every known record type produces an entry, even when it carries nothing we
 * fold in (`turn_context`, `world_state`, the cumulative `token_count` event).
 * That is deliberate: `skipped` means "this line was broken", and inflating it
 * with records we simply chose to ignore would make a healthy transcript look
 * damaged.
 *
 * Cumulative counters are the trap here. A `token_usage_record` carries three
 * usage blocks - `usage` (this response), `turn_token_usage` and
 * `thread_token_usage` (both running totals). Only the first is folded in;
 * summing the others across lines would multiply the real number.
 * @param {Record<string, unknown>} value
 * @param {number} line
 * @returns {TranscriptEntry}
 */
function parseRolloutLine(value, line) {
  const payload = /** @type {Record<string, unknown>} */ (value.payload);
  const type = /** @type {string} */ (str(value.type));
  const timestamp = str(value.timestamp) ?? str(payload.timestamp);

  /** @type {TranscriptEntry} */
  const entry = {
    line,
    type,
    role: null,
    model: null,
    text: "",
    toolCalls: [],
    usage: null,
    sessionId: str(payload.session_id) ?? str(payload.thread_id),
    timestamp,
    finalMessage: false,
  };

  if (type === "session_meta") {
    entry.sessionId = entry.sessionId ?? str(payload.id);
    entry.model = str(payload.model);
    return entry;
  }

  if (type === "response_item" && payload.type === "message") {
    entry.role = str(payload.role);
    entry.text = textOf(payload.content);
    return entry;
  }

  if (type === "token_usage_record") {
    entry.usage = readCodexUsage(payload.usage);
    return entry;
  }

  if (type === "event_msg" && payload.type === "task_complete") {
    // The harness naming its own answer. It repeats the assistant message that
    // already arrived as a response_item, so it sets lastMessage without being
    // pushed as a second message - see addEntry.
    entry.text = str(payload.last_agent_message) ?? "";
    entry.finalMessage = entry.text.length > 0;
    return entry;
  }

  // Known envelope, nothing to fold: counted as parsed, contributes nothing.
  return entry;
}

/**
 * Parse one jsonl line. Returns null for blank, malformed or shapeless lines -
 * the caller counts those as skipped rather than throwing.
 *
 * Handles both harnesses: a codex rollout envelope is dispatched to
 * parseRolloutLine, anything else is read as a Claude record.
 * @param {string} raw
 * @param {number} [line]
 * @returns {TranscriptEntry|null}
 */
export function parseLine(raw, line = 0) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;

  if (isRolloutEnvelope(value)) return parseRolloutLine(value, line);

  const message = isRecord(value.message) ? value.message : null;
  const type = str(value.type) ?? str(message?.role) ?? null;
  if (!type) return null;

  const content = message ? message.content : value.content;
  const usage = readUsage(message?.usage) ?? readUsage(value.usage);

  return {
    line,
    type,
    role: str(message?.role) ?? str(value.role),
    model: str(message?.model) ?? str(value.model),
    text: textOf(content),
    toolCalls: toolCallsOf(content, line),
    usage,
    sessionId: str(value.sessionId) ?? str(value.session_id),
    timestamp: str(value.timestamp) ?? str(value.ts),
    finalMessage: false,
  };
}

/**
 * Fold one parsed entry into a running summary. Exported so a streaming reader
 * and the whole-text reader share exactly one accumulation path.
 * @param {TranscriptSummary} summary
 * @param {TranscriptEntry} entry
 * @returns {TranscriptSummary} the same summary, mutated
 */
export function addEntry(summary, entry) {
  summary.parsed += 1;

  if (entry.sessionId && !summary.sessionId) summary.sessionId = entry.sessionId;

  if (entry.role) {
    summary.messages.push({
      role: entry.role,
      model: entry.model,
      text: entry.text,
      line: entry.line,
      timestamp: entry.timestamp,
    });
    if (entry.role === "assistant" && entry.text.length > 0) summary.lastMessage = entry.text;
  } else if (entry.finalMessage && entry.text.length > 0) {
    // A roleless record the harness marked as the turn's answer (codex
    // task_complete). It is the same text the assistant message already
    // carried, so it updates lastMessage without becoming a second message.
    summary.lastMessage = entry.text;
  }

  for (const call of entry.toolCalls) {
    summary.toolCalls.push(call);
    summary.toolCounts[call.name] = (summary.toolCounts[call.name] ?? 0) + 1;
  }

  if (entry.usage) {
    summary.usage.input += entry.usage.input;
    summary.usage.output += entry.usage.output;
    summary.usage.cacheWrite += entry.usage.cacheWrite;
    summary.usage.cacheRead += entry.usage.cacheRead;
    summary.usage.total += entry.usage.total;
  }

  return summary;
}

/**
 * Parse a whole transcript held in memory.
 * @param {string} text
 * @returns {TranscriptSummary}
 */
export function parseTranscript(text) {
  const summary = emptySummary();
  if (typeof text !== "string" || text.length === 0) return summary;
  for (const [index, raw] of text.split("\n").entries()) {
    if (raw.trim().length === 0) continue;
    summary.lines += 1;
    const entry = parseLine(raw, index + 1);
    if (entry === null) summary.skipped += 1;
    else addEntry(summary, entry);
  }
  return summary;
}

/**
 * Read a transcript jsonl off disk, line by line, so a long session never has to
 * fit in memory at once. A missing file is an empty transcript, not a crash: the
 * harness creates it lazily on the first turn.
 * @param {string} filePath
 * @returns {Promise<TranscriptSummary>}
 */
export async function readTranscript(filePath) {
  const summary = emptySummary();
  /** @type {import("node:fs").ReadStream} */
  let stream;
  try {
    stream = createReadStream(filePath, { encoding: "utf8" });
  } catch {
    return summary;
  }

  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let line = 0;
  try {
    for await (const raw of lines) {
      line += 1;
      if (raw.trim().length === 0) continue;
      summary.lines += 1;
      const entry = parseLine(raw, line);
      if (entry === null) summary.skipped += 1;
      else addEntry(summary, entry);
    }
  } catch (/** @type {any} */ err) {
    lines.close();
    stream.destroy();
    if (err && err.code === "ENOENT") return summary;
    throw err;
  }
  return summary;
}

/**
 * Legacy helper kept for callers that already hold plain blocks (test/smoke).
 * @typedef {{ tokens?: number }} UsageBlock
 * @param {UsageBlock[]} blocks
 * @returns {{ tokens: number }}
 */
export function summarizeUsage(blocks) {
  /** @type {{ tokens: number }} */
  const total = { tokens: 0 };
  for (const b of blocks) {
    total.tokens += b.tokens ?? 0;
  }
  return total;
}
