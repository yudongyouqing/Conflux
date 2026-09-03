import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  buildRuntimeArgs,
  buildRuntimeEnv,
  RUNTIME_OPERATOR_PROMPT,
  SCHEDULED_WAKE_PROMPT,
  buildHeadlessArgs,
  isDue,
  hasActiveRun,
  tickScheduledAgents,
  createRuntimeAgent,
  listRuntimeAgentsWithLiveness,
  wakeSessionForMail,
} from "../core/runtime-agents.js";
import { getAutoWake, setAutoWake, setSetting } from "../core/app-settings.js";
import { registerSession, mergeSessionMeta } from "../core/sessions.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// fake ~/.claude so the transcript guard can be exercised hermetically
const FAKE_HOME = mkdtempSync(join(tmpdir(), "muiltchat-wake-home-"));
const makeTranscript = (sessionId: string, projectDir: string) => {
  const dir = join(FAKE_HOME, "projects", projectDir.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), '{"type":"user","message":"hi"}' + "\n", "utf8");
};
after(() => {
  try { rmSync(FAKE_HOME, { recursive: true, force: true }); } catch {}
});
import { makeDb } from "./helpers.js";

const { db, cleanup } = makeDb();
after(cleanup);

test("claude args always carry the operator prompt", () => {
  const args = buildRuntimeArgs({ runtime: "claude", model: null, instructions: null });
  const i = args.indexOf("--append-system-prompt");
  assert.ok(i >= 0, "--append-system-prompt present");
  assert.equal(args[i + 1], RUNTIME_OPERATOR_PROMPT);
});

test("user instructions extend, not replace, the operator prompt", () => {
  const args = buildRuntimeArgs({
    runtime: "claude",
    model: "sonnet",
    instructions: "只处理部署相关问题",
  });
  assert.deepEqual(args.slice(0, 2), ["--model", "sonnet"]);
  const i = args.indexOf("--append-system-prompt");
  const prompt = args[i + 1];
  assert.ok(prompt.startsWith(RUNTIME_OPERATOR_PROMPT));
  assert.ok(prompt.includes("只处理部署相关问题"));
});

test("codex args stay model-only (no system-prompt injection)", () => {
  assert.deepEqual(
    buildRuntimeArgs({ runtime: "codex", model: "gpt-5", instructions: "x" }),
    ["--model", "gpt-5"]
  );
});

test("buildRuntimeEnv tags the agent id for MCP-side session linking", () => {
  const env = buildRuntimeEnv({
    id: 7,
    runtime: "claude",
    base_url: null,
    api_key: "sk-test",
    model: null,
    extra_env: null,
  });
  assert.equal(env.MUILTCHAT_AGENT_ID, "7");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "sk-test");
  assert.equal(env.ANTHROPIC_API_KEY, undefined, "replaced, not inherited");
});

// ---- scheduled headless runs (patrol pattern) ----

test("isDue: interval gating math", () => {
  const now = new Date("2026-08-16T10:00:00Z");
  assert.equal(isDue({ interval_min: null, last_scheduled_run: null }, now), false);
  assert.equal(isDue({ interval_min: 0, last_scheduled_run: null }, now), false);
  assert.equal(isDue({ interval_min: 30, last_scheduled_run: null }, now), true, "never ran → due");
  assert.equal(
    isDue({ interval_min: 30, last_scheduled_run: "2026-08-16T09:40:00Z" }, now),
    false,
    "20min of 30min elapsed → not due"
  );
  assert.equal(
    isDue({ interval_min: 30, last_scheduled_run: "2026-08-16T09:29:00Z" }, now),
    true,
    "31min elapsed → due"
  );
});

test("buildHeadlessArgs: one-shot prompts per runtime", () => {
  const claudeArgs = buildHeadlessArgs({ runtime: "claude", model: null, instructions: null });
  assert.ok(claudeArgs.includes("-p"), "headless claude runs -p");
  assert.ok(claudeArgs.includes("mcp__muiltchat__*"), "headless pre-authorizes muiltchat tools");
  assert.equal(claudeArgs[claudeArgs.indexOf("-p") + 1], SCHEDULED_WAKE_PROMPT);

  const codexArgs = buildHeadlessArgs({ runtime: "codex", model: "gpt-5", instructions: null });
  assert.equal(codexArgs[0], "exec");
  assert.ok(codexArgs.includes("--model"));
});

