const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("muiltchatDesktop", {
  isElectron: true,
  platform: process.platform,
});
