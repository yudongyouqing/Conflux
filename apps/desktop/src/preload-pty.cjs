// PTY IPC bridge: renderer ↔ main (#130)
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("confluxPty", {
  // spawn a runtime agent in a Conflux PTY
  spawn: (agentId, command, args, opts) =>
    ipcRenderer.invoke("pty:spawn", { agentId, command, args, opts }),
  // inject a prompt into the live process
  inject: (agentId, text) => ipcRenderer.invoke("pty:inject", { agentId, text }),
  // get the accumulated output buffer
  getBuffer: (agentId) => ipcRenderer.invoke("pty:buffer", { agentId }),
  // check if alive
  isAlive: (agentId) => ipcRenderer.invoke("pty:alive", { agentId }),
  // kill
  kill: (agentId) => ipcRenderer.invoke("pty:kill", { agentId }),
  // subscribe to output stream (returns unsubscribe)
  onOutput: (agentId, callback) => {
    const channel = `pty:output:${agentId}`;
    const handler = (_event, data) => callback(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
