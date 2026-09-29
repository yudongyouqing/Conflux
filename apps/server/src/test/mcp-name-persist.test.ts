import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleHookEvent } from "../core/live.js";
import { registerSession, getSession } from "../core/sessions.js";
import { makeDb } from "./helpers.js";

const cleanups: Array<() => void> = [];
after(() => cleanups.forEach((c) => c()));

function freshDb() {
  const { db, cleanup } = makeDb();
  cleanups.push(cleanup);
  return db;
}

function fakeHome(): string {
  return mkdtempSync(join(tmpdir(), "muiltchat-name-persist-"));
}

test("a user_named session (MCP register_session path) survives hook directory naming", async (t) => {
  const db = freshDb();
  const home = fakeHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));

  // what the MCP register_session tool now produces: explicit name + flag
  registerSession(db, {
    id: "mcp-named-1",
    name: "Conflux 开发主会话",
    description: "自述",
  });
  db.prepare(
    `UPDATE sessions SET metadata = json_set(COALESCE(metadata,'{}'), '$.user_named', json('true')) WHERE id = 'mcp-named-1'`,
  ).run();

  // next user message fires the prompt hook → directory naming must NOT clobber
  handleHookEvent(
    db,
    "prompt",
    { session_id: "mcp-named-1", cwd: "/Users/x/code/Conflux", prompt: "下一条消息" },
    home,
  );
  assert.equal(getSession(db, "mcp-named-1")!.name, "Conflux 开发主会话");

  // and stop events must not clobber it either
  handleHookEvent(db, "stop", { session_id: "mcp-named-1", cwd: "/Users/x/code/Conflux" }, home);
  assert.equal(getSession(db, "mcp-named-1")!.name, "Conflux 开发主会话");
});
