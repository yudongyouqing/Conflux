import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WEB_CONSOLE_ID } from "@conflux/shared";
import { makeDb } from "./helpers.js";
import { startHttpServer } from "../http/server.js";
import { insertThread, updateThread } from "../core/threads/store.js";
import { saveRuntimeSettings } from "../core/runtime-env.js";
import {
  approvePendingCall,
  askThread,
  hangupCall,
  replyMessage,
  waitForMessageOutcome,
} from "../core/messages.js";
import { buildGraph } from "../core/graph.js";
import {
  buildOriginalDirectoryWakePlan,
  detectLocalNetworkInfo,
  installCliHook,
} from "../core/hooks.js";
import {
  commitGitChanges,
  getGitStatus,
  getPrDetail,
  resolveGitBinary,
  stageGitFiles,
} from "../core/git-worktree.js";
import {
  execWorkspaceCommand,
  listWorkspaceDirectory,
  readWorkspaceFile,
} from "../core/workspace-tools.js";

const ACP_SHIM = fileURLToPath(new URL("./managed-acp-shim.cjs", import.meta.url));
const CLAUDE_SHIM = fileURLToPath(new URL("./managed-claude-shim.cjs", import.meta.url));

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

function makeTempGitRepo(): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), "conflux-paseo-git-"));
  const gitBin = resolveGitBinary();
  const git = (args: string[]) =>
    execFileSync(gitBin, args, {
      cwd: repoDir,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Paseo Test"]);
  git(["config", "user.email", "paseo@local"]);
  mkdirSync(join(repoDir, "src"), { recursive: true });
  writeFileSync(join(repoDir, "src", "auth.ts"), "export const leeway = 0;\n", "utf8");
  git(["add", "-A"]);
  git(["commit", "-m", "initial commit"]);
  return {
    repoDir,
    cleanup: () => rmSync(repoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 }),
  };
}

test("incoming_call_mode (auto/ask/dnd), trace_id, context diff, wait/reply, hangup & live graph pruning", async () => {
  const { db, cleanup } = makeDb();
  try {
    const a = insertThread(db, {
      id: "peer-a",
      project_id: null,
      name: "Claude · 后端",
      kind: "external",
      runtime: "claude",
      host: "yuqi",
      workdir: "/tmp/my-app",
      incoming_call_mode: "dnd",
    });
    const b = insertThread(db, {
      id: "peer-b",
      project_id: null,
      name: "Codex · mac-mini",
      kind: "external",
      runtime: "codex",
      host: "mac-mini",
      workdir: "/Users/yuqi/dev/ios-client",
      incoming_call_mode: "ask",
    });

    // 1. DND refuses INCOMING calls to peer-a...
    await assert.rejects(
      () =>
        askThread(db, {
          from_thread: b.id,
          to_thread: a.id,
          question: "能打扰你吗？",
        }),
      /免打扰/,
    );

    // 2. ...but DND NEVER blocks OUTBOUND calls from peer-a!
    // Target peer-b is in "ask" mode, so call pauses in awaiting_approval with attached context Diff.
    const callRes = await askThread(db, {
      from_thread: a.id,
      to_thread: b.id,
      question: "核对 JWT leeway 兼容",
      context: "+ const leeway = 30;",
    });
    assert.equal(callRes.message.status, "awaiting_approval");
    assert.equal(callRes.message.context, "+ const leeway = 30;");
    assert.ok(callRes.message.trace_id?.startsWith("tr_"));
    assert.equal(callRes.delivery_method, "awaiting-human-approval");

    // 3. Human approves call -> transitions to pending; synchronous waiter wakes on reply!
    const approved = await approvePendingCall(db, callRes.message.id);
    assert.equal(approved.message.status, "pending");

    const waitPromise = waitForMessageOutcome(db, callRes.message.id, 5);
    setTimeout(() => {
      replyMessage(db, callRes.message.id, b.id, "完全兼容");
    }, 30);
    const outcome = await waitPromise;
    assert.equal(outcome.timed_out, false);
    assert.equal(outcome.message.status, "replied");
    assert.equal(outcome.message.reply, "完全兼容");

    // 4. Hangup cancels an active call and wakes waiters immediately.
    saveRuntimeSettings(db, { pair_cooldown_ms: 0 });
    updateThread(db, b.id, { incoming_call_mode: "auto" });
    const call2 = await askThread(db, {
      from_thread: a.id,
      to_thread: b.id,
      question: "再确认一个接口",
    });
    const wait2 = waitForMessageOutcome(db, call2.message.id, 5);
    setTimeout(() => {
      hangupCall(db, call2.message.id, "用户手动挂断");
    }, 30);
    const hungUp = await wait2;
    assert.equal(hungUp.timed_out, false);
    assert.equal(hungUp.message.status, "cancelled");

    // 5. Live graph strictly excludes stopped external peers (zero zombie nodes).
    const g1 = buildGraph(db);
    assert.equal(g1.nodes.length, 2);
    assert.equal(g1.nodes.find((n) => n.id === b.id)?.host, "mac-mini");

    updateThread(db, b.id, { state: "stopped" });
    const g2 = buildGraph(db);
    assert.equal(g2.nodes.length, 1);
    assert.equal(g2.nodes[0]?.id, a.id);
  } finally {
    cleanup();
  }
});

