import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { makeDb } from "./helpers.js";
import { createServerContext } from "../http/context.js";
import { registerMessageRoutes } from "../http/routes/messages.js";
import { registerRuntimeRoutes } from "../http/routes/runtimes.js";
import { registerSession, endSession } from "../core/sessions.js";
import { askSession, checkInbox } from "../core/messages.js";
import { setAutoWake } from "../core/app-settings.js";
import { createRuntimeAgent } from "../core/runtime-agents.js";
import { bindRuntimeInstance } from "../core/runtime-instances.js";

test("HTTP retry uses header identity, keeps the same message, and rejects seen/unknown mail", async () => {
  const { db, cleanup } = makeDb();
  const app = Fastify();
  try {
    setAutoWake(db, false);
    for (const id of ["sender", "target", "other"]) registerSession(db, { id, name: id });
    registerMessageRoutes(app, createServerContext(db, { dataDir: "test", port: 0 }));
    const message = askSession(db, {
      from_session: "sender",
      to_session: "target",
      question: "original",
    });
    const retry = (actor: string, id = message.id, payload = {}) =>
      app.inject({
        method: "POST",
        url: `/messages/${id}/retry`,
        headers: { "x-session-id": actor },
        payload,
      });
    assert.equal((await retry("other", message.id, { actor: "sender" })).statusCode, 403);
    assert.equal((await retry("sender", 999999)).statusCode, 404);
    const response = await retry("web-console");
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().message.id, message.id);
    assert.equal(response.json().message.delivery.state, "queued");
    checkInbox(db, "target");
    assert.equal((await retry("sender")).statusCode, 409);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n, 1);
    assert.equal(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'retry_message_delivery'")
          .get() as { n: number }
      ).n,
      4,
    );
  } finally {
    await app.close();
    cleanup();
  }
});

test("HTTP runtime routes control only a verified runtime process, return public instance data and resume safely", async () => {
  const { db, cleanup } = makeDb();
  const app = Fastify();
  try {
    const preset = createRuntimeAgent(db, {
      name: "HTTP preset",
      runtime: "claude",
      api_key: "private-api-key",
      extra_env: '{"SECRET_TOKEN":"private-env"}',
    });
    let alive = true;
    const inspected: number[] = [];
    const killed: number[] = [];
    const inspect = (pid: number) => {
      inspected.push(pid);
      return alive ? { runtime: "claude" as const, token: "created-1" } : ("exited" as const);
    };
    registerRuntimeRoutes(app, createServerContext(db, { dataDir: "test", port: 0 }), {
      platform: "win32",
      inspect,
      launch: () => undefined,
      terminate: (pid) => {
        killed.push(pid);
        alive = false;
      },
    });
    const launched = await app.inject({
      method: "POST",
      url: `/runtimes/${preset.id}/start`,
      payload: {},
    });
    assert.equal(launched.statusCode, 200);
    const instance = launched.json().instance;
    assert.equal(instance.state, "starting");
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/runtime-instances/${instance.id}/stop`,
          payload: {},
        })
      ).statusCode,
      409,
    );
    registerSession(db, {
      id: "actual-conversation",
      name: "actual",
      runtime: "claude",
      runtime_pid: 555,
      metadata: { runtime_instance_id: instance.id, agent_id: preset.id },
    });
    assert.equal(
      bindRuntimeInstance(db, instance.id, "actual-conversation", 555, { inspect }),
      true,
    );
    inspected.length = 0;
    const listed = await app.inject({ method: "GET", url: "/runtime-instances" });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().instances[0].can_stop, true);
    assert.deepEqual(inspected, [555], "list probes each selected PID only once");
    assert.equal(listed.body.includes("private-api-key"), false);
    assert.equal(listed.body.includes("private-env"), false);
    const stopped = await app.inject({
      method: "POST",
      url: `/runtime-instances/${instance.id}/stop`,
      payload: {},
    });
    assert.equal(stopped.statusCode, 200);
    assert.deepEqual(killed, [555]);
    endSession(db, "actual-conversation");
    const resumed = await app.inject({
      method: "POST",
      url: `/runtime-instances/${instance.id}/resume`,
      payload: {},
    });
    assert.equal(resumed.statusCode, 200);
    assert.notEqual(resumed.json().instance.id, instance.id);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/runtime-instances/${instance.id}/resume`,
          payload: {},
        })
      ).statusCode,
      409,
    );
    const audit = JSON.stringify(db.prepare("SELECT * FROM audit_log").all());
    assert.equal(audit.includes("private-api-key"), false);
    assert.equal(audit.includes("private-env"), false);
    const snapshots = JSON.stringify(db.prepare("SELECT * FROM runtime_instances").all());
    assert.equal(snapshots.includes("private-api-key"), false);
    assert.equal(snapshots.includes("private-env"), false);
  } finally {
    await app.close();
    cleanup();
  }
});
