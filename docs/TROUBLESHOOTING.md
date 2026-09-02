# 故障排查 / Troubleshooting

本文按“现象 → 检查 → 处理”记录常见问题。Conflux 默认只绑定本机回环地址，不会把本地 API 暴露到局域网。

## 中文

### 页面打不开

先确认使用的是与启动命令匹配的地址：

| 启动方式 | 工作空间 | API 健康检查 |
| --- | --- | --- |
| `npm run dev:desktop` | Electron 窗口 | `http://127.0.0.1:9527/healthz` |
| `npm run dev:all` | `http://127.0.0.1:5173/` | `http://127.0.0.1:9527/healthz` |
| `npm start` | `http://127.0.0.1:9527/` | `http://127.0.0.1:9527/healthz` |

浏览器开发模式下，`5173` 是 Vite 页面端口，`9527` 是 API 端口。看到 `VITE ready` 只说明 Vite 已启动；看到 `http server listening` 只说明 API 已监听。可以分别检查：

```powershell
(Invoke-WebRequest http://127.0.0.1:5173/ -UseBasicParsing).StatusCode
(Invoke-WebRequest http://127.0.0.1:9527/healthz -UseBasicParsing).Content
```

预期第二条返回包含 `{"ok":true}`。如果 `localhost` 无法打开，优先使用 `127.0.0.1`，避免本机 IPv4/IPv6 解析差异。

不要同时运行 `npm run dev:desktop` 和 `npm run dev:all`，它们会竞争 `5173`、`9527` 和同一个 SQLite 数据目录。停止当前开发命令后再切换入口。

### Electron 桌面壳状态与 MCP 会话在线

Electron 桌面壳使用 Main 与 Renderer 之间的私有 ping/pong 检查 UI 是否响应：

| 状态 | 含义 |
| --- | --- |
| `responsive` | 最近一次 ping 在超时窗口内收到合法 pong，Renderer 正常响应。 |
| `unknown` | 暂时没有收到 pong，或 Electron 报告 Renderer 无响应；不等同于崩溃。 |
| `crashed` | Electron 明确报告 Renderer 进程已退出，桌面实例会提示并退出。 |

这组状态只描述 Electron 桌面壳，不写入会话数据库，也不改变 Agent 会话状态。桌面实例启动的 server/web 服务还会独立进行 HTTP 健康检查；连续两次失败会结束桌面实例，但不会回收 MCP 会话。

MCP 会话显示为 `connected` 或“在线”，才表示 MCP stdio 连接仍在通过 lease 续租。PID 探测、终端窗口可见性和窗口聚焦只用于辅助查找进程与 Resume，不能作为 Agent 会话存活的依据。遇到状态不一致时，先分别检查 Electron 日志、本地服务健康端点和 MCP 宿主连接。

### 端口已被占用

启动失败时如果看到 `PORT_IN_USE`，先查看占用者：

```powershell
Get-NetTCPConnection -LocalPort 5173,9527 -State Listen -ErrorAction SilentlyContinue |
  Select-Object LocalAddress,LocalPort,OwningProcess
Get-Process -Id <PID>
```

如果占用者是本次启动遗留的 Conflux/Electron 进程，关闭它后重试。不要在没有确认进程归属时结束进程，也不要连接一个未知服务；Conflux 会拒绝接管非本应用的监听端口。

### 数据库被锁定

`DATA_LOCKED` / `SQLITE_BUSY` / `SQLITE_LOCKED` 通常表示另一个 Conflux、旧的 `muiltchat` 服务或备份程序正在使用数据库。关闭重复实例，等待文件操作结束后重试。不要删除 `data.db-wal` 或 `data.db-shm`，它们可能包含尚未合并的数据。

默认数据目录是：

```text
Windows: %USERPROFILE%\.muiltchat
macOS/Linux: ~/.muiltchat
```

检查当前目录：

```powershell
npx tsx apps/server/src/index.ts path
```

### 数据库损坏

