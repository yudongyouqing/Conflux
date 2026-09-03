import { test } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";

import { resolveConfig } from "../config.js";
import { buildCli } from "../cli/commands.js";
import {
  MIGRATION_MARKER_FILENAME,
  migrateDataDir,
  readMigrationStatus,
  resolveDataHome,
  type MigrationMarker,
} from "../core/config-migration.js";

function makeTempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `conflux-${label}-`));
}

function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function withEnv<T>(values: Record<string, string | undefined>, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function seedLegacyDir(root: string): string {
  const source = join(root, "legacy", ".muiltchat");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "data.db"), "legacy-db-v1");
  writeFileSync(join(source, "data.db-wal"), "legacy-wal-v1");
  writeFileSync(join(source, "data.db-shm"), "legacy-shm-v1");
  return source;
}

function readMarker(destination: string): MigrationMarker {
  return JSON.parse(
    readFileSync(join(destination, MIGRATION_MARKER_FILENAME), "utf8")
  ) as MigrationMarker;
}

test("resolves explicit, Conflux, legacy, project, and global data homes in order", () => {
  const root = makeTempDir("resolution");
  try {
    const explicit = join(root, "explicit");
    const conflux = join(root, "conflux");
    const legacy = join(root, "legacy");
    const home = join(root, "home");
    const project = join(root, "project");
    const projectData = join(project, ".muiltchat");
    mkdirSync(projectData, { recursive: true });

    const env = {
      CONFLUX_HOME: conflux,
      MUILTCHAT_HOME: legacy,
      CLAUDE_PROJECT_DIR: project,
    };

    assert.equal(
      resolveDataHome({ override: explicit, env, homeDir: home }),
      resolve(explicit)
    );
    assert.equal(
      resolveDataHome({ env, homeDir: home }),
      resolve(conflux)
    );
    assert.equal(
      resolveDataHome({ env: { MUILTCHAT_HOME: legacy }, homeDir: home }),
      resolve(legacy)
    );
    assert.equal(
      resolveDataHome({
        env: { CLAUDE_PROJECT_DIR: project },
        homeDir: home,
      }),
      resolve(projectData)
    );
    assert.equal(
      resolveDataHome({
        env: { CLAUDE_PROJECT_DIR: join(root, "missing-project") },
        homeDir: home,
      }),
      resolve(join(home, ".muiltchat"))
    );
  } finally {
    removeTempDir(root);
  }
});

test("resolveConfig honors CONFLUX_HOME before the legacy environment", () => {
  const root = makeTempDir("config");
  const conflux = join(root, ".conflux");
  const legacy = join(root, ".muiltchat");
  try {
    withEnv(
      {
        CONFLUX_HOME: conflux,
        MUILTCHAT_HOME: legacy,
        CLAUDE_PROJECT_DIR: undefined,
      },
      () => {
        const config = resolveConfig("global");
        assert.equal(config.dataDir, resolve(conflux));
        assert.equal(config.dbPath, join(resolve(conflux), "data.db"));
      }
    );
  } finally {
    removeTempDir(root);
  }
});

test("directory resolution never creates ~/.conflux without explicit migration", () => {
  const root = makeTempDir("no-auto-migration");
  try {
    const home = join(root, "home");
    const resolved = resolveDataHome({ env: {}, homeDir: home });

    assert.equal(resolved, resolve(join(home, ".muiltchat")));
    assert.equal(existsSync(join(home, ".conflux")), false);
    assert.equal(existsSync(resolved), false);
  } finally {
    removeTempDir(root);
  }
});

test("migrateDataDir checkpoints before copying and preserves the legacy source", () => {
  const root = makeTempDir("migration-success");
  try {
    const source = seedLegacyDir(root);
    const destination = join(root, "conflux", ".conflux");
    const checkpointed: string[] = [];
    const copiedAt = "2026-09-01T00:00:00.000Z";

    const result = migrateDataDir({
      from: source,
      to: destination,
      checkpoint: (dbPath) => {
        checkpointed.push(dbPath);
        assert.equal(existsSync(dbPath), true);
        assert.equal(existsSync(destination), false);
      },
      now: () => copiedAt,
    });

    assert.equal(result.status, "migrated");
    assert.deepEqual(result.copied, ["data.db", "data.db-wal", "data.db-shm"]);
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(checkpointed, [join(resolve(source), "data.db")]);
    assert.equal(result.sourcePreserved, true);
    assert.deepEqual(result.marker, {
      version: 1,
      source: resolve(source),
      destination: resolve(destination),
      copied_at: copiedAt,
      source_preserved: true,
    });
    assert.deepEqual(readMarker(destination), result.marker);

    for (const file of ["data.db", "data.db-wal", "data.db-shm"]) {
      assert.equal(
        readFileSync(join(destination, file), "utf8"),
        readFileSync(join(source, file), "utf8")
      );
      assert.equal(existsSync(join(source, file)), true);
    }
  } finally {
    removeTempDir(root);
  }
});

