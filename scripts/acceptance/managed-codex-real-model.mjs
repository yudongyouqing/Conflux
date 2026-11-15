// Real-model acceptance for the managed Codex executor — the milestone gate
// before wiring a Claude managed endpoint. Runs the REAL codex app-server
// (whatever `codex` resolves to on PATH; the version gate must accept it),
// an isolated CONFLUX_HOME for Conflux data (codex keeps its own ~/.codex
// auth), and one managed preset whose instructions require a distinctive
// reply prefix — which also proves developerInstructions passthrough
// against the real protocol.
//
// Scenarios (each asserts on server state, filesystem effects and replies):
//   A. external session asks -> approval (ACCEPT) -> task executes, file
//      written, reply carries the instructions prefix, asker's inbox sees it
//   B. approval DECLINE -> task completes without the forbidden side effect
//   C. interrupt a long turn -> interrupted terminal state, then a follow-up
//      task completes on the same instance (executor survives interrupts)
//
// Usage: node scripts/acceptance/managed-codex-real-model.mjs
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PORT = 9533;
const BASE = `http://127.0.0.1:${PORT}`;
const PREFIX = "【受管验收】"; // preset instructions demand this reply prefix
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const runDir = join(tmpdir(), `conflux-real-model-${Date.now()}`);
const home = join(runDir, "home");
const project = join(runDir, "project");
mkdirSync(home, { recursive: true });
mkdirSync(project, { recursive: true });
const report = { startedAt: new Date().toISOString(), scenarios: {}, userAgent: null };
const summary = (name, pass, details) => {
  report.scenarios[name] = { pass, ...details };
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`, details ?? "");
};

async function waitFor(fn, what, ms = 300000, every = 1000) {
  const start = Date.now();
  for (;;) {
    const v = await fn().catch((e) => {
      throw e;
    });
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(every);
  }
}

async function api(method, path, body, headers) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : undefined;
}

const serverLog = createWriteStream(join(runDir, "server.log"));
const server = spawn(
  process.execPath,
  ["--import", "tsx", "src/index.ts", "serve", "--port", String(PORT)],
  {
    cwd: join(ROOT, "apps", "server"),
    env: { ...process.env, CONFLUX_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
server.stdout.pipe(serverLog);
server.stderr.pipe(serverLog);

const stop = async () => {
  server.kill();
  await sleep(800);
  if (server.exitCode === null) server.kill("SIGKILL");
  writeFileSync(join(runDir, "report.json"), JSON.stringify(report, null, 2));
  console.log("report + logs ->", runDir);
};

try {
  await waitFor(
    async () => (await fetch(`${BASE}/healthz`).catch(() => null))?.ok,
    "server healthz",
    30000,
  );

  const preset = await api("POST", "/runtimes", {
    name: "真实模型验收",
    runtime: "codex",
    workdir: project,
    execution_mode: "managed",
    instructions: `回答必须以${PREFIX}开头，除此之外保持一句话简短作答。`,
  });
  const started = await api("POST", `/runtimes/${preset.agent.id}/start`, {});
  const instanceId = started.instance.id;
  await waitFor(
    async () =>
      (await api("GET", "/runtime-instances")).instances.find((i) => i.id === instanceId)?.state ===
      "running",
    "instance running",
  );
  const session = (await api("GET", `/runtime-instances/${instanceId}/managed`)).binding.session_id;
  const userAgent = (readFileSync(join(runDir, "server.log"), "utf8").match(/"userAgent":"([^"]+)"/) ?? [])[1];
  report.userAgent = userAgent ?? null;
  console.log("instance", instanceId, "session", session, "userAgent", userAgent);

  const runOf = async (messageId) =>
    (await api("GET", `/runtime-instances/${instanceId}/managed`)).runs.find(
      (r) => r.message_id === messageId,
    );
  const ask = (from, question) =>
    api("POST", "/web/ask", { from_session: from, to_session: session, question }).then(
      (r) => r.message.id,
    );
  // Drive one run to a terminal state, answering every approval the model
  // requests along the way with the SAME decision (a real turn may ask more
  // than once: write a file, then run a command, ...).
  const driveToTerminal = async (messageId, decision, what) => {
    const deadline = Date.now() + 300000;
    let firstKind = null;
    let answered = 0;
    for (;;) {
      const s = await api("GET", `/runtime-instances/${instanceId}/managed`);
      const run = s.runs.find((r) => r.message_id === messageId);
      if (run && ["completed", "failed", "interrupted", "unknown"].includes(run.state)) {
        return { run, firstKind, answered };
      }
      const pending = s.current.pendingApprovals;
      if (pending.length > 0) {
        firstKind ??= pending[0].kind;
        answered += 1;
        await api(
          "POST",
          `/runtime-instances/${instanceId}/managed/approvals/${pending[0].id}`,
          { decision },
          { "X-Session-Id": "web-console" },
        );
        continue;
      }
      if (Date.now() > deadline) throw new Error(`timeout driving ${what} to terminal`);
      await sleep(1500);
    }
  };

  // ---- A: external ask -> allow approval -> executed + prefixed reply ----
  await api("POST", "/sessions/register", { name: "外部验收会话", session_id: "external-asker" });
  const msgA = await ask("external-asker", "请在当前工作目录创建文件 verdict.txt，内容为 ACCEPTED（一行），然后告诉我完成了。");
  const driveA = await driveToTerminal(msgA, "accept", "A");
  // The external session receives the answer through its NATIVE reply
  // channel (checkReplies) — not via any console-only surface.
  const replyA = (
    await api("GET", "/messages/replies", undefined, { "X-Session-Id": "external-asker" })
  ).replies.find((m) => m.id === msgA)?.reply;
  const verdict = existsSync(join(project, "verdict.txt"))
    ? readFileSync(join(project, "verdict.txt"), "utf8").trim()
    : null;
  summary("A external ask + accept + instructions passthrough",
    driveA.run.state === "completed" && verdict === "ACCEPTED" && typeof replyA === "string" && replyA.includes(PREFIX), {
    approvalKind: driveA.firstKind ?? "none",
    approvalsAnswered: driveA.answered,
    verdictFile: verdict,
    reply: replyA?.slice(0, 160) ?? null,
  });

  // ---- B: declined approval -> no forbidden side effect ----
  const msgB = await ask(
    "web-console",
    "请创建文件 forbidden.txt，内容为 NOPE，然后告诉我结果。",
  );
  const driveB = await driveToTerminal(msgB, "decline", "B");
  const replyB = (await api("GET", `/runtime-instances/${instanceId}/managed`)).runs.find(
    (r) => r.message_id === msgB,
  )?.final_text;
  summary("B declined approval blocks side effect", driveB.run.state === "completed" && !existsSync(join(project, "forbidden.txt")), {
    approvalKind: driveB.firstKind ?? "none",
    approvalsDeclined: driveB.answered,
    forbiddenFileExists: existsSync(join(project, "forbidden.txt")),
    reply: replyB?.slice(0, 160) ?? null,
  });

  // ---- C: interrupt, then the executor keeps serving ----
  // The task must outlive the interrupt latency — counting to 2000 does.
  const msgC = await ask(
    "web-console",
    "请从 1 数到 2000，每行一个数字，全部列出，绝对不要省略任何数字，也不要提前停下。",
  );
  await waitFor(
    async () => (await runOf(msgC))?.state === "running" ? true : false,
    "C running",
    180000,
  );
  await sleep(4000); // let the turn get properly underway
  const interrupt = await api("POST", `/runtime-instances/${instanceId}/managed/interrupt`, {});
  await waitFor(
    async () => ((await runOf(msgC))?.state === "interrupted" ? true : false),
    "C interrupted",
  );
  const msgC2 = await ask("web-console", "1+1 等于几？只回答一个数字。");
  await waitFor(
    async () => ((await runOf(msgC2))?.state === "completed" ? true : false),
    "C follow-up completion",
  );
  const replyC2 = (await api("GET", `/runtime-instances/${instanceId}/managed`)).runs.find(
    (r) => r.message_id === msgC2,
  )?.final_text;
  summary("C interrupt then follow-up on same instance", !!replyC2 && /2/.test(replyC2), {
    interruptAccepted: interrupt.accepted,
    followUpReply: replyC2?.slice(0, 160) ?? null,
  });

  report.finishedAt = new Date().toISOString();
  await stop();
  const failed = Object.values(report.scenarios).filter((s) => !s.pass);
  console.log(failed.length === 0 ? "ALL SCENARIOS PASS" : `${failed.length} SCENARIO(S) FAILED`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (err) {
  console.error("ABORTED:", err);
  report.error = String(err);
  await stop();
  process.exitCode = 1;
}
