import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers.js";
import {
  parseProcessLines,
  isRuntimeCommand,
  runtimePidsFrom,
  probeRuntimePids,
  reconcileRuntimeLiveness,
  isClaudeCommand,
  claudePidsFrom,
  probeClaudePids,
  reconcileLiveness,
} from "../core/liveness.js";
import { registerSession, endSession } from "../core/sessions.js";

const { db, cleanup } = makeDb();
after(cleanup);

test("parseProcessLines reads both Get-CimInstance and ps formats", () => {
  const win = parseProcessLines(
    '123 "C:\\Program Files\\nodejs\\node.exe" C:\\x\\claude-code\\cli.js\n' +
      "456 cmd /c claude\n" +
      "\n" +
      "not-a-pid line\n"
  );
  assert.deepEqual(
    win.map((e) => e.pid),
    [123, 456]
  );
  assert.equal(win[0].command.includes("claude-code"), true);

  const posix = parseProcessLines(" 789 /usr/local/bin/claude --resume abc\n");
  assert.equal(posix[0].pid, 789);
});

test("isClaudeCommand matches claude invocation shapes, rejects lookalikes", () => {
  assert.ok(isClaudeCommand("cmd /c claude"));
  assert.ok(isClaudeCommand('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\x\\node_modules\\@anthropic-ai\\claude-code\\cli.js"'));
  assert.ok(isClaudeCommand("C:\\tools\\claude.exe --resume 123"));
  assert.ok(isClaudeCommand("/usr/local/bin/claude"));
  assert.ok(!isClaudeCommand("node server.js"));
  assert.ok(!isClaudeCommand("vim my-claude-notes.md"), "similar filename ≠ claude process");
  assert.ok(!isClaudeCommand("powershell -Command Get-CimInstance"));
});

test("isRuntimeCommand matches Codex invocation shapes, rejects lookalikes", () => {
  assert.ok(isRuntimeCommand("codex", "codex"));
  assert.ok(isRuntimeCommand("codex.exe exec --full-auto", "codex"));
  assert.ok(
    isRuntimeCommand(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\x\\node_modules\\@openai\\codex\\bin\\codex.js"',
      "codex"
    )
  );
  assert.ok(isRuntimeCommand("node /tools/codex-cli/bin/run.js", "codex"));
  assert.ok(!isRuntimeCommand("vim my-codex-notes.md", "codex"), "similar filename != Codex process");
  assert.ok(!isRuntimeCommand("node /notes/my-codex-cli-notes.js", "codex"), "similar package name != Codex process");
  assert.ok(!isRuntimeCommand("node server.js", "codex"));
  assert.ok(!isRuntimeCommand("claude --resume 123", "codex"));
});

test("runtimePidsFrom separates Claude and Codex processes", () => {
  const entries = [
    { pid: 11, command: "cmd /c claude" },
    { pid: 22, command: "codex exec" },
    { pid: 22, command: "codex exec --full-auto" },
    { pid: 33, command: "node /app/@openai/codex/bin/codex.js" },
    { pid: 44, command: "node app.js" },
  ];
  assert.deepEqual([...runtimePidsFrom(entries, "claude")], [11]);
  assert.deepEqual([...runtimePidsFrom(entries, "codex")].sort(), [22, 33]);
});

test("probeRuntimePids returns both runtime PID sets", async () => {
  const fake = async () =>
    "10 cmd /c claude\n20 codex exec\n30 node x @openai/codex\n40 node x.js";
  const pids = await probeRuntimePids(fake as never, "win32");
  assert.deepEqual([...pids!.claude], [10]);
  assert.deepEqual([...pids!.codex].sort(), [20, 30]);
});

test("claudePidsFrom dedups pids across entries", () => {
  const pids = claudePidsFrom([
    { pid: 1, command: "cmd /c claude" },
    { pid: 1, command: "cmd /c claude --resume x" },
    { pid: 2, command: "node app.js" },
    { pid: 3, command: "/usr/bin/claude" },
  ]);
  assert.deepEqual([...pids].sort(), [1, 3]);
});

