#!/usr/bin/env node
/**
 * Screenshot rig (#113): seed a throwaway db, boot the real server + vite
 * against it, drive the real app through the scenario list, save PNGs to
 * docs/assets/screenshots/. Re-run any time — README shots never drift.
 */
import { spawn, execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PORT = "19527";
const OUT = join(ROOT, "docs/assets/screenshots");

const home = mkdtempSync(join(tmpdir(), "conflux-capture-"));
console.log("fixture:", home);
execSync(`node ${join(ROOT, "scripts/capture/seed-fixture.mjs")} ${home}`, { stdio: "inherit" });
mkdirSync(OUT, { recursive: true });

const server = spawn("npx", ["tsx", "apps/server/src/index.ts", "serve"], {
  cwd: ROOT,
  env: { ...process.env, CONFLUX_HOME: home, CONFLUX_PORT: PORT },
  stdio: "ignore",
  detached: true,
});
const vite = spawn("npx", ["vite", "--port", "5199", "--strictPort", "--host", "127.0.0.1"], {
  cwd: join(ROOT, "apps/web"),
  env: { ...process.env, VITE_API_TARGET: `http://127.0.0.1:${PORT}` },
  stdio: "ignore",
  detached: true,
});

const cleanup = () => {
  try { process.kill(-server.pid); process.kill(-vite.pid); } catch {}
  try { rmSync(home, { recursive: true, force: true }); } catch {}
};
process.on("exit", cleanup);

// wait for both to be up
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const okS = await fetch(`http://127.0.0.1:${PORT}/healthz`).then((r) => r.ok).catch(() => false);
  const okV = await fetch("http://127.0.0.1:5199/").then((r) => r.ok).catch(() => false);
  if (okS && okV) break;
}

const { chromium } = await import(join(ROOT, "node_modules/playwright/index.mjs"));
const b = await chromium.launch();
const page = await b.newPage({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 1.5,
});
await page.goto("http://127.0.0.1:5199", { waitUntil: "networkidle" });
await page.evaluate(() => localStorage.removeItem("conflux.active-custom-theme"));
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(2500);

const shot = (name) => page.screenshot({ path: join(OUT, name) });

await shot("graph-light.png");
// drawer: click a session row in the sidebar
const row = page.locator("aside button:has(span.truncate)").first();
if (await row.count()) { await row.click(); await page.waitForTimeout(900); await shot("detail-light.png"); }
// messages view
await page.getByText("消息流", { exact: true }).first().click();
await page.waitForTimeout(1200);
await shot("messages-light.png");
// dark pair
await page.evaluate(() => localStorage.setItem("conflux.active-custom-theme", "终端深色"));
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(2500);
await shot("graph-dark.png");
await page.getByText("消息流", { exact: true }).first().click();
await page.waitForTimeout(1200);
await shot("messages-dark.png");

await b.close();
console.log("captured →", OUT);
process.exit(0);
