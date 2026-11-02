import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openDb, stopWalCheckpoint } from "../core/db.js";

// While another process holds the SQLite write lock, a writing MCP tool
// must fail once with the MAPPED, readable error — not leak a raw
// SQLITE_BUSY, not crash the tool call by throwing from the error-audit
// write, and not wait a second busy-timeout on that audit row (the same
// double-stall fixed for HTTP in #272). Wall time is a loose guard only:
// CI runners oversleep sqlite's incremental busy callback.
const BUSY_TIMEOUT_MS = 10000;

test("mcp writing tool under a held lock returns a mapped error once, then recovers", { timeout: 90000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "muiltchat-mcp-lock-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !/^(CONFLUX_|CLAUDE_|CODEX_)/.test(entry[0]),
    ),
  );
  Object.assign(env, {
    HOME: directory,
    USERPROFILE: directory,
    CODEX_HOME: directory,
    CLAUDE_CONFIG_DIR: directory,
    CONFLUX_LOG_LEVEL: "silent",
    CONFLUX_CLAUDE_PID: "0",
    CONFLUX_CODEX_PID: "0",
  });

  const client = new Client({ name: "mcp-lock-test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        resolve(__dirname, "../index.ts"),
        "--data-dir",
        directory,
        "mcp",
      ],
      env,
      stderr: "pipe",
    }),
  );
  t.after(() => client.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const block = (result.content as { type: string; text?: string }[]).find(
      (item) => item.type === "text",
    );
    return JSON.parse(block!.text!);
  };

  // A healthy write first, so the session is registered. Tools return
  // the payload directly (e.g. { entry }) on success and { error } on failure.
  const healthy = await call("publish_context", {
    title: "healthy",
    content: "healthy write",
    tags: ["lock-test"],
  });
  assert.ok(healthy.entry?.id > 0);

  // An external CLI/MCP-style writer holds the lock on the same file.
  const locker = openDb({
    dataDir: directory,
    dbPath: join(directory, "data.db"),
    scope: "global",
  });
  t.after(() => {
    stopWalCheckpoint(locker);
    locker.close();
  });
  t.after(() => {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // disposable temp dir — leave it behind rather than fail the test
    }
  });
  await locker.exec("BEGIN IMMEDIATE");
  const registeredSession = locker
    .prepare(`SELECT id FROM sessions ORDER BY created_at LIMIT 1`)
    .get() as { id: string };
  locker
    .prepare(
      `INSERT INTO context_entries (session_id, title, content, created_at, updated_at)
       VALUES (?, 'held', 'held row', datetime('now'), datetime('now'))`,
    )
    .run(registeredSession.id);

  const startedAt = Date.now();
  const blocked = await call("publish_context", {
    title: "contended",
    content: "contended write",
    tags: ["lock-test"],
  });
  const elapsedMs = Date.now() - startedAt;
  assert.ok(typeof blocked.error === "string", "the contended write must report failure");
  assert.ok(
    !/database is locked|SQLITE/i.test(blocked.error),
    `raw lock error leaked to the model: ${blocked.error}`,
  );
  assert.ok(elapsedMs >= BUSY_TIMEOUT_MS - 1000, "the real busy timeout must elapse");
  assert.ok(elapsedMs < 3 * BUSY_TIMEOUT_MS, "no second full wait on the audit row");

  // Release; the same write recovers and the rollback leaves no residue.
  locker.exec("ROLLBACK");
  const recovered = await call("publish_context", {
    title: "recovered",
    content: "recovered write",
    tags: ["lock-test"],
  });
  assert.ok(recovered.entry?.id > 0);
  const held = locker
    .prepare(`SELECT COUNT(*) AS n FROM context_entries WHERE title = 'held'`)
    .get() as { n: number };
  assert.equal(held.n, 0);
});
