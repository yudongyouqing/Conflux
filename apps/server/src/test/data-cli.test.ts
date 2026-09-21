import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCli } from "../cli/commands.js";
import { openDb } from "../core/db.js";
import { registerSession } from "../core/sessions.js";

async function runCli(args: string[]): Promise<string> {
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (value?: unknown) => output.push(String(value));
  try {
    const program = buildCli("conflux").exitOverride();
    await program.parseAsync(["node", "conflux", ...args]);
    return output.join("\n");
  } finally {
    console.log = originalLog;
  }
}

test("conflux data counts + data clear via CLI", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "muiltchat-data-cli-"));

  const db = openDb({ dataDir, dbPath: join(dataDir, "data.db"), scope: "global" });
  registerSession(db, { id: "s1", name: "one" });
  registerSession(db, { id: "web-console", name: "Web 控制台" });

  // node:test runs t.after hooks in REGISTRATION order (FIFO), and a
  // throwing hook skips every hook after it — so connections must close
  // before the directory delete (Windows: deleting an open data.db gives
  // EBUSY), and the delete itself must never throw.
  t.after(() => db.close());
  t.after(() => {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // disposable temp dir — leave it behind rather than fail the test
    }
  });

  const counts = await runCli(["--data-dir", dataDir, "data", "counts"]);
  assert.match(counts, /"sessions":1/);
  assert.match(counts, /"messages":0/);

  await runCli(["--data-dir", dataDir, "data", "clear", "--sessions"]);

  const left = (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;
  assert.equal(left, 1, "web-console 保留，s1 清除");
  const backups = readdirSync(join(dataDir, "backups"));
  assert.equal(backups.length, 1, "清除前自动备份");
});
