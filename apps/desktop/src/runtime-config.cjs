const path = require("node:path");

function configureElectronRuntime(electronApp, repoRoot) {
  if (electronApp.isPackaged) return { mode: "production" };

  const userDataPath = path.join(repoRoot, ".electron-dev");
  electronApp.setPath("userData", userDataPath);
  electronApp.disableHardwareAcceleration();
  electronApp.commandLine.appendSwitch("disable-gpu");
  // This development workstation cannot launch Chromium's sandboxed renderer.
  // Packaged builds leave the sandbox untouched because this branch is dev-only.
  electronApp.commandLine.appendSwitch("no-sandbox");
  return { mode: "development", userDataPath };
}

module.exports = { configureElectronRuntime };
