const { contextBridge, ipcRenderer } = require("electron");

const desktopApi = Object.freeze({
  isElectron: true,
  platform: process.platform,
  showWindow: () => ipcRenderer.send("conflux:show-window"),
});

contextBridge.exposeInMainWorld("confluxDesktop", desktopApi);
// Keep the old global for pages that still reference the pre-rename API.
contextBridge.exposeInMainWorld("muiltchatDesktop", desktopApi);
