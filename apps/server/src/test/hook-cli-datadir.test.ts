import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { openDb } from "../core/db.js";
import { registerSession, getSession } from "../core/sessions.js";

for (const event of ["session-start", "prompt", "stop"] as const) {
  test(`hook ${event} honors --data-dir over a different CONFLUX_HOME`, () => {
    const root = mkdtempSync(join(tmpdir(), "conflux-hook-cli-"));
    const selected = join(root, "selected-a");
    const ambient = join(root, "ambient-b");
    const profile = join(root, "profile");
    const project = join(root, "project");
    for (const directory of [selected, ambient, profile, project]) {
      mkdirSync(directory, { recursive: true });
    }
    const a = openDb({ dataDir: selected, dbPath: join(selected, "data.db"), scope: "global" });
    const b = openDb({ dataDir: ambient, dbPath: join(ambient, "data.db"), scope: "global" });
    const id = `isolated-hook-${event}`;
    try {
      if (event !== "session-start") {
        for (const db of [a, b]) {
          registerSession(db, {
            id,
            name: "original",
            project_dir: project,
            metadata: { busy: event === "stop", user_named: true },
          });
        }
      }
      const ambientBefore = b.prepare("SELECT * FROM sessions ORDER BY id").all();
      const entry = resolve(__dirname, "../index.ts");
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", entry, "--data-dir", selected, "hooks", "dispatch", event],
        {
          cwd: resolve(__dirname, "../../../.."),
          env: {
            ...process.env,
            CONFLUX_HOME: ambient,
            HOME: profile,
            USERPROFILE: profile,
            CLAUDE_CONFIG_DIR: join(profile, ".claude"),
            CODEX_HOME: join(profile, ".codex"),
          },
          input: JSON.stringify({ session_id: id, cwd: project, prompt: "test prompt" }),
          encoding: "utf8",
          timeout: 20_000,
          windowsHide: true,
        },
      );
      assert.equal(result.status, 0, result.stderr || result.error?.message || "hook command failed");
      const session = getSession(a, id);
      assert.ok(session, "the selected database must contain the hook session");
      if (event === "prompt" || event === "stop") {
        const metadata = JSON.parse(session.metadata || "{}");
        assert.equal(metadata.busy, event === "prompt", "update must land in the selected database");
      }
      assert.deepEqual(
        b.prepare("SELECT * FROM sessions ORDER BY id").all(),
        ambientBefore,
        "the environment-selected database must remain unchanged",
      );
    } finally {
      a.close();
      b.close();
      assert.equal(dirname(root), tmpdir());
      assert.ok(basename(root).startsWith("conflux-hook-cli-"));
      rmSync(root, { recursive: true, force: true });
    }
  });
}
