import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers.js";
import {
  createConversation,
  getConversation,
  listConversations,
  addTurn,
  getTurns,
  deleteConversation,
} from "../core/conversations.js";
import { createAgent } from "../core/agents.js";

const { db, cleanup } = makeDb();
after(cleanup);
const agent = createAgent(db, {
  name: "chat-agent",
  system_prompt: "p",
  model_config: { provider: "anthropic", model: "m" },
});

test("createConversation and getConversation roundtrip", () => {
  const c = createConversation(db, { agent_id: agent.id, initiated_by: "web-ui", title: "hello" });
  assert.equal(c.agent_id, agent.id);
  assert.equal(getConversation(db, c.id)!.title, "hello");
  assert.equal(getConversation(db, 9999), null);
});

test("listConversations filters by agent", () => {
  createConversation(db, { agent_id: agent.id });
  const other = createAgent(db, {
    name: "other",
    system_prompt: "p",
    model_config: { provider: "openai", model: "m" },
  });
  createConversation(db, { agent_id: other.id });
  const mine = listConversations(db, { agent_id: agent.id });
  assert.ok(mine.length >= 2);
  assert.ok(mine.every((c) => c.agent_id === agent.id));
});

test("addTurn appends in order with correct roles", () => {
  const c = createConversation(db, { agent_id: agent.id });
  addTurn(db, { conversation_id: c.id, role: "user", content: "hi" });
  addTurn(db, { conversation_id: c.id, role: "assistant", content: "hello" });
  const turns = getTurns(db, c.id);
  assert.deepEqual(turns.map((t) => t.role), ["user", "assistant"]);
  assert.deepEqual(turns.map((t) => t.content), ["hi", "hello"]);
});

test("deleteConversation cascades turns", () => {
  const c = createConversation(db, { agent_id: agent.id });
  addTurn(db, { conversation_id: c.id, role: "user", content: "x" });
  assert.ok(deleteConversation(db, c.id));
  assert.equal(getTurns(db, c.id).length, 0);
  assert.equal(getConversation(db, c.id), null);
});