test("migrateDataDir cleans its temporary destination after a copy failure", () => {
  const root = makeTempDir("migration-failure");
  try {
    const source = seedLegacyDir(root);
    const destination = join(root, "conflux", ".conflux");
    const sourceSnapshot = new Map(
      ["data.db", "data.db-wal", "data.db-shm"].map((file) => [
        file,
        readFileSync(join(source, file), "utf8"),
      ])
    );
    let copies = 0;

    assert.throws(
      () =>
        migrateDataDir({
          from: source,
          to: destination,
          checkpoint: () => undefined,
          copyFile: (from, to) => {
            copies++;
            if (copies === 2) throw new Error("copy failed");
            copyFileSync(from, to);
          },
        }),
      /copy failed/
    );

    assert.equal(existsSync(destination), false);
    assert.equal(
      readdirSync(root).some((entry) => entry.includes("conflux-migration")),
      false
    );
    for (const [file, contents] of sourceSnapshot) {
      assert.equal(readFileSync(join(source, file), "utf8"), contents);
    }
  } finally {
    removeTempDir(root);
  }
});

test("repeated migration reports conflicts and never overwrites the destination", () => {
  const root = makeTempDir("migration-conflict");
  try {
    const source = seedLegacyDir(root);
    const destination = join(root, "conflux", ".conflux");
    migrateDataDir({
      from: source,
      to: destination,
      checkpoint: () => undefined,
      now: () => "2026-09-01T00:00:00.000Z",
    });
    writeFileSync(join(source, "data.db"), "legacy-db-v2");

    let checkpointCalls = 0;
    const result = migrateDataDir({
      from: source,
      to: destination,
      checkpoint: () => {
        checkpointCalls++;
      },
    });

    assert.equal(result.status, "conflict");
    assert.ok(result.conflicts.includes("data.db"));
    assert.equal(checkpointCalls, 0);
    assert.equal(readFileSync(join(destination, "data.db"), "utf8"), "legacy-db-v1");
    assert.deepEqual(readMigrationStatus(destination), {
      status: "migrated",
      destination: resolve(destination),
      marker: readMarker(destination),
    });
  } finally {
    removeTempDir(root);
  }
});

test("package bins and MCP config expose Conflux while retaining one manual legacy entry", () => {
  const packageJson = JSON.parse(
    readFileSync(resolve(__dirname, "../../package.json"), "utf8")
  ) as { bin: Record<string, string> };
  assert.equal(packageJson.bin.conflux, "dist/index.js");
  assert.equal(packageJson.bin.muiltchat, "dist/index.js");

  const mcpConfig = JSON.parse(
    readFileSync(resolve(__dirname, "../../../..", ".mcp.json"), "utf8")
  ) as {
    mcpServers: Record<string, { command: string; args: string[] }>;
  };
  assert.deepEqual(Object.keys(mcpConfig.mcpServers), ["conflux"]);
  const legacyOnlyConfig = {
    mcpServers: { muiltchat: mcpConfig.mcpServers.conflux },
  };
  assert.equal(legacyOnlyConfig.mcpServers.muiltchat.args.at(-1), "mcp");
  assert.deepEqual(Object.keys(legacyOnlyConfig.mcpServers), ["muiltchat"]);
});

test("Conflux and muiltchat buildCli calls expose the same command tree", () => {
  const conflux = buildCli(["conflux", "path"]);
  const legacy = buildCli(["muiltchat", "path"]);
  const confluxCommands = conflux.commands.map((command) => command.name()).sort();
  const legacyCommands = legacy.commands.map((command) => command.name()).sort();

  assert.equal(conflux.name(), "conflux");
  assert.equal(legacy.name(), "muiltchat");
  assert.deepEqual(confluxCommands, legacyCommands);
  assert.ok(confluxCommands.includes("path"));
  assert.ok(confluxCommands.includes("migrate"));

  const migrate = conflux.commands.find((command) => command.name() === "migrate");
  assert.ok(migrate);
  assert.ok(migrate.options.some((option) => option.long === "--from"));
  assert.ok(migrate.options.some((option) => option.long === "--to"));
  assert.ok(migrate.options.some((option) => option.long === "--status"));
});

test("path and migrate CLI commands use explicit directories and status is read-only", async () => {
  const root = makeTempDir("cli");
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (value?: unknown) => output.push(String(value));

  try {
    const explicit = join(root, "explicit");
    await buildCli("conflux").parseAsync([
      "node",
      "conflux",
      "--data-dir",
      explicit,
      "path",
    ]);
    assert.equal(JSON.parse(output.pop()!).dataDir, resolve(explicit));

    const source = join(root, "legacy");
    mkdirSync(source, { recursive: true });
    const db = new Database(join(source, "data.db"));
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT)");
    db.close();

    const destination = join(root, "conflux");
    await buildCli("conflux").parseAsync([
      "node",
      "conflux",
      "migrate",
      "--from",
      source,
      "--to",
      destination,
    ]);
    assert.equal(JSON.parse(output.pop()!).status, "migrated");

    const statusDestination = join(root, "status-only");
    await buildCli("conflux").parseAsync([
      "node",
      "conflux",
      "migrate",
      "--status",
      "--to",
      statusDestination,
    ]);
    assert.equal(JSON.parse(output.pop()!).status, "not-migrated");
    assert.equal(existsSync(statusDestination), false);
  } finally {
    console.log = originalLog;
    removeTempDir(root);
  }
});
