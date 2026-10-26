/**
 * Configure electron-updater after the packaged window is ready.
 * Development builds and explicitly disabled updates remain offline.
 */
function configureAutoUpdater({ app, autoUpdater, log, env = process.env } = {}) {
  if (!app?.isPackaged) return { enabled: false, reason: "development" };
  if (env.CONFLUX_DISABLE_AUTO_UPDATE === "1") {
    return { enabled: false, reason: "disabled" };
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("error", (error) => {
    log(`auto-update error: ${error instanceof Error ? error.message : String(error)}`);
  });
  autoUpdater.on("update-available", (info) => {
    log(`auto-update available version=${info?.version ?? "unknown"}`);
    autoUpdater.downloadUpdate().catch((error) => {
      log(`auto-update download failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    log(`auto-update downloaded version=${info?.version ?? "unknown"}`);
  });
  autoUpdater.checkForUpdates().catch((error) => {
    log(`auto-update check failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  return { enabled: true, reason: "packaged" };
}

module.exports = { configureAutoUpdater };
