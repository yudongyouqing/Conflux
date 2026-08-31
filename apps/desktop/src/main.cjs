const path = require("node:path");
const { spawn } = require("node:child_process");
const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");

const {
  createDevServiceSpecs,
  createDevServiceSpawnOptions,
  assertDevServicePorts,
  waitForService,
  stopChild,
  WEB_URL,
} = require("./dev-services.cjs");
const { configureElectronRuntime } = require("./runtime-config.cjs");
const { createTray } = require("./tray.cjs");
const { externalLinkDecision } = require("./security.cjs");

const repoRoot = path.resolve(__dirname, "../../..");
const children = [];
let mainWindow;
let tray;
let isQuitting = false;
let servicesStopped = false;
let focusWhenReady = false;

function log(message) {
  process.stderr.write(`[desktop] ${message}\n`);
}

log(`boot cwd=${process.cwd()} repoRoot=${repoRoot}`);
configureElectronRuntime(app, repoRoot);

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    focusWhenReady = true;
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function openExternal(url) {
  shell.openExternal(url).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    log(`external link failed: ${message}`);
  });
}

function routeNavigation(event, url, appOrigin) {
  const decision = externalLinkDecision(url, appOrigin);
  if (decision.action === "allow") return;

  event.preventDefault();
  if (decision.action === "external") openExternal(decision.url);
}

async function startDevServices() {
  const specs = createDevServiceSpecs(repoRoot);
  await assertDevServicePorts(specs);
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
    const record = {
      name: spec.name,
      pid: child.pid ?? null,
      startedAt: new Date().toISOString(),
      child,
    };
    log(`${record.name} pid=${record.pid ?? "unknown"} startedAt=${record.startedAt}`);
    children.push(record);
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

  const appOrigin = new URL(WEB_URL).origin;
  mainWindow.webContents.on("will-navigate", (event, url) =>
    routeNavigation(event, url, appOrigin)
  );
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const decision = externalLinkDecision(url, appOrigin);
    if (decision.action === "external") openExternal(decision.url);
    return { action: decision.action === "allow" ? "allow" : "deny" };
  });
  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.once("closed", () => {
    mainWindow = undefined;
  });
  mainWindow.once("ready-to-show", () => {
    if (focusWhenReady) {
      focusWhenReady = false;
      focusMainWindow();
      return;
    }
    mainWindow.show();
  });
  return mainWindow.loadURL(WEB_URL);
}

async function start() {
  log("starting development services");
  const { specs, processes } = await startDevServices();
  await Promise.all(
    specs.map((spec, index) => waitForService(spec, processes[index]))
  );
  log("development services ready");
  await createWindow();
  log("window loaded");
}

function stopDevServices() {
  if (servicesStopped) return;
  servicesStopped = true;
  for (const service of children) stopChild(service.child);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => focusMainWindow());
  ipcMain.on("conflux:show-window", focusMainWindow);

  app.whenReady().then(() => {
    log("app ready");
    tray = createTray({
      showWindow: focusMainWindow,
      quit: () => app.quit(),
    });
    return start();
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    log(`startup failed: ${message}`);
    dialog.showErrorBox("muiltchat 启动失败", message);
    app.quit();
  });

  app.on("before-quit", () => {
    if (isQuitting) return;
    isQuitting = true;
    stopDevServices();
    tray?.destroy();
    tray = undefined;
  });

  // Closing the last window hides it; the tray remains the explicit exit path.
  app.on("window-all-closed", () => {});
}
