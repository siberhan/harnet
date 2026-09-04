/**
 * Harnet live end-to-end driver - the CONTROL SERVICE run against a real agent.
 *
 * scripts/live-spike.sh proved the tmux chain by hand (send-keys, a hook file,
 * a jsonl parse). This driver proves the layer above it: nothing here talks to
 * tmux on its own behalf. A real queue + result registry + control service +
 * a real adapter are wired together, and the flow is
 *
 *   service.submitGroup(...)      -> adapter.write -> tmux send-keys -> agent
 *   wait for the completion file  (the harness, not us, decides the turn ended)
 *   service.handleSignal(...)     -> adapter.handleStop / handleNotify
 *                                 -> queue.complete -> groups.record -> wake-up
 *
 * Both harnesses run through the same code path; only the profile below differs.
 *   claude: `Stop` hook, payload on stdin, report read from the transcript.
 *   codex:  `notify` program, payload as argv[1] with HYPHENATED keys, and the
 *           report already inside the notification - the rollout jsonl is read
 *           for evidence (usage, message count) and cross-checked, not for the
 *           report itself.
 *
 * It is manual-only: it opens a real TUI, spends real tokens and needs a
 * logged-in harness. Never wire it into CI. scripts/live-e2e.sh is the entry
 * point; it builds the throwaway repo and the hook/notify config this expects.
 *
 * Everything runs on its own tmux socket (HARNET_E2E_SOCKET) so the user's own
 * tmux server is untouched.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createControlService } from "../src/service/control.js";
import { createGroupRegistry } from "../src/service/jobs.js";
import { createQueue } from "../src/service/queue.js";
import { createClaudeAdapter, spawnRunner, sessionName } from "../src/adapters/claude.js";
import { createCodexAdapter } from "../src/adapters/codex.js";
import { parseTranscript } from "../src/observe/transcript.js";
import { createReportReader } from "../src/service/report.js";

/**
 * @param {string} name
 * @returns {string}
 */
function required(name) {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`missing env: ${name}`);
  return value;
}

const HARNESS = process.env.HARNET_E2E_HARNESS ?? "claude";
const AGENT = process.env.HARNET_E2E_AGENT ?? "e2e";
const SOCKET = process.env.HARNET_E2E_SOCKET ?? "harnet-e2e";
const RUN_ROOT = required("HARNET_E2E_ROOT");
const WORKTREE = required("HARNET_E2E_WORKTREE");
const SIGNAL_FILE = required("HARNET_E2E_SIGNAL");
const NOTIFY_FILE = process.env.HARNET_E2E_NOTIFY ?? join(RUN_ROOT, "notification.jsonl");
const NOTIFY_PROGRAM = process.env.HARNET_E2E_NOTIFY_PROGRAM ?? "";
const TOKEN = process.env.HARNET_E2E_TOKEN ?? "HARNET-E2E-OK";
const PROMPT =
  process.env.HARNET_E2E_PROMPT ?? `Reply with exactly this one word and nothing else: ${TOKEN}`;
const BOOT_TIMEOUT_MS = Number(process.env.BOOT_TIMEOUT ?? 45) * 1000;
const SIGNAL_TIMEOUT_MS = Number(process.env.SIGNAL_TIMEOUT ?? 180) * 1000;
const FLUSH_TIMEOUT_MS = Number(process.env.FLUSH_TIMEOUT ?? 15) * 1000;
const KEEP = process.env.KEEP === "1";
/** Boot the TUI, prove it is ready, then stop - costs no tokens and no quota. */
const DRY_BOOT = process.env.DRY_BOOT === "1";

const ESC = "\u001b";
/** @param {string} s */
const bold = (s) => `${ESC}[1m${s}${ESC}[0m`;
/** @param {string} s */
const say = (s) => console.log(`\n${bold(`== ${s}`)}`);
/** @param {string} s */
const info = (s) => console.log(`   ${s}`);
/**
 * @param {string} label
 * @param {unknown} text
 */
