# Conflux

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933.svg)](https://nodejs.org/)

> 一个以本地优先为理念的桌面工作空间，用于连接 AI 编程会话、智能体、消息与共享上下文。
>
> A local-first desktop workspace for connecting AI coding sessions, agents, messages, and shared context.

Conflux 为多个 AI 编程会话提供一个共享空间。每个会话都可以发布知识、向其他会话提问、异步接收回复，并作为实时节点出现在会话图谱中。

Conflux gives AI coding sessions a shared place to exchange context and coordinate work. Each session can publish knowledge, ask another session a question, receive asynchronous replies, and appear as a live node in a conversation graph.

公开项目名为 `Conflux`。当前内部 npm package 名称、CLI 命令、环境变量、数据目录和部分运行时文本仍使用 `muiltchat`，这是重命名过渡期的兼容约定。

The public project name is `Conflux`. Internal npm package names, CLI commands, environment variables, data directories, and some runtime text still use `muiltchat` during the rename transition.

## 项目简介 / Overview

AI 编程助手通常以彼此隔离的进程运行，因此很难回答这些问题：另一个会话正在做什么？之前的会话把实现记录发布在哪里？两个智能体如何在不手动复制粘贴的情况下交换工作结果？哪些运行时智能体仍然在线？

AI coding assistants usually run as isolated processes. That makes it difficult to answer simple questions: What is another session working on? Where did a previous session publish the implementation notes I need? How can two agents exchange work without manual copy and paste? Which runtime agents are still online?

Conflux 连接这些会话，不要求额外部署数据库服务、消息代理或托管控制平面。数据默认保存在本机 SQLite 数据库中，Electron 桌面客户端则把现有 React 工作空间加载到原生窗口中。

Conflux connects those sessions without requiring a database server, message broker, or hosted control plane. Data stays in a local SQLite database by default, while the Electron desktop client loads the existing React workspace into a native window.

## 特性 / Features

- **会话图谱（Session graph）：** 以图谱方式浏览会话、智能体和有向对话通道。
  **Session graph:** Browse sessions, agents, and directed conversation channels as a graph.
- **共享上下文（Shared context）：** 发布可搜索的笔记，并查询其他会话拥有的上下文。
  **Shared context:** Publish searchable notes and query context owned by other sessions.
- **异步消息（Async messaging）：** 向其他会话提问并异步接收回复，支持 `/resume` 之后的会话继承。
  **Async messaging:** Ask another session a question and receive the reply later, including across `/resume` transitions.
- **内置智能体（Internal agents）：** 定义带有系统提示词的模型智能体，并在工作空间中直接对话。
  **Internal agents:** Define model-backed agents with a system prompt and chat with them from the workspace.
- **运行时智能体（Runtime agents）：** 配置 Claude Code 或 Codex CLI 预设，并在独立终端环境中启动它们。
  **Runtime agents:** Configure Claude Code or Codex CLI presets and launch them in a clean terminal environment.
- **Claude Code 集成：** 通过 MCP 和可选的生命周期 Hooks 连接会话。
  **Claude Code integration:** Connect sessions through MCP and optional lifecycle hooks.
- **多种接口：** 同一套核心能力同时提供 MCP、HTTP REST 和 CLI 接口。
  **Multiple interfaces:** Expose the same core capabilities through MCP, HTTP REST, and the CLI.
- **本地优先存储：** 使用带 WAL 模式的 SQLite 保存应用状态，不依赖外部数据库。
  **Local-first storage:** Keep application state in SQLite with WAL mode and no external database dependency.
- **Electron 客户端：** 在桌面窗口中运行 React 工作空间，并自动启动本地服务。
  **Electron client:** Run the React workspace in a desktop window while starting the local services automatically.

## 项目状态 / Project Status

Conflux 目前处于积极开发阶段。当前版本已经包含 Electron 桌面开发壳和现有 Web 工作空间。Electron 集成目前面向开发环境，尚未提供 Windows、macOS 或 Linux 安装包。

Conflux is in active development. The current version includes the Electron desktop development shell and the existing web workspace. The Electron integration currently targets development workflows; packaged installers for Windows, macOS, or Linux are not available yet.

当前可用功能：

Available now:

- Windows 上的 Electron 开发模式。
  Electron development mode on Windows.
- Fastify HTTP 服务器。
  Fastify HTTP server.
- 基于 React、Vite 和 React Flow 的工作空间。
  Workspace built with React, Vite, and React Flow.
- MCP 服务器和 Claude Code Hooks。
  MCP server and Claude Code hooks.
- SQLite 持久化和核心回归测试。
  SQLite persistence and core regression tests.

后续计划：

Planned:

- Windows、macOS 和 Linux 安装包。
  Packaged installers for Windows, macOS, and Linux.
- 系统托盘和后台进程支持。
  Tray and background process support.
- 自动更新。
  Automatic updates.
- 将内部 package 名称和数据目录从 `muiltchat` 完整迁移到 `Conflux`。
  Full migration of internal package and data-directory names from `muiltchat` to `Conflux`.

## 快速开始 / Quick Start

### 环境要求 / Requirements

- Node.js >= 18。
  Node.js >= 18.
- npm >= 9。
  npm >= 9.
- 如果需要 MCP 会话集成，请安装 Claude Code。
  Install Claude Code if you want MCP session integration.
- 如果需要使用内置智能体，请准备 Anthropic 或 OpenAI API key。
  Prepare an Anthropic or OpenAI API key if you want to use internal agents.

### 安装 / Install

```bash
git clone https://github.com/yudongyouqing/Conflux.git
cd Conflux
npm install
```

### 启动 Electron 桌面客户端 / Start the Electron desktop client

```bash
npm run dev:desktop
```

该命令会启动本地 API 服务器和 Vite 开发服务器，等待两个服务就绪后，在 Electron 窗口中打开工作空间。

This command starts the local API server and Vite development server, waits for both services to become available, and opens the workspace in an Electron window.

开发环境端点：

Development endpoints:

- 工作空间（Web workspace）：<http://127.0.0.1:5173>
- API 服务器（API server）：<http://127.0.0.1:9527>
- OpenAPI 文档（OpenAPI docs）：<http://127.0.0.1:9527/docs>

不要同时运行 `npm run dev:all` 和 `npm run dev:desktop`。两个命令会使用相同的端口和 SQLite 数据目录。

Do not run `npm run dev:all` and `npm run dev:desktop` at the same time. Both commands use the same ports and SQLite data directory.

### 启动浏览器开发模式 / Run the web workspace separately

如果开发时更喜欢使用浏览器，可以运行：

If you prefer a browser during development, run:

```bash
npm run dev:all
```

然后打开 <http://127.0.0.1:5173>。`dev:all` 会并行启动本地 API 服务器和 Vite 开发服务器。

Then open <http://127.0.0.1:5173>. `dev:all` starts the local API server and Vite development server in parallel.

### 运行本地生产服务器 / Run the local production server

```bash
npm start
```

该命令会构建 shared package、server 和 web workspace，然后由 API 服务器从 `apps/web/dist` 提供静态文件，默认地址为 <http://127.0.0.1:9527>。

This command builds the shared package, server, and web workspace, then serves the built frontend from `apps/web/dist` through the API server at <http://127.0.0.1:9527>.

## 架构 / Architecture

```text
                    +----------------------+
                    |  Electron 桌面客户端  |
                    |  apps/desktop        |
                    +----------+-----------+
                               |
                               v
                    +----------------------+
                    |  React 工作空间       |
                    |  apps/web + Vite     |
                    +----------+-----------+
                               |
                               v
                    +----------------------+
                    |  Fastify 本地 API     |
                    |  HTTP + OpenAPI      |
                    +-----+-----------+----+
                          |           |
                          v           v
                 +------------+  +----------+
                 | SQLite     |  | MCP + CLI|
                 | 本地数据    |  | 适配器    |
                 +------------+  +----------+
```

Electron 主进程位于 `apps/desktop`，在开发模式下负责启动 API 和 Vite 服务，并在服务健康检查通过后加载桌面窗口。React 界面位于 `apps/web`，Fastify、SQLite 和核心业务逻辑位于 `apps/server`，共享 TypeScript 类型位于 `packages/shared`。

The Electron main process lives in `apps/desktop`. In development mode it starts the API and Vite services, waits for health checks, and then loads the desktop window. The React UI lives in `apps/web`, Fastify, SQLite, and core business logic live in `apps/server`, and shared TypeScript types live in `packages/shared`.

核心业务逻辑位于 `apps/server/src/core`。HTTP、MCP 和 CLI 接口调用同一套核心操作，因此不同接口之间的数据行为保持一致。

Core business logic lives in `apps/server/src/core`. The HTTP, MCP, and CLI interfaces call the same core operations, keeping data behavior consistent across interfaces.

## 仓库结构 / Repository Layout

```text
apps/
  desktop/       Electron 主进程和桌面开发运行时
  server/        Fastify API、SQLite 核心、MCP 服务器和 CLI
  web/           使用 Vite 和 React Flow 构建的 React 工作空间
packages/
  shared/        server 和 web 共用的 TypeScript 类型
docs/
  superpowers/   开发计划和设计规格
```

```text
apps/
  desktop/       Electron main process and desktop development runtime
  server/        Fastify API, SQLite core, MCP server, and CLI
  web/           React workspace built with Vite and React Flow
packages/
  shared/        Shared TypeScript types for the server and web apps
docs/
  superpowers/   Development plans and design specifications
```

## Claude Code 集成 / Claude Code Integration

### MCP

可以在 Claude Code 所使用的项目 `.mcp.json` 中添加 Conflux：

Add Conflux to the `.mcp.json` used by a Claude Code project:

```json
{
  "mcpServers": {
    "conflux": {
      "command": "npx",
      "args": [
        "tsx",
        "<repo>/apps/server/src/index.ts",
        "mcp"
      ]
    }
  }
}
```

如果直接使用仓库根目录中的配置，现有的 `muiltchat` MCP server key 仍然可以继续使用。公开名称和 MCP key 可以不同，内部兼容名称不会影响功能。

If you use the configuration in the repository root directly, its existing `muiltchat` MCP server key continues to work. The public name and MCP key may differ; the internal compatibility name does not change the behavior.

MCP 会话可以使用以下工具：

An MCP-connected session can use tools such as:

- `publish_context`
- `query_context`
- `ask_session`
- `reply_ask`
- `check_inbox`
- `check_replies`
- `get_graph`

每个会话都会注册到图谱中，并可以参与共享上下文和异步消息。

Each session registers itself in the graph and can participate in shared context and asynchronous messaging.

### Hooks

安装 Claude Code Hooks：

Install the Claude Code hooks:

```bash
npx tsx apps/server/src/index.ts hooks install
```

卸载 Hooks：

Uninstall the hooks:

```bash
npx tsx apps/server/src/index.ts hooks uninstall
```

Hooks 会把会话生命周期事件与会话身份关联起来，并持续更新在线状态。当前支持 `SessionStart`、`UserPromptSubmit` 和 `Stop`，安装前会备份现有的 `settings.json`。

Hooks associate lifecycle events with session identity and keep liveness information current. The current integration supports `SessionStart`, `UserPromptSubmit`, and `Stop`, and backs up the existing `settings.json` before installation.

Hooks 还会维护自定义标题、`/resume` 会话继承关系以及未投递消息。Claude Code 使用自定义配置目录时，可以通过 `CLAUDE_CONFIG_DIR` 指定该目录。

Hooks also maintain custom titles, `/resume` lineage, and undelivered messages. Set `CLAUDE_CONFIG_DIR` when Claude Code uses a custom configuration directory.

## 内置智能体 / Internal Agents

内置智能体是保存在本地数据库中的模型智能体。可以在 Agents 标签页创建智能体，配置名称、系统提示词、提供商和模型，然后直接在工作空间中与其对话。

Internal agents are model-backed agents stored in the local database. Create one from the Agents tab with a name, system prompt, provider, and model, then chat with it from the workspace.

支持的提供商环境变量包括：

Supported provider environment variables include:

```bash
ANTHROPIC_API_KEY=your-anthropic-key
OPENAI_API_KEY=your-openai-key
```

设置页面接口会报告哪些提供商已经完成配置：

The settings endpoint reports which providers are configured:

```text
GET /settings
```

## 运行时智能体 / Runtime Agents

运行时智能体是用于启动真实 CLI 编程助手的预设。每个预设可以配置：

Runtime agents are presets for launching real CLI coding assistants. A preset can define:

- 运行时：Claude Code 或 Codex。
  Runtime: Claude Code or Codex.
- 工作目录。
  Working directory.
- 模型。
  Model.
- API base URL 和 API key。
  API base URL and API key.
- 额外环境变量。
  Extra environment variables.
- 启动指令。
  Startup instructions.
- 心跳和定时运行间隔。
  Heartbeat and scheduled-run interval.

桌面工作空间可以在新终端窗口中启动运行时智能体；定时预设也可以在后台以无头模式运行。启动器会清理会话范围的环境变量，并在首选终端不可用时使用平台相关的后备方案。

The workspace can launch runtime agents in a new terminal window, and scheduled presets can run headlessly in the background. The launcher removes session-scoped environment variables and uses platform-specific fallback chains when a preferred terminal is unavailable.

## 数据与配置 / Data and Configuration

默认情况下，Conflux 将 SQLite 数据保存到：

By default, Conflux stores SQLite data under:

```text
~/.muiltchat
```

当前实现仍使用 `.muiltchat`，以兼容重命名前的版本。可以通过 `MUILTCHAT_HOME` 环境变量或 CLI 的 `--data-dir` 选项覆盖数据目录。数据库文件名为 `data.db`，并启用 SQLite WAL 模式。

The current implementation still uses `.muiltchat` for compatibility with pre-rename versions. Override the data directory with the `MUILTCHAT_HOME` environment variable or the CLI `--data-dir` option. The database file is `data.db`, and SQLite WAL mode is enabled.

Linux、macOS 或 Git Bash：

On Linux, macOS, or Git Bash:

```bash
MUILTCHAT_HOME=/path/to/conflux-data npm run dev:server
```

Windows PowerShell：

On Windows PowerShell:

```powershell
$env:MUILTCHAT_HOME = "C:\\path\\to\\conflux-data"
npm run dev:server
```

CLI 也支持 `--scope global` 和 `--scope project`。如果需要精确指定路径，可以直接运行：

The CLI also supports `--scope global` and `--scope project`. To specify an exact path, run:

```bash
npx tsx apps/server/src/index.ts --data-dir /path/to/conflux-data path
```

不需要部署外部数据库服务。

No external database service is required.

## 开发命令 / Development Commands

```bash
# 构建 shared package、server 和 web workspace
npm run build

# 启动 Electron 桌面开发客户端
npm run dev:desktop

# 同时启动 server 和浏览器开发服务器
npm run dev:all

# 只启动 server 开发进程
npm run dev:server

# 只启动 web 开发服务器
npm run dev:web

# 启动 stdio MCP server
npm run mcp

# 运行 server 回归测试
npm test -w apps/server

# 运行 Electron 服务和运行时测试
node --test apps/desktop/test/dev-services.test.cjs apps/desktop/test/runtime-config.test.cjs
```

The main commands are:

- `npm run build`: Build the shared package, server, and web workspace.
- `npm run dev:desktop`: Start the Electron desktop development client.
- `npm run dev:all`: Start the server and browser development server together.
- `npm run dev:server`: Start only the server development process.
- `npm run dev:web`: Start only the Vite development server.
- `npm run mcp`: Start the stdio MCP server.
- `npm test -w apps/server`: Run the server regression suite.
- `node --test apps/desktop/test/dev-services.test.cjs apps/desktop/test/runtime-config.test.cjs`: Run Electron service and runtime tests.

## HTTP API

本地服务器默认绑定 `127.0.0.1:9527`。开发模式下可以在 `/docs` 查看 OpenAPI 文档和 Swagger UI：<http://127.0.0.1:9527/docs>。

The local server binds to `127.0.0.1:9527` by default. In development mode, OpenAPI documentation and Swagger UI are available at `/docs`: <http://127.0.0.1:9527/docs>.

常用资源包括：

Common resources include:

- `/healthz`
- `/graph`
- `/sessions`
- `/messages`
- `/context`
- `/agents`
- `/conversations`
- `/runtimes`
- `/settings`
- `/audit`

需要会话身份的请求应提供 `X-Session-Id` 请求头。HTTP、MCP 和 CLI 接口共享同一套核心数据操作。

Requests that require a session identity should provide the `X-Session-Id` header. The HTTP, MCP, and CLI interfaces share the same core data operations.

## 贡献 / Contributing

欢迎提交 Issue、改进建议和 Pull Request。提交 Pull Request 前，请：

Issues, ideas, and pull requests are welcome. Before opening a pull request:

1. 保持改动聚焦，并说明面向用户的行为变化。
2. 运行 `npm run build`。
3. 运行 `npm test -w apps/server`。
4. 修改桌面运行时相关代码时，运行 `node --test apps/desktop/test/dev-services.test.cjs apps/desktop/test/runtime-config.test.cjs`。

1. Keep changes focused and explain user-facing behavior changes.
2. Run `npm run build`.
3. Run `npm test -w apps/server`.
4. Run `node --test apps/desktop/test/dev-services.test.cjs apps/desktop/test/runtime-config.test.cjs` when changing the desktop runtime.

## 许可证 / License

Conflux 使用 [MIT License](./LICENSE) 发布。

Conflux is released under the [MIT License](./LICENSE).
