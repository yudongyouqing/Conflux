const TRAY_ICON_DATA_URL =
  "data:image/svg+xml;charset=utf-8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#1677ff"/><path d="M11.5 4.5a4.5 4.5 0 1 0 0 7" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>'
  );

function createTray({ electron = require("electron"), showWindow, quit, icon } = {}) {
  const trayIcon =
    icon ??
    (electron.nativeImage?.createFromDataURL
      ? electron.nativeImage.createFromDataURL(TRAY_ICON_DATA_URL)
      : electron.nativeImage?.createEmpty?.());
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

module.exports = { TRAY_ICON_DATA_URL, createTray };
