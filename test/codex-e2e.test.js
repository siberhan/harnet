/**
 * The codex half of the live end-to-end run, pinned by its own captures.
 *
 * scripts/live-e2e.sh codex, 2026-09-04, codex 0.153.0: one job went in through
 * service.submitGroup, out through send-keys into a real TUI, and came back as
 * the notify program's argv[1]. Both files here are that run, verbatim:
 *   live-codex-e2e-notify.json   - what the notify program was handed
 *   live-codex-e2e-rollout.jsonl - what codex wrote to ~/.codex/sessions
 *
 * What these tests defend, which the earlier spike fixtures do not: the whole
 * chain on the codex side - real payload -> real adapter -> real queue -> real
 * control service -> the wake-up a parent agent would actually read - and the
 * cross-check that the rollout says the same thing the notify said.
 *
 * Unlike claude, codex needs no transcript read on a healthy turn: the answer
 * is already in the signal. The report reader is the fallback, so it is wired
 * in with transcriptPath null, exactly as src/adapters/codex.js calls it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { createCodexAdapter } from "../src/adapters/codex.js";
import { createControlService } from "../src/service/control.js";
import { createGroupRegistry } from "../src/service/jobs.js";
import { createQueue } from "../src/service/queue.js";
import { createReportReader } from "../src/service/report.js";
import { parseTranscript } from "../src/observe/transcript.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const notify = JSON.parse(readFileSync(join(FIXTURES, "live-codex-e2e-notify.json"), "utf8"));
const rolloutText = readFileSync(join(FIXTURES, "live-codex-e2e-rollout.jsonl"), "utf8");

const PROMPT = "Reply with exactly this one word and nothing else: HARNET-E2E-OK";
const ANSWER = "HARNET-E2E-OK";

/** The real service with tmux stubbed out; nothing else is faked. */
function wire() {
  const queue = createQueue();
  const groups = createGroupRegistry();
  /** @type {import("../src/service/report.js").ReportAttempt[]} */
  const attempts = [];
  const adapter = createCodexAdapter({
    run: () => ({ status: 0, stdout: "", stderr: "" }),
    root: "/repo",
    queue,
    readReport: createReportReader({
      parse: parseTranscript,
      readFile: () => null,
      flushTimeoutMs: 0,
      onAttempt: (a) => attempts.push(a),
    }),
  });
  adapter.bind({ agentId: "e2e", sessionId: notify["thread-id"] });
  const service = createControlService({ queue, groups, adapters: { e2e: adapter } });
  return { service, groups, attempts };
}

describe("live codex e2e captures", () => {
  it("the notify payload is the turn we submitted, in the worktree we opened", () => {
    assert.equal(notify.type, "agent-turn-complete");
    assert.equal(notify.client, "codex-tui");
    assert.deepEqual(notify["input-messages"], [PROMPT]);
    assert.equal(notify["last-assistant-message"], ANSWER);
    assert.match(notify.cwd, /harnet-live-e2e-[A-Za-z0-9]+\/agent-wt$/);
  });

  it("the rollout parses clean and agrees with the notify", () => {
    const summary = parseTranscript(rolloutText);

    assert.equal(summary.skipped, 0, "every rollout line is understood");
    assert.equal(summary.parsed, summary.lines);
    assert.equal(summary.sessionId, notify["thread-id"]);
    // The cross-check the live run prints: two independent sources, one answer.
    assert.equal(summary.lastMessage, notify["last-assistant-message"]);
    // A full rollout also carries codex's own developer preamble and the
    // environment_context user turn; the prompt and the answer are the last of
    // each, and there is exactly one assistant turn.
    const roles = summary.messages.map((m) => m.role);
    assert.deepEqual(roles.filter((r) => r === "assistant"), ["assistant"]);
    assert.equal(roles[roles.length - 1], "assistant");
    assert.equal(summary.messages[summary.messages.length - 1].text, ANSWER);
    // Real numbers from the run: a one-word answer on a large system prompt.
    assert.equal(summary.usage.output, 12);
    assert.equal(summary.usage.input, 16934);
    assert.equal(
      summary.usage.total,
      summary.usage.input + summary.usage.output + summary.usage.cacheWrite + summary.usage.cacheRead,
    );
  });
});

describe("wired into the real service: the live codex notify", () => {
  it("completes the job and never has to read the rollout", () => {
    const { service, attempts } = wire();
    const submitted = service.submitGroup({
      parent: null,
      turn: 1,
      jobs: [{ prompt: PROMPT, agent: "e2e" }],
    });
    assert.equal(submitted.dispatched[0].sent, true);

    const handled = service.handleSignal({ agent: "e2e", payload: notify });

    assert.equal(handled.signal?.matched, true);
    assert.equal(handled.job?.id, submitted.jobs[0].id);
    assert.equal(handled.job?.status, "done");
    assert.equal(handled.job?.report, ANSWER);
    // The signal carried the answer, so the fallback reader was never needed.
    assert.equal(attempts.length, 0);
  });

  it("emits exactly one wake-up carrying the report", () => {
    const { service } = wire();
    service.submitGroup({ parent: null, turn: 1, jobs: [{ prompt: PROMPT, agent: "e2e" }] });
    const handled = service.handleSignal({ agent: "e2e", payload: notify });

    // One job, one group, one wake-up - handleSignal returns it directly.
    const wakeup = handled.wakeup;
    assert.ok(wakeup !== null, "a completed one-job group must wake its parent");
    assert.match(wakeup.message, /Status: done/);
    assert.match(wakeup.message, new RegExp(`Report: ${ANSWER}`));
    assert.doesNotMatch(wakeup.message, /no report/);
  });

  it("ignores a notify for a thread nobody is bound to", () => {
    const { service } = wire();
    service.submitGroup({ parent: null, turn: 1, jobs: [{ prompt: PROMPT, agent: "e2e" }] });
    const stray = { ...notify, "thread-id": "01a06ddd-dead-beef-0000-000000000000" };
    const handled = service.handleSignal({ agent: "e2e", payload: stray });

    assert.equal(handled.signal?.matched, false);
  });
});
