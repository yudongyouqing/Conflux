const { contextBridge, ipcRenderer } = require("electron");

const RENDERER_PING_CHANNEL = "conflux:renderer-ping";
const RENDERER_PONG_CHANNEL = "conflux:renderer-pong";

ipcRenderer.on(RENDERER_PING_CHANNEL, (_event, payload) => {
  if (!payload || !Number.isInteger(payload.nonce) || payload.nonce <= 0) {
    return;
  }
  ipcRenderer.send(RENDERER_PONG_CHANNEL, { nonce: payload.nonce });
});

const desktopApi = Object.freeze({
  isElectron: true,
  platform: process.platform,
  showWindow: () => ipcRenderer.send("conflux:show-window"),
});

contextBridge.exposeInMainWorld("confluxDesktop", desktopApi);
// Keep the old global for pages that still reference the pre-rename API.
contextBridge.exposeInMainWorld("muiltchatDesktop", desktopApi);
