import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "../config.js";
import { openDb, stopWalCheckpoint } from "../core/db.js";
import { getSession, registerSession } from "../core/sessions.js";

const cliEntry = fileURLToPath(new URL("../index.ts", import.meta.url));

function runHookDispatch(
  args: string[],
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", cliEntry, ...args],
    {
      input: JSON.stringify(payload),
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: 15_000,
    },
  );
  assert.equal(result.error, undefined, `hook spawn failed: ${result.error?.message}`);
  assert.equal(
    result.status,
    0,
    `hook dispatch exited ${result.status}: ${result.stderr || result.stdout}`,
  );
  return result;
}

function parseBusy(metadata: string | null | undefined): unknown {
  if (!metadata) return undefined;
  return (JSON.parse(metadata) as Record<string, unknown>).busy;
}

test("hooks dispatch honors explicit --data-dir over CONFLUX_HOME for session-start, prompt, and stop", () => {
  const dirA = mkdtempSync(join(tmpdir(), "conflux-hook-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "conflux-hook-b-"));
  const sid = "hook-isolated-session-01";
  try {
    // Point CONFLUX_HOME at B, but explicitly target A via --data-dir
    runHookDispatch(
      ["--data-dir", dirA, "hooks", "dispatch", "session-start"],
      { session_id: sid, cwd: dirA },
      { CONFLUX_HOME: dirB },
    );

    const dbA1 = openDb(resolveConfig("global", dirA));
    const rowA1 = getSession(dbA1, sid);
    stopWalCheckpoint(dbA1);
    dbA1.close();
    assert.ok(rowA1, "session-start wrote session to explicit --data-dir A");

    const dbB1 = openDb(resolveConfig("global", dirB));
    const rowB1 = getSession(dbB1, sid);
    assert.equal(rowB1, null, "CONFLUX_HOME database B stayed untouched on session-start");

    // Seed the same session id in B so prompt/stop isolation is proven directly
    registerSession(dbB1, { id: sid, name: "same-id-in-b", project_dir: dirB });
    stopWalCheckpoint(dbB1);
    dbB1.close();

    runHookDispatch(
      ["--data-dir", dirA, "hooks", "dispatch", "prompt"],
      { session_id: sid, cwd: dirA, prompt: "only for database A" },
      { CONFLUX_HOME: dirB },
    );

    const dbA2 = openDb(resolveConfig("global", dirA));
    const rowA2 = getSession(dbA2, sid);
    stopWalCheckpoint(dbA2);
    dbA2.close();
    assert.equal(parseBusy(rowA2?.metadata), true, "prompt marked session busy in A");

    const dbB2 = openDb(resolveConfig("global", dirB));
    const rowB2 = getSession(dbB2, sid);
    stopWalCheckpoint(dbB2);
    dbB2.close();
    assert.equal(rowB2?.name, "same-id-in-b", "prompt did not rename session in B");
    assert.equal(parseBusy(rowB2?.metadata), undefined, "prompt did not mark B busy");

    runHookDispatch(
      ["--data-dir", dirA, "hooks", "dispatch", "stop"],
      { session_id: sid, cwd: dirA },
      { CONFLUX_HOME: dirB },
    );

    const dbA3 = openDb(resolveConfig("global", dirA));
    const rowA3 = getSession(dbA3, sid);
    stopWalCheckpoint(dbA3);
    dbA3.close();
    assert.equal(parseBusy(rowA3?.metadata), false, "stop cleared busy flag in A");

    const dbB3 = openDb(resolveConfig("global", dirB));
    const rowB3 = getSession(dbB3, sid);
    stopWalCheckpoint(dbB3);
    dbB3.close();
    assert.equal(parseBusy(rowB3?.metadata), undefined, "stop did not mutate metadata in B");
  } finally {
    for (const dir of [dirA, dirB]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows WAL locks can linger briefly; temp dir is disposable.
      }
    }
  }
});
