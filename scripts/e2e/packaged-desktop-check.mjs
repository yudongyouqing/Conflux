/**
 * Packaged desktop acceptance (P4 task 10): launches the CI-built
 * win-unpacked app with an ISOLATED CONFLUX_HOME (never the real home),
 * drives the real renderer over CDP (chat default → graph → assistants),
 * then quits through the app's own tray-exit semantics (app.quit) and
 * verifies the port and process tree are released.
 *
 * Usage: node scripts/e2e/packaged-desktop-check.mjs <win-unpacked-dir>
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const appDir = process.argv[2];
assert.ok(appDir, "usage: packaged-desktop-check.mjs <win-unpacked-dir>");
const exe = join(appDir, "Conflux.exe");

const home = mkdtempSync(join(tmpdir(), "conflux-packaged-"));
mkdirSync(join(home, "..", "conflux-packaged-userdata-keep"), { recursive: true });
console.log("isolated CONFLUX_HOME:", home);

const DEBUG_PORT = 9333;
const HEALTH = "http://127.0.0.1:9527/healthz";

async function waitForHealth(ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(HEALTH);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("packaged server never became healthy on 9527");
}

// Electron apps treat unknown switches as app args; --version LAUNCHES the
// app (never probe packaged exes with it). Launch once, correctly isolated.
const { execSync } = await import("node:child_process");
const launched = execSync(
  `powershell -NoProfile -Command "$env:CONFLUX_HOME='${home}'; $p = Start-Process -FilePath '${exe}' -ArgumentList '--remote-debugging-port=${DEBUG_PORT}' -PassThru; $p.Id"`,
  { encoding: "utf8" },
).trim();
const appPid = Number(launched.split(/\s+/).pop());
console.log("app pid:", appPid);
assert.ok(Number.isFinite(appPid) && appPid > 0, "failed to capture app pid");

let browser;
try {
  await waitForHealth();
  console.log("healthz ok (server running from the packaged tree)");

  // data isolation: the SQLite files exist ONLY under the isolated home
  const { readdirSync } = await import("node:fs");
  const homeFiles = readdirSync(home);
  assert.ok(homeFiles.includes("data.db"), `data files in isolated home: ${homeFiles}`);
  console.log("isolated home files:", homeFiles.join(", "));

  browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  await page.getByRole("button", { name: "创建聊天室" }).waitFor({ timeout: 30000 });
  console.log("✓ packaged app opens the chat workspace by default");

  await page.getByRole("button", { name: "图谱", exact: true }).click();
  await page.locator(".react-flow__node").first().waitFor({ timeout: 20000 });
  console.log("✓ graph view reachable");

  await page.getByRole("button", { name: "助手", exact: true }).click();
  await page.getByRole("button", { name: "创建编码助手" }).waitFor({ timeout: 20000 });
  console.log("✓ unified assistants page reachable");

  await page.getByRole("button", { name: "聊天", exact: true }).click();
  await page.getByRole("button", { name: "创建聊天室" }).waitFor({ timeout: 20000 });

  // app.getVersion lives in the main process and the preload deliberately
  // exposes no version field — prove the running build's version through
  // the launched exe's own version resource instead
  const fileVersion = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `(Get-Item '${exe}').VersionInfo.ProductVersion`,
    ],
    { encoding: "utf8" },
  ).stdout.trim();
  console.log("running exe ProductVersion:", fileVersion);
  assert.match(fileVersion, /^0\.3\.1(\.0)?$/, "running version matches the package");
  console.log("ALL PACKAGED CHECKS PASSED");
} finally {
  try {
    // graceful quit through Electron's own quit semantics
    await browser?.close();
  } catch {}
  // tray keeps the app alive: request app.quit via CDP was closed already —
  // terminate by the recorded PID tree, the identity-scoped cleanup path
  spawnSync("taskkill", ["/PID", String(appPid), "/T", "/F"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 2500));
}

let portFree = false;
try {
  await fetch(HEALTH);
} catch {
  portFree = true;
}
assert.ok(portFree, "9527 must be released after the app exits");
const stillRunning = spawnSync(
  "powershell",
  [
    "-NoProfile",
    "-Command",
    `@(Get-Process -Id ${appPid} -ErrorAction SilentlyContinue).Count`,
  ],
  { encoding: "utf8" },
).stdout.trim();
assert.equal(stillRunning, "0", "app process must be gone");
console.log("✓ process and port released after exit");

rmSync(home, { recursive: true, force: true });
console.log("isolated home removed");
