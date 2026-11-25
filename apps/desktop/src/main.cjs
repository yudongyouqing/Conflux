const path = require("node:path");
const { spawn } = require("node:child_process");
const { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, Notification, shell } = require("electron");

const {
  assertPortAvailable,
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
const { resolveRuntimePaths } = require("./runtime-paths.cjs");
const { configureElectronRuntime } = require("./runtime-config.cjs");
const { createTray } = require("./tray.cjs");
const { startMessageNotifications } = require("./desktop-notify.cjs");
const { externalLinkDecision, installProductionCsp } = require("./security.cjs");
const { configureAutoUpdater } = require("./auto-update.cjs");

const repoRoot = path.resolve(__dirname, "../../..");
const PRODUCTION_URL = `http://${PRODUCTION_HOST}:${PRODUCTION_PORT}/`;
const ICON_PATH = path.join(__dirname, "..", "build", "icon.png");
const children = [];
let mainWindow;
let tray;
let stopMessageNotifications = null;
let isQuitting = false;
let servicesStopped = false;
let focusWhenReady = false;
let rendererFailureHandled = false;
let servicesReady = false;
let runtimeFailureHandled = false;
const startupController = new AbortController();

function log(message) {
  process.stderr.write(`[desktop] ${message}\n`);
}

function startAutoUpdater() {
  if (!app.isPackaged || process.env.CONFLUX_DISABLE_AUTO_UPDATE === "1") return;
  try {
    const { autoUpdater } = require("electron-updater");
    configureAutoUpdater({ app, autoUpdater, log });
  } catch (error) {
    log(`auto-update unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

log(`boot cwd=${process.cwd()} repoRoot=${repoRoot}`);
const runtime = configureElectronRuntime(app, repoRoot);

function throwIfStartupAborted(signal) {
  if (signal?.aborted) throw new Error("Conflux startup was aborted");
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
    log(`external link failed: ${error instanceof Error ? error.message : String(error)}`);
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
  dialog.showErrorBox("Conflux 服务异常", message);
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
  dialog.showErrorBox("Conflux 页面进程异常", message);
  app.quit();
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

  const record = { name: spec.name, pid: child.pid ?? null, child };
  log(`${record.name} pid=${record.pid ?? "unknown"} started`);
  children.push(record);
  return child;
}

async function startDevServices(signal) {
  const specs = createDevServiceSpecs(repoRoot, {
    nodeExecPath: process.env.npm_node_execpath,
    npmExecPath: process.env.npm_execpath,
  });
  await assertDevServicePorts(specs);
  throwIfStartupAborted(signal);
  const processes = [];

  for (const spec of specs) {
    throwIfStartupAborted(signal);
    log(`spawning ${spec.name}: ${spec.command} ${spec.args.join(" ")}`);
    const child = spawn(
      spec.command,
      spec.args,
      createDevServiceSpawnOptions(spec.cwd, process.env, spec.shell),
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

  await startProductionService(paths, {
    signal,
    spawnFn: (command, args, options) => {
      const ownedChild = spawn(command, args, options);
      return recordChild({ name: "server" }, ownedChild);
    },
  });
  return { webUrl: PRODUCTION_URL };
}

function createWindow(webUrl) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset",
          vibrancy: "sidebar",
          visualEffectState: "followWindow",
          transparent: true,
          backgroundColor: "#00000000",
        }
      : {}),
    icon: ICON_PATH,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  const appOrigin = new URL(webUrl).origin;
  if (runtime.mode === "production") installProductionCsp(mainWindow.webContents.session, appOrigin);
  mainWindow.webContents.on("will-navigate", (event, url) =>
    routeNavigation(event, url, appOrigin),
  );
  mainWindow.webContents.on("will-redirect", (event, url) =>
    routeNavigation(event, url, appOrigin),
  );
  mainWindow.webContents.on("unresponsive", () => log("renderer unresponsive"));
  mainWindow.webContents.on("responsive", () => log("renderer responsive"));
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    handleRendererCrash(details);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const decision = externalLinkDecision(url, appOrigin);
    if (decision.action === "external") openExternal(decision.url);
    return { action: "deny" };
  });
  mainWindow.on("close", (event) => {
    if (isQuitting || process.env.CONFLUX_QUIT_ON_LAST_WINDOW_CLOSED === "1") return;
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.once("closed", () => {
    servicesReady = false;
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
  const { webUrl } =
    runtime.mode === "production"
      ? await startProductionServiceOwned(signal)
      : await (async () => {
          log("starting development services");
          const { specs, processes } = await startDevServices(signal);
          await Promise.all(
            specs.map((spec, index) =>
              waitForService(spec, processes[index], {
                timeoutMs: spec.startupTimeoutMs,
                signal,
              }),
            ),
          );
          return { webUrl: WEB_URL };
        })();
  throwIfStartupAborted(signal);
  servicesReady = true;
  log(`${runtime.mode} services ready`);
  await createWindow(webUrl);
  log("window loaded");
}

function stopDevServices() {
  if (servicesStopped) return servicesStopped;
  servicesStopped = Promise.all(children.map((service) => stopChild(service.child)));
  return servicesStopped;
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  const trustedSender = (event) => mainWindow && event.sender === mainWindow.webContents;
  app.on("second-instance", () => focusMainWindow());
  app.on("activate", () => focusMainWindow());
  ipcMain.on("conflux:show-window", (event) => {
    if (trustedSender(event)) focusMainWindow();
  });
  ipcMain.on("conflux:native-theme", (event, mode) => {
    if (!trustedSender(event)) return;
    nativeTheme.themeSource = mode === "dark" ? "dark" : "light";
  });
  ipcMain.handle("conflux:pick-directory", async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  app
    .whenReady()
    .then(async () => {
      log("app ready");
      app.setName("Conflux");
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: "Conflux",
            submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }],
          },
          { role: "editMenu" },
          { role: "windowMenu" },
        ]),
      );
      if (process.platform === "darwin" && app.dock) {
        try {
          app.dock.setIcon(ICON_PATH);
        } catch (error) {
          log(`dock icon not applied: ${error instanceof Error ? error.message : error}`);
        }
      }
      tray = createTray({
        showWindow: focusMainWindow,
        quit: () => app.quit(),
      });
      await start(startupController.signal);
      throwIfStartupAborted(startupController.signal);
      stopMessageNotifications = startMessageNotifications({
        baseUrl: PRODUCTION_URL.replace(/\/$/, ""),
        onNotify: ({ title, body }) => {
          try {
            if (!Notification.isSupported()) return;
            const n = new Notification({ title, body, silent: false });
            n.on("click", focusMainWindow);
            n.show();
          } catch {
            // notification center unavailable — the web view still shows it
          }
        },
      });
      startAutoUpdater();
    })
    .catch((error) => {
      if (isQuitting || startupController.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      log(`startup failed: ${message}`);
      dialog.showErrorBox("Conflux 启动失败", message);
      app.quit();
    });

  app.on("before-quit", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    isQuitting = true;
    startupController.abort();
    servicesReady = false;
    stopMessageNotifications?.();
    stopMessageNotifications = null;
    tray?.destroy();
    tray = undefined;
    stopDevServices().finally(() => app.quit());
  });

  app.on("window-all-closed", () => {
    if (process.env.CONFLUX_QUIT_ON_LAST_WINDOW_CLOSED === "1") app.quit();
  });
}