test("createRuntimeAgent validates the interval range", () => {
  assert.throws(() =>
    createRuntimeAgent(db, { name: "bad", runtime: "claude", interval_min: 0 })
  );
  assert.throws(() =>
    createRuntimeAgent(db, { name: "bad", runtime: "claude", interval_min: 20000 })
  );
  const ok = createRuntimeAgent(db, { name: "patrol-test", runtime: "claude", interval_min: 60 });
  assert.equal(ok.interval_min, 60);
});

test("tickScheduledAgents launches due agents, skips fresh and overlapping ones", () => {
  const launched: number[] = [];
  const launcher = (_db: unknown, id: number) => {
    launched.push(id);
  };

  // due: interval set, never ran
  const due = createRuntimeAgent(db, { name: "sched-due", runtime: "claude", interval_min: 5 });
  // not due: no interval
  const manual = createRuntimeAgent(db, { name: "sched-manual", runtime: "claude" });
  // overlapping: due but has a live spawned session
  const busy = createRuntimeAgent(db, { name: "sched-busy", runtime: "claude", interval_min: 5 });
  registerSession(db, {
    id: "live-patrol-run",
    name: "patrol",
    description: "running",
    metadata: { source: "claude-hook", agent_id: busy.id, runtime: "claude" },
  });

  const n = tickScheduledAgents(db as never, launcher as never);
  assert.ok(n >= 1);
  assert.ok(launched.includes(due.id), "due agent launches");
  assert.ok(!launched.includes(manual.id), "manual agent never scheduled");
  assert.ok(!launched.includes(busy.id), "overlapping run skipped");
});

test("hasActiveRun matches only its own preset's live sessions", () => {
  const mine = createRuntimeAgent(db, { name: "ar-mine", runtime: "claude" });
  const other = createRuntimeAgent(db, { name: "ar-other", runtime: "claude" });
  registerSession(db, {
    id: "other-run",
    name: "x",
    description: "y",
    metadata: { source: "claude-hook", agent_id: other.id, runtime: "claude" },
  });
  assert.equal(hasActiveRun(db, mine.id), false);
  assert.equal(hasActiveRun(db, other.id), true);
});

test("listRuntimeAgentsWithLiveness derives live from spawned session heartbeats", () => {
  const a = createRuntimeAgent(db, { name: "live-probe", runtime: "claude" });
  const b = createRuntimeAgent(db, { name: "dead-probe", runtime: "claude" });

  // fresh heartbeat for a's spawned session (via mergeSessionMeta, like hooks)
  registerSession(db, { id: "spawn-a1", name: "spawn-a1" });
  mergeSessionMeta(db, "spawn-a1", { agent_id: a.id, runtime: "claude" });
  // b's session heartbeated long ago (stale string in the past)
  registerSession(db, { id: "spawn-b1", name: "spawn-b1" });
  mergeSessionMeta(db, "spawn-b1", { agent_id: b.id });
  db.prepare(`UPDATE sessions SET last_heartbeat_at = ? WHERE id = ?`).run(
    new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    "spawn-b1"
  );

  const agents = listRuntimeAgentsWithLiveness(db);
  const la = agents.find((x) => x.id === a.id)!;
  const lb = agents.find((x) => x.id === b.id)!;
  assert.equal(la.live, true, "fresh heartbeat -> live");
  assert.ok(la.last_seen);
  assert.equal(lb.live, false, "old heartbeat -> offline");
  assert.ok(lb.last_seen, "offline still reports last_seen");
});

// ---- auto-answer wake ----