`DATA_CORRUPT` 表示 SQLite 报告数据库损坏或不是有效数据库。先停止所有 Conflux 进程，再完整备份数据目录，包括 `data.db`、`data.db-wal`、`data.db-shm` 和配置文件。不要覆盖原目录。

如果服务仍能启动，先导出可读取的数据：

```powershell
npx tsx apps/server/src/index.ts data export --output .\conflux-backup.json
```

恢复时使用一份新的数据目录和事务导入：

```powershell
npx tsx apps/server/src/index.ts --data-dir .\conflux-recovered data import --file .\conflux-backup.json --conflict copy
```

导入失败会回滚当前事务。原目录和迁移源目录始终保留，确认恢复结果后再处理备份。

### MCP 中看不到当前会话

检查项目 `.mcp.json` 中是否只有一个 Conflux server。新配置使用 `conflux` key；旧项目可以继续使用 `muiltchat` key，但不要同时保留两个 key，否则会启动两份 MCP server，产生重复会话。

```json
{
  "mcpServers": {
    "conflux": {
      "command": "npx",
      "args": ["tsx", "<repo>/apps/server/src/index.ts", "mcp"]
    }
  }
}
```

修改配置后必须完全退出并重新启动 MCP 宿主（例如 Claude Code 或其他客户端），仅刷新网页不会重新建立 stdio 连接。确认使用的是当前仓库路径，并检查宿主的 stderr 日志；MCP 的 stdout 只应包含 JSON-RPC 数据。

Conflux 中 MCP 会话显示为“在线”，表示对应的 MCP stdio 连接仍在续租租约；这不代表终端窗口当前可见或处于焦点，也不代表 Codex 或 Claude CLI 进程仍然存在。反过来，即使 Codex 或 Claude CLI 进程仍存在，也不能单独证明当前会话仍连接。关闭终端窗口后，如果 UI 短时间内仍显示“在线”，等待下一次服务 `liveness` 扫描。正常 `stdin` 断开仍会立即回收会话；强制结束宿主或 CLI 进程、以及断电时，服务无法收到正常断开信号，会在租约 TTL（Time to Live）内回收会话。

手动验证功能分支前，先关闭主工作树遗留的旧 server 和 MCP 宿主/连接，再启动当前工作树。否则 `dist/` 文件或 SQLite 数据库可能来自错误工作树，导致验证结果反映了错误的代码或数据。

### Provider 或 API key 未配置

内部智能体需要在启动服务前设置对应环境变量：

```powershell
$env:OPENAI_API_KEY = "<your-openai-key>"
# 或：$env:ANTHROPIC_API_KEY = "<your-anthropic-key>"
npm run dev:server
```

设置页和 `/settings` 只报告是否已配置，不会回显完整 key。不要把真实 key 写入仓库、Issue、日志或导出文件。

### 迁移旧版 muiltchat 数据

Conflux 默认继续读取 `~/.muiltchat`，不会在普通启动时自动移动或删除旧目录。需要新目录时，先停止服务，再显式执行：

```powershell
npx tsx apps/server/src/index.ts migrate --from "$env:USERPROFILE\.muiltchat" --to "$env:USERPROFILE\.conflux"
npx tsx apps/server/src/index.ts migrate --status --to "$env:USERPROFILE\.conflux"
```

迁移只复制文件，源目录保持不变；成功后目标目录会写入 `.conflux-migration.json`。目标有冲突时命令会停止，不会覆盖现有文件。

## English

### The page does not open

Use the endpoint that matches the command you started:

| Mode | Workspace | API health check |
| --- | --- | --- |
| `npm run dev:desktop` | Electron window | `http://127.0.0.1:9527/healthz` |
| `npm run dev:all` | `http://127.0.0.1:5173/` | `http://127.0.0.1:9527/healthz` |
| `npm start` | `http://127.0.0.1:9527/` | `http://127.0.0.1:9527/healthz` |

