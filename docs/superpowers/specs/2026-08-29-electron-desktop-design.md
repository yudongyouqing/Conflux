# Electron 桌面开发壳设计

## 目标

为 muiltchat 增加一个 Windows Electron 开发客户端。Electron 负责桌面窗口和进程生命周期，现有 React/Vite 界面与 Fastify/SQLite 服务继续复用，第一阶段要求现有图谱、会话、消息、Agents、运行时和设置页面在 Electron 窗口内可用。

## 范围

- 新增 `apps/desktop` workspace。
- 运行一个 `npm run dev:desktop` 命令后，自动启动本地 API 服务、Vite 开发服务和 Electron 窗口。
- Electron 窗口在开发模式加载 `http://127.0.0.1:5173`。
- 后端继续监听 `127.0.0.1:9527`，Vite 代理目标固定使用 IPv4 地址，避免 Windows 上 `localhost` 的 IPv6 解析问题。
- 关闭 Electron 时终止由它启动的 Vite 和 Fastify 子进程。
- 使用安全的 Electron 默认配置：`contextIsolation: true`、`nodeIntegration: false`，preload 只暴露平台和 Electron 标识。

第一阶段不包含安装包、自动更新、系统托盘、开机启动或将业务 HTTP API 改写成 IPC。这些功能可以建立在本阶段的进程边界之上，但不进入当前切片。

## 架构

```text
apps/desktop/src/main.cjs
  ├─ spawn: npm run serve -w apps/server
  ├─ spawn: npm run dev -w apps/web -- --host 127.0.0.1
  ├─ wait: GET http://127.0.0.1:9527/healthz
  ├─ wait: GET http://127.0.0.1:5173/
  └─ BrowserWindow.loadURL(http://127.0.0.1:5173)

apps/web/src/*
  └─ fetch relative API paths
       └─ Vite proxy
            └─ http://127.0.0.1:9527

apps/server/src/*
  └─ Fastify + SQLite + MCP + agent/runtime logic
```

`apps/desktop/src/dev-services.cjs` 只负责开发服务定义、HTTP 就绪检测和子进程停止，保持 Electron 生命周期代码可测试。`main.cjs` 负责 Electron 窗口、启动顺序、错误展示和退出清理。`preload.cjs` 不承载业务数据访问，避免把 Node 能力直接暴露给 React 页面。

## 启动与退出流程

1. `npm run dev:desktop` 进入 `apps/desktop` 的 Electron 脚本。
2. Electron 主进程根据自身路径计算仓库根目录，并以仓库根目录作为两个子进程的工作目录。
3. 主进程启动 Fastify 和 Vite，继承开发终端输出，隐藏额外的 Windows 控制台窗口。
4. 主进程轮询后端健康检查和 Vite 根页面；任一服务在超时前没有响应时，显示明确错误并退出。
5. 两个地址可访问后，创建安全配置的 BrowserWindow 并加载 Vite 地址。
6. Electron 退出前递归终止自己启动的两个子进程，避免残留监听端口。

## 错误处理

- `npm` 子进程启动失败时保留原始错误，并通过 Electron 对话框提示。
- 服务在规定时间内未响应时，错误包含具体 URL，便于区分后端和前端启动失败。
- BrowserWindow 加载失败不会静默显示空白窗口；启动流程统一捕获并退出。
- 已有用户手动启动的服务只会产生端口占用错误，不会被桌面进程主动终止；开发者应关闭旧的 `dev:all` 后再启动桌面命令。

## 测试与验收

- 单元测试验证 Windows 下两个子进程的命令、参数、工作目录和就绪 URL。
- 单元测试验证 HTTP 就绪检测在服务响应时成功，在超时后给出失败结果。
- `npm test -w apps/server` 保持现有后端回归测试通过。
- `npm run build` 验证共享包、后端和前端仍可构建。
- `npm run dev:desktop` 验证 Electron 窗口打开后能展示现有 React 页面，且页面 API 请求通过 Vite 代理访问后端。

## 成功标准

在干净的 Windows 开发环境中执行 `npm run dev:desktop`，无需手动打开浏览器或另外启动服务，即可出现 muiltchat Electron 窗口；现有页面正常加载，关闭窗口后 `5173` 和 `9527` 不留下由本次启动产生的服务进程。
