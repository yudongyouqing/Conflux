<div align="center">
  <h1>Conflux</h1>
  <p>本地优先的桌面工作空间 · 连接 AI 编程会话、智能体、消息与共享上下文</p>
  <p>简体中文 ｜ <a href="./docs/README.en.md">English</a></p>
  <p>
    <img src="https://img.shields.io/badge/Electron-37-47848F?logo=electron&logoColor=white" alt="Electron">
    <img src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white" alt="React">
    <img src="https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=nodedotjs&logoColor=white" alt="Node.js">
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  </p>
</div>

Conflux 为多个 AI 编程会话提供一个共享空间。每个会话都可以发布知识、向其他会话提问、异步接收回复，并作为实时节点出现在会话图谱中。

公开项目名和新 CLI 入口为 `Conflux`。npm package 名称、旧 CLI 入口、环境变量和默认数据目录继续保留 `muiltchat` 兼容性。

文档入口：[迁移指南](docs/MIGRATION.md) · [故障排查](docs/TROUBLESHOOTING.md) · [贡献指南](CONTRIBUTING.md) · [更新日志](CHANGELOG.md)

## 项目简介

AI 编程助手通常以彼此隔离的进程运行，因此很难回答这些问题：

- 另一个会话正在做什么？
- 之前的会话把实现记录发布在哪里？
- 两个智能体如何在不手动复制粘贴的情况下交换工作结果？
- 哪些运行时智能体仍然在线？

Conflux 连接这些会话，不要求额外部署数据库服务、消息代理或托管控制平面。数据默认保存在本机 SQLite 数据库中，Electron 桌面客户端则把现有 React 工作空间加载到原生窗口中。

## 特性

- **会话图谱：** 以图谱方式浏览会话、智能体和有向对话通道。
- **共享上下文：** 发布可搜索的笔记，并查询其他会话拥有的上下文。
- **异步消息：** 向其他会话提问并异步接收回复，支持 `/resume` 之后的会话继承。
- **内置智能体：** 定义带有系统提示词的模型智能体，并在工作空间中直接对话。
- **运行时智能体：** 配置 Claude Code 或 Codex CLI 预设，并在独立终端环境中启动它们。
- **Claude Code 集成：** 通过 MCP 和可选的生命周期 Hooks 连接会话。
- **多种接口：** 同一套核心能力同时提供 MCP、HTTP REST 和 CLI 接口。
- **本地优先存储：** 使用带 WAL 模式的 SQLite 保存应用状态，不依赖外部数据库。
- **Electron 客户端：** 在桌面窗口中运行 React 工作空间，并自动启动本地服务。

## 项目状态

Conflux 目前处于积极开发阶段。当前版本已经包含 Electron 桌面开发壳、生产资源加载路径、安装包配置和跨平台 CI；正式发布仍以 GitHub Actions 生成的未签名产物为准。

当前可用：

- Windows 上的 Electron 开发模式。
- Electron 单实例、托盘、服务生命周期、端口诊断和窗口安全边界。
- Fastify HTTP 服务器。
- 基于 React、Vite 和 React Flow 的工作空间。
- MCP 服务器和 Claude Code Hooks。
- Claude Code/Codex 会话存活探测、恢复继承和异步协作消息。
- 版本化数据导入导出、旧目录迁移、稳定错误码和敏感信息扫描。
- Windows 未签名 NSIS 与目录包的 CI 构建配置。
- SQLite 持久化和核心回归测试。

后续计划：

- 自动更新和代码签名。
- 面向 macOS/Linux 的正式安装包发行。
- 将内部 package 名称和数据目录从 `muiltchat` 完整迁移到 `Conflux`，同时继续保留兼容层。

## 快速开始

### 环境要求

- Node.js 22 LTS（server package 仍声明 Node.js >= 18 兼容）。
- npm >= 9。
- 如果需要 MCP 会话集成，请安装 Claude Code。
- 如果需要使用内置智能体，请准备 Anthropic 或 OpenAI API key。

### 安装

```bash
git clone https://github.com/yudongyouqing/Conflux.git
cd Conflux
npm ci
```

### 启动 Electron 桌面客户端

```bash
npm run dev:desktop
```

该命令会启动本地 API 服务器和 Vite 开发服务器，等待两个服务就绪后，在 Electron 窗口中打开工作空间。

