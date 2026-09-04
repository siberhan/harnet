/**
 * Transcript observer. README: Gozlem ve Tamamlanma.
 *
 * Structural channel only: the harness writes one JSON object per line into its
 * own transcript jsonl (messages, tool_use blocks, usage counters). Harnet reads
 * job state and reporting from here.
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
 * Flatten a content array into plain text, ignoring non-text blocks.
 * @param {unknown} content
 * @returns {string}
 */
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
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
 */

/**
 * Parse one jsonl line. Returns null for blank, malformed or shapeless lines -
 * the caller counts those as skipped rather than throwing.
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
 * @typedef {{ tokens?: number, cost?: number }} UsageBlock
 * @param {UsageBlock[]} blocks
 * @returns {{ tokens: number, cost: number }}
 */
export function summarizeUsage(blocks) {
  /** @type {{ tokens: number, cost: number }} */
  const total = { tokens: 0, cost: 0 };
  for (const b of blocks) {
    total.tokens += b.tokens ?? 0;
    total.cost += b.cost ?? 0;
  }
  return total;
}
