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
const {
  PRODUCTION_HOST,
  PRODUCTION_PORT,
  startProductionService,
} = require("./production-services.cjs");
const { assertPortAvailable } = require("./port-diagnostics.cjs");
const { resolveRuntimePaths } = require("./runtime-paths.cjs");
const { configureElectronRuntime } = require("./runtime-config.cjs");
const { createTray } = require("./tray.cjs");
const { externalLinkDecision } = require("./security.cjs");

const repoRoot = path.resolve(__dirname, "../../..");
const PRODUCTION_URL = `http://${PRODUCTION_HOST}:${PRODUCTION_PORT}/`;
const children = [];
let mainWindow;
let tray;
let isQuitting = false;
let servicesStopped = false;
let focusWhenReady = false;
const startupController = new AbortController();

function log(message) {
  process.stderr.write(`[desktop] ${message}\n`);
}

log(`boot cwd=${process.cwd()} repoRoot=${repoRoot}`);
const runtime = configureElectronRuntime(app, repoRoot);

function throwIfStartupAborted(signal) {
  if (signal?.aborted) {
    throw new Error("Conflux startup was aborted");
  }
}

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

function recordChild(spec, child) {
  child.stdout?.on("data", (chunk) => process.stderr.write(`[${spec.name}] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[${spec.name}] ${chunk}`));
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
  return child;
}

async function startDevServices(signal) {
  const specs = createDevServiceSpecs(repoRoot);
  await assertDevServicePorts(specs);
  throwIfStartupAborted(signal);
  const processes = [];

  for (const spec of specs) {
    throwIfStartupAborted(signal);
    log(`spawning ${spec.name}: ${spec.command} ${spec.args.join(" ")}`);
    const child = spawn(
      spec.command,
      spec.args,
      createDevServiceSpawnOptions(spec.cwd, process.env)
    );
    processes.push(recordChild(spec, child));
  }

  return { specs, processes };
}

async function startProductionServiceOwned(signal) {
  const paths = resolveRuntimePaths({
    isPackaged: true,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
  await assertPortAvailable(PRODUCTION_PORT, PRODUCTION_HOST);
  throwIfStartupAborted(signal);

  const { child } = await startProductionService(paths, {
    signal,
    spawnFn: (command, args, options) => {
      const ownedChild = spawn(command, args, options);
      return recordChild({ name: "server" }, ownedChild);
    },
  });
  return { webUrl: PRODUCTION_URL, processes: [child] };
}

function createWindow(webUrl) {
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

  const appOrigin = new URL(webUrl).origin;
  mainWindow.webContents.on("will-navigate", (event, url) =>
    routeNavigation(event, url, appOrigin)
  );
  mainWindow.webContents.on("will-redirect", (event, url) =>
    routeNavigation(event, url, appOrigin)
  );
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const decision = externalLinkDecision(url, appOrigin);
    if (decision.action === "external") openExternal(decision.url);
    return { action: "deny" };
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
  return mainWindow.loadURL(webUrl);
}

async function start(signal) {
  const services = runtime.mode === "production"
    ? await startProductionServiceOwned(signal)
    : await (async () => {
        log("starting development services");
        const { specs, processes } = await startDevServices(signal);
        await Promise.all(
          specs.map((spec, index) =>
            waitForService(spec, processes[index], { signal })
          )
        );
        return { webUrl: WEB_URL };
      })();
  throwIfStartupAborted(signal);
  log(`${runtime.mode} services ready`);
  await createWindow(services.webUrl);
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
    return start(startupController.signal);
  }).catch((error) => {
    if (isQuitting || startupController.signal.aborted) return;
    const message = error instanceof Error ? error.message : String(error);
    log(`startup failed: ${message}`);
    dialog.showErrorBox("muiltchat 启动失败", message);
    app.quit();
  });

  app.on("before-quit", () => {
    if (isQuitting) return;
    isQuitting = true;
    startupController.abort();
    stopDevServices();
    tray?.destroy();
    tray = undefined;
  });

  // Closing the last window hides it; the tray remains the explicit exit path.
  app.on("window-all-closed", () => {});
}
