const { contextBridge, ipcRenderer } = require("electron");

const pickDirectory = async () => {
  const picked = await ipcRenderer.invoke("conflux:pick-directory");
  return typeof picked === "string" ? picked : null;
};

const desktopApi = Object.freeze({
  isElectron: true,
  platform: process.platform,
  showWindow: () => ipcRenderer.send("conflux:show-window"),
  pickDirectory,
  pickProjectDirectory: pickDirectory,
  setNativeTheme: (mode) => ipcRenderer.send("conflux:native-theme", mode),
});

contextBridge.exposeInMainWorld("confluxDesktop", desktopApi);
