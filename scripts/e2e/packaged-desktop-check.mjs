/**
 * Packaged desktop acceptance (P4 task 10): launches the CI-built
 * win-unpacked app FULLY ISOLATED and drives the real renderer over CDP,
 * then quits through an explicit quit path and verifies release.
 *
 * Isolation proof (all must hold before the app is driven):
 *  - ports 9527 (production API) and 9333 (CDP) are free BEFORE launch;
 *  - CONFLUX_HOME points at a fresh temp dir AND the app gets
 *    --user-data-dir at its own fresh temp dir (Electron userData/sessionData);
 *  - the real Electron userData tree is snapshotted before/after and must
 *    be byte-identical (anything the switch fails to redirect shows up here);
 *  - the healthy 9527 listener is attributed to THIS launch by walking the
 *    process tree up to the recorded app pid (a fresh dir alone does not
 *    prove which instance answered).
 *
 * Exit proof: an explicit quit path is invoked (CDP Browser.close) and the
 * app must exit and release 9527 within the grace window. taskkill /F is a
 * FAILURE fallback only — if used, the exit check is recorded as failed and
 * the script exits non-zero.
 *
 * Usage: node scripts/e2e/packaged-desktop-check.mjs <win-unpacked-dir>
 * (Never probe packaged Electron exes with --version: it LAUNCHES the app.)
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const appDir = process.argv[2];
assert.ok(appDir, "usage: packaged-desktop-check.mjs <win-unpacked-dir>");
const exe = join(appDir, "Conflux.exe");

const DEBUG_PORT = 9333;
const PROD_PORT = 9527;
const HEALTH = `http://127.0.0.1:${PROD_PORT}/healthz`;
const REAL_USER_DATA = join(process.env.APPDATA ?? "", "conflux-monorepo");

// ---- helpers ---------------------------------------------------------------

function ps(command) {
  return spawnSync("powershell", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
  }).stdout;
}

async function portOpen(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`);
    return true;
  } catch (error) {
    // undici wraps the socket error: the code lives on error.cause
    const code = error?.code ?? error?.cause?.code;
    return code !== "ECONNREFUSED";
  }
}

async function waitFor(fn, { timeoutMs = 30_000, label = "condition" }) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Recursive fingerprint (count + total bytes) of the REAL Electron
 *  userData tree — the isolation oracle for --user-data-dir. */
function snapshotUserData() {
  if (!existsSync(REAL_USER_DATA)) return "absent";
  const out = ps(
    `(Get-ChildItem -Recurse -Force -ErrorAction SilentlyContinue '${REAL_USER_DATA}' |` +
      ` Measure-Object -Property Length -Sum).Count.ToString() + ':' +` +
      ` [int64](Get-ChildItem -Recurse -Force -ErrorAction SilentlyContinue '${REAL_USER_DATA}' |` +
      ` Measure-Object -Property Length -Sum).Sum`,
  ).trim();
  return out;
}

