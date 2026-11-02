import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { wakeRunEnv } from "../core/wake/launcher.js";
import { cleanTerminalEnv } from "../core/terminal.js";

// Cross-database regression: every spawn channel that carries a Conflux
// identity into a child process must pin the child to THIS server's data
// directory. Before the fix, a server running on a custom data dir woke
// executors (and opened resume terminals) whose CLI/MCP silently fell back
// to the default ~/.muiltchat — the room-task executors could not see the
// task rows that summoned them. Two isolated directories prove the child
// lands in its own, never the sibling's and never the default.

const entry = resolve(__dirname, "../index.ts");

function resolvedDataDir(env: NodeJS.ProcessEnv): { dataDir: string; dbPath: string } {
  const stdout = execFileSync(
    process.execPath,
    ["--import", "tsx", entry, "path"],
    { env, encoding: "utf8", cwd: resolve(__dirname, "../../..") },
  );
  const config = JSON.parse(stdout.slice(stdout.indexOf("{"))) as {
    dataDir: string;
    dbPath: string;
  };
  return config;
}

test("wake env pins the child to the summoning server's data directory", () => {
  const dirA = mkdtempSync(join(tmpdir(), "conflux-home-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "conflux-home-b-"));
  try {
    const envA = wakeRunEnv({ dataDir: dirA });
    assert.equal(envA.CONFLUX_HOME, dirA, "the wake env must carry the summoner's data dir");

    // The real CLI, run under exactly that env, must resolve dirA — and
    // only dirA's database may come into existence. dirB stays untouched.
    const resolved = resolvedDataDir(envA);
    assert.equal(resolved.dataDir, dirA);
    assert.equal(resolved.dbPath, join(dirA, "data.db"));
    assert.equal(existsSync(join(dirA, "data.db")), false, "path must not create the database");
    assert.equal(existsSync(dirB), true, "the sibling directory is never touched");

    // The same construction for dirB resolves dirB: no channel is baked to
    // one directory, and neither falls back to the default home.
    const envB = wakeRunEnv({ dataDir: dirB });
    assert.equal(resolvedDataDir(envB).dataDir, dirB);
    assert.notEqual(envA.CONFLUX_HOME, envB.CONFLUX_HOME);
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("cleanTerminalEnv keeps CONFLUX_HOME but still drops session-scoped vars", () => {
  const env = cleanTerminalEnv({
    CONFLUX_HOME: "/custom/home",
    CLAUDECODE: "1",
    ANTHROPIC_API_KEY: "secret",
    PATH: "/usr/bin",
  });
  assert.equal(env.CONFLUX_HOME, "/custom/home");
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.PATH, "/usr/bin");
});
