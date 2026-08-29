# Electron 桌面开发壳实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为 Windows 增加一个 Electron 开发客户端，自动启动现有 Vite 前端和 Fastify 后端，并在桌面窗口中完整加载现有 React 界面。

**架构：** 新增 `apps/desktop` workspace。Electron 主进程启动两个现有 npm workspace 命令并等待 `9527/healthz` 与 `5173/` 可访问，然后让 BrowserWindow 加载 Vite 页面。业务 API 继续走相对路径和 Vite proxy，服务端核心逻辑不重写。

**技术栈：** Electron、Node.js CommonJS 主进程、React 18、Vite、Fastify、Node `node:test`。

---

## 文件清单

- 创建：`apps/desktop/package.json`，声明 Electron workspace 和开发脚本。
- 创建：`apps/desktop/src/dev-services.cjs`，定义子进程命令、HTTP 就绪检测和停止逻辑。
- 创建：`apps/desktop/src/main.cjs`，创建安全 BrowserWindow、启动服务和处理退出清理。
- 创建：`apps/desktop/src/preload.cjs`，通过 `contextBridge` 暴露最小桌面信息。
- 创建：`apps/desktop/test/dev-services.test.cjs`，覆盖服务命令和就绪检测。
- 修改：`package.json`，增加 `dev:desktop` 根脚本。
- 修改：`apps/web/vite.config.ts`，将 API proxy 固定到 `127.0.0.1:9527`。
- 修改：`package-lock.json`，由 npm 安装 Electron workspace 依赖生成。

### 任务 1：为开发服务边界编写失败测试

**文件：**
- 创建：`apps/desktop/test/dev-services.test.cjs`
- 依赖：`node:test`、`node:assert/strict`、`node:http`

- [ ] **步骤 1：编写失败的测试**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const {
  createDevServiceSpecs,
  waitForHttp,
} = require("../src/dev-services.cjs");

test("creates IPv4 service specs rooted at the repository", () => {
  const specs = createDevServiceSpecs("C:\\repo");

  assert.deepEqual(
    specs.map(({ name, command, args, cwd, url }) => ({
      name,
      command,
      args,
      cwd,
      url,
    })),
    [
      {
        name: "server",
        command: process.platform === "win32" ? "npm.cmd" : "npm",
        args: ["run", "serve", "-w", "apps/server"],
        cwd: "C:\\repo",
        url: "http://127.0.0.1:9527/healthz",
      },
      {
        name: "web",
        command: process.platform === "win32" ? "npm.cmd" : "npm",
        args: ["run", "dev", "-w", "apps/web", "--", "--host", "127.0.0.1"],
        cwd: "C:\\repo",
        url: "http://127.0.0.1:5173/",
      },
    ]
  );
});

test("waitForHttp resolves when a local service responds", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  await assert.doesNotReject(
    waitForHttp(`http://127.0.0.1:${port}/`, {
      timeoutMs: 500,
      intervalMs: 10,
    })
  );

  await new Promise((resolve) => server.close(resolve));
});

