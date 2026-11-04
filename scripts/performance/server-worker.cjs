const assert = require("node:assert/strict");
const { mkdirSync, statSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { performance } = require("node:perf_hooks");
const { measureSync, snapshot } = require("./measurement.cjs");
const root = resolve(__dirname, "../..");
const { openDb, stopWalCheckpoint } = require(join(root, "apps/server/dist/core/db.js"));
const { registerSession, listSessions } = require(join(root, "apps/server/dist/core/sessions.js"));
const { askSession, listMessages } = require(join(root, "apps/server/dist/core/messages.js"));
const { publishContext } = require(join(root, "apps/server/dist/core/context.js"));
const { queryContext } = require(join(root, "apps/server/dist/core/search.js"));
const { getGraph } = require(join(root, "apps/server/dist/core/graph.js"));
const { startHttpServer } = require(join(root, "apps/server/dist/http/server.js"));
const { directory, size, samples, warmup } = JSON.parse(process.argv[2]);
let app;
let monitor;
const sqliteCases = [];

process.once("disconnect", async () => {
  if (app) await app.close().catch(() => {});
  closeDb(monitor);
  process.exit(0);
});

function counts(db) {
  const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  return {
    sessions: count("sessions"),
    messages: count("messages"),
    contexts: count("context_entries"),
    edges: count("edges"),
    audit: count("audit_log"),
  };
}

function seed(name) {
  const dataDir = join(directory, name);
  mkdirSync(dataDir, { recursive: true });
  const db = openDb({ dataDir, dbPath: join(dataDir, "data.db"), scope: "global" });
  db.transaction(() => {
    for (let i = 0; i < size; i++)
      registerSession(db, {
        id: `perf-${i}`,
        name: `Synthetic ${i}`,
        description: "performance fixture",
      });
    for (let i = 0; i < size * 10; i++)
      askSession(db, {
        from_session: `perf-${i % size}`,
        to_session: `perf-${(i + 1) % size}`,
        question: `synthetic message ${i} ${"x".repeat(128)}`,
      });
    for (let i = 0; i < size * 2; i++)
      publishContext(db, {
        session_id: `perf-${i % size}`,
        title: `Synthetic context ${i}`,
        content: `${i % 5 === 0 ? "needle" : "ordinary"} ${"context data ".repeat(40)}`,
        tags: ["synthetic"],
      });
  })();
  assert.deepEqual(counts(db), {
    sessions: size,
    messages: size * 10,
    contexts: size * 2,
    edges: size,
    audit: 0,
  });
  return db;
}

function storage(db) {
  const file = db.name;
  const bytes = (path) => {
    try {
      return statSync(path).size;
    } catch (error) {
      if (error.code === "ENOENT") return 0;
      throw error;
    }
  };
  return {
    databaseBytes: bytes(file),
    walBytes: bytes(`${file}-wal`),
    shmBytes: bytes(`${file}-shm`),
    pageCount: db.pragma("page_count", { simple: true }),
    freelistCount: db.pragma("freelist_count", { simple: true }),
  };
}

function closeDb(db) {
  if (db?.open) {
    stopWalCheckpoint(db);
    db.close();
  }
}

async function main() {
  const db = seed("sqlite");
  let sqlite;
  try {
    const before = { counts: counts(db), storage: storage(db) };
    const cases = sqliteCases;
    const run = (name, op, validate) =>
      cases.push({ name, ...measureSync(op, validate, samples, warmup) });
    run(
      "sessions-list",
      () => listSessions(db, { status: "all" }),
      (v) => assert.equal(v.length, size),
    );
    run(
      "graph",
      () => getGraph(db, { status: "all" }),
      (v) => {
        assert.equal(v.nodes.length, size);
        assert.equal(v.edges.length, size);
      },
    );
    run(
      "messages-list-50",
      () => listMessages(db, { limit: 50 }),
      (v) => assert.equal(v.length, Math.min(50, size * 10)),
    );
    run(
      "context-fts-25",
      () => queryContext(db, { query: "needle", limit: 25 }),
      (v) => {
        assert.equal(v.length, Math.min(25, Math.ceil((size * 2) / 5)));
        assert.ok(v.every((e) => e.content.startsWith("needle")));
      },
    );
    run(
      "message-insert",
      () =>
        askSession(db, {
          from_session: "perf-0",
          to_session: "perf-1",
          question: "measured message",
        }),
      (v) => {
        assert.equal(v.question, "measured message");
        assert.ok(v.id > 0);
      },
    );
    run(
      "context-insert-fts",
      () =>
        publishContext(db, {
          session_id: "perf-0",
          title: "Measured context",
          content: "measured content",
          tags: ["synthetic"],
        }),
      (v) => assert.equal(v.content, "measured content"),
    );
    const after = { counts: counts(db), storage: storage(db) };
    assert.equal(after.counts.messages - before.counts.messages, samples + warmup);
    assert.equal(after.counts.contexts - before.counts.contexts, samples + warmup);
    assert.equal(
      queryContext(db, { query: "measured", limit: 25 }).length,
      Math.min(25, samples + warmup),
    );
    sqlite = {
      before,
      after,
      cases,
      sqliteVersion: db.prepare("SELECT sqlite_version() AS version").get().version,
      pragmas: Object.fromEntries(
        ["journal_mode", "synchronous", "busy_timeout", "page_size", "wal_autocheckpoint"].map(
          (key) => [key, db.pragma(key, { simple: true })],
        ),
      ),
    };
  } finally {
    closeDb(db);
  }
  monitor = seed("http");
  const before = { counts: counts(monitor), storage: storage(monitor) };
  const start = performance.now();
  app = await startHttpServer({
    host: "127.0.0.1",
    port: 0,
    overrideDataDir: join(directory, "http"),
  });
  const startupMs = performance.now() - start;
  process.on("message", async ({ id, command }) => {
    try {
      if (command === "snapshot")
        process.send({
          id,
          resources: snapshot(),
          counts: counts(monitor),
          storage: storage(monitor),
        });
      else if (command === "stop") {
        await app.close();
        closeDb(monitor);
        process.send({ id, stopped: true }, () => process.disconnect());
      } else throw Error(`Unknown command: ${command}`);
    } catch (error) {
      process.send({ id, error: error.message });
    }
  });
  process.send({
    ready: true,
    url: `http://127.0.0.1:${app.server.address().port}`,
    sqlite,
    before,
    startupMs,
  });
}

main().catch(async (error) => {
  console.error(error.stack);
  if (app) await app.close().catch(() => {});
  closeDb(monitor);
  if (process.connected)
    process.send({ failed: true, sqlite: { cases: sqliteCases } }, () => process.exit(1));
  else process.exit(1);
});
