// Browser acceptance harness for the managed Codex panel — REAL layout in
// chromium (jsdom cannot validate it), shim-backed app-server (no real
// model). Boots an isolated server (own CONFLUX_HOME, CODEX_PATH pointed at
// the test shim), drives one managed instance through three states via the
// HTTP API, and screenshots the panel on desktop + narrow viewports:
//
//   waiting-approval  (task text carries @approval)
//   running           (@hold keeps the turn in flight)
//   stopped           (official stop while the panel stays open — the
//                      persisted-view path: badge 已停止, history readable)
//
// Usage: node scripts/acceptance/managed-codex-screenshots.mjs [outDir]
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PORT = 9531;
const BASE = `http://127.0.0.1:${PORT}`;
const SHIM = join(ROOT, "apps", "server", "src", "test", "managed-codex-shim.cjs");
const OUT = resolve(process.cwd(), process.argv[2] ?? "managed-panel-shots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, what, ms = 20000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(250);
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

const home = mkdtempSync(join(tmpdir(), "conflux-shots-home-"));
const project = mkdtempSync(join(tmpdir(), "conflux-shots-proj-"));
mkdirSync(OUT, { recursive: true });
const serverLog = createWriteStream(join(OUT, "server.log"));

const server = spawn(process.execPath, ["--import", "tsx", "src/index.ts", "serve", "--port", String(PORT)], {
  cwd: join(ROOT, "apps", "server"),
  env: {
    ...process.env,
    CONFLUX_HOME: home,
    CODEX_PATH: SHIM,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.pipe(serverLog);
server.stderr.pipe(serverLog);

try {
  await waitFor(
    async () => (await fetch(`${BASE}/healthz`).catch(() => null))?.ok,
    "server healthz",
  );
  console.log("server up on", BASE);

  // ---- one managed preset + instance ----
  const preset = await api("POST", "/runtimes", {
    name: "截图验收助手",
    runtime: "codex",
    workdir: project,
    execution_mode: "managed",
    instructions: "截图验收：简短作答。",
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
  console.log("managed instance", instanceId, "session", session);

  // ---- browser ----
  const browser = await chromium.launch();
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const narrow = await browser.newContext({ viewport: { width: 390, height: 844 } });

  // Sidebar on wide screens; drawer behind the menu button on narrow ones.
  // Tab views never unmount, so every assistants-page query is scoped to the
  // ACTIVE surface — the chat tab also shows the managed session by name.
  async function openPanel(p) {
    await p.goto(BASE);
    if (p.viewportSize()?.width < 700) await p.getByLabel("打开导航").click();
    await p.getByRole("button", { name: "助手", exact: true }).click();
    const surf = p.locator('.tab-surface[data-active="true"]');
    await surf.getByText("截图验收助手", { exact: true }).first().click(); // expand the card
    await surf.getByText("打开受管执行面板").click();
    await waitFor(
      async () => (await p.getByText(/空闲|执行中|等待审批|已停止/).count()) > 0,
      "panel state badge",
    );
  }

  const page = await desktop.newPage();
  await openPanel(page);
  console.log("panel open");

  const shoot = async (state, p) => {
    const file = join(OUT, `${state}.png`);
    await p.screenshot({ path: file });
    console.log("shot", file);
  };

  // ---- state 1: waiting-approval ----
  await api("POST", "/web/ask", {
    to_session: session,
    question: "@approval 运行示例命令 node shim-tool.cjs run",
  });
  await waitFor(
    async () =>
      (await api("GET", `/runtime-instances/${instanceId}/managed`)).current.pendingApprovals.length >
      0,
    "pending approval",
  );
  await waitFor(async () => (await page.getByText("等待审批").count()) > 0, "approval badge");
  await sleep(500);
  await shoot("waiting-approval-desktop", page);
  const phone = await narrow.newPage();
  await openPanel(phone);
  await shoot("waiting-approval-narrow", phone);

  const approval = (
    await api("GET", `/runtime-instances/${instanceId}/managed`)
  ).current.pendingApprovals[0];
  await api(
    "POST",
    `/runtime-instances/${instanceId}/managed/approvals/${approval.id}`,
    { decision: "accept" },
    { "X-Session-Id": "web-console" },
  );
  await waitFor(
    async () =>
      (await api("GET", `/runtime-instances/${instanceId}/managed`)).runs.some(
        (r) => r.state === "completed",
      ),
    "approved turn completed",
  );

  // ---- state 2: running (held turn) ----
  // The waiting-approval state ALSO badges 执行中 (activeRun is held across
  // approvals), so "badge says 执行中" alone is ambiguous — wait until the
  // approval card is gone AND the API reports a fresh active turn.
  await api("POST", "/web/ask", { to_session: session, question: "@hold 长任务进行中" });
  await waitFor(
    async () =>
      (await api("GET", `/runtime-instances/${instanceId}/managed`)).current.activeRun !== null &&
      (await page.getByText("本次允许").count()) === 0,
    "approval card gone + active turn",
  );
  await waitFor(async () => (await page.getByText("执行中").count()) > 0, "running badge");
  await sleep(500);
  await shoot("running-desktop", page);
  // narrow page keeps polling the same instance — its badge flips too (same
  // disambiguation: the approval card must be gone there as well)
  await waitFor(
    async () =>
      (await phone.getByText("本次允许").count()) === 0 && (await phone.getByText("执行中").count()) > 0,
    "running badge (narrow)",
  );
  await shoot("running-narrow", phone);

  // ---- state 3: stopped while the panel stays open ----
  await api("POST", `/runtime-instances/${instanceId}/stop`, {});
  await waitFor(async () => (await page.getByText("已停止").count()) > 0, "stopped badge");
  await waitFor(async () => (await phone.getByText("已停止").count()) > 0, "stopped badge (narrow)");
  await sleep(500);
  await shoot("stopped-desktop", page);
  await shoot("stopped-narrow", phone);

  await browser.close();
  writeFileSync(
    join(OUT, "README.txt"),
    [
      "managed Codex panel acceptance shots (shim-backed, isolated CONFLUX_HOME)",
      `instance ${instanceId} / session ${session}`,
      "states: waiting-approval / running (@hold) / stopped (panel left open)",
      "viewports: desktop 1280x800, narrow 390x844",
    ].join("\n"),
  );
  console.log("DONE ->", OUT);
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 800));
  if (server.exitCode === null) server.kill("SIGKILL");
  serverLog.close();
  try {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  } catch {
    // Windows may hold handles briefly; leftovers stay in %TEMP%
  }
}
