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
  let csp;
  const calls = [];
  class Window extends EventEmitter {
    constructor() {
      super(); window = this;
      this.webContents = new EventEmitter();
      this.webContents.session = { webRequest: { onHeadersReceived: fn => { csp = fn; } } };
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.send = () => {};
    }
    loadURL() { return Promise.resolve(); }
    hide() { calls.push("hide"); }
  }
  const electron = { app, ipcMain, BrowserWindow: Window, nativeTheme: {}, dialog: {}, Menu: {}, Notification: {}, shell: {} };
  const pty = { spawnAgent: () => { calls.push("spawn"); return { pid: 10 }; }, subscribe: () => () => {}, inject: () => true, getBuffer: () => null, isAlive: () => false, kill: () => {}, killAll: () => calls.push("killAll") };
  const context = vm.createContext({ require: name => {
    if (name === "electron") return electron;
    if (name === "./runtime-config.cjs") return { configureElectronRuntime: () => ({ mode: "production" }) };
    if (name === "./renderer-watchdog.cjs") return { createRendererWatchdog: () => ({ start() {}, stop() {} }) };
    if (name === "./pty-manager.cjs") return pty;
    return localRequire(name);
  }, __dirname: path.dirname(sourcePath), process: { platform: "win32", env, cwd: () => __dirname, stderr: { write() {} } }, AbortController, URL });
  vm.runInContext(fs.readFileSync(sourcePath, "utf8"), context);
  vm.runInContext('createWindow("http://127.0.0.1:9527/")', context);
  return { context, app, handlers, window, calls, csp };
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

test("production window installs the CSP before loading and quit stops notification polling", async () => {
  const h = harness();
  assert.equal(typeof h.csp, "function");
  let stopped = 0;
  h.context.stopPolling = () => stopped++;
  vm.runInContext("stopMessageNotifications = stopPolling", h.context);
  h.app.emit("before-quit", { preventDefault() {} });
  assert.equal(stopped, 1);
  assert.ok(h.calls.includes("killAll"));
});

test("PTY IPC rejects foreign senders and malformed spawn payloads", () => {
  const h = harness();
  const spawn = h.handlers.get("pty:spawn");
  assert.equal(spawn({ sender: {} }, { agentId: 1, command: "cmd.exe", args: [] }).ok, false);
  assert.equal(spawn({ sender: h.window.webContents }, null).ok, false);
  assert.equal(h.calls.includes("spawn"), false);
  assert.equal(spawn({ sender: h.window.webContents }, { agentId: 1, command: "cmd.exe", args: [] }).ok, true);
});
