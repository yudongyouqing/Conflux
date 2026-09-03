import { test } from "node:test";
import assert from "node:assert/strict";

import { addTurn, createConversation } from "../core/conversations.js";
import { createAgent } from "../core/agents.js";
import { publishContext } from "../core/context.js";
import { nowIso } from "../core/db.js";
import { askSession, replyAsk } from "../core/messages.js";
import { createRuntimeAgent } from "../core/runtime-agents.js";
import { getSession, registerSession } from "../core/sessions.js";
import { exportData, importData, type ConfluxDataBundle } from "../core/data-transfer.js";
import { makeDb } from "./helpers.js";

function bundleWithResources(): ConfluxDataBundle {
  const timestamp = "2026-09-01T00:00:00.000Z";
  return {
    format: "conflux-data",
    version: 1,
    exported_at: timestamp,
    scope: "global",
    sessions: [
      {
        id: "session-a",
        name: "Session A",
        description: "source A",
        project_dir: "C:/project-a",
        status: "active",
        created_at: timestamp,
        last_heartbeat_at: timestamp,
        metadata: null,
        runtime: "claude",
        identity_source: "hook",
        runtime_pid: 101,
      },
      {
        id: "session-b",
        name: "Session B",
        description: null,
        project_dir: "C:/project-a",
        status: "stale",
        created_at: timestamp,
        last_heartbeat_at: timestamp,
        metadata: null,
        runtime: "codex",
        identity_source: "mcp",
        runtime_pid: 202,
      },
    ],
    context_entries: [
      {
        id: 1,
        session_id: "session-a",
        title: "Context",
        content: "Shared context",
        tags: ["one", "two"],
        created_at: timestamp,
        updated_at: timestamp,
      },
    ],
    messages: [
      {
        id: 1,
        edge_id: 1,
        from_session: "session-a",
        to_session: "session-b",
        question: "Question",
        reply: "Answer",
        status: "replied",
        created_at: timestamp,
        replied_at: timestamp,
      },
    ],
    edges: [
      {
        id: 1,
        from: "session-a",
        to: "session-b",
        weight: 1,
        last_interact_at: timestamp,
        last_message: "Question",
      },
    ],
    agents: [
      {
        id: 1,
        name: "Internal Agent",
        system_prompt: "Answer clearly",
        model_config: { provider: "openai", model: "gpt-4.1" },
        description: "test agent",
        created_at: timestamp,
        updated_at: timestamp,
      },
    ],
    conversations: [
      {
        id: 1,
        agent_id: 1,
        initiated_by: "web-ui",
        title: "Conversation",
        created_at: timestamp,
        updated_at: timestamp,
      },
    ],
    turns: [
      {
        id: 1,
        conversation_id: 1,
        role: "user",
        content: "Hello",
        created_at: timestamp,
      },
    ],
    runtime_agents: [
      {
        id: 1,
        name: "Claude preset",
        runtime: "claude",
        workdir: "C:/project-a",
        model: "claude-sonnet",
        base_url: null,
        extra_env: null,
        instructions: "Inspect the inbox",
        interval_min: null,
        last_scheduled_run: null,
        created_at: timestamp,
        updated_at: timestamp,
        api_key_configured: true,
      },
    ],
  };
}

test("exports every resource and never serializes runtime API keys", () => {
  const { db, cleanup } = makeDb();
  try {
    registerSession(db, {
      id: "source-a",
      name: "Source A",
      project_dir: "C:/project-a",
      runtime: "claude",
      identity_source: "hook",
      runtime_pid: 123,
    });
    registerSession(db, {
      id: "source-b",
      name: "Source B",
      project_dir: "C:/project-a",
    });
    publishContext(db, {
      session_id: "source-a",
      title: "Knowledge",
      content: "A useful fact",
      tags: ["fact"],
    });
    const message = askSession(db, {
      from_session: "source-a",
      to_session: "source-b",
      question: "Can you confirm?",
    });
    replyAsk(db, message.id, "source-b", "Confirmed");
    const agent = createAgent(db, {
      name: "Researcher",
      system_prompt: "Be precise",
      model_config: { provider: "openai", model: "gpt-4.1" },
    });
    const conversation = createConversation(db, {
      agent_id: agent.id,
      initiated_by: "source-a",
      title: "Research",
    });
    addTurn(db, { conversation_id: conversation.id, role: "user", content: "Start" });
    createRuntimeAgent(db, {
      name: "Codex preset",
      runtime: "codex",
      api_key: "secret-runtime-key",
    });

    const bundle = exportData(db, { scope: "global" });
    assert.equal(bundle.format, "conflux-data");
    assert.equal(bundle.version, 1);
    assert.equal(bundle.sessions.length, 3);
    assert.ok(bundle.context_entries.length > 0);
    assert.ok(bundle.messages.length > 0);
    assert.ok(bundle.edges.length > 0);
    assert.ok(bundle.agents.length > 0);
    assert.ok(bundle.conversations.length > 0);
    assert.ok(bundle.turns.length > 0);
    assert.equal(bundle.runtime_agents.length, 1);
    assert.equal(bundle.runtime_agents[0].api_key_configured, true);
    assert.equal("api_key" in bundle.runtime_agents[0], false);
    assert.equal(JSON.stringify(bundle).includes("secret-runtime-key"), false);
  } finally {
    cleanup();
  }
});

