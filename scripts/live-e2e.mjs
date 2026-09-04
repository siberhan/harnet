/**
 * Harnet live end-to-end driver - the CONTROL SERVICE run against a real agent.
 *
 * scripts/live-spike.sh proved the tmux chain by hand (send-keys, a hook file,
 * a jsonl parse). This driver proves the layer above it: nothing here talks to
 * tmux on its own behalf. A real queue + result registry + control service +
 * the real claude adapter are wired together, and the flow is
 *
 *   service.submitGroup(...)      -> adapter.write -> tmux send-keys -> claude
 *   wait for the Stop hook file   (the harness, not us, decides the turn ended)
 *   service.handleSignal(...)     -> adapter.handleStop -> queue.complete
 *                                 -> groups.record -> wake-up message
 *
 * It is manual-only: it opens a real TUI, spends real tokens and needs a
 * logged-in harness. Never wire it into CI. scripts/live-e2e.sh is the entry
 * point; it builds the throwaway repo and the hook config this file expects.
 *
 * Everything runs on its own tmux socket (HARNET_E2E_SOCKET) so the user's own
 * tmux server is untouched.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { createControlService } from "../src/service/control.js";
import { createGroupRegistry } from "../src/service/jobs.js";
import { createQueue } from "../src/service/queue.js";
import { createClaudeAdapter, spawnRunner, sessionName } from "../src/adapters/claude.js";
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

const AGENT = process.env.HARNET_E2E_AGENT ?? "e2e";
const SOCKET = process.env.HARNET_E2E_SOCKET ?? "harnet-e2e";
const RUN_ROOT = required("HARNET_E2E_ROOT");
const WORKTREE = required("HARNET_E2E_WORKTREE");
const STOP_FILE = required("HARNET_E2E_STOP");
const NOTIFY_FILE = process.env.HARNET_E2E_NOTIFY ?? join(RUN_ROOT, "notification.jsonl");
const TOKEN = process.env.HARNET_E2E_TOKEN ?? "HARNET-E2E-OK";
const PROMPT =
  process.env.HARNET_E2E_PROMPT ?? `Reply with exactly this one word and nothing else: ${TOKEN}`;
const BOOT_TIMEOUT_MS = Number(process.env.BOOT_TIMEOUT ?? 45) * 1000;
const SIGNAL_TIMEOUT_MS = Number(process.env.SIGNAL_TIMEOUT ?? 180) * 1000;
const FLUSH_TIMEOUT_MS = Number(process.env.FLUSH_TIMEOUT ?? 15) * 1000;
const KEEP = process.env.KEEP === "1";

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
 * Readiness is checked BEFORE the trust dialog, same order as live-spike.sh:
 * a banner that stays printed above the composer would otherwise match forever.
 * @returns {Promise<{ ready: boolean, pane: string }>}
 */
