import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers.js";
import { getGraph } from "../core/graph.js";
import { registerSession, endSession } from "../core/sessions.js";
import { createAgent } from "../core/agents.js";
import { createConversation } from "../core/conversations.js";

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

