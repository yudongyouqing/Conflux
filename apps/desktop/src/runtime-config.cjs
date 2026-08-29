const path = require("node:path");

function configureElectronRuntime(electronApp, repoRoot) {
  if (electronApp.isPackaged) return;

  electronApp.setPath("userData", path.join(repoRoot, ".electron-dev"));
  electronApp.disableHardwareAcceleration();
  electronApp.commandLine.appendSwitch("disable-gpu");
  // This development workstation cannot launch Chromium's sandboxed renderer.
  // Packaged builds leave the sandbox untouched because this branch is dev-only.
  electronApp.commandLine.appendSwitch("no-sandbox");
}

module.exports = { configureElectronRuntime };
