# Electron 桌面运行时与会话可信度实现计划

> 面向 AI 代理的工作者：必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（- [ ]）语法跟踪进度。

**目标：** 让 Conflux 通过一个 Electron 入口可靠启动开发或生产服务，并让 Codex、Claude、MCP 和 Hook 共享可解释、可恢复的会话身份与存活状态。

**架构：** Electron 主进程拥有本次启动的本地 server 子进程，开发模式另拥有 Vite 子进程，生产模式从应用资源目录解析 server 与静态前端。业务数据仍只经过 HTTP API；会话表增加明确的 runtime、identity source 和 runtime PID 字段，旧 metadata 继续作为迁移兼容来源。

**技术栈：** Electron 37、Electron Builder、Node.js CommonJS、TypeScript、Fastify、SQLite WAL、Node node:test。

---

## 执行边界

当前工作区已经有 Codex liveness 的未提交改动和对应计划 docs/superpowers/plans/2026-08-30-codex-liveness.md。执行本计划时先验证并单独提交那组改动；不得使用 git reset、git checkout 或覆盖式生成命令清除它们。若 git diff 中包含与 liveness 无关的用户改动，保持原样并只把本计划新增的文件加入提交。

## 文件清单

创建：

- apps/desktop/src/runtime-paths.cjs：解析开发与打包态资源、server 入口和数据路径。
- apps/desktop/src/port-diagnostics.cjs：检查端口可用性，并在 Windows 上解析占用 PID。
- apps/desktop/src/production-services.cjs：启动打包后的 server 子进程、传递静态资源路径并等待健康检查。
- apps/desktop/src/security.cjs：窗口导航、外部链接和生产 CSP 的纯策略函数。
- apps/desktop/src/tray.cjs：托盘菜单和窗口显示/隐藏行为。
- apps/desktop/test/runtime-paths.test.cjs：开发态和打包态路径测试。
- apps/desktop/test/port-diagnostics.test.cjs：空闲端口、占用端口和占用者诊断测试。
- apps/desktop/test/production-services.test.cjs：生产 server 参数和退出行为测试。
- apps/desktop/test/security.test.cjs：导航白名单、外部链接和 CSP 测试。

修改：

- apps/desktop/src/main.cjs：单实例、模式选择、服务生命周期、托盘和安全窗口。
- apps/desktop/src/dev-services.cjs：加入端口预检、服务归属记录和可取消清理。
- apps/desktop/src/runtime-config.cjs：只在开发态写入 .electron-dev，不改变打包态用户目录。
- apps/desktop/src/preload.cjs：只暴露桌面信息和最小窗口动作。
- apps/desktop/package.json、apps/desktop/electron-builder.yml：生产构建、目录构建、安装包和 native module 解包。
- package.json、package-lock.json：增加桌面构建与检查脚本及依赖。
- apps/server/src/config.ts、apps/server/src/http/server.ts：生产静态目录和本地服务配置。
- apps/server/src/core/db.ts、apps/server/src/core/sessions.ts、apps/server/src/core/graph.ts：会话身份迁移、读写和图谱输出。
- apps/server/src/core/live.ts、apps/server/src/core/liveness.ts、apps/server/src/mcp/server.ts：沿用运行时无关探测，补齐显式字段、心跳清理和迁移兼容。
- packages/shared/src/index.ts：同步会话与图节点类型。
- apps/server/src/test/sessions.test.ts、apps/server/src/test/liveness.test.ts、apps/server/src/test/graph.test.ts：增加迁移和身份回归测试。
- apps/desktop/test/dev-services.test.cjs、apps/desktop/test/runtime-config.test.cjs：扩展开发服务和运行时测试。
- apps/web/index.html、apps/web/src/vite-env.d.ts：生产安全策略元信息和桌面 API 类型声明。

### 任务 1：锁定现有 Codex liveness 改动

**文件：** 验证现有 liveness 文件和 docs/superpowers/plans/2026-08-30-codex-liveness.md。

- [ ] 步骤 1：检查未提交改动边界

运行：

`powershell
git diff --check
git status --short
npm test -w apps/server
npm run build -w apps/server
`