test("original-directory hook install preserves existing settings & wake refuses missing cwd", () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "conflux-hook-home-"));
  const validCwd = mkdtempSync(join(tmpdir(), "conflux-wake-cwd-"));
  try {
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    writeFileSync(
      join(fakeHome, ".claude", "settings.json"),
      JSON.stringify({
        theme: "dark",
        hooks: {
          Stop: [{ matcher: "", hooks: [{ type: "command", command: "echo user-custom-hook" }] }],
        },
      }),
      "utf8",
    );

    const installed = installCliHook("claude", {
      hubUrl: "http://100.111.186.21:9527",
      homeDir: fakeHome,
    });
    assert.ok(existsSync(installed.config_path));
    const parsed = JSON.parse(readFileSync(installed.config_path, "utf8")) as {
      theme: string;
      hooks: Record<string, unknown[]>;
    };
    assert.equal(parsed.theme, "dark");
    assert.equal(parsed.hooks.Stop.length, 2, "must preserve existing user hook alongside Conflux hook");
    assert.ok(JSON.stringify(parsed.hooks.Stop).includes("user-custom-hook"));
    assert.ok(JSON.stringify(parsed.hooks.Stop).includes("conflux hook check"));

    // Idempotent re-install must not duplicate Conflux hook
    installCliHook("claude", { hubUrl: "http://100.111.186.21:9527", homeDir: fakeHome });
    const parsed2 = JSON.parse(readFileSync(installed.config_path, "utf8")) as {
      hooks: Record<string, unknown[]>;
    };
    assert.equal(parsed2.hooks.Stop.length, 2);

    // Tier-2 original-directory wake builds exact cwd + native resume args
    const claudePlan = buildOriginalDirectoryWakePlan({
      runtime: "claude",
      sessionId: "sess_8f3a12",
      cwd: validCwd,
      prompt: "reply to peer",
    });
    assert.equal(claudePlan.cwd, validCwd);
    assert.deepEqual(claudePlan.args, ["--resume", "sess_8f3a12", "-p", "reply to peer"]);

    const codexPlan = buildOriginalDirectoryWakePlan({
      runtime: "codex",
      sessionId: "codex_m7710",
      cwd: validCwd,
      prompt: "check swift auth",
    });
    assert.equal(codexPlan.cwd, validCwd);
    assert.deepEqual(codexPlan.args, ["exec", "resume", "codex_m7710", "check swift auth"]);

    // Strictly refuses missing cwd — never spawns orphan headless thread
    assert.throws(
      () =>
        buildOriginalDirectoryWakePlan({
          runtime: "claude",
          sessionId: "sess_bad",
          cwd: join(fakeHome, "does-not-exist-dir"),
          prompt: "hi",
        }),
      /原工作目录不存在/,
    );

    const net = detectLocalNetworkInfo(9527);
    assert.equal(net.port, 9527);
    assert.ok(net.mcp_http_url.endsWith("/mcp"));
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(validCwd, { recursive: true, force: true });
  }
});

test("Paseo Git stage/commit, gh PR detail with checks/comments, terminal exec & safe file explorer", async () => {
  const { repoDir, cleanup } = makeTempGitRepo();
  const shimDir = mkdtempSync(join(tmpdir(), "conflux-gh-shim-"));
  try {
    writeFileSync(join(repoDir, "src", "auth.ts"), "export const leeway = 30;\n", "utf8");
    writeFileSync(join(repoDir, "src", "extra.ts"), "export const x = 1;\n", "utf8");

    // Stage single file, verify staged flag, commit it
    const st1 = stageGitFiles(repoDir, ["src/auth.ts"], true);
    assert.equal(st1.files.find((f) => f.path === "src/auth.ts")?.staged, true);
    assert.equal(st1.files.find((f) => f.path === "src/extra.ts")?.staged, false);

    const committed = commitGitChanges(repoDir, "feat(auth): add 30s leeway");
    assert.equal(committed.ok, true);
    assert.ok(committed.commit_sha);
    assert.equal(
      getGitStatus(repoDir).files.some((f) => f.path === "src/auth.ts"),
      false,
    );

    // Mock gh CLI returning PR detail + checks + inline review comment
    const ghShim = join(shimDir, "fake-gh.cjs");
    writeFileSync(
      ghShim,
      `const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") {
  console.log(JSON.stringify({
    number: 42,
    title: "feat(auth): add leeway",
    state: "OPEN",
    url: "https://github.com/demo/my-app/pull/42",
    headRefName: "feat/auth",
    baseRefName: "main",
    isDraft: false,
    statusCheckRollup: [
      { name: "typecheck", conclusion: "SUCCESS" },
      { name: "ios auth", conclusion: "FAILURE", description: "missing openapi doc" }
    ],
    comments: [],
    reviews: []
  }));
} else if (args[0] === "api") {
  console.log(JSON.stringify([
    { id: 9, user: { login: "reviewer" }, path: "src/auth.ts", line: 1, body: "Cap leeway at 120s" }
  ]));
}
`,
      "utf8",
    );

    const prRes = getPrDetail(repoDir, "feat/auth", ghShim);
    assert.equal(prRes.gh_available, true);
    assert.equal(prRes.pr?.number, 42);
    assert.equal(prRes.pr?.checks.length, 2);
    assert.equal(prRes.pr?.checks[0]?.status, "pass");
    assert.equal(prRes.pr?.checks[1]?.status, "fail");
    assert.equal(prRes.pr?.comments[0]?.author, "@reviewer");
    assert.equal(prRes.pr?.comments[0]?.path, "src/auth.ts");

    // Embedded terminal exec
    const termRes = await execWorkspaceCommand(repoDir, "echo paseo-shell-ok");
    assert.equal(termRes.ok, true);
    assert.match(termRes.stdout, /paseo-shell-ok/);

    // File explorer & path traversal guard
    const entries = listWorkspaceDirectory(repoDir);
    assert.ok(entries.some((e) => e.name === "src" && e.kind === "dir"));
    const content = readWorkspaceFile(repoDir, "src/auth.ts");
    assert.match(content.content, /leeway = 30/);
    assert.throws(() => readWorkspaceFile(repoDir, "../escape.txt"), /escapes workspace/);
  } finally {
    cleanup();
    rmSync(shimDir, { recursive: true, force: true });
  }
});

