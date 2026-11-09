import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDb } from "../core/db.js";
import { resolveConfig } from "../config.js";
import { launchWakeRun } from "../core/wake/launcher.js";
import { wakeSessionForMail } from "../core/wake/index.js";
import { registerSession } from "../core/sessions.js";
import { setAutoWake } from "../core/app-settings.js";
import type { DB } from "../core/db.js";

// Pin policy: EVERY wake/managed launch this server controls carries an
// explicit same-database MCP mount. A project's existing .mcp.json can name
// a conflux server, but nothing confirms it targets the orchestrator's
// library — presence alone must never bypass pinning.

interface Fixture {
  db: DB;
  a: string;
  b: string;
  project: string;
  root: string;
}

function isolated(run: (fx: Fixture) => void) {
  const root = mkdtempSync(join(tmpdir(), "cfx-wake-pin-"));
  const a = join(root, "orchestrator-a");
  const b = join(root, "ambient-b");
  const project = join(root, "project");
  for (const dir of [a, b, project]) mkdirSync(dir, { recursive: true });
  const previous = process.env.CONFLUX_HOME;
  process.env.CONFLUX_HOME = b; // ambient points at the WRONG library
  const db = openDb(resolveConfig("global", a)); // the handle points at A
  try {
    return run({ db, a, b, project, root });
  } finally {
    db.close();
    if (previous === undefined) delete process.env.CONFLUX_HOME;
    else process.env.CONFLUX_HOME = previous;
    assert.equal(dirname(root), tmpdir(), "cleanup guard: only our temp root");
    assert.ok(root.includes("cfx-wake-pin-"), "cleanup guard: right prefix");
    rmSync(root, { recursive: true, force: true });
  }
}

test("an existing project mount to database B must not bypass database A pinning", () =>
  isolated(({ db, project, b }) => {
    // the project carries its OWN conflux mount — aimed at the ambient B
    writeFileSync(
      join(project, ".mcp.json"),
      JSON.stringify({
        mcpServers: { conflux: { command: process.execPath, args: ["server.js", "--data-dir", b, "mcp"] } },
      }),
    );
    const result = launchWakeRun({
      db,
      sessionId: "pin-project",
      projectDir: project,
      command: "claude -p",
      prompt: "test",
      pinCodex: false,
      dryRun: true,
    });
    assert.ok(!result.ok || result.command.includes("--mcp-config"), "an unconfirmed mount must never bypass the pinned launch");
    if (result.ok) {
      const cfg = JSON.parse(
        readFileSync(join(dirname(db.name), "wake-mcp.json"), "utf8"),
      ) as { mcpServers: { conflux: { args: string[] } } };
      const args = cfg.mcpServers.conflux.args;
      assert.equal(args[args.indexOf("--data-dir") + 1], dirname(db.name));
    }
  }));

test("tmux resume uses the database handle instead of ambient CONFLUX_HOME", () =>
  isolated(({ db, a, project, root }) => {
    const sid = "pin-offline";
    const claudeHome = join(root, "fake-claude");
    mkdirSync(join(claudeHome, "projects", "fixture"), { recursive: true });
    writeFileSync(join(claudeHome, "projects", "fixture", `${sid}.jsonl`), "{}\n");
    registerSession(db, { id: sid, name: "offline", project_dir: project, metadata: { runtime: "claude" } });
    db.prepare(`UPDATE sessions SET status='stale' WHERE id=?`).run(sid);
    setAutoWake(db, true);
    const result = wakeSessionForMail(db, sid, {
      dryRun: true,
      claudeHome,
      io: {
        available: () => true,
        alive: () => false,
        paneForPid: () => null,
        send: () => true,
        capture: () => "",
        launch: () => {
          throw new Error("dry-run must not launch tmux");
        },
      },
    });
    assert.equal(result.woke, true);
    assert.equal(
      existsSync(join(a, "wake-mcp.json")),
      true,
      "tmux wrote its config to the ambient database instead of the orchestrator's",
    );
    const cfg = JSON.parse(readFileSync(join(a, "wake-mcp.json"), "utf8")) as {
      mcpServers: { conflux: { args: string[] } };
    };
    const args = cfg.mcpServers.conflux.args;
    assert.equal(args[args.indexOf("--data-dir") + 1], a);
  }));

test("codex wake must provide an explicit library mount or refuse the wake", () =>
  isolated(({ db, project }) => {
    const command = "codex exec --skip-git-repo-check -";
    const result = launchWakeRun({
      db,
      sessionId: "pin-codex",
      projectDir: project,
      command,
      prompt: "test",
      pinCodex: true,
      dryRun: true,
    });
    assert.ok(
      !result.ok || result.command !== command,
      "codex command returned unchanged: no pinned mount survives env scrubbing",
    );
    if (result.ok) {
      // the override must pin the mount to the orchestrator's database
      const dirIdx = result.command.indexOf("mcp_servers.conflux.args=");
      assert.ok(dirIdx >= 0, "codex override args missing");
      assert.ok(result.command.includes(dirname(db.name)), "codex mount not pinned to the db handle's dir");
    }
  }));
