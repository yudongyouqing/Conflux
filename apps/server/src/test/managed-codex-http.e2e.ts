import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDb, stopWalCheckpoint, type DB } from "../core/db.js";
import { appendManagedEvent } from "../core/managed-codex/store.js";
import { createRuntimeAgent } from "../core/runtime-agents.js";
import { stopRuntimeInstance } from "../core/runtime-instances.js";
import { registerSession } from "../core/sessions.js";
import { WEB_CONSOLE_ID } from "@conflux/shared";
import { createServerContext } from "../http/context.js";
import { registerManagedCodexRoutes } from "../http/routes/managed-codex.js";
import { ManagedCodexManager, setManagedCodexManager } from "../core/managed-codex/manager.js";

// HTTP contract for the managed executor via Fastify inject (real child
// processes behind the routes — SERIAL *.e2e.ts suite): status and
// event replay for live instances, interrupts carrying expected_turn_id,
// and the approval boundary — only the human console identity may answer,
// the actor is never taken from the body, and errors classify as
// 400/403/404/409 instead of ambiguous 500s.

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

interface HttpFixture {
  db: DB;
  dir: string;
  app: ReturnType<typeof Fastify>;
  manager: ManagedCodexManager;
  instanceId: string;
  sessionId: string;
  dispose: () => Promise<void>;
}