/** The pid currently LISTENING on the production port. */
function listenerPid(port) {
  const out = ps(
    `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess`,
  ).trim();
  const pid = Number(out);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

/** True when `childPid`'s ancestor chain reaches `rootPid`. */
function pidDescendsFrom(childPid, rootPid) {
  let current = childPid;
  for (let hop = 0; hop < 12 && Number.isFinite(current) && current > 0; hop++) {
    if (current === rootPid) return true;
    const parent = Number(
      ps(`(Get-CimInstance Win32_Process -Filter "ProcessId=${current}").ParentProcessId`).trim(),
    );
    if (!Number.isFinite(parent) || parent <= 0) return false;
    current = parent;
  }
  return false;
}

function pidAlive(pid) {
  return ps(`@(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Count`).trim() === "1";
}

// ---- pre-flight: the ports must be free BEFORE we can attribute them -------

assert.equal(
  await portOpen(PROD_PORT),
  false,
  `port ${PROD_PORT} is occupied — refusing to run against an instance we did not launch`,
);
assert.equal(
  await portOpen(DEBUG_PORT),
  false,
  `port ${DEBUG_PORT} is occupied — refusing to run`,
);

const home = mkdtempSync(join(tmpdir(), "conflux-packaged-home-"));
const userDataDir = mkdtempSync(join(tmpdir(), "conflux-packaged-userdata-"));
const userDataBefore = snapshotUserData();
console.log("isolated CONFLUX_HOME:", home);
console.log("isolated --user-data-dir:", userDataDir);
console.log("real userData fingerprint (before):", userDataBefore);

// ---- launch ----------------------------------------------------------------

// PowerShell 5.1 Start-Process has no -Environment; isolation flows through
// the session environment. --version would LAUNCH the app — never use it.
const launched = ps(
  `$env:CONFLUX_HOME='${home}'; $p = Start-Process -FilePath '${exe}' ` +
    `-ArgumentList '--remote-debugging-port=${DEBUG_PORT}','--user-data-dir=${userDataDir}' ` +
    `-PassThru; $p.Id`,
).trim();
const appPid = Number(launched.split(/\s+/).pop());
assert.ok(Number.isFinite(appPid) && appPid > 0, "failed to capture the app pid");
console.log("app pid:", appPid);

let exitCheckPassed = false;
let exitPath = "none";
let browser;
try {
  await waitFor(async () => {
    try {
      return (await fetch(HEALTH)).ok;
    } catch {
      return false;
    }
  }, { timeoutMs: 60_000, label: "packaged server health" });
  console.log("healthz ok");

  // attribution: the healthy listener must be OUR process tree
  const serverPid = listenerPid(PROD_PORT);
  assert.ok(serverPid, "nobody is listening on 9527 after healthz?");
  assert.ok(
    pidDescendsFrom(serverPid, appPid),
    `9527 listener pid ${serverPid} does not descend from app pid ${appPid} — wrong instance`,
  );
  console.log(`✓ 9527 owned by pid ${serverPid}, descended from the launched app`);

  // data isolation: files exist ONLY under the fresh homes
  const homeFiles = readdirSync(home);
  assert.ok(homeFiles.includes("data.db"), `isolated home missing data.db: ${homeFiles}`);
  assert.ok(
    existsSync(join(userDataDir, "GPUCache")) || readdirSync(userDataDir).length > 0,
    "isolated --user-data-dir was not used — Electron fell back to the real profile",
  );
  console.log("✓ data and profile live under the isolated dirs");

  browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  await page.getByRole("button", { name: "创建聊天室" }).waitFor({ timeout: 30_000 });
  console.log("✓ packaged app opens the chat workspace by default");

  await page.getByRole("button", { name: "图谱", exact: true }).click();
  await page.locator(".react-flow__node").first().waitFor({ timeout: 20_000 });
  console.log("✓ graph view reachable");

  await page.getByRole("button", { name: "助手", exact: true }).click();
  await page.getByRole("button", { name: "创建编码助手" }).waitFor({ timeout: 20_000 });
  console.log("✓ unified assistants page reachable");

  const fileVersion = ps(`(Get-Item '${exe}').VersionInfo.ProductVersion`).trim();
  console.log("running exe ProductVersion:", fileVersion);
  assert.match(fileVersion, /^0\.3\.1(\.0)?$/, "running version matches the package");

  // ---- explicit quit path, then wait -------------------------------------
  // CDP Browser.close is the automatable quit invocation (equivalent to
  // closing every window); the tray-only design means we VERIFY rather than
  // assume it exits.
  exitPath = "cdp-browser-close";
  await browser.close();
  browser = undefined;
  exitCheckPassed = await waitFor(
    async () => !pidAlive(appPid) && !(await portOpen(PROD_PORT)),
    { timeoutMs: 20_000, label: "graceful exit after Browser.close" },
  ).then(
    () => true,
    () => false,
  );
} finally {
  try {
    await browser?.close();
  } catch {}
  if (!exitCheckPassed && pidAlive(appPid)) {
    // FAILURE fallback — if this runs, the exit check above is recorded failed
    spawnSync("taskkill", ["/PID", String(appPid), "/T", "/F"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ---- post-exit proofs -------------------------------------------------------

if (!exitCheckPassed) {
  console.error(
    `✗ EXIT CHECK FAILED: graceful quit via ${exitPath} did not release the app; ` +
      "taskkill /F fallback was used — this run does NOT verify normal exit",
  );
}
assert.ok(!pidAlive(appPid), "app process must be gone");
assert.equal(await portOpen(PROD_PORT), false, "9527 must be released after exit");

const userDataAfter = snapshotUserData();
assert.equal(
  userDataAfter,
  userDataBefore,
  "the real Electron userData tree changed during the run — isolation failed",
);
console.log("✓ real userData tree untouched (fingerprint identical)");

console.log(`exit: ${exitPath} (${exitCheckPassed ? "graceful, verified" : "FAILED, forced"})`);
console.log("ALL PACKAGED CHECKS " + (exitCheckPassed ? "PASSED" : "FAILED (exit)"));

rmSync(home, { recursive: true, force: true });
rmSync(userDataDir, { recursive: true, force: true });
if (!exitCheckPassed) process.exitCode = 1;
