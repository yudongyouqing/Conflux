import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { registerSession, endSession } from "../core/sessions.js";
import { makeDb } from "./helpers.js";
import { registerSessionDirectory, sessionResourceUri } from "../mcp/session-directory.js";

test("MCP directory exposes prompts and mention resources with full, unambiguous IDs", async (t) => {
  const { db, cleanup } = makeDb();
  t.after(cleanup);
  const unusual = "路径/id %?#";
  registerSession(db, { id: "current-session", name: "Same name", project_dir: "/project one" });
  registerSession(db, { id: unusual, name: "Same name", project_dir: "C:\\project two" });
  endSession(db, unusual);
  const server = new McpServer({ name: "directory-test", version: "1.0.0" });
  let prepared = 0;
  const refresh = registerSessionDirectory(server, {
    db,
    currentSessionId: () => "current-session",
    beforeRead: () => {
      prepared++;
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "directory-client", version: "1.0.0" });
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await client.connect(clientTransport);
  let changed = 0;
  client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
    changed++;
  });
  assert.ok(client.getServerCapabilities()?.prompts);
  assert.ok(client.getServerCapabilities()?.resources);
  assert.ok((await client.listPrompts()).prompts.some((p) => p.name === "list"));
  const tools = await client.listTools();
  assert.equal(
    tools.tools.find((tool) => tool.name === "list_session_directory")?.annotations?.readOnlyHint,
    true,
  );
  const listed = await client.callTool({ name: "list_session_directory", arguments: {} });
  const suggested = await client.callTool({
    name: "find_session_candidates",
    arguments: { query: "Same name" },
  });
  assert.equal(
    (suggested.structuredContent as { requires_confirmation: boolean }).requires_confirmation,
    true,
  );
  assert.equal((suggested.structuredContent as { candidates: unknown[] }).candidates.length, 2);
  const resolved = await client.callTool({
    name: "find_session_candidates",
    arguments: { query: unusual },
  });
  assert.equal(
    (resolved.structuredContent as { requires_confirmation: boolean }).requires_confirmation,
    false,
  );
  assert.equal((db.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n, 0);
  const sessions = (
    listed.structuredContent as {
      sessions: Array<{ id: string; current: boolean; status: string; resource_uri: string }>;
    }
  ).sessions;
  assert.deepEqual(new Set(sessions.map((s) => s.id)), new Set(["current-session", unusual]));
  assert.equal(sessions.find((s) => s.id === "current-session")?.current, true);
  assert.equal(sessions.find((s) => s.id === unusual)?.status, "ended");
  const active = await client.callTool({
    name: "list_session_directory",
    arguments: { status: "active" },
  });
  assert.equal((active.structuredContent as { sessions: unknown[] }).sessions.length, 1);
  const resources = (await client.listResources()).resources;
  assert.ok(resources.some((r) => r.uri === sessionResourceUri(unusual)));
  const resource = await client.readResource({ uri: sessionResourceUri(unusual) });
  assert.equal(JSON.parse((resource.contents[0] as { text: string }).text).id, unusual);
  for (const id of [".", ".."]) {
    registerSession(db, { id, name: `Dot session ${id}` });
    const attached = (await client.readResource({ uri: sessionResourceUri(id) })).contents[0];
    assert.ok("text" in attached);
    assert.equal(JSON.parse(attached.text).id, id);
  }
  const prompt = await client.getPrompt({ name: "list" });
  assert.ok(
    prompt.messages.some(
      (m) => m.content.type === "text" && m.content.text.includes("current-session"),
    ),
  );
  await assert.rejects(client.readResource({ uri: sessionResourceUri("not-found") }), /not found/i);
  await assert.rejects(client.getPrompt({ name: "list", arguments: { status: "invalid" } }));
  registerSession(db, { id: "later", name: "Later session" });
  const previousChanges = changed;
  refresh();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(changed, previousChanges + 1);
  refresh();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(changed, previousChanges + 1);
  assert.ok(
    (await client.listResources()).resources.some((r) => r.uri === sessionResourceUri("later")),
  );
  assert.ok(prepared > 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n, 0);
});

test("empty directory and Markdown-special names remain readable data", async (t) => {
  const { db, cleanup } = makeDb();
  t.after(cleanup);
  const { readSessionDirectory, formatSessionDirectory } =
    await import("../mcp/session-directory.js");
  assert.match(formatSessionDirectory(readSessionDirectory(db, "none")), /No registered sessions/);
  registerSession(db, {
    id: "literal-id",
    name: "name|column\n# injected",
    project_dir: "<project>",
  });
  const text = formatSessionDirectory(readSessionDirectory(db, "none"));
  assert.ok(text.includes("literal-id"));
  assert.ok(!text.includes("\n# injected"));
  assert.ok(!text.includes("<project>"));
});
