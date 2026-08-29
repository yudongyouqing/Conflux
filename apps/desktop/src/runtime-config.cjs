const path = require("node:path");

function configureElectronRuntime(electronApp, repoRoot) {
  if (electronApp.isPackaged) return;

  electronApp.setPath("userData", path.join(repoRoot, ".electron-dev"));
  electronApp.disableHardwareAcceleration();
}

module.exports = { configureElectronRuntime };
