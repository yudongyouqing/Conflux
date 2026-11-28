#!/usr/bin/env node
/** Seed an isolated database, capture the real UI, and stop every owned process. */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import services from "../../apps/desktop/src/dev-services.cjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PORT = "19527";
const OUT = process.env.CONFLUX_CAPTURE_OUT || join(ROOT, "docs/assets/screenshots");
const home = mkdtempSync(join(tmpdir(), "conflux-capture-"));
const children = [];
let browser;
try {
  console.log("fixture:", home);
  execFileSync(process.execPath, [join(ROOT, "scripts/capture/seed-fixture.mjs"), home], { cwd: ROOT, stdio: "inherit" });
  mkdirSync(OUT, { recursive: true });
  const launch = (args, cwd, env) => {
    const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: "ignore", windowsHide: true, detached: process.platform !== "win32" });
    children.push(child);
    return child;
  };
  const server = launch(["--import", "tsx", "apps/server/src/index.ts", "serve"], ROOT, { CONFLUX_HOME: home, CONFLUX_PORT: PORT });
  const vite = launch([join(ROOT, "node_modules/vite/bin/vite.js"), "--port", "5199", "--strictPort", "--host", "127.0.0.1"], join(ROOT, "apps/web"), { VITE_API_TARGET: "http://127.0.0.1:" + PORT });
  await Promise.all([
    services.waitForService({ name: "capture server", url: "http://127.0.0.1:" + PORT + "/healthz" }, server),
    services.waitForService({ name: "capture web", url: "http://127.0.0.1:5199/" }, vite),
  ]);
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 });
  await page.goto("http://127.0.0.1:5199", { waitUntil: "domcontentloaded" });
  const shot = name => page.screenshot({ path: join(OUT, name) });
  const graph = async () => {
    await page.getByTestId("rail-graph-btn").click();
    await page.getByTestId("mesh-node-cap-claude-conflux").waitFor();
    await page.evaluate(() => document.fonts.ready);
  };
  await page.getByTestId("rail-settings-btn").click();
  await page.getByTestId("theme-preset-浅色").click();
  await graph();
  await shot("graph-light.png");
  await page.getByTestId("node-enter-cap-claude-conflux").click();
  await page.getByTestId("agent-workbench").first().waitFor();
  await shot("detail-light.png");
  await page.getByTestId("rail-history-btn").click();
  await page.getByTestId("call-history-modal").waitFor();
  await shot("messages-light.png");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("rail-settings-btn").click();
  await page.getByTestId("theme-preset-终端蓝黑").click();
  await graph();
  await shot("graph-dark.png");
  await page.getByTestId("rail-history-btn").click();
  await page.getByTestId("call-history-modal").waitFor();
  await shot("messages-dark.png");
  console.log("captured →", OUT);
} finally {
  try {
    await browser?.close();
  } finally {
    await Promise.all(children.map(child => services.stopChild(child)));
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
