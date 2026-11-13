import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDb, stopWalCheckpoint, type DB } from "../core/db.js";
import { createRuntimeAgent } from "../core/runtime-agents.js";
import { getMessage } from "../core/messages.js";
import { registerSession } from "../core/sessions.js";
import type { RuntimeAgent } from "@conflux/shared";
import { ManagedCodexManager, setManagedCodexManager } from "../core/managed-codex/manager.js";
import { sanitizeApprovalPayload } from "../core/managed-codex/approvals.js";

// Approval semantics against the shim's @approval turn (real child
// processes — SERIAL *.e2e.ts suite; see the process-e2e note in
// runtime-instances-process.e2e.ts): requests are
// recorded sanitized and pause the run; decisions are applied exactly once,
// only while the receiving connection generation is still live; dead
// connections expire their approvals instead of showing answerable.

const shimPath = resolve(__dirname, "managed-codex-shim.cjs");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | undefined, ms = 8000, what = "condition"): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(50);
  }
}

interface Fixture {
  db: DB;
  dir: string;
  manager: ManagedCodexManager;
  agent: RuntimeAgent;
  sessionId: string;
  instanceId: string;
  dispose: () => Promise<void>;
}

async function makeFixture(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "managed-codex-appr-"));
  const db = openDb({ dataDir: dir, dbPath: join(dir, "data.db"), scope: "global" });
  const projectDir = join(dir, "project");
  mkdirSync(projectDir, { recursive: true });
  const agent = createRuntimeAgent(db, {
    name: "approval fixture",
    runtime: "codex",
    workdir: projectDir,
    execution_mode: "managed",
  });
  const manager = new ManagedCodexManager(db, {
    resolveLaunch: () => ({
      executable: shimPath,
      args: [],
      env: { ...process.env, SHIM_LOG: join(dir, "shim-rpc.log"), SHIM_CWD: projectDir },
      cwd: projectDir,
    }),
  });
  setManagedCodexManager(manager);
  const { instance } = await manager.start(agent);
  const binding = db
    .prepare(`SELECT session_id FROM managed_codex_bindings WHERE instance_id = ?`)
    .get(instance.id) as { session_id: string };
  return {
    db,
    dir,
    manager,
    agent,
    sessionId: binding.session_id,
    instanceId: instance.id,
    dispose: async () => {
      await manager.shutdown();
      setManagedCodexManager(null);
      stopWalCheckpoint(db);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function insertAsk(fx: Fixture, question: string): number {
  registerSession(fx.db, { id: "asker", name: "asker" });
  fx.db
    .prepare(
      `INSERT INTO messages (from_session, to_session, question, status, created_at)
       VALUES ('asker', ?, ?, 'pending', ?)`,
    )
    .run(fx.sessionId, question, new Date().toISOString());
  return Number(
    (fx.db.prepare(`SELECT id FROM messages WHERE question = ?`).get(question) as { id: number }).id,
  );
}

function runRow(fx: Fixture, messageId: number) {
  return fx.db
    .prepare(`SELECT id, state FROM managed_codex_runs WHERE message_id = ?`)
    .get(messageId) as { id: number; state: string } | undefined;
}

test("approval payload sanitization drops policy amendments and keeps the decision surface", () => {
  const sanitized = sanitizeApprovalPayload("commandExecution", {
    kind: "command",
    threadId: "t",
    turnId: "tu",
    itemId: "it",
    startedAtMs: 1,
    command: "npm install fixture-pkg",
    cwd: "C:\\tmp",
    reason: "network",
    proposedExecpolicyAmendment: { sensitive: "policy-blob" },
    proposedNetworkPolicyAmendments: [{ host: "*.internal" }],
    environmentId: "env-secret",
  });
  assert.deepEqual(Object.keys(sanitized).sort(), ["command", "cwd", "itemId", "kind", "reason"]);
  const fileChange = sanitizeApprovalPayload("fileChange", {
    threadId: "t",
    grantRoot: "C:\\shared",
    reason: "outside workspace",
    nested: { deep: { secret: 1 } },
  });
  assert.deepEqual(Object.keys(fileChange).sort(), ["grantRoot", "itemId", "reason"]);
});

test("an approval pauses the run, records sanitized data, and resumes on accept", async () => {
  const fx = await makeFixture();
  try {
    const messageId = insertAsk(fx, "@approval accept path");
    await fx.manager.enqueue({
      messageId,
      instanceId: fx.instanceId,
      text: "@approval accept path",
    });
    const run = await waitFor(
      () => (runRow(fx, messageId)?.state === "waiting_approval" ? runRow(fx, messageId) : undefined),
      8000,
      "waiting_approval",
    );
    // The stored payload is sanitized decision surface, nothing more.
    const approval = fx.db
      .prepare(`SELECT * FROM managed_codex_approvals WHERE run_id = ?`)
      .get(run!.id) as { id: number; request_kind: string; payload: string; state: string };
    assert.equal(approval.request_kind, "commandExecution");
    assert.equal(approval.state, "pending");
    const payload = JSON.parse(approval.payload) as Record<string, unknown>;
    assert.ok(payload.command);
    assert.equal("proposedExecpolicyAmendment" in payload, false);

    const status = fx.manager.instanceStatus(fx.instanceId);
    assert.deepEqual(
      status.pendingApprovals.map((a) => a.id),
      [approval.id],
    );

    const ok = await fx.manager.resolveApproval(fx.instanceId, approval.id, "accept");
    assert.deepEqual(ok, { ok: true });

    await waitFor(
      () => (runRow(fx, messageId)?.state === "completed" ? true : undefined),
      8000,
      "completed",
    );
    assert.equal(getMessage(fx.db, messageId)!.reply, "shim final answer");
  } finally {
    await fx.dispose();
  }
});

test("decline answers the agent and still completes the turn honestly", async () => {
  const fx = await makeFixture();
  try {
    const messageId = insertAsk(fx, "@approval decline path");
    await fx.manager.enqueue({
      messageId,
      instanceId: fx.instanceId,
      text: "@approval decline path",
    });
    const run = await waitFor(
      () => (runRow(fx, messageId)?.state === "waiting_approval" ? runRow(fx, messageId) : undefined),
      8000,
      "waiting_approval",
    );
    const approval = fx.db
      .prepare(`SELECT id FROM managed_codex_approvals WHERE run_id = ?`)
      .get(run!.id) as { id: number };
    await fx.manager.resolveApproval(fx.instanceId, approval.id, "decline");
    await waitFor(
      () => (runRow(fx, messageId)?.state === "completed" ? true : undefined),
      8000,
      "completed after decline",
    );
  } finally {
    await fx.dispose();
  }
});

test("resolving the same approval twice conflicts; unknown ids 404; bad decisions 400", async () => {
  const fx = await makeFixture();
  try {
    const messageId = insertAsk(fx, "@approval double answer");
    await fx.manager.enqueue({
      messageId,
      instanceId: fx.instanceId,
      text: "@approval double answer",
    });
    const run = await waitFor(
      () => (runRow(fx, messageId)?.state === "waiting_approval" ? runRow(fx, messageId) : undefined),
      8000,
      "waiting_approval",
    );
    const approval = fx.db
      .prepare(`SELECT id FROM managed_codex_approvals WHERE run_id = ?`)
      .get(run!.id) as { id: number };

    const bad = await fx.manager.resolveApproval(fx.instanceId, approval.id, "acceptForSession");
    assert.equal(bad.ok, false);
    assert.equal((bad as { status: number }).status, 400);

    const unknown = await fx.manager.resolveApproval(fx.instanceId, 999999, "accept");
    assert.equal((unknown as { status: number }).status, 404);

    const first = await fx.manager.resolveApproval(fx.instanceId, approval.id, "accept");
    assert.equal(first.ok, true);
    const second = await fx.manager.resolveApproval(fx.instanceId, approval.id, "decline");
    assert.equal(second.ok, false);
    assert.equal((second as { status: number }).status, 409, "double answer is a conflict");
  } finally {
    await fx.dispose();
  }
});

test("approvals die with their connection generation", async () => {
  const fx = await makeFixture();
  try {
    const messageId = insertAsk(fx, "@approval then crash");
    await fx.manager.enqueue({
      messageId,
      instanceId: fx.instanceId,
      text: "@approval then crash",
    });
    const run = await waitFor(
      () => (runRow(fx, messageId)?.state === "waiting_approval" ? runRow(fx, messageId) : undefined),
      8000,
      "waiting_approval",
    );
    const approval = fx.db
      .prepare(`SELECT id FROM managed_codex_approvals WHERE run_id = ?`)
      .get(run!.id) as { id: number };

    // Kill the child out-of-band (crash, not graceful shutdown): the death
    // hook must expire the approval and mark the run unknown.
    const live = fx.manager.getLiveInstanceIds();
    assert.deepEqual(live, [fx.instanceId]);
    fx.manager.crashForTest(fx.instanceId);
    await waitFor(
      () =>
        (
          fx.db
            .prepare(`SELECT state FROM managed_codex_approvals WHERE id = ?`)
            .get(approval.id) as { state: string }
        ).state === "expired"
        ? true
        : undefined,
      8000,
      "approval expired",
    );
    assert.equal(runRow(fx, messageId)!.state, "unknown");
    const late = await fx.manager.resolveApproval(fx.instanceId, approval.id, "accept");
    assert.equal((late as { status: number }).status, 409);
    // Instance row ended; status endpoint now 404s.
    assert.throws(() => fx.manager.instanceStatus(fx.instanceId), /not running/);
  } finally {
    await fx.dispose();
  }
});
