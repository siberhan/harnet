/**
 * src/service/report.js - the fix for the flush race the live e2e run found.
 *
 * The bug it guards (scripts/live-e2e.sh, 2026-09-04, run 3 of 4): the Stop hook
 * fired while the transcript still stopped one line short of the assistant turn,
 * so the job completed with an empty report even though the payload carried the
 * answer. See test/stop-flush-race.test.js for the raw-fixture half of this.
 *
 * Time and sleeping are injected everywhere, so the whole suite is instant and
 * nothing here depends on real timing. The late-flush case still uses a real
 * file on disk and the real transcript parser - the appending happens inside the
 * injected sleep, which is exactly what a slow harness does between our polls.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { createClaudeAdapter } from "../src/adapters/claude.js";
import { createControlService } from "../src/service/control.js";
import { createGroupRegistry } from "../src/service/jobs.js";
import { createQueue } from "../src/service/queue.js";
import {
  DEFAULT_FLUSH_TIMEOUT_MS,
  createReportReader,
  lastMessageFromPayload,
  readFileOrNull,
} from "../src/service/report.js";
import { parseTranscript } from "../src/observe/transcript.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const LIVE_TRANSCRIPT = readFileSync(join(FIXTURES, "live-claude-transcript.jsonl"), "utf8");
const LIVE_STOP = JSON.parse(readFileSync(join(FIXTURES, "live-claude-stop.json"), "utf8"));

/** The real transcript, split at the line the harness had not written yet. */
function splitAtAssistant() {
  const lines = LIVE_TRANSCRIPT.trim().split("\n");
  const at = lines.findIndex((line) => JSON.parse(line).type === "assistant");
  assert.ok(at > 0, "fixture must carry an assistant turn");
  return { before: `${lines.slice(0, at).join("\n")}\n`, full: `${lines.join("\n")}\n` };
}

/** A clock that only moves when something sleeps. */
function fakeClock() {
  let t = 1000;
  return {
    now: () => t,
    /** @param {number} ms */
    sleep(ms) {
      t += ms;
    },
    /** @param {number} ms */
    advance(ms) {
      t += ms;
    },
  };
}

describe("lastMessageFromPayload", () => {
  it("reads the claude Stop spelling", () => {
    assert.equal(lastMessageFromPayload({ last_assistant_message: "hi" }), "hi");
  });

  it("reads the hyphenated codex notify spelling", () => {
    assert.equal(lastMessageFromPayload({ "last-assistant-message": "hi" }), "hi");
    assert.equal(lastMessageFromPayload({ "last-agent-message": "done" }), "done");
  });

  it("ignores blank and non-string values, and non-objects", () => {
    assert.equal(lastMessageFromPayload({ last_assistant_message: "   " }), null);
    assert.equal(lastMessageFromPayload({ last_assistant_message: 42 }), null);
    assert.equal(lastMessageFromPayload(null), null);
    assert.equal(lastMessageFromPayload("done"), null);
  });
});

describe("readFileOrNull", () => {
  it("is null for a file that is not there yet, not a throw", () => {
    assert.equal(readFileOrNull(join(tmpdir(), "harnet-does-not-exist-ever.jsonl")), null);
  });
});

describe("createReportReader: the happy path costs nothing", () => {
  it("returns the transcript message on the first read and never sleeps", () => {
    const clock = fakeClock();
    let sleeps = 0;
    /** @type {import("../src/service/report.js").ReportAttempt[]} */
    const attempts = [];
    const read = createReportReader({
      parse: parseTranscript,
      readFile: () => LIVE_TRANSCRIPT,
      now: clock.now,
      sleep: () => {
        sleeps += 1;
      },
      onAttempt: (a) => attempts.push(a),
    });

    const report = read({ transcriptPath: "/t.jsonl", agentId: "a", payload: LIVE_STOP });
    assert.equal(report, parseTranscript(LIVE_TRANSCRIPT).lastMessage);
    assert.equal(sleeps, 0, "a flushed transcript must not cost a poll interval");
    assert.deepEqual(
      attempts.map((a) => [a.source, a.reads, a.waitedMs]),
      [["transcript", 1, 0]],
    );
  });
});

