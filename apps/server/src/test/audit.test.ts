import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers.js";
import { logAudit, queryAudit } from "../core/audit.js";

const { db, cleanup } = makeDb();
after(cleanup);

test("logAudit stores entries queryable by filters", () => {
  logAudit(db, { caller_session: "s1", interface: "mcp", action: "ask_session", args: { to: "s2" }, result: { id: 1 } });
  logAudit(db, { caller_session: "s2", interface: "http", action: "publish_context", args: { title: "t" }, result: { id: 2 } });
  logAudit(db, { caller_session: "s1", interface: "cli", action: "ask_session", args: { to: "s3" }, result: { id: 3 } });

  const byAction = queryAudit(db, { action: "ask_session" });
  assert.equal(byAction.length, 2);
  assert.ok(byAction.every((e) => e.action === "ask_session"));

  const bySession = queryAudit(db, { session: "s1" });
  assert.equal(bySession.length, 2);

  const byIface = queryAudit(db, { iface: "http" });
  assert.equal(byIface.length, 1);
  assert.equal(byIface[0].action, "publish_context");
});

test("queryAudit orders newest-first and respects limit", () => {
  for (let i = 0; i < 5; i++) {
    logAudit(db, { interface: "cli", action: `bulk-${i}` });
  }
  const top = queryAudit(db, { limit: 3 });
  assert.equal(top.length, 3);
  assert.equal(top[0].action, "bulk-4", "newest entry first");
});

test("oversized args get truncated with marker", () => {
  const huge = "x".repeat(8 * 1024);
  logAudit(db, { interface: "mcp", action: "huge", args: { blob: huge } });
  const [e] = queryAudit(db, { action: "huge" });
  const parsed = JSON.parse(e.args!);
  assert.equal(parsed._truncated, true);
  assert.ok(parsed.length > 8 * 1024);
});