test("waitForHttp rejects with the URL after its timeout", async () => {
  const url = "http://127.0.0.1:1/never-ready";

  await assert.rejects(
    waitForHttp(url, { timeoutMs: 40, intervalMs: 10 }),
    new RegExp("Timed out waiting for " + url.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&"))
  );
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test apps/desktop/test/dev-services.test.cjs`

预期：FAIL，报错 `Cannot find module '../src/dev-services.cjs'`。这是预期的功能缺失，不是测试语法错误。

### 任务 2：实现开发服务定义和就绪检测

**文件：**
- 创建：`apps/desktop/src/dev-services.cjs`
- 测试：`apps/desktop/test/dev-services.test.cjs`

- [ ] **步骤 1：编写最少实现代码**

```js
const http = require("node:http");

const API_HEALTH_URL = "http://127.0.0.1:9527/healthz";
const WEB_URL = "http://127.0.0.1:5173/";

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function createDevServiceSpecs(repoRoot) {
  const command = npmCommand();
  return [
    {
      name: "server",
      command,
      args: ["run", "serve", "-w", "apps/server"],
      cwd: repoRoot,
      url: API_HEALTH_URL,
    },
    {
      name: "web",
      command,
      args: ["run", "dev", "-w", "apps/web", "--", "--host", "127.0.0.1"],
      cwd: repoRoot,
      url: WEB_URL,
    },
  ];
}

function waitForHttp(url, { timeoutMs = 30_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get(url, (response) => {
        response.resume();
        resolve();
      });

      request.once("error", () => {
        if (Date.now() >= deadline) {
          reject(new Error(`Timed out waiting for ${url}`));
          return;
        }
        setTimeout(attempt, intervalMs);
      });
    };

    attempt();
  });
}

function stopChild(child) {
  if (!child || child.killed || child.exitCode !== null) return;

  if (process.platform === "win32" && child.pid) {
    const { spawn } = require("node:child_process");
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }

  child.kill("SIGTERM");
}

module.exports = {
  API_HEALTH_URL,
  WEB_URL,
  createDevServiceSpecs,
  waitForHttp,
  stopChild,
};
```

- [ ] **步骤 2：运行测试验证通过**

运行：`node --test apps/desktop/test/dev-services.test.cjs`

预期：3 个测试全部 PASS，退出码为 0。

- [ ] **步骤 3：Commit**

```bash
git add apps/desktop/src/dev-services.cjs apps/desktop/test/dev-services.test.cjs
git commit -m "feat: add desktop dev service lifecycle"
```

### 任务 3：添加 Electron workspace 和 Vite IPv4 代理

**文件：**
- 创建：`apps/desktop/package.json`
- 修改：`package.json`
- 修改：`apps/web/vite.config.ts`
- 修改：`package-lock.json`

- [ ] **步骤 1：添加 workspace 包和脚本**

`apps/desktop/package.json` 内容：

```json
{
  "name": "muiltchat-desktop",
  "private": true,
  "version": "0.1.0",
  "main": "src/main.cjs",
  "scripts": {
    "dev": "electron ."
  },
  "devDependencies": {
    "electron": "latest"
  }
}
```

在根 `package.json` 的 `scripts` 中增加：

```json
"dev:desktop": "npm run dev -w apps/desktop"
```

将 `apps/web/vite.config.ts` 中的：

```ts
const API_TARGET = "http://localhost:9527";
```

改为：

```ts
const API_TARGET = "http://127.0.0.1:9527";
```

- [ ] **步骤 2：安装 Electron 依赖并更新锁文件**

运行：`npm install --workspace apps/desktop`

预期：npm 退出码为 0，根 `package-lock.json` 包含 `apps/desktop` workspace 和 Electron 包。

- [ ] **步骤 3：验证 workspace 配置**

运行：`npm run dev -w apps/desktop -- --version`

预期：输出 Electron 版本并退出，不出现 `Missing script` 或 workspace 找不到错误。

- [ ] **步骤 4：Commit**

```bash
git add package.json package-lock.json apps/desktop/package.json apps/web/vite.config.ts
git commit -m "build: add electron desktop workspace"
```

### 任务 4：实现 Electron 主进程和 preload

**文件：**
- 创建：`apps/desktop/src/main.cjs`
- 创建：`apps/desktop/src/preload.cjs`
- 依赖：`apps/desktop/src/dev-services.cjs`

- [ ] **步骤 1：编写主进程最少实现**

`apps/desktop/src/main.cjs` 应完成以下行为：从 `__dirname` 向上两级计算仓库根目录；根据 `createDevServiceSpecs` 启动服务；服务子进程使用 `stdio: "inherit"`、`windowsHide: true`；等待两个 URL；创建 `BrowserWindow` 时设置 `contextIsolation: true`、`nodeIntegration: false`、`preload`；加载 `WEB_URL`；在 `before-quit` 中对所有子进程调用 `stopChild`；启动失败通过 `dialog.showErrorBox` 展示服务名或 URL 后调用 `app.quit()`。

主进程的关键实现形状：

```js
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  createDevServiceSpecs,
  waitForHttp,
  stopChild,
  WEB_URL,
} = require("./dev-services.cjs");
const { app, BrowserWindow, dialog } = require("electron");

const repoRoot = path.resolve(__dirname, "../../..");
const children = [];
let mainWindow;

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
  const specs = createDevServiceSpecs(repoRoot);
  for (const spec of specs) {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    children.push(child);
  }
  await Promise.all(specs.map((spec) => waitForHttp(spec.url)));
  await createWindow();
}

app.whenReady().then(start).catch((error) => {
  dialog.showErrorBox("muiltchat 启动失败", error instanceof Error ? error.message : String(error));
  app.quit();
});

app.on("before-quit", () => {
  for (const child of children) stopChild(child);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
```

- [ ] **步骤 2：添加安全 preload**

`apps/desktop/src/preload.cjs` 内容：

```js
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("muiltchatDesktop", {
  isElectron: true,
  platform: process.platform,
});
```

- [ ] **步骤 3：运行语法检查**

运行：`node --check apps/desktop/src/main.cjs` 和 `node --check apps/desktop/src/preload.cjs`

预期：两条命令均退出码为 0。

- [ ] **步骤 4：Commit**

```bash
git add apps/desktop/src/main.cjs apps/desktop/src/preload.cjs
git commit -m "feat: launch muiltchat in electron"
```

### 任务 5：运行完整验证和桌面启动验收

**文件：**
- 验证：`apps/desktop/src/*`
- 验证：`apps/web/vite.config.ts`
- 验证：现有 `apps/server/src/test/*`

- [ ] **步骤 1：运行桌面服务单元测试**

运行：`node --test apps/desktop/test/dev-services.test.cjs`

预期：3 个测试通过，0 个失败。

- [ ] **步骤 2：运行后端回归测试**

运行：`npm test -w apps/server`

预期：现有测试全部通过，0 个失败。

- [ ] **步骤 3：运行完整构建**

运行：`npm run build`

预期：shared、server、web 三个 workspace 均构建成功，退出码为 0。

- [ ] **步骤 4：运行 Electron 开发客户端**

运行：`npm run dev:desktop`

预期：终端出现两个子服务的启动输出，Electron 窗口打开并显示现有 muiltchat 页面；页面请求 `/healthz`、`/graph` 等 API 成功。

- [ ] **步骤 5：验证退出清理**

关闭 Electron 窗口后运行：`netstat -ano`

预期：本次 Electron 启动的 `5173` 和 `9527` 监听端口不再存在。

- [ ] **步骤 6：Commit 验证记录**

```bash
git add docs/superpowers/specs/2026-08-29-electron-desktop-design.md docs/superpowers/plans/2026-08-29-electron-desktop.md
git commit -m "docs: define electron desktop development plan"
```
