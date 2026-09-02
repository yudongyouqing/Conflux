import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers.js";
import { collapseReplyEdges } from "../core/db.js";
import { getGraph } from "../core/graph.js";
import { registerSession, endSession, mergeSessionMeta } from "../core/sessions.js";
import { createAgent } from "../core/agents.js";
import { createConversation } from "../core/conversations.js";
import { createRuntimeAgent } from "../core/runtime-agents.js";
import { askSession, replyAsk, listEdgeMessages } from "../core/messages.js";

const { db, cleanup } = makeDb();
after(cleanup);
registerSession(db, { id: "ext", name: "ext-session" });
registerSession(db, { id: "gone", name: "gone-session" });
const agent = createAgent(db, {
  name: "reviewer",
  system_prompt: "you review",
  model_config: { provider: "anthropic", model: "claude-sonnet-4-5" },
});

test("getGraph unions sessions and agents, no duplicate agent nodes", () => {
  const g = getGraph(db, { status: "all" });
  const ids = g.nodes.map((n) => n.id);
  assert.ok(ids.includes("ext"), "external session present");
  assert.ok(ids.includes(`agent-${agent.id}`), "agent node present");
  const agentTyped = g.nodes.filter((n) => n.id === `agent-${agent.id}`);
  assert.equal(agentTyped.length, 1, "agent appears exactly once");
  assert.equal(agentTyped[0].type, "agent");
  const sessionTyped = g.nodes.filter((n) => n.type === "session");
  assert.ok(!sessionTyped.some((n) => n.id.startsWith("agent-")), "agent-% filtered out of session nodes");
});

test("getGraph shows active MCP placeholders but hides stale ones", () => {
  registerSession(db, {
    id: "graph-codex-live-temp",
    name: "muiltchat",
    description: "Codex session (auto-registered)",
    metadata: { temp: true, runtime: "codex", runtime_pid: 22345 },
  });
  registerSession(db, {
    id: "graph-codex-stale-temp",
    name: "muiltchat",
    description: "Codex session (auto-registered)",
    metadata: { temp: true, runtime: "codex", runtime_pid: 22346 },
  });
  db.prepare(`UPDATE sessions SET last_heartbeat_at = ? WHERE id = ?`).run(
    new Date(Date.now() - 3600_000).toISOString(),
    "graph-codex-stale-temp"
  );

  const g = getGraph(db, { status: "all" });
  assert.ok(g.nodes.some((n) => n.id === "graph-codex-live-temp"));
  assert.ok(!g.nodes.some((n) => n.id === "graph-codex-stale-temp"));
});

test("getGraph returns explicit session identity fields", () => {
  registerSession(db, {
    id: "graph-explicit-identity",
    name: "codex worker",
    runtime: "codex",
    identity_source: "mcp",
    runtime_pid: 4321,
    metadata: { temp: true },
  });

  const node = getGraph(db, { status: "all" }).nodes.find(
    (candidate) => candidate.id === "graph-explicit-identity"
  )!;
  assert.equal(node.runtime, "codex");
  assert.equal(node.identity_source, "mcp");
  assert.equal(node.runtime_pid, 4321);
});

test("getGraph normalizes malformed explicit identity columns", () => {
  registerSession(db, {
    id: "graph-malformed-identity",
    name: "malformed identity",
    runtime: "codex",
    identity_source: "mcp",
    runtime_pid: 4321,
  });
  db.prepare(
    `UPDATE sessions SET runtime = ?, identity_source = ?, runtime_pid = ? WHERE id = ?`
  ).run("unknown-runtime", "unknown-source", 0, "graph-malformed-identity");

  const node = getGraph(db, { status: "all" }).nodes.find(
    (candidate) => candidate.id === "graph-malformed-identity"
  )!;
  assert.equal(node.runtime, null);
  assert.equal(node.identity_source, null);
  assert.equal(node.runtime_pid, null);
});

test("agent node carries conversation_count", () => {
  createConversation(db, { agent_id: agent.id, initiated_by: "test", title: "t" });
  const g = getGraph(db, { status: "all" });
  const node = g.nodes.find((n) => n.id === `agent-${agent.id}`)!;
  assert.equal(node.conversation_count, 1);
});

