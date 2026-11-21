// Browser acceptance for the home sidebar's recency window: seeds
// one isolated server with sessions across age buckets (via API) and
// backdates their heartbeats directly in SQLite, then screenshots the home
// sidebar on desktop + narrow viewports. Expected: 今天/昨天/最近 7 天/10 天内
// groups render, the 20-day-old session stays out, and the hint names it.
//
// Usage: node scripts/acceptance/sidebar-recent-screenshots.mjs [outDir]
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright";

const require2 = createRequire(join(fileURLToPath(new URL(".", import.meta.url)), "package.json"));
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PORT = 9534;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = resolve(process.cwd(), process.argv[2] ?? "sidebar-shots");
const DAY = 86_400_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// name -> days since last heartbeat (null = register only, stamps now)
const SEED = [
  ["今日会话A", 0],
  ["今日会话B", 0],
  ["昨日会话", 1],
  ["三天前会话", 3],
  ["八天前会话", 8],
  ["二十天前会话", 20],
];

async function waitFor(fn, what, ms = 30000) {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(300);
  }
}

const home = mkdtempSync(join(tmpdir(), "conflux-sidebar-home-"));
mkdirSync(OUT, { recursive: true });
const serverLog = createWriteStream(join(OUT, "server.log"));
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

let browser;
try {
  await waitFor(
    async () => (await fetch(`${BASE}/healthz`).catch(() => null))?.ok,
    "server healthz",
  );

  const withIds = SEED.map(([name, days], i) => [name, days, `shot-${i}`]);
  for (const [name, , id] of withIds) {
    await fetch(`${BASE}/sessions/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, session_id: id }),
    });
  }
  // Backdate heartbeats straight in SQLite (WAL: concurrent with the server).
  const Database = require2("better-sqlite3");
  const db = new Database(join(home, "data.db"));
  const upd = db.prepare(`UPDATE sessions SET last_heartbeat_at = ? WHERE id = ?`);
  for (const [, days, id] of withIds) {
    upd.run(new Date(Date.now() - days * DAY).toISOString(), id);
  }
  db.close();

  browser = await chromium.launch();
  for (const [label, viewport] of [
    ["desktop", { width: 1280, height: 800 }],
    ["narrow", { width: 390, height: 844 }],
  ]) {
    const page = await (await browser.newContext({ viewport })).newPage();
    await page.goto(BASE);
    if (label === "narrow") await page.getByLabel("打开导航").click();
    await waitFor(
      async () => (await page.getByText(/最近会话 · 5/).count()) > 0,
      "recent count (5 in-window)",
    );
    await sleep(400);
    const file = join(OUT, `sidebar-${label}.png`);
    await page.screenshot({ path: file });
    console.log("shot", file);

    // collapse acceptance: the group header must fold its sessions away
    if (label === "desktop") {
      await page.locator("aside").getByRole("button", { name: /今天/ }).first().click();
      await page.getByText("今日会话A").waitFor({ state: "detached" });
      await sleep(300);
      const collapsed = join(OUT, "sidebar-desktop-collapsed.png");
      await page.screenshot({ path: collapsed });
      console.log("shot", collapsed);
    }
  }
  await browser.close();
  browser = undefined;
  writeFileSync(
    join(OUT, "README.txt"),
    [
      "home sidebar recency-window acceptance (isolated CONFLUX_HOME)",
      "expect groups 今天/昨天/最近 7 天/10 天内; 二十天前会话 hidden; hint 更早的 1 个会话",
    ].join("\n"),
  );
  console.log("DONE ->", OUT);
} finally {
  await browser?.close().catch(() => {});
  server.kill();
  await sleep(800);
  if (server.exitCode === null) server.kill("SIGKILL");
  serverLog.close();
  let browser;
try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // Windows handle lag; leftovers stay in %TEMP%
  }
}
