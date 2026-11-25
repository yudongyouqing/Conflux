const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const srcDir = path.join(__dirname, "../src");
const mainSource = fs.readFileSync(path.join(srcDir, "main.cjs"), "utf8");
const preloadSource = fs.readFileSync(path.join(srcDir, "preload.cjs"), "utf8");

test("handles Electron native renderer stall and crash events directly", () => {
  assert.match(mainSource, /webContents\.on\(\s*["']unresponsive["']/);
  assert.match(mainSource, /webContents\.on\(\s*["']responsive["']/);
  assert.match(mainSource, /webContents\.on\(\s*["']render-process-gone["']/);
  assert.match(mainSource, /handleRendererCrash/);
});

test("routes child errors and exits through the runtime guard after startup", () => {
  assert.match(mainSource, /serviceRuntimeGuard\.handleChildError/);
  assert.match(mainSource, /serviceRuntimeGuard\.handleChildExit/);
  assert.match(mainSource, /servicesReady\s*=\s*true/);
});

test("exposes native project directory picker and theme sync on confluxDesktop bridge", () => {
  assert.match(preloadSource, /pickProjectDirectory/);
  assert.match(preloadSource, /conflux:pick-directory/);
  assert.match(preloadSource, /setNativeTheme/);
  assert.match(mainSource, /ipcMain\.handle\(\s*["']conflux:pick-directory["']/);
});