const dump = (label, text) => {
  if (label !== "") console.log(`   ${label}`);
  console.log(
    String(text)
      .split("\n")
      .map((l) => `     ${l}`)
      .join("\n"),
  );
};
/** @param {number} ms */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Everything that differs between the two harnesses, in one place. Every other
 * line of this file is harness-agnostic on purpose: that is the claim under
 * test - one control service, two harnesses.
 *
 * @typedef {object} Profile
 * @property {string} signal human name of the completion signal
 * @property {(options: any) => any} createAdapter
 * @property {RegExp} ready pane text that means the composer is up
 * @property {string[]} trustKeys keys that answer "do you trust this directory?"
 * @property {string} [command] tmux command; undefined = the adapter default
 * @property {(payload: any) => string|null} threadIdOf harness session/thread id
 * @property {string} log what the harness writes its structured log to
 */

/** @type {Record<string, Profile>} */
const PROFILES = {
  claude: {
    signal: "Stop hook",
    createAdapter: createClaudeAdapter,
    ready: /Try "|auto mode on/,
    // claude lists "No" first, so the yes answer is one Down away.
    trustKeys: ["Down", "Enter"],
    threadIdOf: (payload) => (typeof payload.session_id === "string" ? payload.session_id : null),
    log: "transcript jsonl",
  },
  codex: {
    signal: "notify program",
    createAdapter: createCodexAdapter,
    ready: /Ask Codex/,
    // MEASURED 2026-09-04: codex 0.153.0 lists "1. Yes, continue" FIRST and
    // "2. No, quit" second. Sending claude's Down+Enter here selects "No, quit"
    // and the process exits, taking the tmux session with it - that is exactly
    // what killed the first two DRY_BOOT runs. Plain Enter takes the default.
    trustKeys: ["Enter"],
    // codex takes its notify program as config, so the session command is not
    // the adapter's bare default. tmux runs this through a shell.
    command: `codex -c 'notify=["${NOTIFY_PROGRAM}"]'`,
    // Real codex 0.153.0 hyphenates its keys; snake_case is accepted in case
    // that changes. src/adapters/codex.js normalises both - this is only for
    // finding the id to bind.
    threadIdOf: (payload) =>
      typeof payload["thread-id"] === "string"
        ? payload["thread-id"]
        : typeof payload.thread_id === "string"
          ? payload.thread_id
          : null,
    log: "rollout jsonl",
  },
};

const profile = PROFILES[HARNESS];
if (profile === undefined) throw new Error(`unknown harness: ${HARNESS}`);

/** Every tmux command the adapter issued, kept for the evidence file. */
/** @type {string[]} */
const tmuxCalls = [];

/**
 * The adapter builds plain `tmux ...` argv. Pin every one of them to our own
 * socket so a live run cannot touch the user's tmux server. This is the only
 * place in this file that is allowed to know about tmux at all.
 * @type {import("../src/adapters/claude.js").Runner}
 */
function isolatedRunner(argv, opts) {
  const onSocket = argv[0] === "tmux" ? ["tmux", "-L", SOCKET, ...argv.slice(1)] : argv;
  tmuxCalls.push(onSocket.join(" "));
  return spawnRunner(onSocket, opts);
}

/** Raw tmux for the boot wait only. No job decision is ever made from the pane. */
function paneText() {
  const res = isolatedRunner(["tmux", "capture-pane", "-p", "-t", sessionName(AGENT)], {
    cwd: RUN_ROOT,
  });
  return res.status === 0 ? res.stdout : "";
}

/** @param {string} keys */
function sendRaw(keys) {
  isolatedRunner(["tmux", "send-keys", "-t", sessionName(AGENT), keys], { cwd: RUN_ROOT });
}

/**
 * Readiness is checked BEFORE any dialog, same order as live-spike.sh: codex
 * leaves its "Update available" banner printed above the composer, so a dialog
 * check that ran first would match forever and never let the loop finish.
 * @returns {Promise<{ ready: boolean, pane: string }>}
 */
