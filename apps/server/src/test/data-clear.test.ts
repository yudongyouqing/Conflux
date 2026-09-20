import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDb } from "./helpers.js";
import type { DB } from "../core/db.js";
import { registerSession } from "../core/sessions.js";
import { publishContext } from "../core/context.js";
import { importData } from "../core/data-transfer.js";
import { setSetting, getSetting } from "../core/app-settings.js";
import { getClearableCounts, clearData } from "../core/data-clear.js";

const cleanups: Array<() => void> = [];
after(() => cleanups.forEach((c) => c()));

function freshDb(): DB {
  const { db, cleanup } = makeDb();
  cleanups.push(cleanup);
  return db;
}

function seed(db: DB): void {
  registerSession(db, { id: "s1", name: "one" });
  registerSession(db, { id: "s2", name: "two" });
  registerSession(db, { id: "web-console", name: "Web 控制台" });
  db.prepare(
    "INSERT INTO messages (from_session, to_session, question, status, created_at) VALUES ('s1','s2','q','replied','2026-01-01T00:00:00Z')",
  ).run();
  db.prepare(
    "INSERT INTO edges (from_session, to_session, weight, last_interact_at) VALUES ('s1','s2',1,'2026-01-01T00:00:00Z')",
  ).run();
  publishContext(db, { session_id: "s1", title: "t", content: "c" });
  db.prepare(
    "INSERT INTO runtime_agents (name, runtime, created_at, updated_at) VALUES ('preset','claude','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
  ).run();
  setSetting(db, "claude-current:4242", "s1");
}

function tmpBackupDir(): string {
  return mkdtempSync(join(tmpdir(), "clear-backup-"));
}

test("getClearableCounts reports per-category counts excluding web-console", () => {
  const db = freshDb();
  seed(db);
  const c = getClearableCounts(db);
  assert.equal(c.sessions, 2, "web-console 不计入可清除数");
  assert.equal(c.messages, 1);
  assert.equal(c.contextEntries, 1);
});

test("clearing sessions cascades messages/context/edges, keeps web-console + presets + backup restorable", () => {
  const db = freshDb();
  seed(db);
  const backupDir = tmpBackupDir();
  const r = clearData(db, { sessions: true }, backupDir);
  assert.equal(r.cleared.sessions, 2);
  assert.equal(r.cleared.messages, 1, "级联删除的消息计数");
  assert.equal(r.cleared.contextEntries, 1);
  const ids = (db.prepare("SELECT id FROM sessions").all() as { id: string }[]).map((x) => x.id);
  assert.deepEqual(ids, ["web-console"]);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM edges").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM context_entries").get() as { n: number }).n, 0);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM runtime_agents").get() as { n: number }).n,
    1,
    "runtime agent 预设不受影响",
  );
  // 备份落地且可恢复
  const files = readdirSync(backupDir).filter((f) => f.startsWith("clear-backup-"));
  assert.equal(files.length, 1);
  const bundle = JSON.parse(readFileSync(join(backupDir, files[0]), "utf8"));
  importData(db, bundle, { conflict: "skip" });
  const restored = (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;
  assert.equal(restored, 3, "导入后 s1/s2/web-console 回来");
  rmSync(backupDir, { recursive: true, force: true });
});

test("clearing sessions purges stale claude-current:* settings", () => {
  const db = freshDb();
  seed(db);
  const backupDir = tmpBackupDir();
  clearData(db, { sessions: true }, backupDir);
  assert.equal(getSetting(db, "claude-current:4242"), null, "孤儿 pid 映射随会话清除");
  rmSync(backupDir, { recursive: true, force: true });
});

test("clearing messages keeps session nodes; clearing context keeps sessions+messages", () => {
  const db = freshDb();
  seed(db);
  const backupDir = tmpBackupDir();
  clearData(db, { messages: true }, backupDir);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n, 3, "节点保留");

  clearData(db, { context: true }, backupDir);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM context_entries").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n, 3);
  rmSync(backupDir, { recursive: true, force: true });
});

test("empty categories is a no-op without writing a backup", () => {
  const db = freshDb();
  seed(db);
  const backupDir = tmpBackupDir();
  const r = clearData(db, {}, backupDir);
  assert.equal(r.backupPath, null);
  assert.equal(readdirSync(backupDir).length, 0);
  rmSync(backupDir, { recursive: true, force: true });
});

test("backup rotation keeps only the newest 5 files", () => {
  const db = freshDb();
  seed(db);
  const backupDir = tmpBackupDir();
  for (let i = 0; i < 7; i++) {
    const f = join(backupDir, `clear-backup-2026-01-0${i + 1}T00.00.00.000Z.json`);
    writeFileSync(f, "{}", "utf8");
    const past = new Date(Date.parse("2026-01-01T00:00:00Z") + i * 1000);
    utimesSync(f, past, past);
  }
  const r = clearData(db, { messages: true }, backupDir);
  assert.ok(r.backupPath);
  const files = readdirSync(backupDir).filter((f) => f.startsWith("clear-backup-"));
  assert.equal(files.length, 5, "滚动保留 5 份");
  assert.ok(files.some((f) => f === r.backupPath!.split("/").pop()), "新备份在内");
  rmSync(backupDir, { recursive: true, force: true });
});