预期：diff 无空白错误；变更只包含会话存活功能；server 测试和构建退出码均为 0。

- [ ] 步骤 2：提交已完成的 liveness 基础

只在步骤 1 确认文件边界后执行：

`powershell
git add apps/server/src/core/graph.ts apps/server/src/core/live.ts apps/server/src/core/liveness.ts apps/server/src/core/sessions.ts apps/server/src/http/server.ts apps/server/src/mcp/server.ts apps/server/src/test/graph.test.ts apps/server/src/test/live-title.test.ts apps/server/src/test/liveness.test.ts apps/server/src/test/sessions.test.ts docs/superpowers/plans/2026-08-30-codex-liveness.md
git commit -m "feat: track codex and claude liveness"
`

预期：提交只包含上述会话存活文件，后续任务以明确的基础提交开始。

### 任务 2：把会话身份从 metadata 提升为显式字段

**文件：**

- 修改：packages/shared/src/index.ts
- 修改：apps/server/src/core/db.ts
- 修改：apps/server/src/core/sessions.ts
- 修改：apps/server/src/core/graph.ts
- 测试：apps/server/src/test/sessions.test.ts、apps/server/src/test/graph.test.ts

- [ ] 步骤 1：编写失败的身份字段测试

测试旧数据库只有 metadata.runtime、metadata.runtime_pid 时，打开数据库后字段被回填；新注册的 Codex 会话在 getSession、listSessions 和 getGraph 中返回相同身份。

`ts
test("migrates runtime identity from legacy metadata", () => {
  const db = openTestDb();
  db.exec(
    "CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, " +
    "project_dir TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, " +
    "last_heartbeat_at TEXT NOT NULL, metadata TEXT); " +
    "INSERT INTO sessions VALUES ('codex-1','repo','working','C:/repo','active', " +
    "'2026-08-30T00:00:00.000Z','2026-08-30T00:00:00.000Z', " +
    "'{\"runtime\":\"codex\",\"runtime_pid\":4321,\"identity_source\":\"mcp\"}'); " +
    "PRAGMA user_version = 8;"
  );
  const reopened = openDb(testConfig());
  const session = getSession(reopened, "codex-1")!;
  assert.equal(session.runtime, "codex");
  assert.equal(session.runtime_pid, 4321);
  assert.equal(session.identity_source, "mcp");
});

test("registers explicit runtime identity without losing legacy metadata", () => {
  const db = openTestDb();
  const session = registerSession(db, {
    id: "codex-2", name: "Conflux", runtime: "codex",
    identity_source: "mcp", runtime_pid: 9876,
    metadata: { temp: true },
  });
  assert.equal(session.runtime, "codex");
  assert.equal(session.identity_source, "mcp");
  assert.equal(session.runtime_pid, 9876);
  assert.match(session.metadata ?? "", /"temp":true/);
});
`

- [ ] 步骤 2：运行测试确认迁移尚未实现

运行：npm test -w apps/server -- --test-name-pattern="runtime identity"。

预期：新增测试失败，原因是 sessions 表没有显式字段或 RegisterInput 不接受身份参数。

- [ ] 步骤 3：实现 v9 迁移和统一读写

在 db.ts 将 schema 版本提升到 9，并为 sessions 增加 runtime TEXT、identity_source TEXT、runtime_pid INTEGER。迁移先 ALTER TABLE，再逐行解析旧 metadata 回填；解析失败时保留原 metadata、显式字段留空并记录 warning。

sessions.ts 的输入类型固定为：

`ts
export type SessionRuntime = "claude" | "codex" | "internal" | "web";
export type IdentitySource = "hook" | "mcp" | "http" | "cli" | "internal";

export interface RegisterInput {
  id: string;
  name: string;
  description?: string | null;
  project_dir?: string | null;
  runtime?: SessionRuntime | null;
  identity_source?: IdentitySource | null;
  runtime_pid?: number | null;
  metadata?: Record<string, unknown> | null;
}
`

注册 upsert 使用 COALESCE(excluded.runtime, sessions.runtime) 等表达式。MCP 的补充注册不能清除 Hook 写入的 PID；getGraph 直接选择显式字段，只把 metadata 用于临时标记、技能卡和旧数据兼容。

