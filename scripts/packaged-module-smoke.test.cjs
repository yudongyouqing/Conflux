const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { REQUIRED_MODULES, verifyPackagedModules } = require("./packaged-module-smoke.cjs");

test("rejects relative or missing app.asar paths", async () => {
  await assert.rejects(() => verifyPackagedModules(""), /Expected absolute app\.asar path/);
  await assert.rejects(() => verifyPackagedModules("relative/app.asar"), /Expected absolute app\.asar path/);
});

test("verifies electron-updater and better-sqlite3 and closes the smoke DB", async () => {
  const closed = [];
  class FakeDb {
    constructor(target) {
      assert.equal(target, ":memory:");
    }
    prepare() {
      return { get: () => ({ one: 1 }) };
    }
    close() {
      closed.push(true);
    }
  }
  const asar = path.resolve("app.asar");
  await verifyPackagedModules(asar, {
    loadModule: (specifier) => {
      if (specifier.endsWith("electron-updater")) return { autoUpdater: {} };
      if (specifier.endsWith("better-sqlite3")) return FakeDb;
      throw new Error(`unexpected module ${specifier}`);
    },
  });
  assert.equal(closed.length, 1);
  assert.deepEqual(REQUIRED_MODULES, ["electron-updater", "better-sqlite3"]);
});

test("reports missing modules or failed SQLite queries", async () => {
  const asar = path.resolve("app.asar");
  await assert.rejects(
    () =>
      verifyPackagedModules(asar, {
        loadModule: (specifier) => {
          if (specifier.endsWith("electron-updater")) throw new Error("cannot find module");
          return class {
            prepare() {
              return { get: () => ({ one: 0 }) };
            }
            close() {}
          };
        },
      }),
    /electron-updater: cannot find module[\s\S]*SQLite binding: SELECT 1 failed/,
  );
});
