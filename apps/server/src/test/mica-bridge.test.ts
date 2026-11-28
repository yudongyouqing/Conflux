import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { MicaPaneInfo, MicaReadResult, ThreadState } from "@conflux/shared";
import { startHttpServer } from "../http/server.js";
import { openDb, stopWalCheckpoint, type DB } from "../core/db.js";
import { insertThread, updateThread, getThread } from "../core/threads/store.js";
import { publishLiveEvent, resetLiveEventBusForTest } from "../core/event-bus.js";
import {
  createDefaultMicaRunner,
  MICA_TIMEOUTS,
  MicaCliError,
  type MicaRunResult,
  type MicaRunner,
} from "../core/mica/client.js";

const SHIM = fileURLToPath(new URL("./mica-shim.cjs", import.meta.url));

interface ShimState {
  panes: MicaPaneInfo[];
  watchers: Array<{ pid: number; at: number }>;
}

type ShimLogName = "opens" | "focuses" | "sent" | "badges" | "events";

interface ShimOpenRecord {
  mode: string;
  cwd: string;
  command: string | null;
  env: Record<string, string>;
}

interface ShimSentRecord {
  pane_id: number;
  text: string;
  literal: boolean;
}

interface ShimBadgeRecord {
  pane_id: number;
  state: string;
  text: string | null;
  sticky: boolean;
}

/**
 * Runner that routes every mica invocation into the state-file shim so the
 * bridge under test never touches a real GUI.
 */
function createShimRunner(statePath: string, hangCommands: string[] = []): MicaRunner {
  const env = {
    ...process.env,
    MICA_SHIM_STATE: statePath,
    ...(hangCommands.length > 0 ? { MICA_SHIM_HANG: hangCommands.join(",") } : {}),
  };
  return {
    exec(args, opts = {}) {
      return new Promise<MicaRunResult>((resolve, reject) => {
        execFile(
          process.execPath,
          [SHIM, ...args],
          {
            timeout: opts.timeoutMs ?? 10_000,
            windowsHide: true,
            shell: false,
            encoding: "utf8",
            env,
          },
          (err, stdout, stderr) => {
            if (!err) return resolve({ stdout, stderr, code: 0 });
            // Match the default runner: execFile timeouts surface as
            // killed+SIGTERM with a null code, not a string errno.
            if ((err as { killed?: boolean }).killed) {
              return reject(new MicaCliError("timeout", `mica ${args[0]} 超时`, stderr));
            }
            const code = (err as { code?: unknown }).code;
            if (typeof code === "string") {
              return reject(new MicaCliError("spawn_failed", err.message, stderr));
            }
            resolve({ stdout, stderr, code: typeof code === "number" ? code : null });
          },
        );
      });
    },
    spawn(args, listeners) {
      const child = spawn(process.execPath, [SHIM, ...args], {
        env,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let buffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let idx = buffer.indexOf("\n");
        while (idx >= 0) {
          const line = buffer.slice(0, idx).replace(/\r$/, "");
          buffer = buffer.slice(idx + 1);
          if (line.trim()) listeners.onStdoutLine(line);
          idx = buffer.indexOf("\n");
        }
      });
      child.on("error", (err) => listeners.onSpawnError(err));
      return {
        kill: () => {
          try {
            child.kill();
          } catch {
            // already gone
          }
        },
        exited: new Promise<void>((resolve) => {
          child.on("close", () => resolve());
          child.on("error", () => resolve());
        }),
      };
    },
  };
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on("error", reject);
  });
}

async function startServer(
  dataDir: string,
  runner: MicaRunner,
): Promise<{ app: FastifyInstance; baseUrl: string }> {
  const port = await getFreePort();
  const app = await startHttpServer({
    host: "127.0.0.1",
    port,
    overrideDataDir: dataDir,
    micaBridgeOptions: {
      createRunner: () => runner,
      badgeDebounceMs: 40,
      reconnectBaseMs: 80,
      notRunningRetryMs: 150,
    },
  });
  return { app, baseUrl: `http://127.0.0.1:${port}` };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readShimState(statePath: string): ShimState {
  return JSON.parse(readFileSync(statePath, "utf8")) as ShimState;
}

function readShimLog<T>(statePath: string, name: ShimLogName): T[] {
  return readFileSync(`${statePath}.${name}.ndjson`, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function appendShimEvent(statePath: string, ev: Record<string, unknown>): void {
  appendFileSync(`${statePath}.events.ndjson`, `${JSON.stringify(ev)}\n`);
}

function readWatcherBeat(statePath: string): { pid: number; at: number } | null {
  try {
    return JSON.parse(readFileSync(`${statePath}.beat`, "utf8")) as { pid: number; at: number };
  } catch {
    return null;
  }
}

function mutateShimState(statePath: string, mutate: (s: ShimState) => void): void {
  const s = readShimState(statePath);
  mutate(s);
  writeFileSync(statePath, JSON.stringify(s, null, 2));
}

async function pollUntil(
  cond: () => boolean,
  opts: { timeoutMs?: number; label?: string } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const started = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`pollUntil timeout: ${opts.label ?? "condition"}`);
    }
    await sleep(60);
  }
}