- [ ] 步骤 4：运行会话和图谱回归测试

运行：

`powershell
npm test -w apps/server -- --test-name-pattern="runtime identity|graph"
npm run build -w packages/shared
npm run build -w apps/server
`

预期：迁移、注册、图谱身份测试全部通过，shared 和 server 构建退出码为 0。

- [ ] 步骤 5：Commit

`powershell
git add packages/shared/src/index.ts apps/server/src/core/db.ts apps/server/src/core/sessions.ts apps/server/src/core/graph.ts apps/server/src/test/sessions.test.ts apps/server/src/test/graph.test.ts
git commit -m "feat: persist explicit session identity"
`

### 任务 3：补齐静态资源路径和生产 server 边界

**文件：**

- 修改：apps/server/src/config.ts、apps/server/src/http/server.ts
- 创建：apps/desktop/src/runtime-paths.cjs、apps/desktop/src/production-services.cjs
- 创建：apps/desktop/test/runtime-paths.test.cjs、apps/desktop/test/production-services.test.cjs

- [ ] 步骤 1：编写路径和启动参数测试

`js
test("resolves packaged resources without using process.cwd", () => {
  const paths = resolveRuntimePaths({
    isPackaged: true,
    resourcesPath: "C:\\Program Files\\Conflux\\resources",
    appPath: "C:\\Program Files\\Conflux\\resources\\app.asar",
  });
  assert.equal(paths.serverEntry, "C:\\Program Files\\Conflux\\resources\\app.asar\\apps\\server\\dist\\index.js");
  assert.equal(paths.webDist, "C:\\Program Files\\Conflux\\resources\\app.asar\\apps\\web\\dist");
});

test("passes static directory and fixed local port to packaged server", () => {
  const spec = createProductionServiceSpec({
    serverEntry: "C:\\app.asar\\apps\\server\\dist\\index.js",
    webDist: "C:\\app.asar\\apps\\web\\dist",
  });
  assert.deepEqual(spec.args, ["C:\\app.asar\\apps\\server\\dist\\index.js", "serve"]);
  assert.equal(spec.env.MUILTCHAT_WEB_DIST, "C:\\app.asar\\apps\\web\\dist");
  assert.equal(spec.env.MUILTCHAT_HOST, "127.0.0.1");
  assert.equal(spec.env.MUILTCHAT_PORT, "9527");
});
`

- [ ] 步骤 2：运行测试确认生产模块缺失或行为不完整

运行：node --test apps/desktop/test/runtime-paths.test.cjs apps/desktop/test/production-services.test.cjs。

预期：新模块缺失或断言失败；测试本身能被 Node 加载。

- [ ] 步骤 3：实现资源解析和 server 配置

runtime-paths.cjs 只根据 app.isPackaged、process.resourcesPath 和 app.getAppPath() 返回路径，不读取当前工作目录。server 的静态目录选择固定为：

`ts
const webDist = process.env.MUILTCHAT_WEB_DIST
  ? resolve(process.env.MUILTCHAT_WEB_DIST)
  : resolve(__dirname, "../../../web/dist");
`

HTTP 服务从 MUILTCHAT_HOST、MUILTCHAT_PORT 读取生产覆盖值，但默认仍为 127.0.0.1:9527；启动日志必须包含 webDist、host、port 和 dataDir。生产 server 不连接已经存在的未知服务。

production-services.cjs 使用 process.execPath 配合 ELECTRON_RUN_AS_NODE=1 启动 server，避免依赖用户全局 Node/npm；将 MUILTCHAT_WEB_DIST、MUILTCHAT_HOST 和 MUILTCHAT_PORT 放入子进程环境，并复用可取消的 HTTP 健康检查。

- [ ] 步骤 4：运行路径、服务和 server 构建测试

运行：

`powershell
node --test apps/desktop/test/runtime-paths.test.cjs apps/desktop/test/production-services.test.cjs
npm test -w apps/server
npm run build -w apps/server
`

预期：桌面纯模块测试、server 全量测试和构建全部通过。

- [ ] 步骤 5：Commit