test("exports and imports pending messages with a null reply timestamp", () => {
  const source = makeDb();
  const target = makeDb();
  try {
    registerSession(source.db, { id: "pending-source", name: "Source" });
    registerSession(source.db, { id: "pending-target", name: "Target" });
    askSession(source.db, {
      from_session: "pending-source",
      to_session: "pending-target",
      question: "Still pending?",
    });

    const bundle = exportData(source.db);
    assert.equal(bundle.messages[0]?.replied_at, null);
    assert.doesNotThrow(() => importData(target.db, bundle));
    assert.equal(
      (target.db.prepare("SELECT replied_at FROM messages WHERE id = 1").get() as {
        replied_at: string | null;
      }).replied_at,
      null
    );
  } finally {
    source.cleanup();
    target.cleanup();
  }
});

test("project export keeps only sessions and related conversation resources", () => {
  const { db, cleanup } = makeDb();
  try {
    registerSession(db, { id: "project-session", name: "Project", project_dir: "C:/project" });
    registerSession(db, { id: "other-session", name: "Other", project_dir: "C:/other" });
    publishContext(db, {
      session_id: "project-session",
      title: "In project",
      content: "Keep",
    });
    publishContext(db, {
      session_id: "other-session",
      title: "Outside project",
      content: "Drop",
    });

    const bundle = exportData(db, { scope: "project", projectDir: "C:/project" });
    assert.deepEqual(bundle.sessions.map((session) => session.id), ["project-session"]);
    assert.deepEqual(
      bundle.context_entries.map((entry) => entry.session_id),
      ["project-session"]
    );
  } finally {
    cleanup();
  }
});

test("rejects an invalid bundle before changing the database", () => {
  const { db, cleanup } = makeDb();
  try {
    const before = (db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number }).count;
    const invalid = { ...bundleWithResources(), format: "wrong" } as unknown;
    assert.throws(() => importData(db, invalid), /invalid|format|bundle/i);
    const after = (db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number }).count;
    assert.equal(after, before);
  } finally {
    cleanup();
  }
});

test("imports with skip, overwrite, and copy while preserving foreign keys", () => {
  const { db, cleanup } = makeDb();
  try {
    const bundle = bundleWithResources();
    const first = importData(db, bundle, { conflict: "overwrite" });
    assert.ok(first.imported > 0);

    const changed: ConfluxDataBundle = {
      ...bundle,
      sessions: bundle.sessions.map((session) => ({ ...session, name: "new name" })),
    };
    const skipped = importData(db, changed, { conflict: "skip" });
    assert.ok(skipped.skipped > 0);
    assert.equal(
      (db.prepare("SELECT name FROM sessions WHERE id = 'session-a'").get() as { name: string }).name,
      "Session A"
    );

    const overwritten = importData(db, changed, { conflict: "overwrite" });
    assert.ok(overwritten.overwritten > 0);
    assert.equal(
      (db.prepare("SELECT name FROM sessions WHERE id = 'session-a'").get() as { name: string }).name,
      "new name"
    );

    const copied = importData(db, changed, { conflict: "copy" });
    assert.ok(copied.copied > 0);
    const copiedSession = db
      .prepare("SELECT id FROM sessions WHERE id LIKE 'session-a-copy-%'")
      .get() as { id: string } | undefined;
    assert.ok(copiedSession);
    const copiedPeer = db
      .prepare("SELECT id FROM sessions WHERE id LIKE 'session-b-copy-%'")
      .get() as { id: string } | undefined;
    assert.ok(copiedPeer);

    const copiedContext = db
      .prepare("SELECT session_id FROM context_entries WHERE session_id = ?")
      .get(copiedSession.id) as { session_id: string } | undefined;
    assert.equal(copiedContext?.session_id, copiedSession.id);

    const copiedEdge = db
      .prepare("SELECT rowid AS id FROM edges WHERE from_session = ? AND to_session = ?")
      .get(copiedSession.id, copiedPeer.id) as { id: number } | undefined;
    assert.ok(copiedEdge);
    const copiedMessage = db
      .prepare("SELECT edge_id, from_session, to_session FROM messages WHERE edge_id = ?")
      .get(copiedEdge.id) as {
      edge_id: number;
      from_session: string;
      to_session: string;
    } | undefined;
    assert.deepEqual(copiedMessage, {
      edge_id: copiedEdge.id,
      from_session: copiedSession.id,
      to_session: copiedPeer.id,
    });

    const copiedAgent = db
      .prepare("SELECT id FROM agents WHERE id <> 1 ORDER BY id DESC")
      .get() as { id: number } | undefined;
    assert.ok(copiedAgent);
    const copiedConversation = db
      .prepare("SELECT id, agent_id FROM conversations WHERE id <> 1 ORDER BY id DESC")
      .get() as { id: number; agent_id: number } | undefined;
    assert.deepEqual(copiedConversation?.agent_id, copiedAgent.id);
    const copiedTurn = db
      .prepare("SELECT conversation_id FROM turns WHERE conversation_id = ?")
      .get(copiedConversation?.id) as { conversation_id: number } | undefined;
    assert.equal(copiedTurn?.conversation_id, copiedConversation?.id);
  } finally {
    cleanup();
  }
});