test("status filter excludes ended sessions", () => {
  endSession(db, "gone");
  const active = getGraph(db, { status: "active" });
  assert.ok(!active.nodes.some((n) => n.id === "gone"));
  const all = getGraph(db, { status: "all" });
  assert.ok(all.nodes.some((n) => n.id === "gone"));
});

test("runtime-agent preset name is a fallback, never masks the session's own name", () => {
  const ra = createRuntimeAgent(db, { name: "worker-x", runtime: "claude" });
  // spawned but idle at the prompt — still on the cwd basename
  registerSession(db, {
    id: "spawn-idle",
    name: "muiltchat",
    description: "Claude Code session (hook)",
    metadata: { source: "claude-hook", agent_id: ra.id, runtime: "claude" },
  });
  // user renamed the conversation in Claude Code (/rename test2)
  registerSession(db, {
    id: "spawn-renamed",
    name: "test2",
    description: "working",
    metadata: { source: "claude-hook", agent_id: ra.id, runtime: "claude", named: true, custom_title: true },
  });
  const g = getGraph(db, { status: "all" });
  const idle = g.nodes.find((n) => n.id === "spawn-idle")!;
  const renamed = g.nodes.find((n) => n.id === "spawn-renamed")!;
  assert.equal(idle.name, "worker-x", "unnamed spawn falls back to the preset name");
  assert.equal(idle.agent_id, ra.id);
  assert.equal(renamed.name, "test2", "custom title / prompt name wins over the preset name");
});


test("agent card skills surface on graph nodes", () => {
  registerSession(db, { id: "card-a", name: "card-a" });
  mergeSessionMeta(db, "card-a", { agent_card: { skills: ["typescript", "sql", 42] } });
  const g = getGraph(db, { status: "all" });
  const node = g.nodes.find((n) => n.id === "card-a")!;
  assert.deepEqual(node.skills, ["typescript", "sql"], "skills extracted, non-strings dropped");
  const plain = g.nodes.find((n) => n.id === "ext")!;
  assert.equal(plain.skills, undefined, "no card -> no skills field noise");
});

test("channels: a reply stays on the channel, no reverse edge is created", () => {
  registerSession(db, { id: "dl-web", name: "web" });
  registerSession(db, { id: "dl-test2", name: "test2" });
  const m = askSession(db, { from_session: "dl-web", to_session: "dl-test2", question: "问一下test1他在做什么" });
  replyAsk(db, m.id, "dl-test2", "test1在讨论mac端接入");

  const g = getGraph(db, { status: "all" });
  const channel = g.edges.find((e) => e.from === "dl-web" && e.to === "dl-test2")!;
  assert.ok(channel, "the channel exists");
  assert.ok(typeof channel.id === "number", "channel carries its id");
  assert.equal(channel.last_message, "问一下test1他在做什么", "channel labels its own question");
  assert.equal(
    g.edges.find((e) => e.from === "dl-test2" && e.to === "dl-web"),
    undefined,
    "a reply never creates a reverse channel"
  );
  // the exchange history lives on the channel
  assert.equal(listEdgeMessages(db, channel.id).length, 1);
});

test("collapseReplyEdges removes question-less edges, keeps real channels", () => {
  registerSession(db, { id: "cr-a", name: "a" });
  registerSession(db, { id: "cr-b", name: "b" });
  askSession(db, { from_session: "cr-a", to_session: "cr-b", question: "real channel" });
  // a reply-created reverse edge (legacy bookkeeping): no question ever traveled b→a
  db.prepare(
    `INSERT INTO edges (from_session, to_session, weight, last_interact_at) VALUES ('cr-b', 'cr-a', 1, '2026-01-01T00:00:00Z')`
  ).run();

  const removed = collapseReplyEdges(db);
  assert.ok(removed >= 1);
  const g = getGraph(db, { status: "all" });
  assert.ok(g.edges.some((e) => e.from === "cr-a" && e.to === "cr-b"), "real channel kept");
  assert.equal(
    g.edges.find((e) => e.from === "cr-b" && e.to === "cr-a"),
    undefined,
    "reply-only reverse edge collapsed"
  );
});