test("wakeSessionForMail: guards, dedup and command shape", () => {
  // not a CLI conversation
  registerSession(db, { id: "web-console", name: "Web 控制台" });
  assert.equal(wakeSessionForMail(db, "web-console", { dryRun: true }).woke, false);
  assert.deepEqual(
    wakeSessionForMail(db, "agent-1", { dryRun: true }),
    { woke: false, reason: "not a CLI conversation" }
  );

  // active + BUSY → the running turn will surface the mail itself
  registerSession(db, {
    id: "wake-busy",
    name: "busy",
    description: "d",
    metadata: { source: "claude-hook", named: true, claude_pid: 424242, busy: true },
  });
  assert.deepEqual(
    wakeSessionForMail(db, "wake-busy", { dryRun: true }),
    { woke: false, reason: "busy — the running turn will surface the mail" }
  );

  // active + IDLE → the open TUI holds the thread lock, so a FRESH
  // headless run answers (digest-seeded; resume is codex-impossible here)
  registerSession(db, {
    id: "wake-alive",
    name: "alive",
    description: "d",
    metadata: { source: "claude-hook", named: true, claude_pid: 424242 },
  });
  const idle = wakeSessionForMail(db, "wake-alive", { dryRun: true, claudeHome: FAKE_HOME });
  assert.equal(idle.woke, true);
  if (idle.woke) {
    assert.ok(idle.command.includes("-p "), "headless prompt (delivered via stdin)");
    assert.ok(!idle.command.includes("--resume "), "must not resume a TUI-locked thread");
  }

  // offline claude session → dry-run returns the full wake command
  registerSession(db, {
    id: "wake-dead",
    name: "dead",
    description: "d",
    metadata: { source: "claude-hook", named: true, claude_pid: 999999 },
  });
  db.prepare(`UPDATE sessions SET status = 'stale' WHERE id = 'wake-dead'`).run();
  assert.deepEqual(
    wakeSessionForMail(db, "wake-dead", { dryRun: true }),
    { woke: false, reason: "no transcript (zero-turn conversation)" },
    "no transcript → cannot resume"
  );
  makeTranscript("wake-dead", "C:/Project folder/项目/muiltchat");
  const w = wakeSessionForMail(db, "wake-dead", { dryRun: true, claudeHome: FAKE_HOME });
  assert.equal(w.woke, true);
  if (w.woke) {
    assert.ok(w.command.includes("--resume wake-dead"), "resumes the conversation");
    assert.ok(w.command.trimEnd().endsWith("-p"), "headless prompt via stdin");
  }

  // global opt-out
  setAutoWake(db, false);
  assert.equal(wakeSessionForMail(db, "wake-dead", { dryRun: true }).woke, false);
  setAutoWake(db, true);
});

test("wakeSessionForMail: codex wakes headlessly via exec resume", () => {
  // no rollout binding → cannot resume
  registerSession(db, {
    id: "wake-codex-unbound",
    name: "cu",
    description: "d",
    metadata: { runtime: "codex", runtime_pid: 313131 },
  });
  db.prepare(`UPDATE sessions SET status = 'stale' WHERE id = 'wake-codex-unbound'`).run();
  assert.deepEqual(
    wakeSessionForMail(db, "wake-codex-unbound", { dryRun: true }),
    { woke: false, reason: "no codex_session_id (rollout binding missing)" }
  );

  // bound uuid → codex exec resume command (no transcript requirement)
  registerSession(db, {
    id: "wake-codex",
    name: "cw",
    description: "d",
    metadata: { runtime: "codex", runtime_pid: 323232, codex_session_id: "01c0d3x-uuid" },
  });
  db.prepare(`UPDATE sessions SET status = 'stale' WHERE id = 'wake-codex'`).run();
  const w = wakeSessionForMail(db, "wake-codex", { dryRun: true });
  assert.equal(w.woke, true);
  if (w.woke) {
    assert.ok(w.command.includes("exec resume 01c0d3x-uuid"), "resumes the codex conversation");
    assert.ok(!w.command.includes("--resume "), "not the claude resume flag");
  }
});

test("wakeSessionForMail dedups within the window", () => {
  registerSession(db, {
    id: "wake-dedup",
    name: "dd",
    description: "d",
    metadata: { source: "claude-hook", named: true },
  });
  db.prepare(`UPDATE sessions SET status = 'stale' WHERE id = 'wake-dedup'`).run();
  makeTranscript("wake-dedup", "C:/Project folder/项目/muiltchat");
  // dryRun is a pure preview (no side effects), so simulate the dedup key a
  // real wake would have stamped
  const first = wakeSessionForMail(db, "wake-dedup", {
    dryRun: true,
    now: new Date("2026-08-16T11:59:00Z"),
    claudeHome: FAKE_HOME,
  });
  assert.equal(first.woke, true, "no in-flight wake → wakeable");
  setSetting(db, "auto-wake:wake-dedup", "2026-08-16T12:00:00Z");
  const second = wakeSessionForMail(db, "wake-dedup", {
    dryRun: true,
    now: new Date("2026-08-16T12:01:00Z"),
    claudeHome: FAKE_HOME,
  });
  assert.deepEqual(second, { woke: false, reason: "wake already in flight" });
  // past the dedup window it may wake again
  const third = wakeSessionForMail(db, "wake-dedup", {
    dryRun: true,
    now: new Date("2026-08-16T12:05:00Z"),
    claudeHome: FAKE_HOME,
  });
  assert.equal(third.woke, true);
});

test("auto_wake setting round-trips with default on", () => {
  assert.equal(getAutoWake(db), true);
  setAutoWake(db, false);
  assert.equal(getAutoWake(db), false);
  setAutoWake(db, true);
  assert.equal(getAutoWake(db), true);
});
