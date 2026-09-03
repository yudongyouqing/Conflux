const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const srcDir = path.join(__dirname, "../src");
const mainSource = fs.readFileSync(path.join(srcDir, "main.cjs"), "utf8");
const preloadSource = fs.readFileSync(path.join(srcDir, "preload.cjs"), "utf8");

test("keeps renderer ping and pong on private matching IPC channels", () => {
  assert.match(preloadSource, /RENDERER_PING_CHANNEL\s*=\s*["']conflux:renderer-ping["']/);
  assert.match(preloadSource, /RENDERER_PONG_CHANNEL\s*=\s*["']conflux:renderer-pong["']/);
  assert.match(preloadSource, /ipcRenderer\.on\(\s*RENDERER_PING_CHANNEL/);
  assert.match(preloadSource, /ipcRenderer\.send\(\s*RENDERER_PONG_CHANNEL/);
  assert.match(mainSource, /ipcMain\.on\(\s*["']conflux:renderer-pong["']/);
  assert.match(mainSource, /webContents\.send\(\s*["']conflux:renderer-ping["']/);
});

test("validates the pong sender and nonce before marking the renderer healthy", () => {
  assert.match(mainSource, /event\.sender\s*!==\s*mainWindow\.webContents/);
  assert.match(mainSource, /Number\.isInteger\([\s\S]*?nonce/);
  assert.match(mainSource, /rendererWatchdog\.handlePong/);
});

test("handles recoverable window stalls separately from renderer crashes", () => {
  assert.match(mainSource, /webContents\.on\(\s*["']unresponsive["']/);
  assert.match(mainSource, /webContents\.on\(\s*["']responsive["']/);
  assert.match(mainSource, /webContents\.on\(\s*["']render-process-gone["']/);
  assert.match(mainSource, /rendererWatchdog\.markUnresponsive/);
  assert.match(mainSource, /rendererWatchdog\.markResponsive/);
  assert.match(mainSource, /rendererWatchdog\.markCrashed/);
});

test("stops renderer watchdog during window close and application quit", () => {
  assert.match(
    mainSource,
    /mainWindow\.once\(\s*["']closed["'][\s\S]*?rendererWatchdog\?\.stop/
  );
  assert.match(
    mainSource,
    /app\.on\(\s*["']before-quit["'][\s\S]*?rendererWatchdog\?\.stop/
  );
});

test("monitors owned services only after startup and routes unhealthy state to one failure path", () => {
  assert.match(mainSource, /createServiceHealthMonitor/);
  assert.match(mainSource, /probeHttp/);
  assert.match(mainSource, /createServiceRuntimeGuard/);
  assert.match(mainSource, /servicesReady/);
  assert.match(mainSource, /startServiceHealthMonitors/);
  assert.match(mainSource, /stopServiceHealthMonitors/);
  assert.match(mainSource, /failRuntime/);
  assert.match(mainSource, /serviceRuntimeGuard\.handleHealthState/);
});

test("routes child errors and exits through the runtime guard", () => {
  assert.match(mainSource, /serviceRuntimeGuard\.handleChildError/);
  assert.match(mainSource, /serviceRuntimeGuard\.handleChildExit/);
  assert.match(mainSource, /servicesReady\s*=\s*true/);
});
