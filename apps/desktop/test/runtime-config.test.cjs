const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { configureElectronRuntime } = require("../src/runtime-config.cjs");

test("configures a writable development userData directory", () => {
  const repoRoot = path.resolve("repo");
  const calls = [];
  const electronApp = {
    isPackaged: false,
    setPath: (...args) => calls.push(["setPath", ...args]),
    disableHardwareAcceleration: () => calls.push(["disableHardwareAcceleration"]),
    commandLine: {
      appendSwitch: (...args) => calls.push(["appendSwitch", ...args]),
    },
  };

  configureElectronRuntime(electronApp, repoRoot);

  assert.deepEqual(calls, [
    ["setPath", "userData", path.join(repoRoot, ".electron-dev")],
    ["disableHardwareAcceleration"],
    ["appendSwitch", "disable-gpu"],
    ["appendSwitch", "no-sandbox"],
  ]);
});

test("leaves packaged Electron runtime configuration unchanged", () => {
  const calls = [];
  const electronApp = {
    isPackaged: true,
    setPath: (...args) => calls.push(["setPath", ...args]),
    disableHardwareAcceleration: () => calls.push(["disableHardwareAcceleration"]),
    commandLine: {
      appendSwitch: (...args) => calls.push(["appendSwitch", ...args]),
    },
  };

  configureElectronRuntime(electronApp, "C:\\repo");

  assert.deepEqual(calls, []);
});