async function makeHttpFixture(): Promise<HttpFixture> {
  const dir = mkdtempSync(join(tmpdir(), "managed-codex-http-"));
  const db = openDb({ dataDir: dir, dbPath: join(dir, "data.db"), scope: "global" });
  const projectDir = join(dir, "project");
  mkdirSync(projectDir, { recursive: true });
  const agent = createRuntimeAgent(db, {
    name: "http fixture",
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
  const app = Fastify();
  registerManagedCodexRoutes(app, createServerContext(db, { dataDir: dir, port: 0 }));
  return {
    db,
    dir,
    app,
    manager,
    instanceId: instance.id,
    sessionId: binding.session_id,
    dispose: async () => {
      await app.close();
      await manager.shutdown();
      setManagedCodexManager(null);
      stopWalCheckpoint(db);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("managed status endpoint returns binding, runs and current execution; unknown instances 404", async () => {
  const fx = await makeHttpFixture();
  try {
    const ok = await fx.app.inject({ method: "GET", url: `/runtime-instances/${fx.instanceId}/managed` });
    assert.equal(ok.statusCode, 200);
    const body = ok.json() as {
      binding: { thread_id: string };
      current: { live: boolean; threadId: string; activeRun: unknown; pendingApprovals: unknown[] };
      runs: unknown[];
    };
    assert.equal(body.binding.thread_id, "shim-thread-0001");
    assert.equal(body.current.live, true);
    assert.equal(body.current.threadId, "shim-thread-0001");
    assert.deepEqual(body.current.pendingApprovals, []);

    const missing = await fx.app.inject({ method: "GET", url: "/runtime-instances/nope/managed" });
    assert.equal(missing.statusCode, 404);

    // A TERMINAL-mode instance row alone must not qualify for the persisted
    // view — only a managed trace (binding/runs) does.
    fx.db
      .prepare(
        `INSERT INTO runtime_instances (id, preset_id, preset_name, runtime, preset_snapshot, state, created_at, updated_at)
         VALUES ('terminal-inst-1', 1, 'terminal preset', 'claude', '{}', 'ended', ?, ?)`,
      )
      .run(new Date().toISOString(), new Date().toISOString());
    const terminal = await fx.app.inject({
      method: "GET",
      url: "/runtime-instances/terminal-inst-1/managed",
    });
    assert.equal(terminal.statusCode, 404, "non-managed instance ids stay 404");

    appendManagedEvent(fx.db, { instanceId: fx.instanceId, type: "text", payload: { text: "replayed text" } });
    const events = await fx.app.inject({
      method: "GET",
      url: `/runtime-instances/${fx.instanceId}/managed/events`,
    });
    assert.equal(events.statusCode, 200);
    const replay = events.json().events;
    assert.ok(replay.length > 0);
    assert.equal(typeof replay[0].payload, "object");
    assert.equal("instance_id" in replay[0], false);
  } finally {
    await fx.dispose();
  }
});

test("interrupt endpoint accepts expected_turn_id and reports nothing-to-interrupt", async () => {
  const fx = await makeHttpFixture();
  try {
    const idle = await fx.app.inject({
      method: "POST",
      url: `/runtime-instances/${fx.instanceId}/managed/interrupt`,
      payload: {},
    });
    assert.equal(idle.statusCode, 200);
    assert.deepEqual(idle.json(), { accepted: false, reason: "no active turn" });

    const stale = await fx.app.inject({
      method: "POST",
      url: `/runtime-instances/${fx.instanceId}/managed/interrupt`,
      payload: { expected_turn_id: "someone-elses-turn" },
    });
    assert.equal(stale.statusCode, 200);
    assert.equal(stale.json().accepted, false);

    const unknown = await fx.app.inject({
      method: "POST",
      url: "/runtime-instances/nope/managed/interrupt",
      payload: {},
    });
    assert.equal(unknown.statusCode, 404);
  } finally {
    await fx.dispose();
  }
});

test("approval decisions: console identity required, decisions validated, states classified", async () => {
  const fx = await makeHttpFixture();
  try {
    // Produce a pending approval through a real @approval turn.
    registerSession(fx.db, { id: "asker", name: "asker" });
    fx.db
      .prepare(
        `INSERT INTO messages (from_session, to_session, question, status, created_at)
         VALUES ('asker', ?, '@approval via http', 'pending', ?)`,
      )
      .run(fx.sessionId, new Date().toISOString());
    const messageId = Number(
      (fx.db.prepare(`SELECT id FROM messages WHERE question = ?`).get("@approval via http") as { id: number }).id,
    );
    await fx.manager.enqueue({
      messageId,
      instanceId: fx.instanceId,
      text: "@approval via http",
    });
    const approvalRow = await waitFor(
      () =>
        (
          fx.db
            .prepare(`SELECT id, state FROM managed_codex_approvals WHERE state = 'pending'`)
            .get() as { id: number; state: string } | undefined
        ) ?? undefined,
      8000,
      "pending approval",
    );

    const approve = (headers: Record<string, string>, decision: unknown) =>
      fx.app.inject({
        method: "POST",
        url: `/runtime-instances/${fx.instanceId}/managed/approvals/${approvalRow!.id}`,
        headers,
        payload: { decision },
      });

    // An agent session may not approve on the user's behalf — the actor is
    // the session identity, and body actors are ignored.
    const agentAnswer = await approve({ "x-session-id": "asker" }, { decision: "accept", actor: "web-console" });
    assert.equal(agentAnswer.statusCode, 403);

    const badDecision = await approve({ "x-session-id": WEB_CONSOLE_ID }, "acceptForSession");
    assert.equal(badDecision.statusCode, 400);

    const unknownApproval = await fx.app.inject({
      method: "POST",
      url: `/runtime-instances/${fx.instanceId}/managed/approvals/999999`,
      headers: { "x-session-id": WEB_CONSOLE_ID },
      payload: { decision: "accept" },
    });
    assert.equal(unknownApproval.statusCode, 404);

    const foreignInstance = await fx.app.inject({
      method: "POST",
      url: "/runtime-instances/not-an-instance/managed/approvals/1",
      headers: { "x-session-id": WEB_CONSOLE_ID },
      payload: { decision: "accept" },
    });
    assert.equal(foreignInstance.statusCode, 409);

    const accepted = await approve({ "x-session-id": WEB_CONSOLE_ID }, "accept");
    assert.equal(accepted.statusCode, 200);

    const repeat = await approve({ "x-session-id": WEB_CONSOLE_ID }, "accept");
    assert.equal(repeat.statusCode, 409, "second answer conflicts");

    await waitFor(
      () =>
        (
          fx.db
            .prepare(`SELECT state FROM managed_codex_runs WHERE message_id = ?`)
            .get(messageId) as { state: string }
        ).state === "completed"
          ? true
          : undefined,
      8000,
      "completed after http approval",
    );
  } finally {
    await fx.dispose();
  }
});

test("status keeps serving the persisted view after the instance stops", async () => {
  const fx = await makeHttpFixture();
  try {
    // The exact journey from the field report: a task is mid-flight when the
    // instance stops — the run lands in `unknown` for human review, and the
    // panel must still be able to READ it afterwards.
    registerSession(fx.db, { id: "asker", name: "asker" });
    fx.db
      .prepare(
        `INSERT INTO messages (from_session, to_session, question, status, created_at)
         VALUES ('asker', ?, '@hold stopped mid-turn', 'pending', ?)`,
      )
      .run(fx.sessionId, new Date().toISOString());
    const messageId = Number(
      (
        fx.db.prepare(`SELECT id FROM messages WHERE question = ?`).get("@hold stopped mid-turn") as {
          id: number;
        }
      ).id,
    );
    await fx.manager.enqueue({
      messageId,
      instanceId: fx.instanceId,
      text: "@hold stopped mid-turn",
    });
    await waitFor(
      () =>
        (
          fx.db.prepare(`SELECT state FROM managed_codex_runs WHERE message_id = ?`).get(messageId) as {
            state: string;
          }
        ).state === "running"
          ? true
          : undefined,
      8000,
      "running",
    );
    await stopRuntimeInstance(fx.db, fx.instanceId);

    const res = await fx.app.inject({ method: "GET", url: `/runtime-instances/${fx.instanceId}/managed` });
    assert.equal(res.statusCode, 200, "stopped instances serve their persisted state");
    const body = res.json() as {
      binding: { thread_id: string };
      current: { live: boolean; threadId: string; activeRun: unknown; pendingApprovals: unknown[] };
      runs: Array<{ state: string }>;
    };
    assert.equal(body.current.live, false);
    assert.equal(body.current.activeRun, null, "no live control for a stopped instance");
    assert.deepEqual(body.current.pendingApprovals, []);
    assert.equal(body.binding.thread_id, "shim-thread-0001", "binding survives the stop");
    assert.ok(body.runs.some((r) => r.state === "unknown"), "the mid-flight run is still reviewable");

    const missing = await fx.app.inject({ method: "GET", url: "/runtime-instances/nope/managed" });
    assert.equal(missing.statusCode, 404, "ids that were never managed still 404");
  } finally {
    await fx.dispose();
  }
});

test("without a live manager the managed routes report unavailable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "managed-codex-nomgr-"));
  const db = openDb({ dataDir: dir, dbPath: join(dir, "data.db"), scope: "global" });
  const app = Fastify();
  try {
    registerManagedCodexRoutes(app, createServerContext(db, { dataDir: dir, port: 0 }));
    const status = await app.inject({ method: "GET", url: "/runtime-instances/x/managed" });
    assert.equal(status.statusCode, 503);
  } finally {
    await app.close();
    stopWalCheckpoint(db);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
