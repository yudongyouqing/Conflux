import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openDb, stopWalCheckpoint } from "../core/db.js";
import { registerSession, endSession } from "../core/sessions.js";

test(
  "actual stdio MCP server exposes session commands and live resources without sending messages",
  { timeout: 30000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "conflux-directory-stdio-"));
    const db = openDb({ dataDir: directory, dbPath: join(directory, "data.db"), scope: "global" });
    let client: Client | undefined;
    t.after(async () => {
      await client?.close();
      stopWalCheckpoint(db);
      db.close();
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    registerSession(db, { id: "peer-online", name: "Shared name" });
    registerSession(db, { id: "peer-ended", name: "Shared name" });
    endSession(db, "peer-ended");
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
      // This protocol client has no real CLI ancestor; avoid host process probes.
      CONFLUX_CLAUDE_PID: "0",
      CONFLUX_CODEX_PID: "0",
    });
    client = new Client({ name: "directory-stdio-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", resolve(__dirname, "../index.ts"), "--data-dir", directory, "mcp"],
      env,
      stderr: "pipe",
    });
    await client.connect(transport);
    assert.ok((await client.listPrompts()).prompts.some((p) => p.name === "list"));
    const result = await client.callTool({ name: "list_session_directory", arguments: {} });
    assert.notEqual(result.isError, true);
    const sessions = (
      result.structuredContent as {
        sessions: Array<{ id: string; status: string; resource_uri: string }>;
      }
    ).sessions;
    assert.ok(sessions.some((s) => s.id === "peer-online" && s.status === "active"));
    assert.ok(sessions.some((s) => s.id === "peer-ended" && s.status === "ended"));
    const uri = sessions.find((s) => s.id === "peer-ended")!.resource_uri;
    assert.ok((await client.listResources()).resources.some((r) => r.uri === uri));
    const attached = (await client.readResource({ uri })).contents[0];
    assert.ok("text" in attached);
    assert.equal(JSON.parse(attached.text).id, "peer-ended");
    const prompt = await client.getPrompt({ name: "list" });
    assert.ok(
      prompt.messages.some(
        (m) => m.content.type === "text" && m.content.text.includes("peer-ended"),
      ),
    );
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n, 0);
  },
);
