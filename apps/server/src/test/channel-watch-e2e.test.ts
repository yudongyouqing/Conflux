import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import type { ChannelSnapshot } from "../cli/channel-watch.js";
import { openDb } from "../core/db.js";
import { askSession } from "../core/messages.js";
import { registerSession } from "../core/sessions.js";
import { startHttpServer } from "../http/server.js";

interface Fixture {
  dataDir: string;
  edgeId: number;
}

function createFixture(): Fixture {
  const dataDir = mkdtempSync(join(tmpdir(), "muiltchat-channel-watch-e2e-"));
  const db = openDb({ dataDir, dbPath: join(dataDir, "data.db"), scope: "global" });
  try {
    registerSession(db, { id: "watch-from", name: "from" });
    registerSession(db, { id: "watch-to", name: "to" });
    const message = askSession(db, {
      from_session: "watch-from",
      to_session: "watch-to",
      question: "initial question",
    });
    assert.ok(message.edge_id);
    return { dataDir, edgeId: message.edge_id };
  } finally {
    db.close();
  }
}

function snapshotsFromJsonStream(buffer: string): ChannelSnapshot[] {
  const snapshots: ChannelSnapshot[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < buffer.length; index += 1) {
    const character = buffer[index]!;
    if (start === -1) {
      if (character === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        snapshots.push(JSON.parse(buffer.slice(start, index + 1)) as ChannelSnapshot);
        start = -1;
      }
    }
  }
  return snapshots;
}

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timeout = setTimeout(() => {
      child.kill();
      resolvePromise();
    }, 1000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolvePromise();
    });
    child.kill("SIGINT");
  });
}

test("channel watch emits a new snapshot after another database connection adds a message", async () => {
  const fixture = createFixture();
  const entry = resolve(__dirname, "../index.ts");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", entry, "--data-dir", fixture.dataDir, "channel", "watch", String(fixture.edgeId), "--interval", "10"],
    { cwd: resolve(__dirname, "../../../.."), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  let snapshots: ChannelSnapshot[] = [];
  let resolveFirstSnapshot: (() => void) | undefined;
  let resolveSecondSnapshot: (() => void) | undefined;
  const firstSnapshot = new Promise<void>((resolvePromise, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("channel watch did not print its initial snapshot")),
      3000,
    );
    resolveFirstSnapshot = () => {
      clearTimeout(timeout);
      resolvePromise();
    };
  });

  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    snapshots = snapshotsFromJsonStream(stdout);
    if (snapshots.length >= 1) resolveFirstSnapshot?.();
    if (snapshots.length >= 2) resolveSecondSnapshot?.();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  try {
    await firstSnapshot;

    const writer = openDb({
      dataDir: fixture.dataDir,
      dbPath: join(fixture.dataDir, "data.db"),
      scope: "global",
    });
    try {
      askSession(writer, {
        from_session: "watch-from",
        to_session: "watch-to",
        question: "added while watching",
      });
    } finally {
      writer.close();
    }

    const secondSnapshot = new Promise<void>((resolvePromise, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`channel watch did not print an updated snapshot: ${stderr}`)),
        3000,
      );
      resolveSecondSnapshot = () => {
        clearTimeout(timeout);
        resolvePromise();
      };
    });
    if (snapshots.length >= 2) resolveSecondSnapshot?.();
    await secondSnapshot;
    assert.equal(snapshots[0]!.messages.length, 1);
    assert.deepEqual(
      snapshots[1]!.messages.map((message) => message.question),
      ["initial question", "added while watching"],
    );
  } finally {
    await stopChild(child);
    rmSync(fixture.dataDir, { recursive: true, force: true });
  }
});

test("channel watch through HTTP emits a new snapshot after another database connection adds a message", async () => {
  const fixture = createFixture();
  let app: Awaited<ReturnType<typeof startHttpServer>> | undefined;
  let child: ChildProcess | undefined;
  try {
    app = await startHttpServer({ host: "127.0.0.1", port: 0, overrideDataDir: fixture.dataDir });
    const address = app.server.address();
    assert.ok(address && typeof address !== "string");

    const entry = resolve(__dirname, "../index.ts");
    child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        entry,
        "--http",
        `http://127.0.0.1:${address.port}`,
        "channel",
        "watch",
        String(fixture.edgeId),
        "--interval",
        "10",
      ],
      { cwd: resolve(__dirname, "../../../.."), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let snapshots: ChannelSnapshot[] = [];
    let resolveFirstSnapshot: (() => void) | undefined;
    let resolveSecondSnapshot: (() => void) | undefined;
    const firstSnapshot = new Promise<void>((resolvePromise, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("HTTP channel watch did not print its initial snapshot")),
        3000,
      );
      resolveFirstSnapshot = () => {
        clearTimeout(timeout);
        resolvePromise();
      };
    });

    assert.ok(child.stdout);
    assert.ok(child.stderr);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      snapshots = snapshotsFromJsonStream(stdout);
      if (snapshots.length >= 1) resolveFirstSnapshot?.();
      if (snapshots.length >= 2) resolveSecondSnapshot?.();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    await firstSnapshot;

    const writer = openDb({
      dataDir: fixture.dataDir,
      dbPath: join(fixture.dataDir, "data.db"),
      scope: "global",
    });
    try {
      askSession(writer, {
        from_session: "watch-from",
        to_session: "watch-to",
        question: "added while watching over HTTP",
      });
    } finally {
      writer.close();
    }

    const secondSnapshot = new Promise<void>((resolvePromise, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`HTTP channel watch did not print an updated snapshot: ${stderr}`)),
        3000,
      );
      resolveSecondSnapshot = () => {
        clearTimeout(timeout);
        resolvePromise();
      };
    });
    if (snapshots.length >= 2) resolveSecondSnapshot?.();
    await secondSnapshot;
    assert.equal(snapshots[0]!.messages.length, 1);
    assert.deepEqual(
      snapshots[1]!.messages.map((message) => message.question),
      ["initial question", "added while watching over HTTP"],
    );
  } finally {
    if (child) await stopChild(child);
    if (app) await app.close();
    rmSync(fixture.dataDir, { recursive: true, force: true });
  }
});
