/**
 * Turning a completion signal into a job report.
 *
 * README: Gozlem ve Tamamlanma. The report is the agent's answer, read from the
 * transcript the signal points at - never scraped off the pane.
 *
 * WHY THIS FILE EXISTS (measured, not assumed - scripts/live-e2e.sh, 4 runs on
 * 2026-09-04): the Stop hook can fire BEFORE the harness has flushed the
 * assistant turn to the transcript. One run in four read a transcript that
 * stopped one line short of the answer - 12 lines, 0 skipped, lastMessage null -
 * and the job completed with an EMPTY report while the signal payload itself
 * carried the answer. The same file held 17 lines seconds later. The reader was
 * not wrong; there was genuinely no message yet.
 *
 * So a report reader has to do two things a naive one does not:
 *   1. give the file a short moment to land (poll, do not read once), and
 *   2. fall back to the payload's own copy of the last assistant message when
 *      it still has not landed.
 * Never invent a report. If neither source has one, this returns null and the
 * caller's own default ("no report") stands.
 *
 * The wait is synchronous because the adapter contract (`readReport` in
 * src/adapters/claude.js) is synchronous: a signal handler must produce the
 * report before it completes the job. That blocks the loop, so the default
 * budget is deliberately short (2s) - the payload fallback covers the rest and
 * costs nothing. Pass flushTimeoutMs: 0 to disable waiting entirely.
 *
 * Phase-1 rule (src/MAP.js): no cross-imports. The transcript parser and the
 * filesystem are injected, which is also what lets the tests drive a real late
 * flush without sleeping.
 */

import { readFileSync } from "node:fs";

/** Short on purpose: we block the caller while we wait. */
export const DEFAULT_FLUSH_TIMEOUT_MS = 2000;
export const DEFAULT_POLL_MS = 50;

/**
 * Spellings of "the last thing the agent said" seen on real payloads.
 * claude Stop uses snake_case; codex notify uses hyphens (see
 * src/adapters/codex.js normalizeNotify).
 */
export const LAST_MESSAGE_KEYS = Object.freeze([
  "last_assistant_message",
  "last-assistant-message",
  "lastAssistantMessage",
  "last_agent_message",
  "last-agent-message",
]);

/**
 * @typedef {object} ParsedTranscript
 * @property {string|null} lastMessage
 */

/**
 * @typedef {object} ReportAttempt
 * @property {string|null} transcriptPath
 * @property {string|null} agentId
 * @property {"transcript"|"payload"|"none"} source where the report came from
 * @property {number} reads how many times the transcript was read
 * @property {number} waitedMs how long the caller was blocked
 * @property {string|null} report
 */

/**
 * @typedef {object} ReportReaderOptions
 * @property {(text: string) => ParsedTranscript} parse transcript parser, e.g. parseTranscript
 * @property {(path: string) => string|null} [readFile] defaults to readFileOrNull
 * @property {number} [flushTimeoutMs] 0 disables waiting
 * @property {number} [pollMs]
 * @property {() => number} [now]
 * @property {(ms: number) => void} [sleep] synchronous sleep
 * @property {(attempt: ReportAttempt) => void} [onAttempt] observer, for logs and evidence
 */

/**
 * Block the current thread. Only used between transcript reads, for a budget
 * measured in milliseconds.
 * @param {number} ms
 * @returns {void}
 */
export function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The default `readFile`: a missing transcript is "not there yet", not an error -
 * the whole point of the poll is that the file may still be appearing.
 * @param {string} path
 * @returns {string|null}
 */
export function readFileOrNull(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code === "ENOENT" || code === "EISDIR") return null;
    throw error;
  }
}

/**
 * Read the last assistant message straight off a signal payload.
 * @param {unknown} payload
 * @returns {string|null}
 */
export function lastMessageFromPayload(payload) {
  if (payload === null || typeof payload !== "object") return null;
  const record = /** @type {Record<string, unknown>} */ (payload);
  for (const key of LAST_MESSAGE_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

/**
 * Build the `readReport` function an adapter takes: given a completion signal,
 * produce the job's report or null.
 *
 * @param {ReportReaderOptions} options
 * @returns {(ctx: { transcriptPath: string|null, agentId?: string, payload?: unknown }) => string|null}
 */
export function createReportReader(options) {
  const parse = options.parse;
  const readFile = options.readFile ?? readFileOrNull;
  const flushTimeoutMs = options.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? sleepSync;
  const onAttempt = options.onAttempt ?? null;

  if (typeof parse !== "function") throw new Error("createReportReader needs a parse function");
  if (typeof readFile !== "function") throw new Error("createReportReader needs a readFile function");

  /**
   * @param {string} path
   * @returns {string|null}
   */
  function messageInTranscript(path) {
    const text = readFile(path);
    if (text === null || text === undefined || text === "") return null;
    const summary = parse(text);
    const message = summary?.lastMessage ?? null;
    return typeof message === "string" && message !== "" ? message : null;
  }

  return function readReport(ctx) {
    const startedAt = now();
    const transcriptPath = ctx.transcriptPath ?? null;
    const agentId = ctx.agentId ?? null;
    let reads = 0;

    /**
     * @param {"transcript"|"payload"|"none"} source
     * @param {string|null} report
     * @returns {string|null}
     */
    const finish = (source, report) => {
      if (onAttempt !== null) {
        onAttempt({
          transcriptPath,
          agentId,
          source,
          reads,
          waitedMs: now() - startedAt,
          report,
        });
      }
      return report;
    };

    if (transcriptPath !== null) {
      // First read is always immediate: on a healthy signal the turn is already
      // on disk and nobody should pay for the poll interval.
      const deadline = startedAt + flushTimeoutMs;
      for (;;) {
        reads += 1;
        const message = messageInTranscript(transcriptPath);
        if (message !== null) return finish("transcript", message);
        const remaining = deadline - now();
        if (remaining <= 0) break;
        sleep(Math.min(pollMs, remaining));
      }
    }

    // The transcript never caught up inside the budget. The payload's own copy
    // is the honest answer - it came from the same harness, in the same signal.
    const fromPayload = lastMessageFromPayload(ctx.payload);
    if (fromPayload !== null) return finish("payload", fromPayload);
    return finish("none", null);
  };
}
