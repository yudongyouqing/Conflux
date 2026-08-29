const path = require("node:path");
const { spawn } = require("node:child_process");
const { app, BrowserWindow, dialog } = require("electron");

const {
  createDevServiceSpecs,
  waitForService,
  stopChild,
  WEB_URL,
} = require("./dev-services.cjs");
const { configureElectronRuntime } = require("./runtime-config.cjs");

const repoRoot = path.resolve(__dirname, "../../..");
const children = [];
let mainWindow;

configureElectronRuntime(app, repoRoot);

function startDevServices() {
  const specs = createDevServiceSpecs(repoRoot);
  const processes = [];

  for (const spec of specs) {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    children.push(child);
    processes.push(child);
  }

  return { specs, processes };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  return mainWindow.loadURL(WEB_URL);
}

async function start() {
  const { specs, processes } = startDevServices();
  await Promise.all(
    specs.map((spec, index) => waitForService(spec, processes[index]))
  );
  await createWindow();
}

function stopDevServices() {
  for (const child of children) stopChild(child);
}

app.whenReady().then(start).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  dialog.showErrorBox("muiltchat 启动失败", message);
  app.quit();
});

app.on("before-quit", stopDevServices);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
