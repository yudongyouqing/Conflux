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
  createServiceRuntimeGuard,
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
const { createRendererWatchdog } = require("./renderer-watchdog.cjs");
const { createServiceHealthMonitor, probeHttp } = require("./service-health.cjs");

const repoRoot = path.resolve(__dirname, "../../..");
const PRODUCTION_URL = `http://${PRODUCTION_HOST}:${PRODUCTION_PORT}/`;
const children = [];
let mainWindow;
let tray;
let isQuitting = false;
let servicesStopped = false;
let focusWhenReady = false;
let rendererWatchdog;
let rendererFailureHandled = false;
let servicesReady = false;
let runtimeFailureHandled = false;
let serviceHealthMonitors = [];
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

function failRuntime(failure) {
  if (runtimeFailureHandled || isQuitting) return;
  runtimeFailureHandled = true;
  const message = `${failure.name} 运行异常：${failure.reason}。请重新启动 Conflux。`;
  log(message);
  dialog.showErrorBox("muiltchat 服务异常", message);
  app.quit();
}

const serviceRuntimeGuard = createServiceRuntimeGuard({
  isServicesReady: () => servicesReady,
  isQuitting: () => isQuitting,
  onFailure: failRuntime,
});

function handleRendererCrash(details = {}) {
  if (rendererFailureHandled || isQuitting) return;
  rendererFailureHandled = true;
  const reason = details.reason ?? "unknown";
  const exitCode = details.exitCode ?? "unknown";
  const message = `Renderer 进程已退出（reason=${reason}, exitCode=${exitCode}）。请重新启动 Conflux。`;
  log(message);
  dialog.showErrorBox("muiltchat 页面进程异常", message);
  app.quit();
}

function startRendererWatchdog() {
  rendererWatchdog = createRendererWatchdog({
    sendPing: (payload) => {
      if (
        !mainWindow ||
        mainWindow.isDestroyed() ||
        mainWindow.webContents.isDestroyed()
      ) {
        return;
      }
      try {
        mainWindow.webContents.send("conflux:renderer-ping", payload);
      } catch (error) {
        log(`renderer ping failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    onStateChange: ({ state, reason }) => {
      log(`renderer watchdog state=${state} reason=${reason ?? "none"}`);
    },
  });
  rendererWatchdog.start();
}

function recordChild(spec, child) {
  child.stdout?.on("data", (chunk) => process.stderr.write(`[${spec.name}] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[${spec.name}] ${chunk}`));
  child.once("error", (error) => {
    log(`${spec.name} error: ${error instanceof Error ? error.message : String(error)}`);
    serviceRuntimeGuard.handleChildError(spec, error);
  });
  child.once("exit", (code, signal) => {
    log(`${spec.name} exit code=${code ?? "null"} signal=${signal ?? "null"}`);
    serviceRuntimeGuard.handleChildExit(spec, code, signal);
  });

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

function stopServiceHealthMonitors() {
  for (const monitor of serviceHealthMonitors) {
    monitor.stop();
  }
  serviceHealthMonitors = [];
}

function startServiceHealthMonitors(specs) {
  stopServiceHealthMonitors();
  serviceHealthMonitors = specs.map((spec) => {
    const monitor = createServiceHealthMonitor({
      name: spec.name,
      probe: () => probeHttp(spec.url),
      onStateChange: (snapshot) => {
        log(
          `${snapshot.name} health state=${snapshot.state} failures=${snapshot.consecutiveFailures}`
        );
        serviceRuntimeGuard.handleHealthState(snapshot);
      },
    });
    monitor.start();
    return monitor;
  });
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

  const { spec, child } = await startProductionService(paths, {
    signal,
    spawnFn: (command, args, options) => {
      const ownedChild = spawn(command, args, options);
      return recordChild({ name: "server" }, ownedChild);
    },
  });
  return { webUrl: PRODUCTION_URL, specs: [spec], processes: [child] };
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
  mainWindow.webContents.on("unresponsive", () => {
    if (rendererWatchdog) {
      rendererWatchdog.markUnresponsive({ reason: "unresponsive" });
    }
  });
  mainWindow.webContents.on("responsive", () => {
    if (rendererWatchdog) {
      rendererWatchdog.markResponsive({ reason: "responsive" });
    }
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    if (rendererWatchdog) {
      rendererWatchdog.markCrashed(details);
    }
    handleRendererCrash(details);
  });
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
    servicesReady = false;
    rendererWatchdog?.stop();
    rendererWatchdog = undefined;
    stopServiceHealthMonitors();
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
  startRendererWatchdog();
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
        return { webUrl: WEB_URL, specs, processes };
      })();
  throwIfStartupAborted(signal);
  servicesReady = true;
  startServiceHealthMonitors(services.specs);
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
  ipcMain.on("conflux:renderer-pong", (event, payload) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    if (!payload || !Number.isInteger(payload.nonce) || payload.nonce <= 0) return;
    if (rendererWatchdog) {
      rendererWatchdog.handlePong(payload);
    }
  });

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
    servicesReady = false;
    rendererWatchdog?.stop();
    stopServiceHealthMonitors();
    stopDevServices();
    tray?.destroy();
    tray = undefined;
  });

  // Closing the last window hides it; the tray remains the explicit exit path.
  app.on("window-all-closed", () => {});
}