test("copy remaps internal agent resources to the new canonical agent session", () => {
  const { db, cleanup } = makeDb();
  try {
    registerSession(db, { id: "agent-copy-source", name: "Source" });
    const agent = createAgent(db, {
      name: "Copyable agent",
      system_prompt: "Keep the copied identity consistent",
      model_config: { provider: "openai", model: "gpt-4.1" },
    });
    const agentSessionId = `agent-${agent.id}`;
    publishContext(db, {
      session_id: agentSessionId,
      title: "Agent context",
      content: "Keep this on the copied agent",
    });
    askSession(db, {
      from_session: "agent-copy-source",
      to_session: agentSessionId,
      question: "Can the copy receive this?",
    });
    const conversation = createConversation(db, {
      agent_id: agent.id,
      initiated_by: "agent-copy-source",
      title: "Agent conversation",
    });
    addTurn(db, {
      conversation_id: conversation.id,
      role: "user",
      content: "Keep this turn",
    });

    const bundle = exportData(db);
    importData(db, bundle, { conflict: "copy" });

    const copiedAgent = db
      .prepare("SELECT id FROM agents WHERE id <> ? ORDER BY id DESC LIMIT 1")
      .get(agent.id) as { id: number } | undefined;
    assert.ok(copiedAgent);
    const copiedSessionId = `agent-${copiedAgent.id}`;
    assert.ok(getSession(db, copiedSessionId));
    assert.equal(
      db
        .prepare("SELECT id FROM sessions WHERE id LIKE ?")
        .get(`agent-${agent.id}-copy-%`),
      undefined
    );
    assert.equal(
      (db
        .prepare("SELECT session_id FROM context_entries WHERE session_id = ?")
        .get(copiedSessionId) as { session_id: string } | undefined)?.session_id,
      copiedSessionId
    );
    assert.equal(
      (db
        .prepare("SELECT to_session FROM messages WHERE to_session = ?")
        .get(copiedSessionId) as { to_session: string } | undefined)?.to_session,
      copiedSessionId
    );
    assert.equal(
      (db
        .prepare("SELECT agent_id FROM conversations WHERE agent_id = ?")
        .get(copiedAgent.id) as { agent_id: number } | undefined)?.agent_id,
      copiedAgent.id
    );
  } finally {
    cleanup();
  }
});

test("rolls back the complete import when a later resource insert fails", () => {
  const { db, cleanup } = makeDb();
  try {
    db.exec(`
      CREATE TRIGGER fail_data_transfer
      BEFORE INSERT ON context_entries
      BEGIN
        SELECT RAISE(ABORT, 'forced transfer failure');
      END;
    `);
    assert.throws(
      () => importData(db, bundleWithResources(), { conflict: "overwrite" }),
      /forced transfer failure/
    );
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM agents").get() as { count: number }).count, 0);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM context_entries").get() as { count: number }).count,
      0
    );
  } finally {
    cleanup();
  }
});

test("imports runtime agents without inventing an API key", () => {
  const { db, cleanup } = makeDb();
  try {
    importData(db, bundleWithResources(), { conflict: "overwrite" });
    const row = db.prepare("SELECT api_key FROM runtime_agents WHERE id = 1").get() as {
      api_key: string | null;
    };
    assert.equal(row.api_key, null);
    assert.equal(nowIso().endsWith("Z"), true);
  } finally {
    cleanup();
  }
});