function jsonPost(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("mica routes degrade gracefully when the CLI is missing", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "conflux-mica-missing-"));
  const { app, baseUrl } = await startServer(
    dataDir,
    createDefaultMicaRunner(join(dataDir, "missing", "mica.exe")),
  );
  try {
    const status = (await fetch(`${baseUrl}/mica/status`).then((r) => r.json())) as {
      available: boolean;
      running: boolean;
      panes: unknown[];
    };
    assert.equal(status.available, false);
    assert.equal(status.running, false);
    assert.deepEqual(status.panes, []);
    const panes = (await fetch(`${baseUrl}/mica/panes`).then((r) => r.json())) as {
      running: boolean;
      panes: unknown[];
    };
    assert.equal(panes.running, false);
    assert.deepEqual(panes.panes, []);
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 });
  }
});

test("mica status reports installed-but-not-running when no instance exists", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "conflux-mica-idle-"));
  // State file intentionally absent: the shim treats that as "no GUI running".
  const { app, baseUrl } = await startServer(dataDir, createShimRunner(join(dataDir, "state.json")));
  try {
    const status = (await fetch(`${baseUrl}/mica/status`).then((r) => r.json())) as {
      available: boolean;
      running: boolean;
      panes: unknown[];
    };
    assert.equal(status.available, true);
    assert.equal(status.running, false);
    assert.deepEqual(status.panes, []);
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 });
  }
});

test("a wedged mica list surfaces a timeout (504), never a silent not-running", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "conflux-mica-hang-"));
  const { app, baseUrl } = await startServer(
    dataDir,
    createShimRunner(join(dataDir, "state.json"), ["list"]),
  );
  const savedListTimeout = MICA_TIMEOUTS.list;
  (MICA_TIMEOUTS as { list: number }).list = 150;
  try {
    const res = await fetch(`${baseUrl}/mica/status`);
    assert.equal(res.status, 504);
    const panesRes = await fetch(`${baseUrl}/mica/panes`);
    assert.equal(panesRes.status, 504);
  } finally {
    (MICA_TIMEOUTS as { list: number }).list = savedListTimeout;
    await app.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 });
  }
});

