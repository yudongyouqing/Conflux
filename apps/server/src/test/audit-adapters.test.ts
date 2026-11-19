import { exportData } from "../core/data-transfer.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { dirname, join } from "node:path";
import { writeFileSync } from "node:fs";
import { makeDb } from "./helpers.js";
import { createServerContext } from "../http/context.js";
import { registerSettingsRoutes } from "../http/routes/settings.js";
import { registerRuntimeRoutes } from "../http/routes/runtimes.js";
import { registerWakeStreamRoutes } from "../http/routes/wake-stream.js";
import { registerAgentRoutes } from "../http/routes/agents.js";
import { createChatRoom } from "../core/chat-rooms.js";
import { registerChatRoomRoutes } from "../http/routes/chat-rooms.js";
import { registerSessionRoutes } from "../http/routes/sessions.js";
import { registerSystemRoutes } from "../http/routes/system.js";
import { registerSession } from "../core/sessions.js";
import { publishContext } from "../core/context.js";
import { buildCli } from "../cli/commands.js";
import { upsertManagedBinding } from "../core/managed-codex/store.js";

async function fixture(t: import("node:test").TestContext) {
  const { db, cleanup } = makeDb();
  const app = Fastify();
  const ctx = createServerContext(db, { dataDir: dirname(db.name), port: 0 });
  t.after(async () => { await app.close(); cleanup(); });
  return { db, app, ctx };
}

test("terminal HTTP settings accept every macOS choice", async (t) => {
  const { app, ctx } = await fixture(t);
  registerSettingsRoutes(app, ctx);
  for (const terminal of ["terminal", "iterm", "tmux"]) {
    const res = await app.inject({ method: "PUT", url: "/settings/terminal", payload: { terminal } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().terminal.terminal, terminal);
  }
});

test("runtime HTTP accepts null schedule and validates execution mode", async (t) => {
  const { app, ctx } = await fixture(t);
  registerRuntimeRoutes(app, ctx);
  const valid = await app.inject({ method: "POST", url: "/runtimes", payload: { name: "managed", runtime: "codex", interval_min: null, execution_mode: "managed" } });
  assert.equal(valid.statusCode, 201, valid.body);
  const invalid = await app.inject({ method: "POST", url: "/runtimes", payload: { name: "bad", runtime: "codex", execution_mode: "bogus" } });
  assert.equal(invalid.statusCode, 400, invalid.body);
});

test("wake log rejects encoded path traversal", async (t) => {
  const { app, ctx } = await fixture(t);
  registerWakeStreamRoutes(app, ctx);
  writeFileSync(join(ctx.dataDir, "private.log"), "private fixture");
  for (const endpoint of ["log", "stream"]) {
    const res = await app.inject({ method: "GET", url: `/wake/..%2fprivate/${endpoint}` });
    assert.equal(res.statusCode, 400, res.body);
    assert.ok(!res.body.includes("private fixture"));
  }
});

test("provider connectivity validates missing body", async (t) => {
  const { app, ctx } = await fixture(t);
  registerAgentRoutes(app, ctx);
  const res = await app.inject({ method: "POST", url: "/agents/test-provider" });
  assert.equal(res.statusCode, 400, res.body);
});

test("project HTTP export selects requested client project", async (t) => {
  const { app, db, ctx } = await fixture(t);
  registerSystemRoutes(app, ctx);
  registerSession(db, { id: "client-session", name: "client", project_dir: "C:/client-project" });
  registerSession(db, { id: "other-session", name: "other", project_dir: "C:/other-project" });
  const res = await app.inject({ method: "GET", url: "/data/export?scope=project&project_dir=C%3A%2Fclient-project" });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().sessions.map((s: { id: string }) => s.id), ["client-session"]);
});

test("remote CLI omits JSON type on bodyless requests and forwards project selection", async (t) => {
  const calls: { url: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response("{}", { status: 200 });
  });
  t.mock.method(console, "log", () => {});
  await buildCli().parseAsync(["--http", "http://fixture", "context", "delete", "--id", "1"], { from: "user" });
  assert.equal(new Headers(calls[0].init.headers).has("Content-Type"), false);
  await buildCli().parseAsync(["--http", "http://fixture", "data", "export", "--scope", "project", "--project-dir", "C:/client project"], { from: "user" });
  assert.equal(new URL(calls[1].url).searchParams.get("project_dir"), "C:/client project");
});


test("one-shot local CLI closes its SQLite connection on success and failure", async (t) => {
  const { db } = await fixture(t);
  const prototype = Object.getPrototypeOf(db) as { close: () => unknown };
  const original = prototype.close;
  let closes = 0;
  t.mock.method(prototype, "close", function (this: typeof db) { closes++; return original.call(this); });
  t.mock.method(console, "log", () => {});
  await buildCli().parseAsync(["--data-dir", dirname(db.name), "sessions", "list", "--status", "all"], { from: "user" });
  assert.equal(closes, 1);
  registerSession(db, { id: "owner", name: "owner" });
  const entry = publishContext(db, { session_id: "owner", title: "owned", content: "owned" });
  await assert.rejects(buildCli().parseAsync(["--data-dir", dirname(db.name), "context", "delete", "--id", String(entry.id)], { from: "user" }));
  assert.equal(closes, 2);
});