async function waitForPrompt() {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let trustAnswered = false;
  let updateDeclined = false;
  let last = "";
  while (Date.now() < deadline) {
    last = paneText();
    // A dialog can be drawn over a composer that is already up, so "ready"
    // means the prompt is visible AND nothing is waiting on an answer -
    // otherwise the job text would be typed into a menu.
    const pending = /Press enter to continue/.test(last);
    if (!pending && profile.ready.test(last)) {
      // codex draws its composer while it is still starting MCP servers; keys
      // sent into that window can be dropped. Let the status line clear first.
      const settleUntil = Date.now() + 30_000;
      while (/Starting MCP servers/.test(last) && Date.now() < settleUntil) {
        await delay(2000);
        last = paneText();
      }
      await delay(2000);
      return { ready: true, pane: paneText() };
    }

    // First run in a fresh directory: both harnesses ask the human to trust it.
    // Harnet is the keyboard, so it answers the way a human would - and that
    // this works is itself evidence that send-keys drives the TUI.
    if (!trustAnswered && /trust/i.test(last)) {
      info("trust dialog detected, answering with send-keys");
      trustAnswered = true;
      for (const key of profile.trustKeys) {
        sendRaw(key);
        await delay(1000);
      }
      await delay(4000);
      continue;
    }

    // codex may offer a self-update before it ever shows a prompt. Never take
    // it: the run must use the binary the user actually has. Down + Enter lands
    // on "Skip"; the default option would run an installer.
    if (!updateDeclined && /Update now/.test(last)) {
      info("update offer detected, declining with send-keys (Skip)");
      updateDeclined = true;
      sendRaw("Down");
      await delay(1000);
      sendRaw("Enter");
      await delay(4000);
      continue;
    }

    await delay(2000);
  }
  return { ready: false, pane: last };
}

/**
 * The harness decides the turn is over; we only watch for its output.
 * @returns {Promise<string|null>}
 */
async function waitForSignal() {
  const deadline = Date.now() + SIGNAL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(SIGNAL_FILE)) {
      const text = readFileSync(SIGNAL_FILE, "utf8").trim();
      if (text !== "") return text;
    }
    await delay(1000);
  }
  return null;
}

/**
 * codex writes its rollout under ~/.codex/sessions/<date dirs>/, named after the
 * thread id. Nothing in the notification points at it, so it has to be found.
 * @param {string|null} threadId
 * @returns {string|null}
 */
function findRollout(threadId) {
  if (threadId === null) return null;
  const root = join(homedir(), ".codex", "sessions");
  if (!existsSync(root)) return null;
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.includes(threadId)) continue;
    return join(entry.parentPath ?? root, entry.name);
  }
  return null;
}

/**
 * @param {string} message
 * @param {...unknown} details
 */
function fail(message, ...details) {
  console.error(`\n${ESC}[1;31mBLOCKED: ${message}${ESC}[0m`);
  for (const d of details) console.error(String(d));
  process.exitCode = 1;
}