开发环境端点：

- 工作空间：<http://127.0.0.1:5173>
- API 服务器：<http://127.0.0.1:9527>
- OpenAPI 文档：<http://127.0.0.1:9527/docs>

不要同时运行 `npm run dev:all` 和 `npm run dev:desktop`。两个命令会使用相同的端口和 SQLite 数据目录。

### 启动浏览器开发模式

如果开发时更喜欢使用浏览器，可以运行：

```bash
npm run dev:all
```

然后打开 <http://127.0.0.1:5173>。如果 `localhost` 无法访问，优先尝试 `127.0.0.1`。`dev:all` 会并行启动本地 API 服务器和 Vite 开发服务器。

如果页面或 API 无法打开，请先查看[故障排查指南](docs/TROUBLESHOOTING.md)，其中包含地址检查、端口诊断、MCP 重启和数据恢复步骤。

### 运行本地生产服务器

```bash
npm start
```

该命令会构建 shared package、server 和 web workspace，然后由 API 服务器从 `apps/web/dist` 提供静态文件，默认地址为 <http://127.0.0.1:9527>。

遇到启动、端口、数据库、MCP 或迁移问题时，请查看[故障排查指南](docs/TROUBLESHOOTING.md)。旧版数据和配置的兼容行为见[迁移指南](docs/MIGRATION.md)；参与开发前请阅读[贡献指南](CONTRIBUTING.md)。

## 发布与安装包

Windows 发布由 GitHub Actions 在 `v*` 标签上构建，包含未签名的 NSIS 安装包和 `win-unpacked` 目录包。安装包不代表代码已签名，不应在没有验证来源的情况下运行。

本地构建当前平台的目录包：

```bash
npm run package:desktop:dir
```

在 Windows 上构建 NSIS 安装包：

```bash
npm run package:desktop
```

目录和安装包输出到 `release/`，不会提交到 Git。Windows 上的 native `better-sqlite3` 可能需要 Visual Studio C++ Build Tools；本机没有该工具链时，请使用仓库的 Windows CI。卸载 Conflux 不会删除 `%USERPROFILE%\\.muiltchat` 中的用户数据。

## 架构

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

核心业务逻辑位于 `apps/server/src/core`。HTTP、MCP 和 CLI 接口调用同一套核心操作，因此不同接口之间的数据行为保持一致。

## 仓库结构

```text
apps/
  desktop/       Electron 主进程和桌面开发运行时
  server/        Fastify API、SQLite 核心、MCP 服务器和 CLI
  web/            使用 Vite 和 React Flow 构建的 React 工作空间
packages/
  shared/        server 和 web 共用的 TypeScript 类型
docs/
  README.en.md   English README
  superpowers/   开发计划和设计规格
```

## Claude Code 集成

### MCP

可以在 Claude Code 所使用的项目 `.mcp.json` 中添加 Conflux：

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

仓库根目录中的配置默认只启动 `conflux` MCP server。旧项目可以手动把唯一的 key 改为 `muiltchat`；不要在同一配置中同时保留两个 key，否则会启动两份 server。

修改 `.mcp.json` 后必须完全重启 MCP 宿主；刷新网页不会重新建立 stdio 连接。确认使用的是当前仓库路径，避免同一项目同时运行 `conflux` 和 `muiltchat` 两个 server。

MCP 会话可以使用以下工具：

- `publish_context`
- `query_context`
- `ask_session`
- `reply_ask`
- `check_inbox`
- `check_replies`
- `get_graph`

每个会话都会注册到图谱中，并可以参与共享上下文和异步消息。

### Hooks

安装 Claude Code Hooks：

```bash
npx tsx apps/server/src/index.ts hooks install
```

卸载 Hooks：

```bash
npx tsx apps/server/src/index.ts hooks uninstall
```

Hooks 会把会话生命周期事件与会话身份关联起来，并持续更新在线状态。当前支持 `SessionStart`、`UserPromptSubmit` 和 `Stop`，安装前会备份现有的 `settings.json`。

Hooks 还会维护自定义标题、`/resume` 会话继承关系以及未投递消息。Claude Code 使用自定义配置目录时，可以通过 `CLAUDE_CONFIG_DIR` 指定该目录。

