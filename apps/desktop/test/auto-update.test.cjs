const assert = require("node:assert/strict");
const { test } = require("node:test");
const { configureAutoUpdater } = require("../src/auto-update.cjs");

function fakeUpdater() {
  const listeners = new Map();
  return {
    autoDownload: null,
    autoInstallOnAppQuit: null,
    checkCalls: 0,
    downloadCalls: 0,
    on(event, handler) {
      listeners.set(event, handler);
    },
    checkForUpdates() {
      this.checkCalls += 1;
      return Promise.resolve();
    },
    downloadUpdate() {
      this.downloadCalls += 1;
      return Promise.resolve();
    },
    emit(event, value) {
      return listeners.get(event)?.(value);
    },
  };
}

test("auto updater stays disabled for development and explicit opt-out", () => {
  const updater = fakeUpdater();
  assert.deepEqual(
    configureAutoUpdater({ app: { isPackaged: false }, autoUpdater: updater, log: () => {} }),
    { enabled: false, reason: "development" },
  );
  assert.deepEqual(
    configureAutoUpdater({
      app: { isPackaged: true },
      autoUpdater: updater,
      log: () => {},
      env: { CONFLUX_DISABLE_AUTO_UPDATE: "1" },
    }),
    { enabled: false, reason: "disabled" },
  );
  assert.equal(updater.checkCalls, 0);
});

test("packaged updater checks, downloads available releases, and installs on quit", async () => {
  const updater = fakeUpdater();
  const logs = [];
  const result = configureAutoUpdater({
    app: { isPackaged: true },
    autoUpdater: updater,
    log: (message) => logs.push(message),
  });
  assert.deepEqual(result, { enabled: true, reason: "packaged" });
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, true);
  assert.equal(updater.checkCalls, 1);
  await updater.emit("update-available", { version: "0.2.0" });
  assert.equal(updater.downloadCalls, 1);
  updater.emit("update-downloaded", { version: "0.2.0" });
  assert.ok(logs.some((message) => message.includes("0.2.0")));
});
