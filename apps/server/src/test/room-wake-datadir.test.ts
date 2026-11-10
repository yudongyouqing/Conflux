import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDb } from "../core/db.js";
import { resolveConfig } from "../config.js";
import {
  ensureWakeMcpConfig,
  launchWakeRun,
  pinnedMcpLaunch,
} from "../core/wake/launcher.js";
import { wrapRoomTaskPrompt } from "../core/room-orchestrator.js";

// A wake launched by a server on a NON-default database must carry that
// database to the executor through every channel: the spawn env AND the
// mounted conflux MCP (pinned via --data-dir, env-independent). The room
// task prompt must also name its room so executors can read context once
// their MCP lands on the orchestrator's database.

function isolatedDb() {
  const home = mkdtempSync(join(tmpdir(), "conflux-room-wake-"));
  process.env.CONFLUX_HOME = home;
  const db = openDb(resolveConfig("global"));
  return { db, home };
}

test("pinnedMcpLaunch pins the mounted MCP to the given data dir", () => {
  const launch = pinnedMcpLaunch("C:/tmp/some-home");
  assert.equal(launch.command, process.execPath);
  const dirIdx = launch.args.indexOf("--data-dir");
  assert.ok(dirIdx >= 0, "launch must pass --data-dir");
  assert.equal(launch.args[dirIdx + 1], "C:/tmp/some-home");
  assert.equal(launch.args[launch.args.length - 1], "mcp");
});

test("ensureWakeMcpConfig writes the pinned mount under the given data dir", () => {
  const home = mkdtempSync(join(tmpdir(), "conflux-mcp-json-"));
  try {
    const path = ensureWakeMcpConfig(home, undefined, pinnedMcpLaunch(home));
    assert.equal(path, join(home, "wake-mcp.json"));
    const config = JSON.parse(readFileSync(path, "utf8")) as {
      mcpServers: { conflux: { args: string[] } };
    };
    const dirIdx = config.mcpServers.conflux.args.indexOf("--data-dir");
    assert.ok(dirIdx >= 0, "mounted MCP must be pinned to the data dir");
    assert.equal(config.mcpServers.conflux.args[dirIdx + 1], home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a claude wake derives dataDir from the db handle and pins its MCP mount", () => {
  const { db, home } = isolatedDb();
  try {
    const result = launchWakeRun({
      db,
      sessionId: "room-wake-probe",
      // an existing dir so the missing-project refusal does not short-circuit
      projectDir: home,
      command: "claude --resume room-wake-probe",
      prompt: "probe",
      pinCodex: false,
      dryRun: true,
    });
    assert.equal(result.ok, true);
    // the mount config lands in the ORCHESTRATOR's home, not the global one
    const mcpPath = join(home, "wake-mcp.json");
    assert.ok(existsSync(mcpPath), "wake-mcp.json must be written under the db's dir");
    const config = JSON.parse(readFileSync(mcpPath, "utf8")) as {
      mcpServers: { conflux: { args: string[] } };
    };
    const dirIdx = config.mcpServers.conflux.args.indexOf("--data-dir");
    assert.equal(config.mcpServers.conflux.args[dirIdx + 1], home);
    if (result.ok) assert.match(result.command, /wake-mcp\.json/);
  } finally {
    delete process.env.CONFLUX_HOME;
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("wrapRoomTaskPrompt names the room, task and one-shot token", () => {
  const wrapped = wrapRoomTaskPrompt(7, 12, "tok-abc", "请分析代码");
  assert.match(wrapped, /room_id=7/);
  assert.match(wrapped, /task_id=12/);
  assert.match(wrapped, /task_token="tok-abc"/);
  assert.match(wrapped, /请分析代码/);
});

test("db-derived dataDir equals dirname(db.name)", () => {
  const { db, home } = isolatedDb();
  try {
    assert.equal(dirname(db.name), home);
  } finally {
    delete process.env.CONFLUX_HOME;
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});
