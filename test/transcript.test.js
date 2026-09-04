import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  addEntry,
  emptySummary,
  parseLine,
  parseTranscript,
  readTranscript,
  readUsage,
  summarizeUsage,
} from "../src/observe/transcript.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/transcript.jsonl", import.meta.url));

/**
 * @param {string} name
 * @param {string} body
 * @returns {string}
 */
function tmpTranscript(name, body) {
  const dir = mkdtempSync(join(tmpdir(), "harnet-transcript-"));
  const file = join(dir, name);
  writeFileSync(file, body);
  return file;
}

describe("transcript: line parsing", () => {
  it("reads an assistant message with text, tool_use and usage", () => {
    const entry = parseLine(
      JSON.stringify({
        type: "assistant",
        sessionId: "sess-1",
        timestamp: "2026-09-04T10:00:00Z",
        message: {
          role: "assistant",
          model: "claude-sonnet-4",
          content: [
            { type: "text", text: "on it" },
            { type: "tool_use", id: "toolu_9", name: "Bash", input: { command: "ls" } },
          ],
          usage: { input_tokens: 10, output_tokens: 4 },
        },
      }),
      7,
    );
    assert.ok(entry);
    assert.equal(entry.line, 7);
    assert.equal(entry.role, "assistant");
    assert.equal(entry.model, "claude-sonnet-4");
    assert.equal(entry.text, "on it");
    assert.equal(entry.sessionId, "sess-1");
    assert.equal(entry.timestamp, "2026-09-04T10:00:00Z");
    assert.deepEqual(entry.toolCalls, [
      { id: "toolu_9", name: "Bash", line: 7, input: { command: "ls" } },
    ]);
    assert.deepEqual(entry.usage, {
      input: 10,
      output: 4,
      cacheWrite: 0,
      cacheRead: 0,
      total: 14,
    });
  });

  it("joins multiple text blocks and ignores non-text blocks", () => {
    const entry = parseLine(
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "a" },
            { type: "thinking", thinking: "hidden" },
            { type: "text", text: "b" },
          ],
        },
      }),
    );
    assert.ok(entry);
    assert.equal(entry.text, "ab");
    assert.deepEqual(entry.toolCalls, []);
  });

  it("accepts a plain string content body", () => {
    const entry = parseLine(JSON.stringify({ type: "user", role: "user", content: "hello" }));
    assert.ok(entry);
    assert.equal(entry.text, "hello");
  });

  it("accepts flat top-level usage and a harness-written cost", () => {
    const entry = parseLine(
      JSON.stringify({
        type: "assistant",
        role: "assistant",
        model: "claude-opus-4",
        usage: { input_tokens: 1, output_tokens: 2 },
        costUSD: 0.5,
      }),
    );
    assert.ok(entry);
    assert.equal(entry.cost, 0.5);
    assert.equal(entry.usage?.total, 3);
  });

  it("returns null for anything it cannot use, instead of throwing", () => {
    assert.equal(parseLine(""), null);
    assert.equal(parseLine("   "), null);
    assert.equal(parseLine("{ not json"), null);
    assert.equal(parseLine('{"partial": "line'), null);
    assert.equal(parseLine("[1,2,3]"), null);
    assert.equal(parseLine('"just a string"'), null);
    assert.equal(parseLine("null"), null);
    assert.equal(parseLine('{"no_type_field":true}'), null);
    // @ts-expect-error deliberate wrong type from an untrusted caller
    assert.equal(parseLine(undefined), null);
  });

  it("drops tool_use blocks with no name", () => {
    const entry = parseLine(
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", id: "x" }] },
      }),
    );
    assert.ok(entry);
    assert.deepEqual(entry.toolCalls, []);
  });
});

describe("transcript: usage blocks", () => {
  it("reads snake_case and camelCase counters", () => {
    assert.deepEqual(
      readUsage({
        input_tokens: 5,
        output_tokens: 6,
        cache_creation_input_tokens: 7,
        cache_read_input_tokens: 8,
      }),
      { input: 5, output: 6, cacheWrite: 7, cacheRead: 8, total: 26 },
    );
    assert.deepEqual(readUsage({ inputTokens: 1, outputTokens: 2 }), {
      input: 1,
      output: 2,
      cacheWrite: 0,
      cacheRead: 0,
      total: 3,
    });
  });

  it("treats an absent or all-zero block as no usage", () => {
    assert.equal(readUsage(undefined), null);
    assert.equal(readUsage(null), null);
    assert.equal(readUsage("nope"), null);
    assert.equal(readUsage({}), null);
    assert.equal(readUsage({ input_tokens: 0, output_tokens: 0 }), null);
  });

  it("ignores non-finite counters", () => {
    assert.equal(readUsage({ input_tokens: Number.NaN, output_tokens: 3 })?.input, 0);
  });
});

describe("transcript: cost", () => {
  it("reports only what the harness wrote", () => {
    const summary = parseTranscript(
      JSON.stringify({
        type: "assistant",
        role: "assistant",
        model: "claude-opus-4",
        costUSD: 0.25,
        usage: { input_tokens: 1_000_000, output_tokens: 0 },
      }),
    );
    assert.equal(summary.cost, 0.25);
  });

  it("adds up costs across lines", () => {
    const summary = parseTranscript(
      [
        JSON.stringify({ type: "assistant", role: "assistant", costUSD: 0.25 }),
        JSON.stringify({ type: "assistant", role: "assistant", cost_usd: 0.75 }),
      ].join("\n"),
    );
    assert.equal(summary.cost, 1);
  });

  it("counts a standalone cost line with no usage", () => {
    const summary = parseTranscript(
      JSON.stringify({ type: "result", role: "assistant", cost_usd: 1.5 }),
    );
    assert.equal(summary.cost, 1.5);
    assert.equal(summary.usage.total, 0);
  });

  it("stays null when the harness wrote no cost, however many tokens ran", () => {
    const summary = parseTranscript(
      JSON.stringify({
        type: "assistant",
        role: "assistant",
        model: "claude-opus-4",
        usage: { input_tokens: 1_000_000, output_tokens: 500_000 },
      }),
    );
    assert.equal(summary.cost, null);
    // The tokens are still there for a caller that has a real price sheet.
    assert.equal(summary.usage.total, 1_500_000);
  });

  it("ignores a non-numeric cost field", () => {
    const summary = parseTranscript(
      JSON.stringify({ type: "assistant", role: "assistant", costUSD: "1.20" }),
    );
    assert.equal(summary.cost, null);
  });
});