async function main() {
  say(`harnet live e2e - harness '${HARNESS}', agent '${AGENT}', tmux socket '${SOCKET}'`);
  info(`run root:    ${RUN_ROOT}`);
  info(`worktree:    ${WORKTREE}`);
  info(`signal file: ${SIGNAL_FILE} (${profile.signal})`);

  // -------------------------------------------------------------- wiring --
  say("wiring the real control service");
  const queue = createQueue();
  const groups = createGroupRegistry();
  /** Every distinct transcript state the reader saw, for the evidence file. */
  /** @type {string[]} */
  const reportsRead = [];
  /** @type {import("../src/service/report.js").ReportAttempt|null} */
  let reportAttempt = null;
  const adapter = profile.createAdapter({
    run: isolatedRunner,
    root: RUN_ROOT,
    queue,
    // The report is the agent's answer, read out of the structured log the
    // signal points at - never scraped off the pane. This is the SHIPPING
    // reader (src/service/report.js): it polls for the flush and falls back to
    // the payload's own copy, so the live run exercises the real code path
    // rather than a second implementation of it. The only thing added here is
    // bookkeeping for the evidence file.
    //
    // codex note: its notify already carries the message, so on a healthy turn
    // the adapter never reaches this reader - there it is the fallback path.
    readReport: createReportReader({
      parse: (text) => {
        const summary = parseTranscript(text);
        const line =
          `lines=${summary.lines} parsed=${summary.parsed} skipped=${summary.skipped} ` +
          `session=${summary.sessionId} tokens=${summary.usage.total}`;
        // One line per poll would be noise; only a change is news.
        if (reportsRead[reportsRead.length - 1] !== line) reportsRead.push(line);
        return summary;
      },
      // A manual script may block: the budget is generous here, unlike the 2s
      // the service defaults to.
      flushTimeoutMs: FLUSH_TIMEOUT_MS,
      pollMs: 250,
      onAttempt: (attempt) => {
        reportAttempt = attempt;
      },
    }),
    onNotification: (entry) => {
      appendFileSync(NOTIFY_FILE, `${JSON.stringify(entry.payload)}\n`);
      info(`notification (human needed): ${entry.message}`);
    },
  });
  const service = createControlService({ queue, groups, adapters: { [AGENT]: adapter } });
  info(`queue + group registry + control service + ${HARNESS} adapter: constructed`);

  // --------------------------------------------------------------- spawn --
  say("adapter.spawn -> tmux new-session + pipe-pane");
  mkdirSync(join(RUN_ROOT, ".harnet", "agents", AGENT), { recursive: true });
  const session = adapter.spawn({ agentId: AGENT, worktree: WORKTREE, command: profile.command });
  info(`command:  ${session.command}`);
  info(`session:  ${session.session}`);
  info(`pane log: ${session.absoluteLogPath}`);
  dump("session list:", isolatedRunner(["tmux", "ls"], { cwd: RUN_ROOT }).stdout.trim());

  say("waiting for the TUI to come up");
  const boot = await waitForPrompt();
  if (!boot.ready) {
    fail(`${HARNESS} TUI never reached its prompt within ${BOOT_TIMEOUT_MS / 1000}s`, boot.pane);
    return;
  }
  info("TUI ready");
  // Quota insurance: prove the spawn + dialog + readiness plumbing of a harness
  // without spending a turn on it. The prompt is what costs, not the boot.
  if (DRY_BOOT) {
    say("DRY_BOOT=1: the TUI is up and the plumbing works; sending no prompt");
    dump("pane:", boot.pane.trim());
    if (!KEEP) adapter.kill({ agentId: AGENT });
    return;
  }

  // -------------------------------------------------------------- submit --
  // A group with one child: this is the path a parent agent's fan-out takes,
  // and it is what makes the service emit exactly one wake-up at the end.
  say("service.submitGroup -> queue.dispatch -> adapter.write -> send-keys");
  const sentAt = Date.now();
  // Only the commands issued from here on belong to the job; the boot wait may
  // have answered a dialog with its own send-keys.
  const callsBefore = tmuxCalls.length;
  const submitted = service.submitGroup({
    parent: null,
    turn: 1,
    jobs: [{ prompt: PROMPT, agent: AGENT }],
  });
  const job = submitted.jobs[0];
  info(`group: ${submitted.group.id}`);
  info(`job:   ${job.id} status=${job.status}`);
  info(`sent:  ${PROMPT}`);
  const sendKeys = tmuxCalls.slice(callsBefore).filter((c) => c.includes("send-keys"));
  dump("tmux commands the adapter issued for this job:", sendKeys.join("\n"));
  if (submitted.dispatched.length === 0 || submitted.dispatched[0].sent !== true) {
    fail(
      "control service did not dispatch the job to the adapter",
      JSON.stringify(submitted.dispatched),
    );
    return;
  }

  // -------------------------------------------------------------- signal --
  say(`waiting for the ${profile.signal} (the harness ends the turn, not us)`);
  const raw = await waitForSignal();
  if (raw === null) {
    fail(
      `no ${profile.signal} signal within ${SIGNAL_TIMEOUT_MS / 1000}s`,
      "--- pane ---",
      paneText(),
      "--- notifications (agent may be waiting for a human) ---",
      existsSync(NOTIFY_FILE) ? readFileSync(NOTIFY_FILE, "utf8") : "(none)",
    );
    return;
  }
  const elapsedMs = Date.now() - sentAt;
  info(`signal arrived ${Math.round(elapsedMs / 1000)}s after send-keys`);
  dump("raw payload:", raw);

  const payload = JSON.parse(raw.split("\n").pop() ?? "{}");
  // The signal file is truncated before the session is opened, so anything in it
  // belongs to this run - but say so out loud rather than assume it: the cwd in
  // the payload must be the throwaway worktree (macOS prefixes it with /private).
  if (typeof payload.cwd === "string" && realpathSync(payload.cwd) !== realpathSync(WORKTREE)) {
    info(`WARNING: payload cwd '${payload.cwd}' is not the worktree we opened`);
  }
  // A completion signal carries the harness session/thread id, not an agent id.
  // In the real service the bind happens when the session is opened; here the id
  // only exists once the harness has written it, so bind on the first signal.
  const threadId = profile.threadIdOf(payload);
  if (threadId !== null) {
    adapter.bind({ agentId: AGENT, sessionId: threadId });
    info(`bound harness session ${threadId} -> agent ${AGENT}`);
  } else {
    info("WARNING: the payload carried no session/thread id to bind");
  }

  say("service.handleSignal -> adapter -> queue.complete -> wake-up");
  const handled = service.handleSignal({ agent: AGENT, payload });
  if (handled.signal === null || handled.signal.matched !== true) {
    fail(
      "control service did not match the signal to the running job",
      JSON.stringify(handled, null, 2),
    );
    return;
  }
  info(`signal matched job ${handled.signal.jobId}, status=${handled.signal.status}`);
  for (const line of reportsRead) info(`transcript read: ${line}`);
  if (reportAttempt !== null) {
    info(
      `report source: ${reportAttempt.source} ` +
        `(${reportAttempt.reads} read${reportAttempt.reads === 1 ? "" : "s"}, ` +
        `${reportAttempt.waitedMs}ms waiting for the flush)`,
    );
  } else {
    info(`report source: the ${profile.signal} payload itself, no log read needed`);
  }
  dump("report the service stored:", handled.job?.report ?? "(none)");

  // ----------------------------------------------- structured log evidence --
  // For claude the transcript IS the report source and was read above. For codex
  // the notification already carries the report, so the rollout is read here as
  // INDEPENDENT evidence: same answer, real token counts, nothing skipped.
  /** @type {object|null} */
  let logSummary = null;
  if (HARNESS === "codex") {
    say(`reading the ${profile.log} with src/observe/transcript.js`);
    const rollout = findRollout(threadId);
    if (rollout === null) {
      info(`WARNING: no rollout jsonl found for thread '${threadId}' under ~/.codex/sessions`);
    } else {
      const summary = parseTranscript(readFileSync(rollout, "utf8"));
      logSummary = {
        path: rollout,
        lines: summary.lines,
        parsed: summary.parsed,
        skipped: summary.skipped,
        sessionId: summary.sessionId,
        lastMessage: summary.lastMessage,
        usage: summary.usage,
        messages: summary.messages.length,
        toolCounts: summary.toolCounts,
      };
      dump("rollout summary:", JSON.stringify(logSummary, null, 2));
      info(
        summary.lastMessage === (handled.job?.report ?? null)
          ? "cross-check: the rollout's last message equals the report notify produced"
          : `WARNING: rollout says '${summary.lastMessage}', notify produced '${handled.job?.report}'`,
      );
    }
  }

  const wakeups = service.wakeups();
  if (wakeups.length !== 1) {
    fail(`expected exactly one wake-up, got ${wakeups.length}`, JSON.stringify(wakeups, null, 2));
    return;
  }
  say("wake-up message the parent would receive");
  dump("", wakeups[0].message);

  // ------------------------------------------------------------ evidence --
  const answerMatched = String(handled.job?.report ?? "").trim() === TOKEN;
  const evidence = {
    harness: HARNESS,
    agent: AGENT,
    socket: SOCKET,
    session: session.session,
    command: session.command,
    worktree: WORKTREE,
    prompt: PROMPT,
    sent: { jobId: job.id, groupId: submitted.group.id, tmux: sendKeys },
    signalPayload: payload,
    elapsedMs,
    signal: handled.signal,
    job: { id: handled.job?.id, status: handled.job?.status, report: handled.job?.report },
    transcriptSummaries: reportsRead,
    reportAttempt,
    logSummary,
    wakeup: wakeups[0],
    answerMatchedToken: answerMatched,
    paneLogBytes: existsSync(session.absoluteLogPath)
      ? readFileSync(session.absoluteLogPath).length
      : 0,
  };
  const evidencePath = join(RUN_ROOT, "evidence.json");
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

  say("result");
  info(
    `round trip: ${
      answerMatched ? "verified - the answer is the token we asked for" : `WARNING: report was not '${TOKEN}'`
    }`,
  );
  info(`pane.log bytes: ${evidence.paneLogBytes}`);
  info(`evidence:       ${evidencePath}`);
  if (!KEEP) adapter.kill({ agentId: AGENT });
  info(`chain verified: submitGroup -> send-keys -> ${profile.signal} -> report -> wake-up`);
}

main().catch((error) => {
  fail(String(error instanceof Error ? error.stack : error));
});