test("probeClaudePids returns null on runner failure (TTL fallback stays in charge)", async () => {
  const failing = async () => {
    throw new Error("powershell unavailable");
  };
  assert.equal(await probeClaudePids(failing, "win32"), null);

  const fake = async () => "10 cmd /c claude\n20 node x.js";
  const pids = await probeClaudePids(fake as never, "win32");
  assert.deepEqual([...pids!], [10]);
});

test("reconcileLiveness: live pid stays active + refreshed; dead pid reaped immediately; pidless rows untouched", () => {
  const mk = (id: string, pid: number | null) =>
    registerSession(db, {
      id,
      name: id,
      description: "named",
      metadata:
        pid === null
          ? { source: "claude-hook", named: true }
          : { source: "claude-hook", named: true, claude_pid: pid },
    });
  mk("idle-open", 100); // process alive → must refresh even if heartbeat is old
  mk("dead-proc", 200); // process gone → stale NOW, no TTL wait
  mk("already-stale", 300); // gone, will be pre-marked stale below
  mk("no-pid", null); // no pid → not probe-managed
  // age every heartbeat far past the TTL so refreshing proves probe authority
  db.prepare(
    `UPDATE sessions SET last_heartbeat_at = ?, status = 'active' WHERE id != 'already-stale'`
  ).run(new Date(Date.now() - 3600_000).toISOString());

  const { refreshed, reaped } = reconcileLiveness(db, new Set([100]));
  assert.ok(refreshed >= 1);
  assert.ok(reaped >= 1);

  const row = (id: string) =>
    (db.prepare(`SELECT status, last_heartbeat_at FROM sessions WHERE id = ?`).get(id) as {
      status: string;
      last_heartbeat_at: string;
    });
  assert.equal(row("idle-open").status, "active");
  assert.ok(Date.now() - Date.parse(row("idle-open").last_heartbeat_at) < 5000, "heartbeat refreshed by probe");
  assert.equal(row("dead-proc").status, "stale", "dead process reaped without TTL wait");
  assert.equal(row("already-stale").status, "stale");
  assert.equal(row("no-pid").status, "active", "pidless row keeps the heartbeat model");
});

test("reconcileRuntimeLiveness refreshes live Codex and reaps dead Codex immediately", () => {
  const mk = (id: string, runtime: "claude" | "codex", pid: number) =>
    registerSession(db, {
      id,
      name: id,
      description: "named",
      metadata: { source: `${runtime}-hook`, named: true, runtime, runtime_pid: pid },
    });
  mk("codex-idle-open", "codex", 710);
  mk("codex-dead-proc", "codex", 720);
  mk("claude-idle-open", "claude", 730);
  db.prepare(
    `UPDATE sessions SET last_heartbeat_at = ?, status = 'active'
     WHERE id IN ('codex-idle-open', 'codex-dead-proc', 'claude-idle-open')`
  ).run(new Date(Date.now() - 3600_000).toISOString());

  const now = new Date("2030-01-02T03:04:05.000Z");
  const result = reconcileRuntimeLiveness(
    db,
    { claude: new Set([730]), codex: new Set([710]) },
    now
  );
  assert.ok(result.refreshed >= 2);
  assert.ok(result.reaped >= 1);

  const row = (id: string) =>
    db.prepare(`SELECT status, last_heartbeat_at FROM sessions WHERE id = ?`).get(id) as {
      status: string;
      last_heartbeat_at: string;
    };
  assert.equal(row("codex-idle-open").status, "active");
  assert.equal(row("codex-idle-open").last_heartbeat_at, now.toISOString());
  assert.equal(row("codex-dead-proc").status, "stale");
  assert.equal(row("claude-idle-open").status, "active");
  assert.equal(row("claude-idle-open").last_heartbeat_at, now.toISOString());
});

test("reconcileLiveness never touches the web console", () => {
  registerSession(db, { id: "web-console", name: "Web 控制台", description: "x", metadata: null });
  endSession(db, "web-console");
  reconcileLiveness(db, new Set()); // would reap everything pid-tagged & active
  assert.equal(
    (db.prepare(`SELECT status FROM sessions WHERE id = 'web-console'`).get() as { status: string }).status,
    "ended"
  );
});
