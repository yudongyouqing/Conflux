const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");

const CONFIG_PATH = path.join(__dirname, "..", "electron-builder.yml");
const ROOT_PACKAGE_PATH = path.join(__dirname, "..", "..", "..", "package.json");

function readBuilderConfig() {
  return YAML.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

test("production build config includes app, server, web, and native module resources", () => {
  const config = readBuilderConfig();

  assert.deepEqual(config.files, [
    "apps/desktop/**/*",
    "apps/server/dist/**/*",
    "apps/web/dist/**/*",
  ]);
  assert.ok(config.asarUnpack.includes("**/better-sqlite3/**"));
  assert.ok(config.win.target.some((target) => target.target === "nsis"));
});

test("declares the server workspace as a root production dependency", () => {
  const packageJson = JSON.parse(fs.readFileSync(ROOT_PACKAGE_PATH, "utf8"));

  assert.equal(packageJson.dependencies?.muiltchat, "file:apps/server");
});

test("resolves the Builder config from the desktop project directory", () => {
  const packageJson = JSON.parse(fs.readFileSync(ROOT_PACKAGE_PATH, "utf8"));

  assert.match(
    packageJson.scripts?.["package:desktop"] ?? "",
    /electron-builder --projectDir apps\/desktop --config electron-builder\.yml/
  );
});
