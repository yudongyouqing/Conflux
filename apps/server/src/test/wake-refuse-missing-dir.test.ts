import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchWakeRun } from "../core/wake/launcher.js";
import { wakeSessionForMail } from "../core/wake/index.js";
import { openDb } from "../core/db.js";
import { resolveConfig } from "../config.js";
import { registerSession } from "../core/sessions.js";
import { setAutoWake } from "../core/app-settings.js";

// A wake aimed at a session whose project directory no longer exists must
// be a RECORDED refusal — spawning with a dead cwd surfaces as an async
// ENOENT on the shell itself, which used to take the whole daemon down
// with an unhandled ChildProcess error. No fallback directory either:
// quietly waking in another cwd would read the wrong files and mounts.

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "conflux-refuse-"));
}

test("launchWakeRun refuses a missing project dir instead of spawning", () => {
  const home = tempHome();
  process.env.CONFLUX_HOME = home;
  const db = openDb(resolveConfig("global"));
  try {
    let spawned = 0;
    const missingDir = join(home, "deleted-project");
    const base = {
      db,
      sessionId: "refuse-probe",
      dataDir: home,
      projectDir: missingDir,
      command: "echo must-never-run",
      prompt: "wake probe",
      pinCodex: true,
      onSpawned: () => {
        spawned++;
      },
    };

    for (const dryRun of [false, true]) {
      const result = launchWakeRun({ ...base, dryRun });
      assert.equal(result.ok, false, `dryRun=${dryRun}`);
      assert.equal(spawned, 0, `dryRun=${dryRun}: nothing may be spawned`);
      if (!result.ok) assert.match(result.error, /project dir missing/);
    }
  } finally {
    delete process.env.CONFLUX_HOME;
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("wakeSessionForMail records the refusal as a failed wake", () => {
  const home = tempHome();
  process.env.CONFLUX_HOME = home;
  const db = openDb(resolveConfig("global"));
  try {
    setAutoWake(db, true);
    registerSession(db, {
      id: "ghost-project-session",
      name: "ghost",
      description: null,
      project_dir: join(home, "deleted-project"),
      metadata: { source: "claude-hook", runtime: "claude" },
    });

    // active + idle claude reaches the headless launcher (fresh wake form);
    // the missing directory must stop it there with a recorded reason
    const result = wakeSessionForMail(db, "ghost-project-session");
    assert.equal(result.woke, false);
    assert.match(result.reason, /project dir missing/);
    assert.equal(result.disposition, "failed");
  } finally {
    delete process.env.CONFLUX_HOME;
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});
