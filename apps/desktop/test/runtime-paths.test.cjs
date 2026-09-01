const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { resolveRuntimePaths } = require("../src/runtime-paths.cjs");

test("resolves packaged resources without using process.cwd", () => {
  const resourcesPath = path.resolve("Program Files", "Conflux", "resources");
  const appPath = path.join(resourcesPath, "app.asar");
  const originalCwd = process.cwd;
  process.cwd = () => {
    throw new Error("packaged path resolution must not read process.cwd");
  };

  try {
    const paths = resolveRuntimePaths({
      isPackaged: true,
      resourcesPath,
      appPath,
    });

    assert.equal(paths.serverEntry, path.join(appPath, "apps", "server", "dist", "index.js"));
    assert.equal(paths.webDist, path.join(appPath, "apps", "web", "dist"));
  } finally {
    process.cwd = originalCwd;
  }
});

test("resolves development resources from the desktop app path", () => {
  const repoRoot = path.resolve("repo");
  const paths = resolveRuntimePaths({
    isPackaged: false,
    resourcesPath: path.join(repoRoot, "node_modules", "electron", "dist", "resources"),
    appPath: path.join(repoRoot, "apps", "desktop"),
  });

  assert.equal(paths.repoRoot, repoRoot);
  assert.equal(paths.serverEntry, path.join(repoRoot, "apps", "server", "dist", "index.js"));
  assert.equal(paths.webDist, path.join(repoRoot, "apps", "web", "dist"));
});