`powershell
git add apps/server/src/config.ts apps/server/src/http/server.ts apps/desktop/src/runtime-paths.cjs apps/desktop/src/production-services.cjs apps/desktop/test/runtime-paths.test.cjs apps/desktop/test/production-services.test.cjs
git commit -m "feat: support packaged desktop server"
`

### 任务 4：实现端口诊断、服务归属和退出清理

**文件：**

- 修改：apps/desktop/src/dev-services.cjs
- 创建：apps/desktop/src/port-diagnostics.cjs、apps/desktop/test/port-diagnostics.test.cjs
- 修改：apps/desktop/test/dev-services.test.cjs

- [ ] 步骤 1：编写端口冲突失败测试

`js
test("reports an occupied port instead of probing an unknown service", async () => {
  const server = http.createServer((_req, res) => res.end("foreign"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await assert.rejects(
    assertPortAvailable(port, "127.0.0.1", {
      findOwner: async () => ({ pid: 2468, command: "other-service" }),
    }),
    /127\\.0\\.0\\.1:\\d+.*2468.*other-service/
  );
  await new Promise((resolve) => server.close(resolve));
});
`

- [ ] 步骤 2：运行测试确认端口诊断尚未实现

运行：node --test apps/desktop/test/port-diagnostics.test.cjs。

预期：因 assertPortAvailable 不存在或无法识别占用者而失败。

- [ ] 步骤 3：实现可用性检查和进程树归属

assertPortAvailable 使用 net.createServer().listen() 做绑定测试；EADDRINUSE 时调用注入的 findOwner。Windows 使用 netstat -ano -p tcp 获取 PID，再用 tasklist /FI PID eq <pid> /FO CSV 获取命令摘要。解析不到进程时错误仍保留 host、port 和 PID。开发服务启动前依次检查 9527、5173；任何一个失败都不启动另一个服务。

dev-services.cjs 为每个子进程记录 pid、启动时间和服务名；退出时使用 Windows taskkill /PID <pid> /T /F，非 Windows 使用 SIGTERM，并保证重复调用清理函数幂等。

- [ ] 步骤 4：运行桌面服务测试

运行：node --test apps/desktop/test/dev-services.test.cjs apps/desktop/test/port-diagnostics.test.cjs。

预期：所有测试通过，冲突信息包含具体地址、PID 或“无法解析占用进程”的明确提示。

- [ ] 步骤 5：Commit

`powershell
git add apps/desktop/src/dev-services.cjs apps/desktop/src/port-diagnostics.cjs apps/desktop/test/dev-services.test.cjs apps/desktop/test/port-diagnostics.test.cjs
git commit -m "feat: diagnose and own desktop service ports"
`

### 任务 5：加入单实例、窗口安全边界和托盘

**文件：**

- 修改：apps/desktop/src/main.cjs、apps/desktop/src/preload.cjs、apps/desktop/src/runtime-config.cjs
- 创建：apps/desktop/src/security.cjs、apps/desktop/src/tray.cjs、apps/desktop/test/security.test.cjs
- 修改：apps/web/index.html；创建 apps/web/src/vite-env.d.ts

- [ ] 步骤 1：编写安全策略测试

`js
test("allows only the local Conflux origin", () => {
  assert.equal(isAllowedNavigation("http://127.0.0.1:9527/", "http://127.0.0.1:9527"), true);
  assert.equal(isAllowedNavigation("https://example.com/", "http://127.0.0.1:9527"), false);
});

test("builds a production CSP without unsafe external origins", () => {
  const csp = productionCsp("http://127.0.0.1:9527");
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /connect-src 'self' http:\\/\\/127\\.0\\.0\\.1:9527/);
  assert.doesNotMatch(csp, /connect-src[^;]*https:\\/\\/example\\.com/);
});
`

- [ ] 步骤 2：运行安全测试确认行为缺失

运行：node --test apps/desktop/test/security.test.cjs。

预期：新策略函数缺失或断言失败。

- [ ] 步骤 3：实现单实例和窗口策略

主进程在 app.whenReady() 之前调用 app.requestSingleInstanceLock()；拿不到锁时立即退出。收到 second-instance 时聚焦现有窗口，不创建第二套服务。创建窗口时保留 contextIsolation: true、nodeIntegration: false，并为 will-navigate 和 setWindowOpenHandler 使用 security.cjs 的白名单函数；非 Conflux URL 通过 shell.openExternal，不在业务窗口加载。