async function waitForPrompt() {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let trustAnswered = false;
  let last = "";
  while (Date.now() < deadline) {
    last = paneText();
    if (/Try "|auto mode on/.test(last)) return { ready: true, pane: last };
    if (!trustAnswered && /trust/i.test(last)) {
      info("trust dialog detected, answering with send-keys");
      trustAnswered = true;
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
 * The harness decides the turn is over; we only watch for its hook output.
 * @returns {Promise<string|null>}
 */
async function waitForStop() {
  const deadline = Date.now() + SIGNAL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(STOP_FILE)) {
      const text = readFileSync(STOP_FILE, "utf8").trim();
      if (text !== "") return text;
    }
    await delay(1000);
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
  say(`harnet live e2e - agent '${AGENT}', tmux socket '${SOCKET}'`);
  info(`run root:       ${RUN_ROOT}`);
  info(`worktree:       ${WORKTREE}`);
  info(`stop hook file: ${STOP_FILE}`);

  // -------------------------------------------------------------- wiring --
  say("wiring the real control service");
  const queue = createQueue();
  const groups = createGroupRegistry();
  /** Every distinct transcript state the reader saw, for the evidence file. */
  /** @type {string[]} */
  const reportsRead = [];
  /** @type {import("../src/service/report.js").ReportAttempt|null} */
  let reportAttempt = null;
  const adapter = createClaudeAdapter({
    run: isolatedRunner,
    root: RUN_ROOT,
    queue,
    // The report is the agent's answer, read out of the transcript the Stop
    // payload points at - never scraped off the pane. This is the SHIPPING
    // reader (src/service/report.js): it polls for the flush and falls back to
    // the payload's own copy, so the live run exercises the real code path
    // rather than a second implementation of it. The only thing added here is
    // bookkeeping for the evidence file.
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
  info("queue + group registry + control service + claude adapter: constructed");

  // --------------------------------------------------------------- spawn --
  say("adapter.spawn -> tmux new-session + pipe-pane");
  mkdirSync(join(RUN_ROOT, ".harnet", "agents", AGENT), { recursive: true });
  const session = adapter.spawn({ agentId: AGENT, worktree: WORKTREE });
  info(`session:  ${session.session}`);
  info(`pane log: ${session.absoluteLogPath}`);
  dump("session list:", isolatedRunner(["tmux", "ls"], { cwd: RUN_ROOT }).stdout.trim());

  say("waiting for the TUI to come up");
  const boot = await waitForPrompt();
  if (!boot.ready) {
    fail(`claude TUI never reached its prompt within ${BOOT_TIMEOUT_MS / 1000}s`, boot.pane);
    return;
  }
  info("TUI ready");

  // -------------------------------------------------------------- submit --
  // A group with one child: this is the path a parent agent's fan-out takes,
  // and it is what makes the service emit exactly one wake-up at the end.
  say("service.submitGroup -> queue.dispatch -> adapter.write -> send-keys");
  const sentAt = Date.now();
  // Only the commands issued from here on belong to the job; the boot wait may
  // have answered a trust dialog with its own send-keys.
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
  say("waiting for the Stop hook (the harness ends the turn, not us)");
  const raw = await waitForStop();
  if (raw === null) {
    fail(
      `no Stop signal within ${SIGNAL_TIMEOUT_MS / 1000}s`,
      "--- pane ---",
      paneText(),
      "--- notifications (agent may be waiting for a human) ---",
      existsSync(NOTIFY_FILE) ? readFileSync(NOTIFY_FILE, "utf8") : "(none)",
    );
    return;
  }
  const elapsedMs = Date.now() - sentAt;
  info(`Stop signal arrived ${Math.round(elapsedMs / 1000)}s after send-keys`);
  dump("raw Stop payload:", raw);

  const payload = JSON.parse(raw.split("\n").pop() ?? "{}");
  // A Stop payload carries the harness session id, not an agent id. In the real
  // service the bind happens when the session is opened; here the id only
  // exists once the harness has written it, so bind on the first signal.
  // The hook file is truncated before the session is opened, so anything in it
  // belongs to this run - but say so out loud rather than assume it: the cwd in
  // the payload must be the throwaway worktree (macOS prefixes it with /private).
  if (typeof payload.cwd === "string" && realpathSync(payload.cwd) !== realpathSync(WORKTREE)) {
    info(`WARNING: Stop payload cwd '${payload.cwd}' is not the worktree we opened`);
  }
  if (typeof payload.session_id === "string") {
    adapter.bind({ agentId: AGENT, sessionId: payload.session_id });
    info(`bound harness session ${payload.session_id} -> agent ${AGENT}`);
  }

  say("service.handleSignal -> adapter.handleStop -> queue.complete -> wake-up");
  const handled = service.handleSignal({ agent: AGENT, payload });
  if (handled.signal === null || handled.signal.matched !== true) {
    fail(
      "control service did not match the Stop signal to the running job",
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
  }
  dump("report the service stored:", handled.job?.report ?? "(none)");

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
    agent: AGENT,
    socket: SOCKET,
    session: session.session,
    worktree: WORKTREE,
    prompt: PROMPT,
    sent: { jobId: job.id, groupId: submitted.group.id, tmux: sendKeys },
    stopPayload: payload,
    elapsedMs,
    signal: handled.signal,
    job: { id: handled.job?.id, status: handled.job?.status, report: handled.job?.report },
    transcriptSummaries: reportsRead,
    reportAttempt,
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
  info("chain verified: submitGroup -> send-keys -> Stop hook -> transcript -> wake-up");
}

main().catch((error) => {
  fail(String(error instanceof Error ? error.stack : error));
});
