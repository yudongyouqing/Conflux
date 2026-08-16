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
} from "../core/runtime-agents.js";
import { registerSession } from "../core/sessions.js";
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