test("Streamable HTTP /mcp exposes 4 golden tools and mesh HTTP routes manage peer lifecycle", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "conflux-mcp-http-data-"));
  const repoDir = mkdtempSync(join(tmpdir(), "conflux-mcp-http-repo-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const app = await startHttpServer({
    host: "127.0.0.1",
    port,
    overrideDataDir: dataDir,
    threadManagerOptions: {
      resolveLaunch: (runtime, spec) => ({
        executable: runtime === "claude" ? CLAUDE_SHIM : ACP_SHIM,
        args: [],
        cwd: spec.workdir,
        env: { ...process.env },
      }),
    },
  });

  try {
    // 1. Network info endpoint
    const net = (await fetch(`${baseUrl}/system/network`).then((r) => r.json())) as {
      port: number;
      mcp_http_url: string;
    };
    assert.equal(net.port, port);
    assert.ok(net.mcp_http_url.endsWith("/mcp"));

    // 2. External CLI Hook heartbeat registers 1:1 peer
    const hb = (await fetch(`${baseUrl}/mesh/peers/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "codex_m7710",
        cwd: "/Users/yuqi/dev/ios-client",
        host: "mac-mini",
        runtime: "codex",
        name: "Codex · mac-mini",
      }),
    }).then((r) => r.json())) as { peer: { id: string; host: string }; inbox: unknown[] };
    assert.equal(hb.peer.id, "codex_m7710");
    assert.equal(hb.peer.host, "mac-mini");

    // 3. Streamable HTTP MCP initialize -> tools/list (zero token!)
    const initRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "X-Conflux-Session-Id": "claude_remote_1",
        "X-Conflux-Host": "yuqi",
        "X-Conflux-Cwd": repoDir,
        "X-Conflux-Name": encodeURIComponent("Claude · 后端"),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      }),
    });
    assert.equal(initRes.status, 200);
    const mcpSessionId = initRes.headers.get("mcp-session-id");
    assert.ok(mcpSessionId, "Streamable HTTP MCP must return mcp-session-id");

    const listRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": mcpSessionId!,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    assert.equal(listRes.status, 200);
    const listText = await listRes.text();
    for (const toolName of ["list_peers", "ask_peer", "check_inbox", "reply_peer"]) {
      assert.ok(listText.includes(toolName), `missing golden MCP tool ${toolName}`);
    }

    // 4. Call mode route + mesh call creation + hangup
    const modeRes = await fetch(`${baseUrl}/threads/codex_m7710/call-mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Session-Id": WEB_CONSOLE_ID },
      body: JSON.stringify({ incoming_call_mode: "ask" }),
    });
    assert.equal(modeRes.status, 200);

    const callCreate = (await fetch(`${baseUrl}/mesh/calls`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Session-Id": "claude_remote_1" },
      body: JSON.stringify({
        from_thread: "claude_remote_1",
        to_thread: "codex_m7710",
        question: "请核对 iOS 客户端",
      }),
    }).then((r) => r.json())) as { message: { id: number; status: string } };
    assert.equal(callCreate.message.status, "awaiting_approval");

    const hangRes = (await fetch(`${baseUrl}/mesh/calls/${callCreate.message.id}/hangup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Session-Id": WEB_CONSOLE_ID },
      body: JSON.stringify({}),
    }).then((r) => r.json())) as { message: { status: string } };
    assert.equal(hangRes.message.status, "cancelled");

    // 5. DELETE /mcp marks remote peer offline immediately
    const delRes = await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: { "mcp-session-id": mcpSessionId! },
    });
    assert.ok(delRes.status === 200 || delRes.status === 204);
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 });
    rmSync(repoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 });
  }
});
