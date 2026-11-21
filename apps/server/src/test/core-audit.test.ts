import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs, { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { join, dirname } from "node:path";
import { makeDb } from "./helpers.js";
import { registerSession, markStaleSessions } from "../core/sessions.js";
import { askSession, recordExchange, listEdgeMessages, gatherUnseenMail, formatTypedMailPrompt, replyAsk } from "../core/messages.js";
import { recordApproval } from "../core/managed-codex/approvals.js";
import { enqueueManagedTask, upsertManagedBinding } from "../core/managed-codex/store.js";
import { createRuntimeAgent, runScheduledAgent } from "../core/runtime-agents.js";
import { exportData, importData } from "../core/data-transfer.js";
import { clearData } from "../core/data-clear.js";
import { setSetting, getSetting } from "../core/app-settings.js";
import { createTask, summonAgent, writeResult } from "../core/room-orchestrator.js";
import { realTmuxIO } from "../core/wake/tmux-inject.js";
import { readRuntimeSessionName, getRuntimeProcess } from "../core/live.js";
import { findCodexRolloutPath } from "../core/codex-rollout.js";
import { defaultCodexLaunch } from "../core/managed-codex/adapter.js";
import { launchWakeRun, pinCodexDescendants } from "../core/wake/launcher.js";
import { refreshCodexSessionTitles } from "../core/codex-titles.js";
import { createChatRoom, listChatRooms } from "../core/chat-rooms.js";
import { createAgent } from "../core/agents.js";
import { createConversation, addTurn } from "../core/conversations.js";
import { resolveOnPath } from "../core/terminal.js";
import { completeAsk, prepareAsk } from "../core/ask.js";

test("priority-only registration preserves existing identity and connection metadata", () => {
  const { db, cleanup } = makeDb();
  try {
    registerSession(db, { id: "a", name: "a", metadata: { mcp_connection_id: "lease", runtime_instance_id: "inst", busy: true } });
    const updated = registerSession(db, { id: "a", name: "renamed", priority: "P0" });
    assert.deepEqual(JSON.parse(updated.metadata!), { mcp_connection_id: "lease", runtime_instance_id: "inst", busy: true, priority: "P0" });
  } finally { cleanup(); }
});

test("missing asker never leaves a phantom channel", () => {
  const { db, cleanup } = makeDb();
  try {
    registerSession(db, { id: "b", name: "b" });
    assert.throws(() => askSession(db, { from_session: "gone", to_session: "b", question: "q" }), /session not found/);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM edges").get() as { n: number }).n, 0);
  } finally { cleanup(); }
});

test("failed message insertion rolls back its channel mutation", () => {
  const { db, cleanup } = makeDb();
  try {
    for (const id of ["a", "b"]) registerSession(db, { id, name: id });
    db.exec("CREATE TRIGGER reject_message BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'rejected'); END");
    assert.throws(() => askSession(db, { from_session: "a", to_session: "b", question: "q" }), /rejected/);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM edges").get() as { n: number }).n, 0);
  } finally { cleanup(); }
});

test("archived exchanges remain on one channel and reject self-exchanges", () => {
  const { db, cleanup } = makeDb();
  try {
    for (const id of ["a", "b"]) registerSession(db, { id, name: id });
    const m = recordExchange(db, { from_session: "a", to_session: "b", question: "q", reply: "a" });
    assert.ok(m.edge_id);
    assert.equal(listEdgeMessages(db, m.edge_id!).length, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM edges").get() as { n: number }).n, 1);
    assert.throws(() => recordExchange(db, { from_session: "a", to_session: "a", question: "q" }), /cannot ask yourself/);
  } finally { cleanup(); }
});

test("mail notices use the channel identity when message and edge IDs differ", () => {
  const { db, cleanup } = makeDb();
  try {
    for (const id of ["a", "b"]) registerSession(db, { id, name: id });
    askSession(db, { from_session: "a", to_session: "b", question: "old" });
    const m = askSession(db, { from_session: "a", to_session: "b", question: "q" });
    replyAsk(db, m.id, "b", "x".repeat(2000));
    const items = gatherUnseenMail(db, "a");
    assert.match(items[0].body, new RegExp(`channel show ${m.edge_id} `));
    assert.match(formatTypedMailPrompt(items)!, new RegExp(`全文 channel show ${m.edge_id}(?:$| )`));
  } finally { cleanup(); }
});

test("reused RPC request IDs return each newly persisted approval", () => {
  const { db, cleanup } = makeDb();
  try {
    for (const id of ["a", "b"]) registerSession(db, { id, name: id });
    upsertManagedBinding(db, { instanceId: "inst", sessionId: "b", threadId: "thread", ownerToken: "owner" });
    const message = askSession(db, { from_session: "a", to_session: "b", question: "q" });
    const run = enqueueManagedTask(db, { instanceId: "inst", messageId: message.id, text: "q" });
    const input = { runId: run.id, rpcRequestId: "0", kind: "commandExecution" as const, payload: {} };
    const first = recordApproval(db, input);
    const second = recordApproval(db, input);
    assert.notEqual(second.id, first.id);
  } finally { cleanup(); }
});

test("backup roundtrip retains managed runtime execution mode", () => {
  const source = makeDb();
  const target = makeDb();
  try {
    createRuntimeAgent(source.db, { name: "managed", runtime: "codex", execution_mode: "managed" });
    const bundle = exportData(source.db);
    assert.equal(bundle.runtime_agents[0].execution_mode, "managed");
    importData(target.db, bundle);
    assert.equal((target.db.prepare("SELECT execution_mode FROM runtime_agents").get() as { execution_mode: string }).execution_mode, "managed");
  } finally { source.cleanup(); target.cleanup(); }
});

test("stale-session polling stays readable while another WAL writer holds the lock", () => {
  const { db, cleanup } = makeDb();
  const writer = new Database(db.name);
  try {
    registerSession(db, { id: "a", name: "a" });
    db.pragma("busy_timeout = 1");
    writer.exec("BEGIN IMMEDIATE");
    assert.equal(markStaleSessions(db), 0);
  } finally { writer.exec("ROLLBACK"); writer.close(); cleanup(); }
});

test("message clearing also clears its graph channels", () => {
  const { db, cleanup } = makeDb();
  try {
    for (const id of ["a", "b"]) registerSession(db, { id, name: id });
    askSession(db, { from_session: "a", to_session: "b", question: "q" });
    clearData(db, { messages: true }, join(dirname(db.name), "backups"));
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM edges").get() as { n: number }).n, 0);
  } finally { cleanup(); }
});

test("session clearing removes managed bindings, room tasks and session identity markers", () => {
  const { db, cleanup } = makeDb();
  try {
    registerSession(db, { id: "a", name: "a" });
    upsertManagedBinding(db, { instanceId: "inst", sessionId: "a", threadId: "thread", ownerToken: "owner" });
    createTask(db, { room_id: 1, initiator_session_id: "a", executor_session_id: "a", prompt: "q" });
    for (const key of ["claude-current:1", "codex-current:2", "auto-wake:a"]) setSetting(db, key, "a");
    clearData(db, { sessions: true }, join(dirname(db.name), "backups"));
    for (const table of ["managed_codex_bindings", "room_tasks"]) assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0);
    assert.equal(getSetting(db, "codex-current:2"), null);
    assert.equal(getSetting(db, "auto-wake:a"), null);
  } finally { cleanup(); }
});

test("room summons and completion notifications target stamped runtime instance tmux sessions", (t) => {
  const { db, cleanup } = makeDb();
  const targets: string[] = [];
  t.mock.method(realTmuxIO, "alive", (name: string) => name.endsWith("-inst"));
  t.mock.method(realTmuxIO, "send", (name: string) => { targets.push(name); return true; });
  try {
    for (const id of ["a", "b"]) registerSession(db, { id, name: id, runtime: "codex", metadata: { agent_id: id === "a" ? 1 : 2, tmux_session: `conflux/agent-${id === "a" ? 1 : 2}-inst` } });
    const summoned = summonAgent(db, { room_id: 1, initiator_session_id: "a", executor_session_id: "b", prompt: "q" });
    assert.equal(summoned.method, "tmux");
    writeResult(db, { task_id: summoned.task.id, task_token: summoned.task.task_token, result: "done" });
    assert.deepEqual(targets, ["conflux/agent-2-inst", "conflux/agent-1-inst"]);
  } finally { cleanup(); }
});

test("Claude runtime names respect CLAUDE_CONFIG_DIR", () => {
  const { db, cleanup } = makeDb();
  const previous = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = join(dirname(db.name), "claude");
    mkdirSync(join(process.env.CLAUDE_CONFIG_DIR, "sessions"), { recursive: true });
    writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, "sessions", "987654321.json"), JSON.stringify({ name: "custom title", nameSource: "user" }));
    assert.equal(readRuntimeSessionName(undefined, 987654321)?.name, "custom title");
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
    cleanup();
  }
});