## 内置智能体

内置智能体是保存在本地数据库中的模型智能体。可以在 Agents 标签页创建智能体，配置名称、系统提示词、提供商和模型，然后直接在工作空间中与其对话。

支持的提供商环境变量包括：

```bash
ANTHROPIC_API_KEY=your-anthropic-key
OPENAI_API_KEY=your-openai-key
```

设置页面接口会报告哪些提供商已经完成配置：

```text
GET /settings
```

设置环境变量或运行时预设时只使用本地安全配置，不要把真实 API key 提交到 Git、日志或导出文件。仓库可以用 `npm run check:secrets` 检查公开文件。

## 运行时智能体

运行时智能体是用于启动真实 CLI 编程助手的预设。每个预设可以配置：

- 运行时：Claude Code 或 Codex。
- 工作目录。
- 模型。
- API base URL 和 API key。
- 额外环境变量。
- 启动指令。
- 心跳和定时运行间隔。

桌面工作空间可以在新终端窗口中启动运行时智能体；定时预设也可以在后台以无头模式运行。启动器会清理会话范围的环境变量，并在首选终端不可用时使用平台相关的后备方案。

## 数据与配置

默认情况下，Conflux 将 SQLite 数据保存到：

```text
~/.muiltchat
```

当前实现默认使用 `.muiltchat`，以兼容重命名前的版本。目录优先级为 CLI `--data-dir`、`CONFLUX_HOME`、`MUILTCHAT_HOME`、已有项目目录和 `~/.muiltchat`。没有显式迁移命令时不会创建 `~/.conflux`，也不会移动旧目录。数据库文件名为 `data.db`，并启用 SQLite WAL 模式。

Linux、macOS 或 Git Bash：

```bash
MUILTCHAT_HOME=/path/to/conflux-data npm run dev:server
```

Windows PowerShell：

```powershell
$env:MUILTCHAT_HOME = "C:\path\to\conflux-data"
npm run dev:server
```

CLI 也支持 `--scope global` 和 `--scope project`。如果需要精确指定路径，可以直接运行：

```bash
npx tsx apps/server/src/index.ts --data-dir /path/to/conflux-data path
```

显式迁移旧目录时使用 `conflux migrate --from <legacy-dir> --to <conflux-dir>`；查看目标 marker 使用 `conflux migrate --status --to <conflux-dir>`。迁移只复制数据库文件并保留源目录。

备份可读取的数据：

```bash
npx tsx apps/server/src/index.ts data export --output ./conflux-backup.json
```

导入时使用 `data import --file <bundle.json> --conflict skip|overwrite|copy`。导入会先校验格式，再在一个 SQLite 事务中写入，失败时整体回滚。

不需要部署外部数据库服务。

## 开发命令

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

# 运行 CI 等价的测试和发布配置检查
npm run ci:test

# 运行 CI 等价的构建
npm run ci:build

# 检查公开文件中的敏感信息
npm run check:secrets

# 运行 Electron 服务和运行时测试
node --test apps/desktop/test/dev-services.test.cjs apps/desktop/test/runtime-config.test.cjs
```

## HTTP API

本地服务器默认绑定 `127.0.0.1:9527`。开发模式下可以在 `/docs` 查看 OpenAPI 文档和 Swagger UI：<http://127.0.0.1:9527/docs>。

常用资源包括：

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
- `/data/export`
- `/data/import`

需要会话身份的请求应提供 `X-Session-Id` 请求头。HTTP、MCP 和 CLI 接口共享同一套核心数据操作。

启动失败、端口冲突、数据库锁定、MCP 配置或迁移恢复问题，请参阅[故障排查 / Troubleshooting](docs/TROUBLESHOOTING.md)。

## 贡献

欢迎提交 Issue、改进建议和 Pull Request。提交 Pull Request 前，请阅读[贡献指南](CONTRIBUTING.md)并：

1. 保持改动聚焦，并说明面向用户的行为变化。
2. 运行 `npm run build`。
3. 运行 `npm test -w apps/server`。
4. 修改桌面运行时相关代码时，运行 `npm run test:desktop`。
5. 运行 `npm run check:secrets` 和 `git diff --check`。

## 许可证

Conflux 使用 [MIT License](./LICENSE) 发布。
