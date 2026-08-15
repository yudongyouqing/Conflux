import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers.js";
import {
  createAgent,
  getAgent,
  listAgents,
  updateAgent,
  deleteAgent,
} from "../core/agents.js";
import { getSession } from "../core/sessions.js";

const { db, cleanup } = makeDb();
after(cleanup);

test("createAgent stores model_config as object and registers session", () => {
  const a = createAgent(db, {
    name: "reviewer",
    system_prompt: "you review code",
    model_config: { provider: "anthropic", model: "claude-sonnet-4-5", max_tokens: 2048 },
    description: "desc",
  });
  assert.equal(a.model_config.provider, "anthropic");
  assert.equal(a.model_config.max_tokens, 2048);
  const session = getSession(db, `agent-${a.id}`)!;
  assert.ok(session, "agent session auto-registered");
  assert.equal(session.name, "reviewer");
});

test("updateAgent patches fields, returns null for missing id", () => {
  const a = createAgent(db, {
    name: "v1",
    system_prompt: "p1",
    model_config: { provider: "openai", model: "gpt-x" },
  });
  const u = updateAgent(db, a.id, { name: "v2", system_prompt: "p2" })!;
  assert.equal(u.name, "v2");
  assert.equal(u.system_prompt, "p2");
  assert.equal(u.model_config.provider, "openai", "untouched model_config preserved");
  assert.equal(updateAgent(db, 9999, { name: "x" }), null);
});

test("listAgents returns created agents", () => {
  assert.ok(listAgents(db).length >= 2);
});

test("deleteAgent removes row and ends its session", () => {
  const a = createAgent(db, {
    name: "temp",
    system_prompt: "p",
    model_config: { provider: "anthropic", model: "m" },
  });
  const sid = `agent-${a.id}`;
  assert.ok(deleteAgent(db, a.id));
  assert.equal(getAgent(db, a.id), null);
  assert.equal(getSession(db, sid)!.status, "ended");
});