test("mica open binds thread with cwd+env, reuse focuses, attach/unbind/send/read/badge, bad_target cleanup, watch unbind and badge auto-sync", async () => {
  resetLiveEventBusForTest();
  const dataDir = mkdtempSync(join(tmpdir(), "conflux-mica-flow-data-"));
  const repoDir = mkdtempSync(join(tmpdir(), "conflux-mica-flow-repo-"));
  const statePath = join(dataDir, "state.json");
  const { app, baseUrl } = await startServer(dataDir, createShimRunner(statePath));

  const sseAbort = new AbortController();
  const sseChunks: string[] = [];
  const sseRes = await fetch(`${baseUrl}/live/events`, { signal: sseAbort.signal });
  assert.equal(sseRes.status, 200);
  const reader = sseRes.body!.getReader();
  const decoder = new TextDecoder();
  const sseDrain = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sseChunks.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      // aborted on teardown
    }
  })();

  const db: DB = openDb({
    dataDir,
    dbPath: join(dataDir, "conflux-v2.db"),
    scope: "global",
  });
  const thread = insertThread(db, {
    project_id: null,
    name: "mica-agent 测试线程",
    kind: "external",
    runtime: "claude",
    workdir: repoDir,
  });

  const badgeSyncTick = (state: ThreadState) => {
    updateThread(db, thread.id, { state });
    publishLiveEvent({ type: "thread.updated", thread_id: thread.id, payload: { action: "test" } });
  };

  try {
    // ---- open: exact cwd + session env, binding persisted
    let res = await jsonPost(baseUrl, `/threads/${thread.id}/mica/open`, { mode: "tab" });
    assert.equal(res.status, 200);
    const opened = (await res.json()) as {
      pane: MicaPaneInfo;
      thread: { mica_pane_id: number | null };
      reused: boolean;
    };
    assert.equal(opened.reused, false);
    const paneA = opened.pane.pane_id;
    assert.ok(paneA > 0);
    assert.equal(opened.thread.mica_pane_id, paneA);
    assert.equal(getThread(db, thread.id)?.mica_pane_id, paneA);
    const opens = readShimLog<ShimOpenRecord>(statePath, "opens");
    assert.equal(opens.length, 1);
    assert.equal(opens[0].mode, "new-tab");
    assert.equal(opens[0].cwd, repoDir);
    assert.equal(opens[0].env.CONFLUX_SESSION_ID, thread.id);
    assert.equal(opens[0].env.CONFLUX_THREAD_NAME, thread.name);

    // ---- repeat open without force_new reuses and focuses the bound pane
    res = await jsonPost(baseUrl, `/threads/${thread.id}/mica/open`, {});
    assert.equal(res.status, 200);
    const reused = (await res.json()) as { reused: boolean; pane: MicaPaneInfo };
    assert.equal(reused.reused, true);
    assert.equal(reused.pane.pane_id, paneA);
    assert.equal(readShimLog(statePath, "focuses").length, 1);
    assert.equal(readShimState(statePath).panes.length, 1);

    // ---- attach an existing pane; reject unknown panes
    mutateShimState(statePath, (s) => {
      s.panes.push({
        window_id: 1,
        tab_index: 9,
        pane_id: 777,
        pid: null,
        cwd: repoDir,
        title: "external",
        is_active: false,
        is_focused: false,
        is_quick_terminal: false,
        prompt_state: "idle",
        last_exit_code: null,
        badge: null,
      });
    });
    res = await jsonPost(baseUrl, `/threads/${thread.id}/mica/attach`, { pane_id: 777 });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { thread: { mica_pane_id: number | null } }).thread.mica_pane_id, 777);
    res = await jsonPost(baseUrl, `/threads/${thread.id}/mica/attach`, { pane_id: 99999 });
    assert.equal(res.status, 404);

    // ---- unbind keeps the terminal alive
    res = await fetch(`${baseUrl}/threads/${thread.id}/mica`, { method: "DELETE" });
    assert.equal(res.status, 200);
    assert.equal(getThread(db, thread.id)?.mica_pane_id, null);
    assert.equal(readShimState(statePath).panes.length, 2);

    // ---- re-open, then send (escape Enter + literal modes)
    res = await jsonPost(baseUrl, `/threads/${thread.id}/mica/open`, { mode: "window" });
    assert.equal(res.status, 200);
    const paneB = ((await res.json()) as { pane: MicaPaneInfo }).pane.pane_id;
    assert.equal(readShimLog<ShimOpenRecord>(statePath, "opens").at(-1)?.mode, "new-window");

    res = await jsonPost(baseUrl, `/threads/${thread.id}/mica/send`, {
      text: "npm test",
      submit: true,
    });
    assert.equal(res.status, 200);
    let sent = readShimLog<ShimSentRecord>(statePath, "sent");
    assert.deepEqual(sent.at(-1), { pane_id: paneB, text: "npm test\\r", literal: false });

    res = await jsonPost(baseUrl, `/threads/${thread.id}/mica/send`, {
      text: "pwd",
      submit: true,
      literal: true,
    });
    assert.equal(res.status, 200);
    sent = readShimLog<ShimSentRecord>(statePath, "sent");
    assert.deepEqual(sent.slice(-2), [
      { pane_id: paneB, text: "pwd", literal: true },
      { pane_id: paneB, text: "\\r", literal: false },
    ]);

    // ---- read returns a side-effect-free snapshot
    const readRes = (await fetch(
      `${baseUrl}/threads/${thread.id}/mica/read?scrollback=1&lines=80`,
    ).then((r) => r.json())) as MicaReadResult;
    assert.equal(readRes.pane_id, paneB);
    assert.ok(readRes.cols > 0);
    assert.ok(readRes.text.includes("simulated screen"));

    // ---- explicit badge round trip
    res = await jsonPost(baseUrl, `/threads/${thread.id}/mica/badge`, {
      state: "attention",
      text: "hi",
      sticky: true,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(readShimLog<ShimBadgeRecord>(statePath, "badges").at(-1), {
      pane_id: paneB,
      state: "attention",
      text: "hi",
      sticky: true,
    });

    // ---- bad_target on focus clears the stale binding
    mutateShimState(statePath, (s) => {
      s.panes = s.panes.filter((p) => p.pane_id !== paneB);
    });
    res = await fetch(`${baseUrl}/threads/${thread.id}/mica/focus`, { method: "POST" });
    assert.equal(res.status, 404);
    await pollUntil(() => getThread(db, thread.id)?.mica_pane_id == null, {
      label: "bad_target unbind",
    });

    // ---- watch stream: pane_closed unbinds and broadcasts mica.updated
    // Wait for the previous watcher to wind down first, then for a watcher
    // whose heartbeat postdates this reopen AND has a fresh pid — that closes
    // the cursor-snapshot race between spawning the watcher and appending the
    // event (a stalled machine could otherwise let the old pid masquerade).
    let staleWatcherPid: number | null = null;
    await pollUntil(() => {
      const beat = readWatcherBeat(statePath);
      if (!beat || Date.now() - beat.at > 600) return true;
      staleWatcherPid = beat.pid;
      return false;
    }, { label: "previous watcher wound down" });
    const reopenAt = Date.now();
    res = await jsonPost(baseUrl, `/threads/${thread.id}/mica/open`, {});
    const paneC = ((await res.json()) as { pane: MicaPaneInfo }).pane.pane_id;
    await pollUntil(() => {
      const beat = readWatcherBeat(statePath);
      return Boolean(beat && beat.at >= reopenAt && beat.pid !== staleWatcherPid);
    }, { label: "live watcher after reopen" });
    appendShimEvent(statePath, { type: "pane_closed", pane_id: paneC });
    await pollUntil(() => getThread(db, thread.id)?.mica_pane_id == null, {
      label: "pane_closed unbind",
    });
    await sleep(200);
    assert.ok(sseChunks.join("").includes("mica.updated"), "mica.updated must reach SSE");

    // ---- thread state changes mirror onto the Mica badge
    res = await jsonPost(baseUrl, `/threads/${thread.id}/mica/open`, {});
    const paneD = ((await res.json()) as { pane: MicaPaneInfo }).pane.pane_id;
    const lastBadgeFor = (paneId: number) =>
      readShimLog<ShimBadgeRecord>(statePath, "badges")
        .filter((b) => b.pane_id === paneId)
        .at(-1);

    badgeSyncTick("waiting_approval");
    await pollUntil(
      () =>
        lastBadgeFor(paneD)?.state === "attention" && lastBadgeFor(paneD)?.text === "等待审批",
      { label: "attention badge on waiting_approval" },
    );

    badgeSyncTick("running");
    await pollUntil(
      () =>
        lastBadgeFor(paneD)?.state === "running" &&
        lastBadgeFor(paneD)?.text === thread.name.slice(0, 32),
      { label: "running badge" },
    );

    badgeSyncTick("stopped");
    await pollUntil(() => lastBadgeFor(paneD)?.state === "none", {
      label: "cleared badge on stopped",
    });
  } finally {
    sseAbort.abort();
    await sseDrain;
    await app.close();
    stopWalCheckpoint(db);
    if (db.open) db.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 });
    rmSync(repoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 });
  }
});