describe("transcript: whole-file summary", () => {
  const text = readFileSync(FIXTURE, "utf8");

  it("adds up tokens across the fixture", () => {
    const s = parseTranscript(text);
    assert.deepEqual(s.usage, {
      input: 3300,
      output: 350,
      cacheWrite: 500,
      cacheRead: 4000,
      total: 8150,
    });
    // The fixture carries no cost field, so there is no cost to report.
    assert.equal(s.cost, null);
  });

  it("skips bad lines, counts them, and keeps going", () => {
    const s = parseTranscript(text);
    assert.equal(s.lines, 8);
    assert.equal(s.parsed, 5);
    assert.equal(s.skipped, 3);
    assert.equal(s.lines, s.parsed + s.skipped);
  });

  it("collects messages, tool calls and the session id", () => {
    const s = parseTranscript(text);
    assert.equal(s.sessionId, "sess-42");
    assert.equal(s.messages.length, 5);
    assert.equal(s.messages[0].role, "user");
    assert.equal(s.messages[0].text, "read the map");
    assert.equal(s.toolCalls.length, 3);
    assert.deepEqual(s.toolCounts, { Read: 2, Bash: 1 });
    assert.deepEqual(
      s.toolCalls.map((c) => c.id),
      ["toolu_1", "toolu_2", "toolu_3"],
    );
  });

  it("reports the last assistant text as the turn report", () => {
    assert.equal(parseTranscript(text).lastMessage, "Map read, tests green.");
  });

  it("keeps line numbers pointing at the real file lines", () => {
    const s = parseTranscript(text);
    assert.equal(s.toolCalls[0].line, 2);
    assert.equal(s.toolCalls[1].line, 5);
  });

  it("returns an empty summary for empty or blank input", () => {
    for (const input of ["", "\n\n  \n"]) {
      const s = parseTranscript(input);
      assert.equal(s.lines, 0);
      assert.equal(s.skipped, 0);
      assert.equal(s.cost, null);
      assert.deepEqual(s.messages, []);
    }
    // @ts-expect-error deliberate wrong type from an untrusted caller
    assert.deepEqual(parseTranscript(null), emptySummary());
  });

  it("survives a transcript that is nothing but garbage", () => {
    const s = parseTranscript("oops\n<<<\n{\n");
    assert.equal(s.lines, 3);
    assert.equal(s.skipped, 3);
    assert.equal(s.parsed, 0);
  });
});

describe("transcript: reading from disk", () => {
  it("streams the fixture to the same summary as parseTranscript", async () => {
    const streamed = await readTranscript(FIXTURE);
    const parsed = parseTranscript(readFileSync(FIXTURE, "utf8"));
    assert.deepEqual(streamed, parsed);
  });

  it("handles crlf line endings", async () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-haiku-4-5",
        content: [{ type: "text", text: "hi" }],
        usage: { input_tokens: 2, output_tokens: 1 },
      },
    });
    const file = tmpTranscript("crlf.jsonl", `${line}\r\nbroken\r\n`);
    const s = await readTranscript(file);
    assert.equal(s.parsed, 1);
    assert.equal(s.skipped, 1);
    assert.equal(s.lastMessage, "hi");
  });

  it("treats a missing transcript as an empty one", async () => {
    const s = await readTranscript(join(tmpdir(), "harnet-does-not-exist", "none.jsonl"));
    assert.deepEqual(s, emptySummary());
  });

  it("never reads pane.log: only the path it was handed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harnet-pane-"));
    const jsonl = join(dir, "transcript.jsonl");
    writeFileSync(
      jsonl,
      `${JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      })}\n`,
    );
    // Raw bytes a TUI would leave behind, escape codes and all. If any of it
    // leaked into a decision, the counts below would move.
    const esc = "\u001b";
    writeFileSync(join(dir, "pane.log"), `${esc}[2Jspinner...${esc}[32mdone?${esc}[0m\n`);
    const s = await readTranscript(jsonl);
    assert.equal(s.lines, 1);
    assert.equal(s.parsed, 1);
    assert.equal(s.lastMessage, "done");
  });
});

describe("transcript: accumulator", () => {
  it("folds entries one at a time", () => {
    const summary = emptySummary();
    const entry = parseLine(
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-sonnet-4",
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: null }],
          usage: { input_tokens: 100, output_tokens: 10 },
        },
      }),
      1,
    );
    assert.ok(entry);
    addEntry(summary, entry);
    addEntry(summary, entry);
    assert.equal(summary.parsed, 2);
    assert.equal(summary.usage.total, 220);
    assert.deepEqual(summary.toolCounts, { Bash: 2 });
  });

  it("keeps the legacy block summarizer working", () => {
    assert.deepEqual(summarizeUsage([{ tokens: 3, cost: 1 }, { tokens: 2 }]), {
      tokens: 5,
      cost: 1,
    });
  });
});
