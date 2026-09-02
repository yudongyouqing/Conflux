const path = require("node:path");

function absolutePath(name, value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty absolute path`);
  }
  if (!path.isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute path`);
  }
  return path.normalize(value);
}

function resolveRuntimePaths({ isPackaged, resourcesPath, appPath, dataDir }) {
  const normalizedResourcesPath = absolutePath("resourcesPath", resourcesPath);
  const normalizedAppPath = absolutePath("appPath", appPath);
  const appRoot = isPackaged
    ? normalizedAppPath
    : path.dirname(path.dirname(normalizedAppPath));

  return {
    appRoot,
    repoRoot: isPackaged ? null : appRoot,
    resourcesPath: normalizedResourcesPath,
    serverEntry: path.join(appRoot, "apps", "server", "dist", "index.js"),
    webDist: path.join(appRoot, "apps", "web", "dist"),
    ...(dataDir === undefined ? {} : { dataDir: absolutePath("dataDir", dataDir) }),
  };
}

module.exports = { resolveRuntimePaths };
