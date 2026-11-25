import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WEB_CONSOLE_ID } from "@conflux/shared";
import { startHttpServer } from "../http/server.js";
import { resolveGitBinary } from "../core/git-worktree.js";

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

test("v2 HTTP + SSE live server handles workspace tree, threads, approvals, git diff, settings, and immediate SSE flush", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "conflux-v2-http-data-"));
  const repoDir = mkdtempSync(join(tmpdir(), "conflux-v2-http-repo-"));
  const gitBin = resolveGitBinary();
  const git = (args: string[]) =>
    execFileSync(gitBin, args, { cwd: repoDir, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@local"]);
  writeFileSync(join(repoDir, "hello.ts"), "export const greeting = 'hi';\n", "utf8");
  git(["add", "-A"]);
  git(["commit", "-m", "init"]);

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

  const sseAbort = new AbortController();
  const sseChunks: string[] = [];

  try {
    // 1. SSE connects immediately with flushed headers even when ring buffer is empty.
    const sseRes = await fetch(`${baseUrl}/live/events`, { signal: sseAbort.signal });
    assert.equal(sseRes.status, 200);
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    const firstChunk = await reader.read();
    const initial = decoder.decode(firstChunk.value ?? new Uint8Array());
    assert.ok(initial.includes(": connected"), "SSE must flush immediately on connect");
    const sseDrain = (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          sseChunks.push(decoder.decode(value, { stream: true }));
        }
      } catch {
        // aborted on teardown
      }
    })();

    // 2. Health, Settings, Project creation, @ file search.
    const health = await fetch(`${baseUrl}/healthz`).then((r) => r.json());
    assert.equal(health.ok, true);
    assert.equal(health.schema, "v2");

    const projRes = await fetch(`${baseUrl}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Session-Id": WEB_CONSOLE_ID },
      body: JSON.stringify({ root_path: repoDir, name: "HttpRepo" }),
    });
    assert.equal(projRes.status, 201);
    const { project } = (await projRes.json()) as { project: { id: number } };

    const files = (await fetch(`${baseUrl}/projects/${project.id}/files?q=hel`).then((r) =>
      r.json(),
    )) as { files: Array<{ path: string }> };
    assert.equal(files.files[0]?.path, "hello.ts");

    // 3. One-step thread creation + worktree + git status/diff + workspace tree + graph.
    const thRes = await fetch(`${baseUrl}/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Session-Id": WEB_CONSOLE_ID },
      body: JSON.stringify({
        project_id: project.id,
        name: "http-agy",
        runtime: "antigravity",
        use_worktree: true,
      }),
    });
    assert.equal(thRes.status, 201);
    const { thread } = (await thRes.json()) as {
      thread: { id: string; worktree_path: string | null };
    };
    assert.ok(thread.worktree_path);

    writeFileSync(join(thread.worktree_path!, "hello.ts"), "export const greeting = 'v2';\n", "utf8");
    const gitStatus = (await fetch(`${baseUrl}/threads/${thread.id}/git/status`).then((r) =>
      r.json(),
    )) as { dirty: boolean; files: Array<{ path: string }> };
    assert.equal(gitStatus.dirty, true);
    assert.equal(gitStatus.files[0]?.path, "hello.ts");

    const gitDiff = (await fetch(`${baseUrl}/threads/${thread.id}/git/diff?path=hello.ts`).then((r) =>
      r.json(),
    )) as { diff: string };
    assert.ok(gitDiff.diff.includes("+export const greeting = 'v2';"));

    const tree = (await fetch(`${baseUrl}/workspace/tree`).then((r) => r.json())) as {
      projects: unknown[];
      threads: unknown[];
      cli_probes: unknown[];
    };
    assert.equal(tree.projects.length, 1);
    assert.equal(tree.threads.length, 1);
    assert.equal(tree.cli_probes.length, 4);

    // 4. Stop & cleanup worktree cleanly via HTTP.
    const stopRes = await fetch(`${baseUrl}/threads/${thread.id}/stop`, { method: "POST" });
    assert.equal(stopRes.status, 200);
    const cleanRes = await fetch(`${baseUrl}/threads/${thread.id}/worktree/cleanup`, {
      method: "POST",
    });
    assert.equal(cleanRes.status, 200);

    // 5. SSE received real-time events.
    await new Promise((r) => setTimeout(r, 80));
    const combinedSse = sseChunks.join("");
    assert.ok(combinedSse.includes("project.updated"));
    assert.ok(combinedSse.includes("thread.updated"));

    sseAbort.abort();
    await sseDrain;
  } finally {
    sseAbort.abort();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 });
    rmSync(repoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 });
  }
});
