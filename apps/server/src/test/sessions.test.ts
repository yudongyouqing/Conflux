import { test, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDb } from "./helpers.js";
import { openDb } from "../core/db.js";
import {
  registerSession,
  getSession,
  markStaleSessions,
  listSessions,
  endSession,
  pruneAbandonedSessions,
} from "../core/sessions.js";
import { publishContext } from "../core/context.js";
import { askSession } from "../core/messages.js";

const { db, cleanup } = makeDb();
after(cleanup);

test("openDb backfills explicit identity fields from a v8 sessions table", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "muiltchat-legacy-"));
  const dbPath = join(dataDir, "data.db");
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      project_dir TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      last_heartbeat_at TEXT NOT NULL,
      metadata TEXT
    );
    INSERT INTO sessions
      (id, name, status, created_at, last_heartbeat_at, metadata)
    VALUES
      ('legacy-codex', 'legacy', 'active', '2026-01-01T00:00:00.000Z',
       '2026-01-01T00:00:00.000Z',
       '{"runtime":"codex","runtime_pid":4321,"identity_source":"mcp"}'),
      ('legacy-corrupt', 'legacy', 'active', '2026-01-01T00:00:00.000Z',
       '2026-01-01T00:00:00.000Z', '{not-json');
    PRAGMA user_version = 8;
  `);
  legacy.close();

  const migrated = openDb({ dataDir, dbPath, scope: "global" });
  try {
    const row = migrated
      .prepare(`SELECT runtime, identity_source, runtime_pid FROM sessions WHERE id = ?`)
      .get("legacy-codex") as {
      runtime: string | null;
      identity_source: string | null;
      runtime_pid: number | null;
    };
    assert.equal(row.runtime, "codex");
    assert.equal(row.identity_source, "mcp");
    assert.equal(row.runtime_pid, 4321);
    const corrupt = migrated
      .prepare(`SELECT runtime, identity_source, runtime_pid, metadata FROM sessions WHERE id = ?`)
      .get("legacy-corrupt") as {
      runtime: string | null;
      identity_source: string | null;
      runtime_pid: number | null;
      metadata: string | null;
    };
    assert.equal(corrupt.runtime, null);
    assert.equal(corrupt.identity_source, null);
    assert.equal(corrupt.runtime_pid, null);
    assert.equal(corrupt.metadata, "{not-json");
    assert.equal(migrated.pragma("user_version", { simple: true }), 9);
  } finally {
    migrated.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("registerSession persists explicit identity and preserves it on supplemental registration", () => {
  const registered = registerSession(db, {
    id: "explicit-identity",
    name: "codex session",
    runtime: "codex",
    identity_source: "mcp",
    runtime_pid: 4321,
    metadata: { temp: true },
  });

  assert.equal(registered.runtime, "codex");
  assert.equal(registered.identity_source, "mcp");
  assert.equal(registered.runtime_pid, 4321);
  assert.deepEqual(JSON.parse(registered.metadata ?? "{}"), { temp: true });

  const supplemented = registerSession(db, {
    id: "explicit-identity",
    name: "adopted codex session",
    metadata: { temp: true },
  });
  const row = db
    .prepare(`SELECT runtime, identity_source, runtime_pid, metadata FROM sessions WHERE id = ?`)
    .get("explicit-identity") as {
    runtime: string | null;
    identity_source: string | null;
    runtime_pid: number | null;
    metadata: string | null;
  };

  assert.equal(supplemented.runtime, "codex");
  assert.equal(supplemented.identity_source, "mcp");
  assert.equal(supplemented.runtime_pid, 4321);
  assert.equal(row.runtime, "codex");
  assert.equal(row.identity_source, "mcp");
  assert.equal(row.runtime_pid, 4321);
  assert.deepEqual(JSON.parse(row.metadata ?? "{}"), { temp: true });
});

test("registerSession accepts every supported session runtime and identity source", () => {
  const cases = [
    { id: "identity-claude", runtime: "claude", identity_source: "hook" },
    { id: "identity-codex", runtime: "codex", identity_source: "mcp" },
    { id: "identity-internal", runtime: "internal", identity_source: "internal" },
    { id: "identity-web", runtime: "web", identity_source: "http" },
    { id: "identity-cli", runtime: "internal", identity_source: "cli" },
  ] as const;

  for (const entry of cases) {
    const session = registerSession(db, {
      ...entry,
      name: entry.id,
    });
    assert.equal(session.runtime, entry.runtime);
    assert.equal(session.identity_source, entry.identity_source);
  }
});

test("session reads normalize malformed explicit identity columns", () => {
  registerSession(db, {
    id: "malformed-identity",
    name: "malformed identity",
    runtime: "codex",
    identity_source: "mcp",
    runtime_pid: 4321,
  });
  db.prepare(
    `UPDATE sessions SET runtime = ?, identity_source = ?, runtime_pid = ? WHERE id = ?`
  ).run("unknown-runtime", "unknown-source", -1, "malformed-identity");

  const session = getSession(db, "malformed-identity")!;
  assert.equal(session.runtime, null);
  assert.equal(session.identity_source, null);
  assert.equal(session.runtime_pid, null);

  const listed = listSessions(db, { status: "all" }).find(
    (candidate) => candidate.id === "malformed-identity"
  )!;
  assert.equal(listed.runtime, null);
  assert.equal(listed.identity_source, null);
  assert.equal(listed.runtime_pid, null);
});

test("registerSession upserts: same id updates name and stays active", () => {
  registerSession(db, { id: "s1", name: "first", description: null });
  registerSession(db, { id: "s1", name: "second", description: "d" });
  const s = getSession(db, "s1")!;
  assert.equal(s.name, "second");
  assert.equal(s.status, "active");
});

test("markStaleSessions flips old heartbeats to stale", () => {
  registerSession(db, { id: "old", name: "old" });
  db.prepare(`UPDATE sessions SET last_heartbeat_at = ? WHERE id = ?`).run(
    new Date(Date.now() - 3600_000).toISOString(),
    "old"
  );
  registerSession(db, { id: "fresh", name: "fresh" });
  const changed = markStaleSessions(db, new Date());
  assert.ok(changed >= 1);
  assert.equal(getSession(db, "old")!.status, "stale");
  assert.equal(getSession(db, "fresh")!.status, "active");
});

test("listSessions carries context_count and pending_inbox", () => {
  registerSession(db, { id: "a", name: "a" });
  registerSession(db, { id: "b", name: "b" });
  publishContext(db, { session_id: "a", title: "t", content: "c", tags: null });
  askSession(db, { from_session: "b", to_session: "a", question: "q" });
  const all = listSessions(db, { status: "all" });
  const a = all.find((s) => s.id === "a")!;
  assert.equal(a.context_count, 1);
  assert.equal(a.pending_inbox, 1);
});

test("listSessions shows active MCP placeholders but hides stale ones", () => {
  registerSession(db, {
    id: "codex-live-temp",
    name: "muiltchat",
    description: "Codex session (auto-registered)",
    metadata: { temp: true, runtime: "codex", runtime_pid: 12345 },
  });
  registerSession(db, {
    id: "codex-stale-temp",
    name: "muiltchat",
    description: "Codex session (auto-registered)",
    metadata: { temp: true, runtime: "codex", runtime_pid: 12346 },
  });
  db.prepare(`UPDATE sessions SET last_heartbeat_at = ? WHERE id = ?`).run(
    new Date(Date.now() - 3600_000).toISOString(),
    "codex-stale-temp"
  );

  const all = listSessions(db, { status: "all" });
  assert.ok(all.some((s) => s.id === "codex-live-temp"));
  assert.ok(!all.some((s) => s.id === "codex-stale-temp"));
});

test("endSession marks ended", () => {
  registerSession(db, { id: "bye", name: "bye" });
  endSession(db, "bye");
  assert.equal(getSession(db, "bye")!.status, "ended");
});

// ---- pruneAbandonedSessions: zero-turn zombie cleanup -----------------------

function ageOut(id: string) {
  db.prepare(`UPDATE sessions SET last_heartbeat_at = ? WHERE id = ?`).run(
    new Date(Date.now() - 3600_000).toISOString(),
    id
  );
  markStaleSessions(db);
}

test("pruneAbandonedSessions removes stale zero-turn rows, keeps named/referenced/console", () => {
  const mk = (id: string, extra: Record<string, unknown> = {}) =>
    registerSession(db, {
      id,
      name: "muiltchat",
      description: "Claude Code session (hook)",
      metadata: { source: "claude-hook", ...extra },
    });

  mk("zombie-plain"); // opened, /resume'd away, never prompted
  mk("zombie-temp", { temp: true }); // dead MCP placeholder
  mk("real-named", { named: true }); // got at least one prompt
  mk("real-asked"); // never prompted, but someone asked it → has messages
  registerSession(db, {
    id: "web-console",
    name: "Web 控制台",
    description: "浏览器界面身份",
    metadata: null,
  });
  askSession(db, { from_session: "real-named", to_session: "real-asked", question: "hi" });
  for (const id of ["zombie-plain", "zombie-temp", "real-named", "real-asked", "web-console"]) {
    ageOut(id);
  }

  const removed = pruneAbandonedSessions(db);
  assert.ok(removed >= 2);
  assert.equal(getSession(db, "zombie-plain"), null);
  assert.equal(getSession(db, "zombie-temp"), null);
  assert.ok(getSession(db, "real-named"), "named sessions survive");
  assert.ok(getSession(db, "real-asked"), "referenced sessions survive");
  assert.ok(getSession(db, "web-console"), "web-console survives");
});

test("pruneAbandonedSessions keeps active zombies in global mode (stale gate)", () => {
  registerSession(db, {
    id: "fresh-zombie",
    name: "muiltchat",
    description: "Claude Code session (hook)",
    metadata: { source: "claude-hook" },
  });
  assert.equal(pruneAbandonedSessions(db), 0);
  assert.ok(getSession(db, "fresh-zombie"), "active zero-turn row waits for stale TTL");
});

test("pruneAbandonedSessions never deletes runtime-agent sessions (they idle by design)", () => {
  registerSession(db, {
    id: "spawned-agent",
    name: "muiltchat",
    description: "Claude Code session (hook)",
    metadata: { source: "claude-hook", agent_id: 2, runtime: "claude" },
  });
  ageOut("spawned-agent");
  assert.equal(getSession(db, "spawned-agent")!.status, "stale");
  pruneAbandonedSessions(db);
  assert.ok(getSession(db, "spawned-agent"), "agent-tagged zero-turn session survives the sweep");
});

test("pruneAbandonedSessions claudePid mode reaps the /resume-away predecessor instantly", () => {
  registerSession(db, {
    id: "abandoned-id",
    name: "muiltchat",
    description: "Claude Code session (hook)",
    metadata: { source: "claude-hook", claude_pid: 777 },
  });
  registerSession(db, {
    id: "current-id",
    name: "resumed-conversation",
    description: "doing something",
    metadata: { source: "claude-hook", claude_pid: 777 },
  });

  const removed = pruneAbandonedSessions(db, { claudePid: 777, keepId: "current-id" });
  assert.ok(removed >= 1);
  assert.equal(getSession(db, "abandoned-id"), null, "same-pid unnamed predecessor is reaped");
  assert.ok(getSession(db, "current-id"), "the session being registered is kept");
});
