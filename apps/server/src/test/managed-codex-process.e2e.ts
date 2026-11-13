import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  resolveLaunchPlan,
  spawnAppServer,
  type AppServerProcess,
} from "../core/managed-codex/process.js";

// Real-subprocess E2E for the managed Codex stdio transport against the
// controllable app-server shim (managed-codex-shim.cjs). Runs OUTSIDE the
// parallel *.test.ts suite on purpose — join the serial
// `npm run test:process-e2e -w apps/server` run (see package.json).

const shimPath = resolve(__dirname, "managed-codex-shim.cjs");

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function readShimLog(logPath: string): Array<{ dir: string; frame: Record<string, unknown> }> {
  try {
    return readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { dir: string; frame: Record<string, unknown> });
  } catch {
    return [];
  }
}

interface ServerHandle {
  proc: AppServerProcess;
  logPath: string;
  cwd: string;
  dir: string;
  notifications: string[];
  serverRequests: Array<{ id: number | string; method: string; params: unknown }>;
  stop: () => Promise<void>;
}

async function startShim(markers: { env?: Record<string, string> } = {}): Promise<ServerHandle> {
  const dir = tempDir("managed-codex-e2e-");
  const cwd = join(dir, "project");
  mkdirSync(cwd, { recursive: true });
  const logPath = join(dir, "shim-rpc.log");
  const notifications: string[] = [];
  const serverRequests: ServerHandle["serverRequests"] = [];
  const proc = spawnAppServer({
    executable: shimPath,
    args: ["app-server"],
    cwd,
    env: {
      ...markers.env,
      SHIM_LOG: logPath,
      SHIM_CWD: cwd,
      SHIM_CODEX_HOME: join(dir, "codex-home"),
    },
    handlers: {
      onNotification: (method) => notifications.push(method),
      onServerRequest: (id, method, params) => serverRequests.push({ id, method, params }),
    },
    rpcOptions: { requestTimeoutMs: 5000 },
  });
  const stop = async () => {
    proc.kill();
    await proc.exited;
    rmSync(dir, { recursive: true, force: true });
  };
  return { proc, logPath, cwd, dir, notifications, serverRequests, stop };
}

const turnText = (text: string) => [{ type: "text", text, text_elements: [] as unknown[] }];

test("resolveLaunchPlan maps executables to spawnable commands", () => {
  const exe = resolveLaunchPlan("C:\\tools\\codex.exe", ["app-server"], "win32");
  assert.equal(exe.command, "C:\\tools\\codex.exe");
  assert.deepEqual(exe.args, ["app-server"]);

  const js = resolveLaunchPlan("C:\\tools\\codex.js", ["app-server"], "win32");
  assert.equal(js.command, process.execPath);
  assert.deepEqual(js.args, ["C:\\tools\\codex.js", "app-server"]);

  const posix = resolveLaunchPlan("/usr/local/bin/codex", ["app-server"], "linux");
  assert.equal(posix.command, "/usr/local/bin/codex");
});

