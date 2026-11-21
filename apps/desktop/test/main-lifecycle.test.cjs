const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const sourcePath = path.join(__dirname, "../src/main.cjs");
const localRequire = createRequire(sourcePath);

function harness(env = {}) {
  const app = new EventEmitter();
  app.requestSingleInstanceLock = () => true;
  app.whenReady = () => new Promise(() => {});
  app.quit = () => {};
  const ipcMain = new EventEmitter();
  const handlers = new Map();
  ipcMain.handle = (name, fn) => handlers.set(name, fn);
  let window;
  let windowOpts;
  let csp;
  const calls = [];
  class Window extends EventEmitter {
    constructor(opts) {
      super(); window = this; windowOpts = opts;
      this.webContents = new EventEmitter();
      this.webContents.session = { webRequest: { onHeadersReceived: fn => { csp = fn; } } };
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.send = () => {};
    }
    loadURL() { return Promise.resolve(); }
    isDestroyed() { return false; }
    isMinimized() { return false; }
    show() { calls.push("show"); }
    focus() { calls.push("focus"); }
    hide() { calls.push("hide"); }
  }
  const electron = { app, ipcMain, BrowserWindow: Window, nativeTheme: {}, dialog: {}, Menu: {}, Notification: {}, shell: {} };
  const context = vm.createContext({ require: name => {
    if (name === "electron") return electron;
    if (name === "./runtime-config.cjs") return { configureElectronRuntime: () => ({ mode: "production" }) };
    if (name === "./renderer-watchdog.cjs") return { createRendererWatchdog: () => ({ start() {}, stop() {} }) };
    return localRequire(name);
  }, __dirname: path.dirname(sourcePath), process: { platform: "win32", env, cwd: () => __dirname, stderr: { write() {} } }, AbortController, URL });
  vm.runInContext(fs.readFileSync(sourcePath, "utf8"), context);
  vm.runInContext('createWindow("http://127.0.0.1:9527/")', context);
  return { context, app, ipcMain, handlers, window, windowOpts, calls, csp };
}

test("close opt-in closes the real window while default close hides it", () => {
  for (const enabled of [false, true]) {
    const h = harness(enabled ? { CONFLUX_QUIT_ON_LAST_WINDOW_CLOSED: "1" } : {});
    let prevented = false;
    h.window.emit("close", { preventDefault() { prevented = true; } });
    assert.equal(prevented, !enabled);
    assert.equal(h.calls.includes("hide"), !enabled);
  }
});

test("production window installs the CSP and sandbox before loading and quit stops notification polling", async () => {
  const h = harness();
  assert.equal(typeof h.csp, "function");
  assert.equal(h.windowOpts.webPreferences.sandbox, true);
  assert.equal(h.windowOpts.webPreferences.contextIsolation, true);
  assert.equal(h.windowOpts.webPreferences.nodeIntegration, false);
  let stopped = 0;
  h.context.stopPolling = () => stopped++;
  vm.runInContext("stopMessageNotifications = stopPolling", h.context);
  h.app.emit("before-quit", { preventDefault() {} });
  assert.equal(stopped, 1);
});

test("window IPC rejects foreign senders and exposes no legacy PTY handlers", () => {
  const h = harness();
  assert.equal(h.handlers.has("pty:spawn"), false);
  h.ipcMain.emit("conflux:show-window", { sender: {} });
  assert.equal(h.calls.includes("show"), false);
  h.ipcMain.emit("conflux:show-window", { sender: h.window.webContents });
  assert.equal(h.calls.includes("show"), true);
});
