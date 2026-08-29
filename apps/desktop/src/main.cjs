const path = require("node:path");
const { spawn } = require("node:child_process");
const { app, BrowserWindow, dialog } = require("electron");

const {
  createDevServiceSpecs,
  createDevServiceSpawnOptions,
  waitForService,
  stopChild,
  WEB_URL,
} = require("./dev-services.cjs");
const { configureElectronRuntime } = require("./runtime-config.cjs");

const repoRoot = path.resolve(__dirname, "../../..");
const children = [];
let mainWindow;

function log(message) {
  process.stderr.write(`[desktop] ${message}\n`);
}

log(`boot cwd=${process.cwd()} repoRoot=${repoRoot}`);
configureElectronRuntime(app, repoRoot);

function startDevServices() {
  const specs = createDevServiceSpecs(repoRoot);
  const processes = [];

  for (const spec of specs) {
    log(`spawning ${spec.name}: ${spec.command} ${spec.args.join(" ")}`);
    const child = spawn(
      spec.command,
      spec.args,
      createDevServiceSpawnOptions(spec.cwd, process.env)
    );
    child.stdout.on("data", (chunk) => process.stderr.write(`[${spec.name}] ${chunk}`));
    child.stderr.on("data", (chunk) => process.stderr.write(`[${spec.name}] ${chunk}`));
    child.once("error", (error) => log(`${spec.name} error: ${error.message}`));
    child.once("exit", (code, signal) =>
      log(`${spec.name} exit code=${code ?? "null"} signal=${signal ?? "null"}`)
    );
    log(`${spec.name} pid=${child.pid ?? "unknown"}`);
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
  log("starting development services");
  const { specs, processes } = startDevServices();
  await Promise.all(
    specs.map((spec, index) => waitForService(spec, processes[index]))
  );
  log("development services ready");
  await createWindow();
  log("window loaded");
}

function stopDevServices() {
  for (const child of children) stopChild(child);
}

app.whenReady().then(() => {
  log("app ready");
  return start();
}).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  log(`startup failed: ${message}`);
  dialog.showErrorBox("muiltchat 启动失败", message);
  app.quit();
});

app.on("before-quit", stopDevServices);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