test("managed launches never use an in-memory database marker as CONFLUX_HOME", () => {
  const { db, cleanup } = makeDb();
  const memory = new Database(":memory:");
  try {
    memory.exec("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const agent = createRuntimeAgent(db, { name: "m", runtime: "codex", execution_mode: "managed" });
    assert.notEqual(defaultCodexLaunch(memory, agent).env.CONFLUX_HOME, ":memory:");
  } finally { memory.close(); cleanup(); }
});

test("wake log capture uses the resolved database data directory", async () => {
  const { db, cleanup } = makeDb();
  try {
    const result = launchWakeRun({ db, sessionId: "audit-wake", projectDir: null, command: `"${process.execPath}" -e "process.stdout.write('audit-wake-output')" --`, prompt: "", pinCodex: false });
    assert.equal(result.ok, true);
    const logPath = join(dirname(db.name), "wake-logs", "audit-wake.log");
    const deadline = Date.now() + 5000;
    let output = "";
    while (Date.now() < deadline) {
      try { output = readFileSync(logPath, "utf8"); } catch { /* Child has not opened the log yet. */ }
      if (output.includes("[wake ended ")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.match(output, /audit-wake-output/);
  } finally { cleanup(); }
});

test("empty Codex title refresh performs no rollout directory scans", (t) => {
  const { db, cleanup } = makeDb();
  const home = join(dirname(db.name), "codex");
  const now = new Date();
  mkdirSync(join(home, "sessions", String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")), { recursive: true });
  const reads: string[] = [];
  t.mock.method(fs, "readdirSync", (path: string) => { reads.push(String(path)); return []; });
  try {
    assert.equal(refreshCodexSessionTitles(db, { codexHome: home }), 0);
    assert.deepEqual(reads, []);
  } finally { cleanup(); }
});

test("room listing batches member queries regardless of room count", (t) => {
  const { db, cleanup } = makeDb();
  try {
    for (let i = 0; i < 5; i++) createChatRoom(db, { name: `room-${i}`, members: [] });
    const sql: string[] = [];
    const prepare = db.prepare.bind(db);
    t.mock.method(db, "prepare", (query: string) => { sql.push(query); return prepare(query); });
    assert.equal(listChatRooms(db).length, 5);
    assert.ok(sql.length <= 2, `expected batched rooms/members, got ${sql.length} queries`);
  } finally { cleanup(); }
});

test("adding a turn does not reread its conversation history", (t) => {
  const { db, cleanup } = makeDb();
  try {
    const agent = createAgent(db, { name: "a", system_prompt: "a", model_config: { provider: "openai", model: "fixture" } });
    const conversation = createConversation(db, { agent_id: agent.id });
    addTurn(db, { conversation_id: conversation.id, role: "user", content: "first" });
    const sql: string[] = [];
    const prepare = db.prepare.bind(db);
    t.mock.method(db, "prepare", (query: string) => { sql.push(query); return prepare(query); });
    assert.equal(addTurn(db, { conversation_id: conversation.id, role: "assistant", content: "second" }).content, "second");
    assert.ok(!sql.some((query) => /SELECT \* FROM turns WHERE conversation_id/.test(query)));
  } finally { cleanup(); }
});

test("terminal lookup does not retry a definitive executable-not-found result", (t) => {
  let calls = 0;
  t.mock.method(childProcess, "spawnSync", () => { calls++; return { status: 1, stdout: "" }; });
  assert.equal(resolveOnPath("missing", {}, "win32"), null);
  assert.equal(calls, 1);
});

test("channel, room, binding and approval lookup indexes are installed", () => {
  const { db, cleanup } = makeDb();
  try {
    for (const [table, columns] of [["sessions", "chat_room_id"], ["messages", "edge_id,id"], ["messages", "room_id,id"], ["messages", "from_session,to_session,id"], ["room_tasks", "room_id,initiator_session_id,status"], ["managed_codex_bindings", "session_id"], ["managed_codex_approvals", "run_id,state"]]) {
      const indexes = db.pragma(`index_list(${table})`) as { name: string }[];
      assert.ok(indexes.some(({ name }) => (db.pragma(`index_info(${name})`) as { name: string }[]).map((column) => column.name).join(",") === columns), `${table}(${columns}) index missing`);
    }
  } finally { cleanup(); }
});

test("Codex descendant pinning uses POSIX process discovery outside Windows", (t) => {
  const { db, cleanup } = makeDb();
  const files: string[] = [];
  t.mock.method(childProcess, "execFile", (file: string, _args: string[], _opts: unknown, callback: (error: null, stdout: string) => void) => {
    files.push(file);
    callback(null, "200 100 /usr/bin/codex exec\n");
  });
  try {
    pinCodexDescendants(db, 100, "a", { platform: "linux" });
    assert.equal(files[0], "/bin/ps");
    assert.equal(getSetting(db, "codex-current:200"), "a");
  } finally { cleanup(); }
});

test("late descendant callbacks tolerate a database closed after the wake", (t) => {
  const { db, cleanup } = makeDb();
  let complete!: (error: null, stdout: string) => void;
  t.mock.method(childProcess, "execFile", (_file: string, _args: string[], _opts: unknown, callback: typeof complete) => { complete = callback; });
  pinCodexDescendants(db, 100, "a");
  cleanup();
  assert.doesNotThrow(() => complete(null, "200"));
});

test("scheduled child exit cannot throw a SQLite lock error into the event loop", async (t) => {
  const { db, cleanup } = makeDb();
  const writer = new Database(db.name);
  const child = Object.assign(new EventEmitter(), { unref() {} });
  t.mock.method(childProcess, "spawn", () => child);
  try {
    const agent = createRuntimeAgent(db, { name: "schedule", runtime: "codex", interval_min: 1 });
    runScheduledAgent(db, agent.id);
    db.pragma("busy_timeout = 1");
    writer.exec("BEGIN IMMEDIATE");
    assert.doesNotThrow(() => child.emit("exit", 0));
  } finally {
    writer.exec("ROLLBACK"); writer.close();
    await new Promise((resolve) => setTimeout(resolve, 60));
    cleanup();
  }
});

test("managed dispatch retries a transient enqueue lock without duplicating the message", async (t) => {
  const { db, cleanup } = makeDb();
  try {
    for (const id of ["a", "b"]) registerSession(db, { id, name: id });
    upsertManagedBinding(db, { instanceId: "inst", sessionId: "b", threadId: "thread", ownerToken: "owner" });
    const prepared = prepareAsk(db, { from_session: "a", to_session: "b", question: "q" });
    const prepare = db.prepare.bind(db);
    let failed = false;
    t.mock.method(db, "prepare", (sql: string) => {
      if (!failed && /INSERT INTO managed_codex_runs/.test(sql)) {
        failed = true;
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      }
      return prepare(sql);
    });
    assert.equal((await completeAsk(db, prepared)).wake.woke, true);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM managed_codex_runs").get() as { n: number }).n, 1);
  } finally { cleanup(); }
});

test("Windows runtime discovery runs inline via -EncodedCommand without creating disk helpers", { skip: process.platform !== "win32" }, (t) => {
  const { db, cleanup } = makeDb();
  const previous = process.env.CONFLUX_HOME;
  const previousPid = process.env.CONFLUX_CODEX_PID;
  try {
    const home = join(dirname(db.name), "conflux-unused");
    process.env.CONFLUX_HOME = home;
    delete process.env.CONFLUX_CODEX_PID;
    let seenArgs: readonly string[] = [];
    t.mock.method(
      childProcess,
      "execFileSync",
      (_file: string, args: readonly string[] = []) => {
        seenArgs = args;
        return "321";
      },
    );
    assert.equal(getRuntimeProcess("codex")?.pid, 321);
    assert.ok(seenArgs.includes("-EncodedCommand"), "uses inline -EncodedCommand");
    assert.equal(fs.existsSync(join(home, "find-runtime.ps1")), false, "never writes find-runtime.ps1");
  } finally {
    if (previous === undefined) delete process.env.CONFLUX_HOME; else process.env.CONFLUX_HOME = previous;
    if (previousPid === undefined) delete process.env.CONFLUX_CODEX_PID; else process.env.CONFLUX_CODEX_PID = previousPid;
    cleanup();
  }
});

test("Codex rollout lookup respects CODEX_HOME", () => {
  const { db, cleanup } = makeDb();
  const previous = process.env.CODEX_HOME;
  try {
    const home = join(dirname(db.name), "codex");
    const now = new Date();
    const directory = join(home, "sessions", String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0"));
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "rollout-audit-custom-home.jsonl");
    writeFileSync(path, "{}");
    process.env.CODEX_HOME = home;
    assert.equal(findCodexRolloutPath("audit-custom-home"), path);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    cleanup();
  }
});
