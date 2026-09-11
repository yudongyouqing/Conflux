import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildCli } from "../cli/commands.js";
import type { ChannelSnapshot } from "../cli/channel-watch.js";
import { openDb } from "../core/db.js";
import { askSession, replyAsk } from "../core/messages.js";
import { registerSession } from "../core/sessions.js";
import { startHttpServer } from "../http/server.js";

interface ChannelFixture {
  dataDir: string;
  edgeId: number;
}

function createFixture(): ChannelFixture {
  const dataDir = mkdtempSync(join(tmpdir(), "muiltchat-channel-cli-"));
  const db = openDb({ dataDir, dbPath: join(dataDir, "data.db"), scope: "global" });
  try {
    registerSession(db, { id: "channel-from", name: "from" });
    registerSession(db, { id: "channel-to", name: "to" });
    const first = askSession(db, {
      from_session: "channel-from",
      to_session: "channel-to",
      question: "first",
    });
    askSession(db, {
      from_session: "channel-from",
      to_session: "channel-to",
      question: "second",
    });
    replyAsk(db, first.id, "channel-to", "first reply");
    assert.ok(first.edge_id);
    return { dataDir, edgeId: first.edge_id };
  } finally {
    db.close();
  }
}

async function runCli(args: string[]): Promise<string> {
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (value?: unknown) => output.push(String(value));
  try {
    const program = buildCli("muiltchat").exitOverride();
    await program.parseAsync(["node", "muiltchat", ...args]);
    return output.join("\n");
  } finally {
    console.log = originalLog;
  }
}

function watchUntilInitialOutput(dataDir: string, edgeId: number): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string }> {
  const entry = resolve(__dirname, "../index.ts");
  const child = spawn(process.execPath, ["--import", "tsx", entry, "--data-dir", dataDir, "channel", "watch", String(edgeId), "--interval", "10"], {
    cwd: resolve(__dirname, "../../../.."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";

  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("channel watch did not print its initial snapshot"));
    }, 3000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (!stdout.includes('"edge"')) return;
      child.kill("SIGINT");
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolvePromise({ code, signal, stdout });
    });
  });
}

test("both CLI aliases expose a channel command group", () => {
  for (const cliName of ["conflux", "muiltchat"]) {
    const program = buildCli(cliName);
    const channel = program.commands.find((command) => command.name() === "channel");
    assert.ok(channel, `${cliName} should expose channel`);
    assert.ok(channel.commands.some((command) => command.name() === "show"));
    assert.ok(channel.commands.some((command) => command.name() === "watch"));
  }
});

test("channel show prints an edge in oldest-first order from a local data directory", async () => {
  const fixture = createFixture();
  try {
    const output = await runCli(["--data-dir", fixture.dataDir, "channel", "show", String(fixture.edgeId)]);
    const result = JSON.parse(output) as ChannelSnapshot;
    assert.deepEqual(result.edge, { id: fixture.edgeId, from: "channel-from", to: "channel-to" });
    assert.deepEqual(result.messages.map((message) => message.question), ["first", "second"]);
    assert.equal(result.messages[0]!.reply, "first reply");
  } finally {
    rmSync(fixture.dataDir, { recursive: true, force: true });
  }
});

test("channel show uses the existing HTTP edge endpoint when --http is set", async () => {
  const fixture = createFixture();
  let app: Awaited<ReturnType<typeof startHttpServer>> | undefined;
  try {
    app = await startHttpServer({ host: "127.0.0.1", port: 0, overrideDataDir: fixture.dataDir });
    const address = app.server.address();
    assert.ok(address && typeof address !== "string");
    const output = await runCli([
      "--http",
      `http://127.0.0.1:${address.port}`,
      "channel",
      "show",
      String(fixture.edgeId),
    ]);
    assert.equal((JSON.parse(output) as ChannelSnapshot).edge.id, fixture.edgeId);
  } finally {
    if (app) await app.close();
    rmSync(fixture.dataDir, { recursive: true, force: true });
  }
});

test("channel show rejects missing and invalid edge ids", async () => {
  const fixture = createFixture();
  try {
    await assert.rejects(
      runCli(["--data-dir", fixture.dataDir, "channel", "show", "0"]),
      /positive integer/,
    );
    await assert.rejects(
      runCli(["--data-dir", fixture.dataDir, "channel", "show", "999999"]),
      /edge not found/,
    );
  } finally {
    rmSync(fixture.dataDir, { recursive: true, force: true });
  }
});

test("channel watch prints its initial snapshot before SIGINT termination", async () => {
  const fixture = createFixture();
  try {
    const watched = await watchUntilInitialOutput(fixture.dataDir, fixture.edgeId);
    assert.ok(watched.code === 0 || watched.signal === "SIGINT");
    assert.equal((JSON.parse(watched.stdout) as ChannelSnapshot).edge.id, fixture.edgeId);
  } finally {
    rmSync(fixture.dataDir, { recursive: true, force: true });
  }
});
