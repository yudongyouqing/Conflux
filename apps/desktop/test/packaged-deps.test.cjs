const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");

const ROOT = path.join(__dirname, "..", "..", "..");
const DESKTOP = path.join(__dirname, "..");
const CONFIG_PATH = path.join(DESKTOP, "electron-builder.yml");

// The desktop main runs from the packaged tree; a module missing from the
// installer kills startup before any error handling (v0.3.0 shipped without
// node-pty and crashed on require). This test recomputes the runtime
// dependency closure of the desktop entry points from the REAL node_modules
// and fails when any package (own or transitive) is not covered by the
// builder files list — so a dependency bump cannot silently repeat the gap.
const ENTRY_DEPENDENCIES = ["node-pty", "electron-updater", "better-sqlite3"];
const NATIVE_PACKAGES = ["node-pty", "better-sqlite3"];

function readBuilderConfig() {
  return YAML.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function resolvePkgDir(name, fromDir) {
  try {
    return path.dirname(require.resolve(path.join(name, "package.json"), { paths: [fromDir] }));
  } catch {
    return path.dirname(require.resolve(name, { paths: [fromDir] }));
  }
}

function dependencyClosure(entries, root) {
  const seen = new Set();
  const topLevel = new Set();
  const walk = (name, fromDir) => {
    const pkgDir = resolvePkgDir(name, fromDir);
    const key = pkgDir.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const rel = path.relative(root, pkgDir).split("\\").join("/");
    const parts = rel.split("/");
    if (parts[0] !== "node_modules") {
      throw new Error(`${name} resolves outside the root node_modules (${rel}); the builder pattern cannot cover it`);
    }
    topLevel.add(parts[1].startsWith("@") ? parts.slice(1, 3).join("/") : parts[1]);
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    for (const dep of Object.keys(pkg.dependencies ?? {})) walk(dep, pkgDir);
  };
  for (const entry of entries) walk(entry, DESKTOP);
  return [...topLevel].sort();
}

test("every desktop runtime dependency is covered by the builder files list", () => {
  const config = readBuilderConfig();
  const filesPatterns = config.files.filter((pattern) => typeof pattern === "string");
  const covered = new Set(
    filesPatterns
      .filter((pattern) => /^node_modules\/(.+)\/\*\*\/\*$/.test(pattern))
      .map((pattern) => pattern.match(/^node_modules\/(.+)\/\*\*\/\*$/)[1]),
  );
  const closure = dependencyClosure(ENTRY_DEPENDENCIES, ROOT);
  assert.ok(closure.length >= ENTRY_DEPENDENCIES.length, "closure computation found the entries");
  const missing = closure.filter((pkg) => !covered.has(pkg));
  assert.deepEqual(
    missing,
    [],
    `packages required at runtime but absent from electron-builder files — add node_modules/<pkg>/**/* entries for them`,
  );
});

test("native modules are unpacked from the asar so their binaries load", () => {
  const config = readBuilderConfig();
  for (const pkg of NATIVE_PACKAGES) {
    assert.ok(
      config.asarUnpack.some((pattern) => pattern.includes(pkg)),
      `${pkg} must stay in asarUnpack (native .node / winpty payloads cannot load from inside the archive)`,
    );
  }
});

test("the files list has no stale dependency entries", () => {
  const config = readBuilderConfig();
  const covered = new Set(
    config.files
      .filter((pattern) => /^node_modules\/(.+)\/\*\*\/\*$/.test(pattern))
      .map((pattern) => pattern.match(/^node_modules\/(.+)\/\*\*\/\*$/)[1]),
  );
  const closure = new Set(dependencyClosure(ENTRY_DEPENDENCIES, ROOT));
  const stale = [...covered].filter((pkg) => !closure.has(pkg));
  assert.deepEqual(
    stale,
    [],
    `node_modules patterns that are no longer in the runtime closure — remove them to keep the installer lean`,
  );
});
