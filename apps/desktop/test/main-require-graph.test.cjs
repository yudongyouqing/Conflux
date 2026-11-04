const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { builtinModules } = require("node:module");
const YAML = require("yaml");

const DESKTOP = path.join(__dirname, "..");
const CONFIG_PATH = path.join(DESKTOP, "electron-builder.yml");

// Startup crash guard: the packaged main loads every top-level require of
// every desktop module before any error handling can react (v0.3.0: the
// missing node-pty killed the app with a bare dialog). This test extracts
// each bare require from the shipped desktop sources and asserts it is
// either a Node builtin, electron itself, or a package covered by the
// builder files list — so "works in dev" cannot hide "absent in the
// installer" anymore.
const REQUIRE_PATTERN = /require\((["'])([^"')]+)\1\)/g;

function desktopSources() {
  return fs
    .readdirSync(path.join(DESKTOP, "src"))
    .filter((file) => file.endsWith(".cjs"))
    .map((file) => ({ file, text: fs.readFileSync(path.join(DESKTOP, "src", file), "utf8") }));
}

function bareRequires(text) {
  const found = new Set();
  for (const match of text.matchAll(REQUIRE_PATTERN)) {
    const specifier = match[2];
    if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
    if (path.isAbsolute(specifier)) continue;
    if (specifier.startsWith("apps/") || specifier.includes("/apps/")) continue;
    found.add(specifier);
  }
  return [...found];
}

function coveredPackages() {
  const config = YAML.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  return new Set(
    config.files
      .filter((pattern) => typeof pattern === "string" && /^node_modules\//.test(pattern))
      .map((pattern) => pattern.match(/^node_modules\/(.+)\/\*\*\/\*$/)?.[1])
      .filter(Boolean),
  );
}

test("every bare require of the desktop main graph is bundled or builtin", () => {
  const covered = coveredPackages();
  const allowed = new Set([...builtinModules, "electron"]);
  const violations = [];
  for (const { file, text } of desktopSources()) {
    for (const specifier of bareRequires(text)) {
      const packageName = specifier.startsWith("@")
        ? specifier.split("/").slice(0, 2).join("/")
        : specifier.split("/")[0];
      if (allowed.has(packageName)) continue;
      if (covered.has(packageName)) continue;
      violations.push(`${file}: require("${specifier}")`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    "requires that resolve in dev but would be missing from the installer — add them to the desktop dependencies and the builder files list",
  );
});