托盘菜单只提供“显示窗口”和“退出”，关闭窗口默认隐藏到托盘；before-quit 设置一次性退出标记并递归停止自己拥有的子进程。preload 的完整暴露面保持为：

`js
contextBridge.exposeInMainWorld("confluxDesktop", {
  isElectron: true,
  platform: process.platform,
  showWindow: () => ipcRenderer.send("conflux:show-window"),
});
`

不得暴露 fs、child_process、数据库连接或任意 IPC 通道。前端增加 Window.confluxDesktop 的只读类型声明，开发兼容入口 muiltchatDesktop 在过渡期保留。

- [ ] 步骤 4：运行桌面安全和语法检查

运行：

`powershell
node --test apps/desktop/test/security.test.cjs
node --check apps/desktop/src/main.cjs
node --check apps/desktop/src/preload.cjs
`

预期：测试和两个语法检查均退出码为 0。

- [ ] 步骤 5：Commit

`powershell
git add apps/desktop/src/main.cjs apps/desktop/src/preload.cjs apps/desktop/src/runtime-config.cjs apps/desktop/src/security.cjs apps/desktop/src/tray.cjs apps/desktop/test/security.test.cjs apps/web/index.html apps/web/src/vite-env.d.ts
git commit -m "feat: secure desktop single-instance window"
`

### 任务 6：接入 Electron Builder 并完成阶段一验收

**文件：**

- 修改：apps/desktop/package.json、package.json、package-lock.json
- 创建：apps/desktop/electron-builder.yml
- 修改：apps/desktop/src/main.cjs、apps/desktop/test/runtime-config.test.cjs

- [ ] 步骤 1：编写构建配置检查

`js
test("production build config includes server, web, and native module resources", () => {
  const config = readBuilderConfig();
  assert.deepEqual(config.files, [
    "apps/desktop/**/*",
    "apps/server/dist/**/*",
    "apps/web/dist/**/*",
  ]);
  assert.ok(config.asarUnpack.includes("**/better-sqlite3/**"));
  assert.ok(config.win.target.some((target) => target.target === "nsis"));
});
`

- [ ] 步骤 2：运行配置测试确认 Builder 配置缺失

运行：node --test apps/desktop/test/runtime-config.test.cjs。

预期：测试因缺少 Builder 配置或构建字段不完整而失败。

- [ ] 步骤 3：实现脚本和打包配置

根脚本增加：

`json
{
  "build:desktop": "npm run build && npm run build -w apps/desktop",
  "package:desktop": "npm run build:desktop && electron-builder --config apps/desktop/electron-builder.yml",
  "test:desktop": "node --test apps/desktop/test/*.test.cjs"
}
`

桌面 package 增加 electron-builder、build 和 package 脚本；Builder 固定把 web/server dist 放入应用资源、把 better-sqlite3 native 文件解包，并配置 Windows NSIS。构建脚本不能调用 tsx 或用户工作目录下的源码；生产主进程加载 server 入口后等待 /healthz 再打开窗口。

- [ ] 步骤 4：运行完整阶段一验证

运行：

`powershell
npm run test:desktop
npm test -w apps/server
npm run build
npm run package:desktop -- --dir
`

预期：桌面纯模块测试、server 测试、根构建和未签名目录打包均成功；产物内存在 apps/web/dist、apps/server/dist/index.js，且没有把 API key 写进构建日志或资源清单。

- [ ] 步骤 5：执行启动、重复启动和退出清理验收

运行：npm run dev:desktop。

验证：窗口在 5 秒内打开；当前 Codex 会话在列表和图谱都可见；再次执行同一命令只聚焦已有窗口；关闭窗口后检查 netstat -ano，9527 和 5173 不再由本次启动占用。

- [ ] 步骤 6：Commit

`powershell
git add apps/desktop/package.json apps/desktop/electron-builder.yml package.json package-lock.json apps/desktop/src/main.cjs apps/desktop/test/runtime-config.test.cjs
git commit -m "build: package conflux desktop client"
`