describe("createReportReader: the flush race", () => {
  it("polls until the assistant turn lands, then reports it", () => {
    const clock = fakeClock();
    const { before, full } = splitAtAssistant();
    let text = before;
    let sleeps = 0;
    const read = createReportReader({
      parse: parseTranscript,
      readFile: () => text,
      now: clock.now,
      pollMs: 50,
      sleep: (ms) => {
        clock.sleep(ms);
        sleeps += 1;
        if (sleeps === 3) text = full; // the harness finally flushes
      },
    });

    const report = read({ transcriptPath: "/t.jsonl", payload: {} });
    assert.equal(report, parseTranscript(full).lastMessage);
    assert.equal(sleeps, 3, "gave up exactly as soon as the message was there");
  });

  it("falls back to the payload when the transcript never catches up", () => {
    const clock = fakeClock();
    const { before } = splitAtAssistant();
    /** @type {import("../src/service/report.js").ReportAttempt[]} */
    const attempts = [];
    const read = createReportReader({
      parse: parseTranscript,
      readFile: () => before,
      now: clock.now,
      pollMs: 50,
      sleep: clock.sleep,
      onAttempt: (a) => attempts.push(a),
    });

    const report = read({ transcriptPath: "/t.jsonl", agentId: "e2e", payload: LIVE_STOP });
    assert.equal(report, LIVE_STOP.last_assistant_message);
    assert.equal(attempts[0].source, "payload");
    assert.equal(attempts[0].waitedMs, DEFAULT_FLUSH_TIMEOUT_MS);
    assert.equal(attempts[0].reads, DEFAULT_FLUSH_TIMEOUT_MS / 50 + 1);
  });

  it("waits no longer than the budget, even with a coarse poll interval", () => {
    const clock = fakeClock();
    const read = createReportReader({
      parse: parseTranscript,
      readFile: () => "",
      now: clock.now,
      flushTimeoutMs: 120,
      pollMs: 500,
      sleep: clock.sleep,
    });

    const startedAt = clock.now();
    read({ transcriptPath: "/t.jsonl", payload: { last_assistant_message: "x" } });
    assert.equal(clock.now() - startedAt, 120);
  });

  it("flushTimeoutMs 0 reads once and gives up", () => {
    let reads = 0;
    let sleeps = 0;
    const read = createReportReader({
      parse: parseTranscript,
      readFile: () => {
        reads += 1;
        return "";
      },
      flushTimeoutMs: 0,
      sleep: () => {
        sleeps += 1;
      },
    });

    assert.equal(read({ transcriptPath: "/t.jsonl", payload: { last_assistant_message: "x" } }), "x");
    assert.equal(reads, 1);
    assert.equal(sleeps, 0);
  });

  it("never invents a report when neither source has one", () => {
    /** @type {import("../src/service/report.js").ReportAttempt[]} */
    const attempts = [];
    const read = createReportReader({
      parse: parseTranscript,
      readFile: () => "",
      flushTimeoutMs: 0,
      onAttempt: (a) => attempts.push(a),
    });

    assert.equal(read({ transcriptPath: "/t.jsonl", payload: {} }), null);
    assert.equal(read({ transcriptPath: null, payload: null }), null);
    assert.deepEqual(
      attempts.map((a) => [a.source, a.reads]),
      [
        ["none", 1],
        ["none", 0],
      ],
    );
  });

  it("skips the file entirely when the signal carries no transcript path", () => {
    let reads = 0;
    const read = createReportReader({
      parse: parseTranscript,
      readFile: () => {
        reads += 1;
        return LIVE_TRANSCRIPT;
      },
    });

    assert.equal(read({ transcriptPath: null, payload: LIVE_STOP }), LIVE_STOP.last_assistant_message);
    assert.equal(reads, 0);
  });
});

describe("createReportReader: a real late flush on disk", () => {
  it("picks up an assistant turn appended between two polls", () => {
    const dir = mkdtempSync(join(tmpdir(), "harnet-report-"));
    const path = join(dir, "transcript.jsonl");
    const { before, full } = splitAtAssistant();
    writeFileSync(path, before);

    let sleeps = 0;
    const read = createReportReader({
      parse: parseTranscript,
      // readFile is the real one on purpose: this test also covers the default.
      pollMs: 1,
      sleep: () => {
        sleeps += 1;
        if (sleeps === 2) writeFileSync(path, full);
      },
    });

    const report = read({ transcriptPath: path, payload: {} });
    assert.equal(report, parseTranscript(full).lastMessage);
    assert.equal(sleeps, 2);
  });

  it("survives a transcript that does not exist yet", () => {
    const dir = mkdtempSync(join(tmpdir(), "harnet-report-"));
    const path = join(dir, "not-written-yet.jsonl");
    const { full } = splitAtAssistant();

    let sleeps = 0;
    const read = createReportReader({
      parse: parseTranscript,
      pollMs: 1,
      sleep: () => {
        sleeps += 1;
        if (sleeps === 2) writeFileSync(path, full);
      },
    });

    assert.equal(read({ transcriptPath: path, payload: {} }), parseTranscript(full).lastMessage);
  });
});