test("resolveLaunchPlan extracts the node script behind an npm cmd shim", () => {
  const dir = tempDir("managed-codex-shim-resolve-");
  try {
    const pkgDir = join(dir, "node_modules", "@openai", "codex", "bin");
    mkdirSync(pkgDir, { recursive: true });
    const script = join(pkgDir, "codex.js");
    writeFileSync(script, "// fake entry\n");
    writeFileSync(
      join(dir, "codex.cmd"),
      [
        "@ECHO off",
        'node "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
      ].join("\r\n"),
    );
    const plan = resolveLaunchPlan(join(dir, "codex.cmd"), ["app-server"], "win32");
    assert.equal(plan.command, process.execPath);
    assert.equal(plan.args[0], resolve(script));
    assert.deepEqual(plan.args.slice(1), ["app-server"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveLaunchPlan refuses a cmd shim with no resolvable script", () => {
  const dir = tempDir("managed-codex-shim-broken-");
  try {
    const shim = join(dir, "codex.cmd");
    writeFileSync(shim, "@ECHO off\r\necho no script here\r\n");
    assert.throws(
      () => resolveLaunchPlan(shim, [], "win32"),
      /cannot resolve npm cmd shim/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawnAppServer drives a full thread/turn lifecycle over stdio", async () => {
  const server = await startShim();
  try {
    const init = await server.proc.conn.request("initialize", {
      clientInfo: { name: "conflux-test", title: null, version: "0.0.0" },
      capabilities: null,
    });
    assert.match(String((init as { userAgent: string }).userAgent), /codex_shim/);

    const started = await server.proc.conn.request("thread/start", { cwd: server.cwd });
    const threadId = (started as { thread: { id: string } }).thread.id;
    assert.equal(threadId, "shim-thread-0001");

    const turn = await server.proc.conn.request("turn/start", {
      threadId,
      input: turnText("plain fixture task"),
    });
    assert.equal((turn as { turn: { status: string } }).turn.status, "inProgress");

    // The full notification chain arrives before turn/completed settles the
    // waiter below — poll briefly instead of assuming synchronous delivery.
    await new Promise<void>((done) => {
      const check = () => {
        if (server.notifications.includes("turn/completed")) done();
        else setTimeout(check, 50);
      };
      check();
    });
    assert.ok(server.notifications.includes("turn/started"));
    assert.ok(server.notifications.includes("item/started"));
    assert.ok(server.notifications.includes("item/agentMessage/delta"));
    assert.ok(server.notifications.includes("item/completed"));

    // The shim received exactly the frames we sent, with the prompt intact.
    const log = readShimLog(server.logPath);
    const turnStart = log.find((e) => e.frame.method === "turn/start");
    assert.ok(turnStart, "shim logged the turn/start frame");
    const input = (turnStart!.frame.params as { input: Array<{ type: string; text: string }> })
      .input;
    assert.equal(input[0]?.type, "text");
    assert.equal(input[0]?.text, "plain fixture task");
  } finally {
    await server.stop();
  }
});

test("a server approval request is answered via respond() and the turn completes", async () => {
  const server = await startShim();
  try {
    await server.proc.conn.request("initialize", { clientInfo: { name: "t", title: null, version: "0" } });
    const started = await server.proc.conn.request("thread/start", {});
    const threadId = (started as { thread: { id: string } }).thread.id;
    const turnPromise = server.proc.conn.request("turn/start", {
      threadId,
      input: turnText("@approval"),
    });
    // Wait for the approval server request.
    await new Promise<void>((done) => {
      const check = () => {
        if (server.serverRequests.length > 0) done();
        else setTimeout(check, 50);
      };
      check();
    });
    const approval = server.serverRequests[0];
    assert.equal(approval.method, "item/commandExecution/requestApproval");
    const params = approval.params as { threadId: string; itemId: string };
    assert.equal(params.threadId, threadId);
    server.proc.conn.respond(approval.id, { decision: "accept" });

    const turn = await turnPromise;
    assert.equal((turn as { turn: { status: string } }).turn.status, "inProgress");
    await new Promise<void>((done) => {
      const check = () => {
        if (server.notifications.includes("turn/completed")) done();
        else setTimeout(check, 50);
      };
      check();
    });
    // The decision landed as a bare {id, result} frame.
    const log = readShimLog(server.logPath);
    const answer = log.find((e) => e.frame.id === approval.id && e.frame.result);
    assert.deepEqual((answer?.frame as { result: { decision: string } }).result, {
      decision: "accept",
    });
  } finally {
    await server.stop();
  }
});

test("child crash settles pending requests and the exit promise", async () => {
  const server = await startShim();
  try {
    await server.proc.conn.request("initialize", { clientInfo: { name: "t", title: null, version: "0" } });
    const started = await server.proc.conn.request("thread/start", {});
    const threadId = (started as { thread: { id: string } }).thread.id;
    // A request the shim acknowledges but never answers stays pending across
    // the crash window — the turn/start itself IS answered before the exit.
    const hanging = server.proc.conn.request("hang/forever", {}, { timeoutMs: 10_000 });
    // Whichever lands first — stdout end or the exit event — must reject it.
    const rejection = assert.rejects(hanging, /exited|stream ended|closed/i);
    await server.proc.conn.request("turn/start", {
      threadId,
      input: turnText("@crash"),
    });
    const exit = await server.proc.exited;
    assert.equal(exit.code, 3);
    await rejection;
    // After death, new requests fail immediately and no shim process remains.
    await assert.rejects(server.proc.conn.request("anything"));
  } finally {
    await server.stop();
  }
});

test("kill() ends the child cleanly and leaves no pending requests", async () => {
  const server = await startShim();
  const pending = server.proc.conn.request("hang/forever", {}, { timeoutMs: 10_000 });
  const rejection = assert.rejects(pending, /killed|exited|closed/i);
  server.proc.kill();
  await server.proc.exited;
  await rejection;
  assert.equal(server.proc.child.exitCode !== null || server.proc.child.signalCode !== null, true);
  rmSync(server.dir, { recursive: true, force: true });
});

test("invalid lines from the peer surface as protocol errors, not crashes", async () => {
  const server = await startShim();
  try {
    const before = server.notifications.length;
    await server.proc.conn.request("initialize", { clientInfo: { name: "t", title: null, version: "0" } });
    const started = await server.proc.conn.request("thread/start", {});
    const threadId = (started as { thread: { id: string } }).thread.id;
    // @invalid makes the shim write a malformed line, then complete normally.
    await server.proc.conn.request("turn/start", {
      threadId,
      input: turnText("@invalid"),
    });
    await new Promise<void>((done) => {
      const check = () => {
        if (server.notifications.includes("turn/completed")) done();
        else setTimeout(check, 50);
      };
      check();
    });
    assert.ok(before < server.notifications.length, "connection survived the bad line");
    assert.ok(server.proc.child.exitCode === null, "shim still alive");
  } finally {
    await server.stop();
  }
});

test("closing stdin ends a well-behaved shim", async () => {
  const server = await startShim();
  try {
    await server.proc.conn.request("initialize", { clientInfo: { name: "t", title: null, version: "0" } });
    server.proc.conn.close();
    const exit = await Promise.race([
      server.proc.exited,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("shim did not exit on stdin end")), 5000),
      ),
    ]);
    assert.equal(exit.code, 0);
  } finally {
    await server.stop();
  }
});