function parseMcpSseOrJson(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as Record<string, unknown>;
  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  assert.ok(dataLines.length > 0, `expected JSON or SSE data in MCP response: ${raw}`);
  return JSON.parse(dataLines[dataLines.length - 1]) as Record<string, unknown>;
}

test("Streamable HTTP /mcp exposes read_mica_snapshot for bound threads, explicit pane_id, and bad_target cleanup", async () => {
  resetLiveEventBusForTest();
  const dataDir = mkdtempSync(join(tmpdir(), "conflux-mica-mcp-data-"));
  const repoDir = mkdtempSync(join(tmpdir(), "conflux-mica-mcp-repo-"));
  const statePath = join(dataDir, "state.json");
  const { app, baseUrl } = await startServer(dataDir, createShimRunner(statePath));

  const db: DB = openDb({
    dataDir,
    dbPath: join(dataDir, "conflux-v2.db"),
    scope: "global",
  });

  try {
    const initRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "X-Conflux-Session-Id": "mcp-mica-caller",
        "X-Conflux-Host": "win-dev",
        "X-Conflux-Cwd": repoDir,
        "X-Conflux-Name": encodeURIComponent("MCP Mica Caller"),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "mica-mcp-test", version: "1.0.0" },
        },
      }),
    });
    assert.equal(initRes.status, 200);
    const sid = initRes.headers.get("mcp-session-id");
    assert.ok(sid, "MCP session id must be returned");

    const mcpCall = async (id: number, method: string, params: Record<string, unknown>) => {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "mcp-session-id": sid!,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });
      assert.equal(res.status, 200);
      return parseMcpSseOrJson(await res.text());
    };

    // 1. tools/list exposes read_mica_snapshot alongside golden tools
    const listed = await mcpCall(2, "tools/list", {});
    assert.ok(JSON.stringify(listed).includes("read_mica_snapshot"));

    // 2. Calling read_mica_snapshot before binding returns a clear isError tool result
    const unbound = await mcpCall(3, "tools/call", {
      name: "read_mica_snapshot",
      arguments: {},
    });
    const unboundResult = unbound.result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(unboundResult.isError, true);
    assert.match(unboundResult.content[0].text, /not bound/i);

    // 3. Open a Mica pane for this thread, send a command, and read via MCP
    const openRes = await jsonPost(baseUrl, `/threads/mcp-mica-caller/mica/open`, { mode: "tab" });
    assert.equal(openRes.status, 200);
    const opened = (await openRes.json()) as { pane: MicaPaneInfo };
    const paneId = opened.pane.pane_id;
    await jsonPost(baseUrl, `/threads/mcp-mica-caller/mica/send`, {
      text: "echo MCP_SNAPSHOT_OK",
      submit: true,
      literal: true,
    });

    // list_peers surfaces mica_pane_id so peers can discover bound terminals
    const peersMsg = await mcpCall(4, "tools/call", {
      name: "list_peers",
      arguments: { include_offline: true },
    });
    const peersBody = JSON.parse(
      ((peersMsg.result as { content: Array<{ text: string }> }).content[0]).text,
    ) as { peers: Array<{ id: string; mica_pane_id: number | null }> };
    const selfPeer = peersBody.peers.find((p) => p.id === "mcp-mica-caller");
    assert.equal(selfPeer?.mica_pane_id, paneId);

    const snapMsg = await mcpCall(5, "tools/call", {
      name: "read_mica_snapshot",
      arguments: { scrollback: true, lines: 42 },
    });
    const snapResult = snapMsg.result as { isError?: boolean; content: Array<{ text: string }> };
    assert.ok(!snapResult.isError, `expected clean snapshot, got: ${JSON.stringify(snapResult)}`);
    const snapPayload = JSON.parse(snapResult.content[0].text) as MicaReadResult & {
      thread_id: string | null;
    };
    assert.equal(snapPayload.thread_id, "mcp-mica-caller");
    assert.equal(snapPayload.pane_id, paneId);
    assert.match(snapPayload.text, /simulated screen for pane/);
    assert.match(snapPayload.text, /\(scrollback\)/);
    assert.match(snapPayload.text, /\(lines=42\)/);

    // 4. Explicit pane_id works without thread_id lookup
    const directMsg = await mcpCall(6, "tools/call", {
      name: "read_mica_snapshot",
      arguments: { pane_id: paneId, scrollback: false, lines: 15 },
    });
    const directPayload = JSON.parse(
      ((directMsg.result as { content: Array<{ text: string }> }).content[0]).text,
    ) as MicaReadResult & { thread_id: string | null };
    assert.equal(directPayload.thread_id, null);
    assert.equal(directPayload.pane_id, paneId);
    assert.ok(!directPayload.text.includes("(scrollback)"));
    assert.match(directPayload.text, /\(lines=15\)/);

    // 5. bad_target clears the stale thread binding automatically
    mutateShimState(statePath, (s) => {
      s.panes = s.panes.filter((p) => p.pane_id !== paneId);
    });
    const staleMsg = await mcpCall(7, "tools/call", {
      name: "read_mica_snapshot",
      arguments: {},
    });
    const staleResult = staleMsg.result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(staleResult.isError, true);
    assert.match(staleResult.content[0].text, /stale binding cleared/i);
    assert.equal(getThread(db, "mcp-mica-caller")?.mica_pane_id, null);
  } finally {
    await app.close();
    stopWalCheckpoint(db);
    if (db.open) db.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 });
    rmSync(repoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 });
  }
});
