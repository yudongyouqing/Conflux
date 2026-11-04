// External CLI/MCP-style writer process for the contention benchmark.
// It opens the same SQLite file the HTTP server already holds open and
// exposes lock control over IPC so the coordinator never has to guess
// whether the write lock is held: every hold/release is acknowledged.
const { statSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { performance } = require("node:perf_hooks");
const { snapshot } = require("./measurement.cjs");
const root = resolve(__dirname, "../..");
const { openDb, stopWalCheckpoint } = require(join(root, "apps/server/dist/core/db.js"));
const { publishContext } = require(join(root, "apps/server/dist/core/context.js"));
const { queryContext } = require(join(root, "apps/server/dist/core/search.js"));
const Database = require("better-sqlite3");
const { dataDir, dbPath } = JSON.parse(process.argv[2]);

// Holder connection uses the production openDb path (WAL, busy_timeout
// 10000, synchronous NORMAL, foreign keys). The victim connection is a
// plain second handle whose busy timeout the coordinator can shorten to
// observe the lock-timeout path quickly; production code is untouched.
const holder = openDb({ dataDir, dbPath, scope: "global" });
const victim = new Database(dbPath);
victim.pragma("busy_timeout = 10000");
victim.pragma("foreign_keys = ON");

function counts() {
  return {
    contexts: holder.prepare("SELECT COUNT(*) AS n FROM context_entries").get().n,
  };
}

function storage() {
  const bytes = (path) => {
    try {
      return statSync(path).size;
    } catch (error) {
      if (error.code === "ENOENT") return 0;
      throw error;
    }
  };
  return {
    databaseBytes: bytes(dbPath),
    walBytes: bytes(`${dbPath}-wal`),
    shmBytes: bytes(`${dbPath}-shm`),
    pageCount: holder.pragma("page_count", { simple: true }),
    freelistCount: holder.pragma("freelist_count", { simple: true }),
  };
}

function closeAll() {
  // A process exit while a transaction is open rolls it back — that is
  // the abrupt-death path the coordinator tests, so never commit here.
  try {
    if (holder?.open) stopWalCheckpoint(holder);
  } catch {
    // already closed
  }
  for (const handle of [holder, victim]) {
    try {
      if (handle?.open) handle.close();
    } catch {
      // Closing during an open transaction must never block shutdown.
    }
  }
}

process.once("disconnect", () => {
  closeAll();
  process.exit(0);
});

process.on("message", async ({ id, command, ...args }) => {
  try {
    switch (command) {
      case "hold": {
        // BEGIN IMMEDIATE takes the write lock before any row is written,
        // and the acknowledgement tells the coordinator the lock is really
        // held rather than assumed after a delay.
        holder.exec("BEGIN IMMEDIATE");
        const insert = holder.prepare(
          `INSERT INTO context_entries (session_id, title, content, tags, created_at, updated_at)
           VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
        );
        for (let k = 0; k < 3; k++)
          insert.run("perf-0", `${args.marker} title ${k}`, `${args.marker} row ${k}`, null);
        process.send({ id, held: true, marker: args.marker, insertedRows: 3 });
        break;
      }
      case "release": {
        holder.exec(args.mode === "rollback" ? "ROLLBACK" : "COMMIT");
        process.send({ id, released: true, mode: args.mode });
        break;
      }
      case "victim-write": {
        victim.pragma(`busy_timeout = ${args.busyTimeoutMs}`);
        try {
          const entry = publishContext(victim, {
            session_id: "perf-0",
            title: `${args.marker} victim title`,
            content: `${args.marker} victim row`,
            tags: ["contention"],
          });
          process.send({ id, outcome: "succeeded", entryId: entry.id });
        } catch (error) {
          process.send({
            id,
            outcome: /SQLITE_(BUSY|LOCKED)/.test(error.code ?? "") ? "expected-lock" : "unexpected",
            errorCode: error.code ?? null,
            message: error.message,
          });
        } finally {
          victim.pragma("busy_timeout = 10000");
        }
        break;
      }
      case "write-burst": {
        const latenciesMs = [];
        const result = { succeeded: 0, expectedLock: 0, unexpected: 0, unexpectedErrors: [], ids: [] };
        for (let i = 0; i < args.count; i++) {
          const at = performance.now();
          try {
            const entry = publishContext(holder, {
              session_id: "perf-0",
              title: `Burst writer ${args.token} ${i}`,
              content: `${args.token} ${i}`,
              tags: ["contention"],
            });
            result.ids.push(entry.id);
            result.succeeded++;
          } catch (error) {
            if (/SQLITE_(BUSY|LOCKED)/.test(error.code ?? "")) result.expectedLock++;
            else {
              result.unexpected++;
              result.unexpectedErrors.push(error.message);
            }
          } finally {
            latenciesMs.push(performance.now() - at);
          }
        }
        process.send({ id, ...result, latenciesMs });
        break;
      }
      case "victim-read": {
        // A second-connection reader in this process: WAL readers see the
        // pre-transaction snapshot while the holder's transaction is open.
        const rows = queryContext(victim, { query: args.marker, limit: 10 });
        process.send({ id, rows: rows.length });
        break;
      }
      case "counts-storage": {
        process.send({ id, counts: counts(), storage: storage(), resources: snapshot() });
        break;
      }
      case "close": {
        process.send({ id, closed: true }, () => {
          closeAll();
          process.exit(0);
        });
        break;
      }
      default:
        throw Error(`Unknown command: ${command}`);
    }
  } catch (error) {
    process.send({ id, error: error.message });
  }
});

process.send({
  ready: true,
  pid: process.pid,
  pragmas: Object.fromEntries(
    ["journal_mode", "synchronous", "busy_timeout", "page_size", "wal_autocheckpoint"].map((key) => [
      key,
      holder.pragma(key, { simple: true }),
    ]),
  ),
});
