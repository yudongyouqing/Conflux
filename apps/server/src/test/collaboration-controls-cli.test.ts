import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname } from "node:path";
import { makeDb } from "./helpers.js";
import { registerSession } from "../core/sessions.js";
import { askSession } from "../core/messages.js";
import { setAutoWake } from "../core/app-settings.js";
import { createRuntimeAgent } from "../core/runtime-agents.js";
import { createRuntimeInstance } from "../core/runtime-instances.js";
import { buildCli } from "../cli/commands.js";

test("CLI exposes guarded runtime controls and retries the original message using caller identity", async () => {
  const { db, cleanup } = makeDb();
  const originalLog = console.log;
  const originalSession = process.env.CONFLUX_SESSION_ID;
  const output: string[] = [];
  console.log = (value?: unknown) => {
    output.push(String(value));
  };
  try {
    setAutoWake(db, false);
    for (const id of ["cli-sender", "cli-target", "cli-other"])
      registerSession(db, { id, name: id });
    const message = askSession(db, {
      from_session: "cli-sender",
      to_session: "cli-target",
      question: "retry original",
    });
    const preset = createRuntimeAgent(db, { name: "cli managed", runtime: "claude" });
    const instance = createRuntimeInstance(db, preset);
    const run = async (...args: string[]) => {
      output.length = 0;
      await buildCli()
        .exitOverride()
        .parseAsync([
          "node",
          "conflux",
          "--data-dir",
          dirname(db.name),
          "--log-level",
          "silent",
          ...args,
        ]);
      return JSON.parse(output.join("\n"));
    };
    process.env.CONFLUX_SESSION_ID = "cli-sender";
    const retried = await run("msg", "retry", String(message.id));
    assert.equal(retried.message.id, message.id);
    assert.equal(retried.message.delivery.state, "queued");
    process.env.CONFLUX_SESSION_ID = "cli-other";
    await assert.rejects(run("msg", "retry", String(message.id)), { statusCode: 403 });
    assert.equal((await run("runtime", "instances")).instances[0].id, instance.id);
    await assert.rejects(run("runtime", "stop", instance.id), { statusCode: 409 });
    await assert.rejects(run("runtime", "resume", instance.id), { statusCode: 409 });
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n, 1);
    assert.equal(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM audit_log WHERE interface = 'cli' AND action = 'retry_message_delivery'",
          )
          .get() as { n: number }
      ).n,
      2,
    );
  } finally {
    console.log = originalLog;
    if (originalSession === undefined) delete process.env.CONFLUX_SESSION_ID;
    else process.env.CONFLUX_SESSION_ID = originalSession;
    cleanup();
  }
});
