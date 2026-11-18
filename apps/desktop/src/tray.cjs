function createTray({ electron = require("electron"), showWindow, quit, icon, platform = process.platform } = {}) {
  // macOS tints template glyphs; other platforms need the colored app icon.
  const templateIcon = () => {
    try {
      const img = electron.nativeImage.createFromPath(
        require("node:path").join(__dirname, "..", "build", platform === "darwin" ? "tray-template.png" : "icon.png"),
      );
      const resized = img.resize({ width: 18, height: 18 });
      if (platform === "darwin") resized.setTemplateImage(true);
      return resized;
    } catch {
      return electron.nativeImage?.createEmpty?.();
    }
  };
  const trayIcon = icon ?? templateIcon();
  const tray = new electron.Tray(trayIcon);
  const displayWindow = typeof showWindow === "function" ? showWindow : () => {};
  const exit = typeof quit === "function" ? quit : () => {};

  tray.setToolTip("Conflux");
  tray.setContextMenu(
    electron.Menu.buildFromTemplate([
      { label: "显示窗口", click: displayWindow },
      { label: "退出", click: exit },
    ])
  );
  tray.on("click", displayWindow);
  return tray;
}

module.exports = { createTray };