describe("wired into the real service: a fake Stop signal", () => {
  /**
   * A real claude adapter + queue + control service, with tmux stubbed out.
   * Only the report reader is under test; everything else is the shipping code.
   * @param {{ transcriptText: string, flushesOnSleep?: boolean }} spec
   */
  function wire(spec) {
    let text = spec.transcriptText;
    const { full } = splitAtAssistant();
    const queue = createQueue();
    const groups = createGroupRegistry();
    /** @type {import("../src/service/report.js").ReportAttempt[]} */
    const attempts = [];
    const clock = fakeClock();

    const adapter = createClaudeAdapter({
      // tmux is not involved: has-session says alive, everything else succeeds.
      run: () => ({ status: 0, stdout: "", stderr: "" }),
      root: "/repo",
      queue,
      readReport: createReportReader({
        parse: parseTranscript,
        readFile: () => text,
        now: clock.now,
        pollMs: 50,
        sleep: (ms) => {
          clock.sleep(ms);
          if (spec.flushesOnSleep === true) text = full;
        },
        onAttempt: (a) => attempts.push(a),
      }),
    });
    adapter.bind({ agentId: "e2e", sessionId: "sess-1" });
    const service = createControlService({ queue, groups, adapters: { e2e: adapter } });
    return { service, groups, attempts };
  }

  const stopPayload = {
    hook_event_name: "Stop",
    session_id: "sess-1",
    transcript_path: "/home/.claude/projects/x/sess-1.jsonl",
    last_assistant_message: "HARNET-E2E-OK",
  };

  it("stores the transcript answer when the file is already flushed", () => {
    const { service, attempts } = wire({ transcriptText: LIVE_TRANSCRIPT });
    const submitted = service.submitGroup({ parent: null, jobs: [{ prompt: "go", agent: "e2e" }] });
    const handled = service.handleSignal({ agent: "e2e", payload: stopPayload });

    assert.equal(handled.job?.id, submitted.jobs[0].id);
    assert.equal(handled.job?.status, "done");
    assert.equal(handled.job?.report, parseTranscript(LIVE_TRANSCRIPT).lastMessage);
    assert.equal(attempts[0].source, "transcript");
  });

  it("stores the payload answer instead of an empty report when the flush is late", () => {
    // This is exactly the live failure: 12 lines on disk, 0 skipped, no message.
    const { before } = splitAtAssistant();
    const { service, attempts } = wire({ transcriptText: before });
    service.submitGroup({ parent: null, jobs: [{ prompt: "go", agent: "e2e" }] });
    const handled = service.handleSignal({ agent: "e2e", payload: stopPayload });

    assert.equal(handled.job?.status, "done");
    assert.equal(handled.job?.report, "HARNET-E2E-OK");
    assert.equal(attempts[0].source, "payload");
  });

  it("the wake-up carries the report instead of 'no report'", () => {
    const { before } = splitAtAssistant();
    const { service } = wire({ transcriptText: before });
    service.submitGroup({ parent: null, jobs: [{ prompt: "go", agent: "e2e" }] });
    const handled = service.handleSignal({ agent: "e2e", payload: stopPayload });

    const message = handled.wakeup?.message ?? "";
    assert.match(message, /Report: HARNET-E2E-OK/);
    assert.doesNotMatch(message, /no report/);
  });

  it("a transcript that lands mid-poll still beats the payload", () => {
    const { before, full } = splitAtAssistant();
    const { service, attempts } = wire({ transcriptText: before, flushesOnSleep: true });
    service.submitGroup({ parent: null, jobs: [{ prompt: "go", agent: "e2e" }] });
    const handled = service.handleSignal({ agent: "e2e", payload: stopPayload });

    assert.equal(handled.job?.report, parseTranscript(full).lastMessage);
    assert.equal(attempts[0].source, "transcript");
  });
});