test("CLI version follows the package version", () => {
  assert.equal(buildCli().version(), "0.3.1");
});


test("open terminal resumes native Codex thread and declared alternate runtime", async (t) => {
  const { db, app, ctx } = await fixture(t);
  const commands: string[] = [];
  registerSessionRoutes(app, ctx, (_settings, input) => { commands.push(input.command); return { opener: "fixture" }; });
  registerSession(db, { id: "conflux-codex", name: "codex", runtime: "codex", metadata: { codex_session_id: "native-thread" } });
  registerSession(db, { id: "cursor-thread", name: "cursor", metadata: { runtime: "cursor" } });
  for (const id of ["conflux-codex", "cursor-thread"]) {
    const res = await app.inject({ method: "POST", url: `/sessions/${id}/open-terminal` });
    assert.equal(res.statusCode, 200, res.body);
  }
  assert.match(commands[0], /resume.*native-thread/);
  assert.match(commands[1], /cursor-agent.*--resume.*cursor-thread/);
});

test("open terminal refuses managed thread bindings before launching another writer", async (t) => {
  const { db, app, ctx } = await fixture(t);
  const commands: string[] = [];
  registerSessionRoutes(app, ctx, (_settings, input) => { commands.push(input.command); return { opener: "fixture" }; });
  for (const status of ["active", "ended"]) {
    const sessionId = `codex-managed-${status}`;
    registerSession(db, { id: sessionId, name: status, runtime: "codex", metadata: { managed_thread_id: `native-${status}` } });
    db.prepare("UPDATE sessions SET status = ? WHERE id = ?").run(status, sessionId);
    upsertManagedBinding(db, { instanceId: `managed-${status}`, sessionId, threadId: `native-${status}`, ownerToken: "owner" });
    const res = await app.inject({ method: "POST", url: `/sessions/${sessionId}/open-terminal` });
    assert.equal(res.statusCode, 409, res.body);
    assert.match(res.json().error, /managed runtime controls/);
  }
  assert.deepEqual(commands, []);
});

test("import preserves database lock error status", async (t) => {
  const { app, ctx } = await fixture(t);
  ctx.write = async () => { throw Object.assign(new Error("locked fixture"), { code: "SQLITE_BUSY" }); };
  registerSystemRoutes(app, ctx);
  const res = await app.inject({ method: "POST", url: "/data/import", payload: { bundle: {} } });
  assert.equal(res.statusCode, 503, res.body);
  assert.equal(res.json().code, "DATA_LOCKED");
});

test("remote session end reports unsupported action", async () => {
  await assert.rejects(buildCli().parseAsync(["--http", "http://fixture", "sessions", "end", "--id", "session"], { from: "user" }), /does not support --http/);
});


test("numeric HTTP resources reject malformed ids and required room bodies", async (t) => {
  const { app, ctx } = await fixture(t);
  registerAgentRoutes(app, ctx);
  registerChatRoomRoutes(app, ctx);
  for (const url of ["/agents/abc/conversations", "/conversations/abc/turns", "/chat-rooms/abc/messages", "/chat-rooms/abc/orchestrate"]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 400, url + res.body);
  }
  for (const url of ["/chat-rooms", "/chat-rooms/1/join", "/chat-rooms/leave", "/chat-rooms/1/summon", "/chat-rooms/1/broadcast"]) {
    const res = await app.inject({ method: "POST", url, payload: {} });
    assert.equal(res.statusCode, 400, url + res.body);
  }
});


test("room summon returns the public task id without executor token", async (t) => {
  const { app, ctx, db } = await fixture(t);
  registerChatRoomRoutes(app, ctx);
  registerSession(db, { id: "web-console", name: "console" });
  registerSession(db, { id: "offline-audit-executor", name: "offline" });
  const room = createChatRoom(db, { name: "audit", members: ["offline-audit-executor"] });
  const res = await app.inject({ method: "POST", url: `/chat-rooms/${room.id}/summon`, payload: { executor_session_id: "offline-audit-executor", prompt: "fixture" } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(typeof res.json().task_id, "number");
  assert.equal("task" in res.json(), false);
  assert.ok(!res.body.includes("task_token"));
});


test("import rejects duplicate bundle ids as a client validation error", async (t) => {
  const { app, db, ctx } = await fixture(t);
  registerSystemRoutes(app, ctx);
  registerSession(db, { id: "duplicate-import", name: "fixture" });
  const bundle = exportData(db);
  bundle.sessions.push({ ...bundle.sessions[0] });
  const res = await app.inject({ method: "POST", url: "/data/import", payload: { bundle } });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().code, "BAD_REQUEST");
});
