import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openDb, stopWalCheckpoint } from "../core/db.js";
import { registerSession } from "../core/sessions.js";
import { setAutoWake } from "../core/app-settings.js";
import { askSession } from "../core/messages.js";
import { createRuntimeAgent } from "../core/runtime-agents.js";
import { createRuntimeInstance } from "../core/runtime-instances.js";

test(
  "MCP retry derives its real caller and exposes guarded instance controls",
  { timeout: 30000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "conflux-controls-mcp-"));
    const db = openDb({ dataDir: directory, dbPath: join(directory, "data.db"), scope: "global" });
    let client: Client | undefined;
    t.after(async () => {
      await client?.close();
      stopWalCheckpoint(db);
      db.close();
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    setAutoWake(db, false);
    for (const id of ["sender", "target"]) registerSession(db, { id, name: id });
    const foreign = askSession(db, {
      from_session: "sender",
      to_session: "target",
      question: "secret-question",
    });
    const preset = createRuntimeAgent(db, { name: "managed", runtime: "claude" });
    const instance = createRuntimeInstance(db, preset);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && !/^(CONFLUX_|CLAUDE_|CODEX_)/.test(entry[0]),
      ),
    );
    Object.assign(env, {
      HOME: directory,
      USERPROFILE: directory,
      CODEX_HOME: directory,
      CLAUDE_CONFIG_DIR: directory,
      CONFLUX_LOG_LEVEL: "silent",
      CONFLUX_CLAUDE_PID: "0",
      CONFLUX_CODEX_PID: "0",
    });
    client = new Client({ name: "controls-test", version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          "--import",
          "tsx",
          resolve(__dirname, "../index.ts"),
          "--data-dir",
          directory,
          "mcp",
        ],
        env,
        stderr: "pipe",
      }),
    );
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client!.callTool({ name, arguments: args });
      const block = (result.content as { type: string; text?: string }[]).find(
        (item) => item.type === "text",
      );
      return JSON.parse(block!.text!);
    };
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of [
      "retry_message_delivery",
      "list_runtime_instances",
      "stop_runtime_instance",
      "resume_runtime_instance",
    ])
      assert.ok(tools.includes(name));
    assert.match(
      (await call("retry_message_delivery", { id: foreign.id, actor: "sender" })).error,
      /not owner/,
    );
    const own = await call("ask_session", {
      to_session: "target",
      question: "own-private-question",
    });
    const retried = await call("retry_message_delivery", { id: own.message.id });
    assert.equal(retried.message.id, own.message.id);
    assert.equal(retried.message.delivery.attempts, 2);
    assert.equal((await call("list_runtime_instances")).instances[0].id, instance.id);
    assert.ok((await call("stop_runtime_instance", { id: instance.id })).error);
    assert.ok((await call("resume_runtime_instance", { id: instance.id })).error);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n, 2);
    const audit = JSON.stringify(
      db.prepare("SELECT * FROM audit_log WHERE action = 'retry_message_delivery'").all(),
    );
    assert.equal(audit.includes("own-private-question"), false);
  },
);
