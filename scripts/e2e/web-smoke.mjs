import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { chromium } from "playwright";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const VITE_BIN = resolve(ROOT, "node_modules/vite/bin/vite.js");
const SERVER_PORT = 19527;
const WEB_PORT = 5199;
const ARTIFACTS = join(ROOT, "test-results", "e2e");
const home = mkdtempSync(join(tmpdir(), "conflux-e2e-"));
const server = spawn(process.execPath, ["--import", "tsx", "apps/server/src/index.ts", "serve"], {
  cwd: ROOT,
  env: { ...process.env, CONFLUX_HOME: home, CONFLUX_PORT: String(SERVER_PORT) },
  stdio: ["ignore", "ignore", "pipe"],
});
const web = spawn(
  process.execPath,
  [
    VITE_BIN,
    "--port",
    String(WEB_PORT),
    "--strictPort",
    "--host",
    "127.0.0.1",
  ],
  {
    cwd: join(ROOT, "apps/web"),
    env: { ...process.env, VITE_API_TARGET: `http://127.0.0.1:${SERVER_PORT}` },
    stdio: ["ignore", "ignore", "pipe"],
  },
);

function childFailure(child, name) {
  return new Promise((_, reject) => {
    const onExit = (code, signal) => {
      reject(new Error(`${name} exited before readiness (code=${code ?? "null"}, signal=${signal ?? "none"})`));
    };
    child.once("exit", onExit);
    child.once("error", (error) => reject(new Error(`${name} failed to start: ${error.message}`)));
  });
}

function stop(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

async function waitFor(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The child process may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function waitForChildOrUrl(child, name, url) {
  return Promise.race([waitFor(url), childFailure(child, name)]);
}

async function seed() {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/capture/seed-core.ts", home],
    {
      cwd: ROOT,
      stdio: "inherit",
    },
  );
  assert.equal(result.status, 0, "fixture seed failed");
}

async function run() {
  mkdirSync(ARTIFACTS, { recursive: true });
  await seed();
  await Promise.all([
    waitForChildOrUrl(server, "server", `http://127.0.0.1:${SERVER_PORT}/healthz`),
    waitForChildOrUrl(web, "web", `http://127.0.0.1:${WEB_PORT}/`),
  ]);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const page = await context.newPage();

  try {
    await page.goto(`http://127.0.0.1:${WEB_PORT}`, { waitUntil: "domcontentloaded" });
    await page.getByText("Conflux", { exact: true }).first().waitFor();
    await page.locator(".react-flow__node").first().waitFor();

    await page.getByRole("button", { name: "消息流", exact: true }).click();
    await page.getByText("M1-B 冒烟清单在哪台机器跑？", { exact: true }).waitFor();

    const composer = page.locator("input").first();
    await composer.fill("@Conflux");
    await composer.press("Enter");
    await composer.fill("E2E smoke message");
    const askResponse = page.waitForResponse(
      (response) => response.url().endsWith("/web/ask") && response.request().method() === "POST",
    );
    await composer.press("Enter");
    assert.equal((await askResponse).ok(), true, "web ask request failed");
    await page.getByText("E2E smoke message", { exact: true }).waitFor();

    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await page.getByRole("button", { name: "创建智能体", exact: true }).click();
    await page.getByRole("button", { name: /模型智能体/ }).click();
    const agentName = `e2e-agent-${Date.now()}`;
    await page.getByPlaceholder("名称 *").fill(agentName);
    await page.getByPlaceholder("模型 * (如 claude-sonnet-4-5)").fill("e2e-model");
    await page.getByPlaceholder("System Prompt *").fill("Respond with a short test result.");
    const createResponse = page.waitForResponse(
      (response) => response.url().endsWith("/agents") && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "创建", exact: true }).click();
    assert.equal((await createResponse).ok(), true, "agent creation request failed");
    await page.getByText(agentName, { exact: true }).waitFor();

    await page.getByRole("button", { name: "图谱", exact: true }).click();
    await page
      .locator(".react-flow__node")
      .filter({ hasText: agentName })
      .waitFor({ timeout: 10_000 });
  } catch (error) {
    await page.screenshot({ path: join(ARTIFACTS, "web-smoke-failure.png"), fullPage: true });
    await context.tracing.stop({ path: join(ARTIFACTS, "web-smoke-failure.zip") });
    throw error;
  } finally {
    await browser.close();
  }
}

try {
  await run();
  console.log("E2E web smoke tests passed");
} finally {
  stop(web);
  stop(server);
  rmSync(home, { recursive: true, force: true });
}
