import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers.js";
import type { DB } from "../core/db.js";
import { registerSession } from "../core/sessions.js";
import { searchSessions } from "../core/sessions.js";

const cleanups: Array<() => void> = [];
after(() => cleanups.forEach((c) => c()));
function freshDb(): DB {
  const { db, cleanup } = makeDb();
  cleanups.push(cleanup);
  return db;
}

function seed(db: DB) {
  registerSession(db, {
    id: "me-p2",
    name: "提问者",
    description: "P2 会话",
    metadata: { priority: "P2" },
  });
  registerSession(db, {
    id: "peer-p2",
    name: "同级 Postgres 专家",
    description: "管数据库迁移",
    metadata: { priority: "P2", agent_card: { skills: ["postgres", "sql"] } },
  });
  registerSession(db, {
    id: "senior-p0",
    name: "P0 架构师",
    description: "postgres 顶层设计",
    metadata: { priority: "P0" },
  });
  registerSession(db, {
    id: "mid-p1",
    name: "P1 DBA",
    description: "postgres 日常运维",
    metadata: { priority: "P1" },
  });
  registerSession(db, {
    id: "dead-p2",
    name: "离线的 PG 备份员",
    description: "postgres 冷备",
    metadata: { priority: "P2" },
  });
  db.prepare("UPDATE sessions SET status = 'stale' WHERE id = 'dead-p2'").run();
}

test("askableFrom filters to priorities the caller may ask (rank >= caller)", () => {
  const db = freshDb();
  seed(db);
  const ids = searchSessions(db, "postgres", { askableFrom: "me-p2" }).map((s) => s.id);
  assert.ok(ids.includes("peer-p2"), "同级 P2 可搜到");
  assert.ok(!ids.includes("senior-p0"), "P0 目标不可见（问会被拒）");
  assert.ok(!ids.includes("mid-p1"), "P1 目标不可见");
});

test("askableFrom excludes the caller itself even on keyword match", () => {
  const db = freshDb();
  seed(db);
  registerSession(db, {
    id: "me2-p2",
    name: "postgres 自述者",
    description: "自己也是个 postgres",
    metadata: { priority: "P2" },
  });
  const ids = searchSessions(db, "postgres", { askableFrom: "me2-p2" }).map((s) => s.id);
  assert.ok(!ids.includes("me2-p2"), "排除调用者自身");
});

test("P0 caller sees everything askable", () => {
  const db = freshDb();
  seed(db);
  registerSession(db, { id: "me-p0", name: "老板", metadata: { priority: "P0" } });
  const ids = searchSessions(db, "postgres", { askableFrom: "me-p0" }).map((s) => s.id);
  assert.ok(ids.includes("peer-p2") && ids.includes("senior-p0") && ids.includes("mid-p1"));
});

test("activeOnly drops stale sessions", () => {
  const db = freshDb();
  seed(db);
  const ids = searchSessions(db, "postgres", { activeOnly: true }).map((s) => s.id);
  assert.ok(!ids.includes("dead-p2"), "stale 不可见");
  const all = searchSessions(db, "postgres").map((s) => s.id);
  assert.ok(all.includes("dead-p2"), "默认行为不变：不过滤");
});

test("default call signature unchanged (no options)", () => {
  const db = freshDb();
  seed(db);
  const n = searchSessions(db, "postgres").length;
  assert.ok(n >= 4, "默认返回全部匹配（含 P0/P1/stale）");
});