In browser development mode, `5173` serves Vite and `9527` serves the API. `VITE ready` confirms only the Vite process; `http server listening` confirms only the API. Check both endpoints with the PowerShell commands above. Prefer `127.0.0.1` when `localhost` resolves unexpectedly.

Do not run `npm run dev:desktop` and `npm run dev:all` at the same time. They share ports and the SQLite data directory.

### Electron shell health and MCP session liveness

The Electron shell uses a private Main-to-Renderer ping/pong check to determine whether the UI responds:

| State | Meaning |
| --- | --- |
| `responsive` | A valid pong arrived within the timeout window; the Renderer responds normally. |
| `unknown` | No pong arrived temporarily, or Electron reported an unresponsive Renderer; this is not a crash. |
| `crashed` | Electron explicitly reported that the Renderer process exited; the desktop instance shows an error and quits. |

These states describe only the Electron shell. They are not written to the session database and do not change Agent session state. The server/web processes owned by the desktop instance also have independent HTTP health checks; two consecutive failures end the desktop instance without reclaiming an MCP session.

An MCP session is live only while the MCP stdio connection is shown as `connected` or `online` and continues renewing its lease. PID detection, terminal visibility, and window focus are only helpers for locating a process and handling Resume; they are not proof that an Agent session is alive. When states disagree, check the Electron log, the local service health endpoints, and the MCP host connection separately.

### A port is already in use

For `PORT_IN_USE`, inspect the listener with the PowerShell commands above. Stop the process only after confirming that it belongs to the current Conflux/Electron run. Conflux does not attach to an unknown service on `5173` or `9527`.

### The database is locked or corrupt

`DATA_LOCKED`, `SQLITE_BUSY`, or `SQLITE_LOCKED` usually means that another Conflux/muiltchat process or a backup tool has the database open. Close the duplicate process and retry. Keep `data.db-wal` and `data.db-shm` alongside `data.db`.

For `DATA_CORRUPT`, stop Conflux, make a complete copy of the data directory, and never overwrite the original. If the service can still start, export readable data and import it into a new directory using `--conflict copy`. Failed imports roll back as one transaction.

The default data directory is `%USERPROFILE%\.muiltchat` on Windows and `~/.muiltchat` on macOS/Linux. `npx tsx apps/server/src/index.ts path` prints the active directory.

### The current MCP session is missing

Keep exactly one Conflux server entry in the project `.mcp.json`. New projects should use the `conflux` key; older projects may keep the single `muiltchat` key. Fully exit and restart the MCP host after changing the file. Reloading the web page does not recreate a stdio connection.

When Conflux shows an MCP session as `online`, the MCP stdio connection is still renewing its lease. This does not mean that the terminal window is visible or focused, and it does not mean that the Codex or Claude CLI process still exists. Conversely, an existing Codex or Claude CLI process alone does not prove that the current session is still connected. If the UI still shows `online` briefly after the terminal window closes, wait for the next service `liveness` scan. A normal `stdin` disconnect still reclaims the session immediately; forced termination of the host or CLI process, or a power loss, cannot send a normal disconnect, so the session is reclaimed within the lease TTL.

Before manually verifying a feature branch, stop the old server and MCP host/connection from the main worktree, then start the current worktree. Otherwise the `dist/` files or SQLite database may come from the wrong worktree, so the verification may reflect the wrong code or data.

### Provider keys and migration

Set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` before starting the server. The UI and `/settings` expose configuration state only. Never commit real keys or put them in logs or export files.

Conflux keeps reading `~/.muiltchat` by default. Explicit migration is reversible: it copies the source, preserves the source directory, and writes `.conflux-migration.json` in the destination. Existing destination files are never overwritten.

## 诊断信息 / Diagnostic information

When reporting an issue, include the command, platform, Node.js version, the endpoint used, and the stable error code. Redact API keys, bearer tokens, private keys, database contents, and personal paths before sharing logs.

报告问题时，请附上启动命令、操作系统、Node.js 版本、访问的地址和稳定错误码；分享日志前请删除 API key、Bearer token、私钥、数据库内容和个人路径。
