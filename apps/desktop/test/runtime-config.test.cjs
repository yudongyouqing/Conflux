const test = require("node:test");
const assert = require("node:assert/strict");

const { configureElectronRuntime } = require("../src/runtime-config.cjs");

test("configures a writable development userData directory", () => {
  const calls = [];
  const electronApp = {
    isPackaged: false,
    setPath: (...args) => calls.push(["setPath", ...args]),
    disableHardwareAcceleration: () => calls.push(["disableHardwareAcceleration"]),
  };

  configureElectronRuntime(electronApp, "C:\\repo");

  assert.deepEqual(calls, [
    ["setPath", "userData", "C:\\repo\\.electron-dev"],
    ["disableHardwareAcceleration"],
  ]);
});

test("leaves packaged Electron runtime configuration unchanged", () => {
  const calls = [];
  const electronApp = {
    isPackaged: true,
    setPath: (...args) => calls.push(["setPath", ...args]),
    disableHardwareAcceleration: () => calls.push(["disableHardwareAcceleration"]),
  };

  configureElectronRuntime(electronApp, "C:\\repo");

  assert.deepEqual(calls, []);
});
