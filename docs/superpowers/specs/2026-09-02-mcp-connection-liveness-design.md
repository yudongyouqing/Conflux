# MCP 连接租约探活设计

**日期：** 2026-09-02

**状态：** 方向已确认，待书面规格审查

**范围：** Codex/Claude 的 MCP 会话存活判定

## 1. 问题与目标

当前实现把 `runtime_pid` 存在于操作系统进程列表中当作会话在线，并由 HTTP 服务每 30 秒刷新 `active`。这只能证明 CLI 进程存在，不能证明：

- 当前 MCP stdio 连接仍然属于这个会话；
- MCP 宿主仍在接收输入；
- 旧的、孤立的 MCP 子进程没有继续运行；
- 同一个逻辑会话没有被新的连接接管。

本次改动的目标是：

1. 对 MCP 会话，以 MCP 连接租约作为在线主判据。
2. 正常断开或 stdin 关闭时立即将会话标记为 `stale`。
3. 异常退出没有关闭事件时，使用短租约 TTL 回收会话。
4. PID 只用于运行时身份关联、辅助诊断和没有 MCP 租约的旧会话兼容逻辑。
5. 保留 Claude Hooks、HTTP、CLI、Codex MCP 和已有数据库的兼容行为。

这里的“在线”定义为“Conflux MCP 连接仍然可用”，不是 Windows 终端窗口是否可见、是否获得焦点或是否处于某个标签页。操作系统没有为终端标签页提供稳定、跨平台的 Codex 会话身份；把 MCP 连接作为边界可以得到可验证的语义。

## 2. 非目标

- 不实现 Windows 窗口句柄、终端标签页或前台窗口探测。
- 不把 Codex transcript 文件活动时间当作在线证明。
- 不改变 MCP 工具协议、HTTP 路径或现有消息语义。
- 不要求 Codex 提供尚不存在的 SessionStart/SessionStop Hook。
- 不迁移用户数据目录，也不删除旧会话。

## 3. 方案概览

### 3.1 连接租约

每次 `runMcpServer()` 启动时生成一个随机 `connection_id`。该连接将以下信息写入当前临时会话或之后接管的逻辑会话 metadata：

```text
mcp_connection_id
mcp_connected_at
mcp_last_heartbeat_at
mcp_connection_state: connected | disconnected
```

MCP 进程启动、每次工具调用和周期性心跳都会刷新租约。租约 token 用来防止旧连接关闭时误杀已经被新连接接管的同一个逻辑会话。

当前仍使用已有 `sessions` 表和 metadata，不新增独立连接表：本阶段每个 MCP 进程只对应一个当前逻辑会话，metadata 足以承载连接代际信息，同时避免扩大数据库迁移范围。后续若需要一个逻辑会话同时支持多个 MCP 客户端，再抽取 `session_connections` 表。

### 3.2 连接断开

MCP 传输层在 `server.connect(transport)` 之前注册 `transport.onclose`，让 MCP SDK 在连接关闭时仍能调用 Conflux 的清理逻辑。由于当前 `StdioServerTransport` 不主动监听 stdin 的 EOF，还要为 `process.stdin` 注册 `end` 和 `close` 监听：

1. stdin 结束时调用 `transport.close()`；
2. `onclose` 只执行一次；
3. 清除心跳定时器和 stdin 监听；
4. 仅当数据库中的 `mcp_connection_id` 仍等于当前 token 时，将当前会话标记为 `stale`，写入断开时间和原因；
5. 不把已经被新 MCP 连接接管的会话标记为 stale；
6. 关闭数据库句柄，使 MCP 子进程能够自然退出。

数据库更新使用“读取 metadata 后带原值条件更新”的方式，避免旧连接的关闭回调覆盖新连接刚写入的 token。已结束会话不会被重新改成 stale。

### 3.3 异常退出与租约过期

HTTP 服务增加 MCP 租约过期扫描。推荐参数如下：

- MCP 心跳间隔：15 秒；
- MCP 租约 TTL：90 秒；
- HTTP 回收扫描：30 秒。

如果进程被强制结束、机器断电或 stdin 事件未到达，超过 TTL 且没有新的 `mcp_last_heartbeat_at` 的会话被标记为 `stale`。一次 PowerShell/`ps` 探测失败不会回收 MCP 租约。

### 3.4 PID 探测边界

`reconcileRuntimeLiveness()` 调整为：

- 有新式 MCP 租约的会话：PID 探测不得刷新其 heartbeat，也不得因为 PID 不在快照中直接标记 stale；连接断开和租约过期负责其生命周期。
- 没有 MCP 租约的 Claude Hook 会话：保留当前 PID 探测行为，继续支持 idle 但窗口仍在的 Claude 会话。
- 没有 MCP 租约的旧 Codex/临时会话：继续走现有兼容路径（PID reconcile 与 TTL fallback），首次重新连接后自动获得新租约。
- PID 仍用于 MCP 启动时定位 Codex/Claude 祖先进程、`/resume` adoption 和诊断，不再是 MCP 在线状态的正向证明。

这样可以避免“Codex 进程还在，所以断开的 MCP 会话仍在线”的误报，也避免“命令行扫描暂时识别不到 Codex，所以连接正常的会话被误杀”的误报。

## 4. 会话生命周期与数据流

### 4.1 启动与 adoption

```text
MCP 启动
  -> 生成 connection_id
  -> 注册临时会话 + 写入租约
  -> 通过显式 session / runtime pin / runtime PID 尝试 adoption
  -> adoption 成功后把同一个 connection_id 写入目标逻辑会话
  -> MCP 工具调用和周期心跳刷新目标会话租约
```

`tryAdopt()` 继续保留当前优先级：显式 `MUILTCHAT_ASSUME_SESSION`、运行时 current pin、运行时 PID。adoption 只改变当前 `sessionId`，不会生成新的逻辑会话或新的连接 token。

### 4.2 正常关闭与重连

```text
stdin end/close 或 transport onclose
  -> 按 token 条件标记当前 lease disconnected
  -> active 会话变为 stale

新 MCP 连接启动
  -> 生成新 token
  -> 接管同一逻辑会话
  -> 旧连接稍后触发 close
  -> token 不匹配，旧 close 不得覆盖新连接状态
```

### 4.3 UI 与 API

第一阶段继续使用现有 `active/stale/ended` 状态，避免破坏客户端和 API 类型。服务端将 active 的 MCP 会话严格限定为新租约仍有效的会话；`runtime_pid` 继续作为身份字段返回，但不再暗示在线证明。

在会话详情和诊断数据中保留以下可解释信息：

- `runtime`：Claude 或 Codex；
- `runtime_pid`：最近关联的运行时 PID；
- `mcp_connection_state`：连接状态；
- `mcp_last_heartbeat_at`：连接最后续租时间。

现有没有租约的会话不显示伪造的 MCP 连接状态，避免把旧数据误解释为新模型。

## 5. 错误处理

- SQLite 暂时锁定：沿用当前 best-effort 处理，下一次心跳或扫描重试，不立即改变状态。
- MCP transport 报错但尚未关闭：记录 stderr 日志，保留当前租约直到 close 或 TTL 过期。
- `metadata` 损坏或缺少 token：跳过租约专用处理，交给现有兼容 TTL；不能因 JSON 解析失败删除会话。
- 新连接接管期间旧连接关闭：使用 token 条件更新，旧关闭回调返回未更新，不影响新连接。
- HTTP 进程探测失败：不修改 MCP 租约状态；非 MCP 旧会话继续使用现有 TTL。
- MCP 启动后尚未完成 adoption：临时节点仍有自己的租约；成功 adoption 后旧临时节点按现有无引用清理逻辑处理。

## 6. 测试策略

### 6.1 Core 单元测试

在实现前先增加失败测试，至少覆盖：

1. 新 MCP 连接生成并持续刷新自己的 token 和 heartbeat。
2. 有效 MCP 租约的会话不会被活跃 PID 快照额外刷新。
3. 有效 MCP 租约的会话不会因为 PID 快照缺失立即变成 stale。
4. 租约过期后会话变成 stale，并记录 disconnected 状态。
5. 旧连接关闭时，如果 token 已被新连接替换，不会回收新连接。
6. 已结束会话不会被 close 或 TTL 扫描重新激活。
7. 没有 MCP 租约的旧 Claude 会话仍保留现有 PID reconcile 行为。

### 6.2 MCP 生命周期测试

使用可控的 fake stdin/transport 验证：

- stdin `end` 或 `close` 会触发一次清理；
- transport `onclose` 与 stdin 事件重复触发时不会重复写入或抛错；
- 清理后心跳定时器停止，数据库句柄关闭；
- MCP SDK 连接前注册的 `onclose` 不破坏 SDK 自己的 close 回调。

### 6.3 回归验证

实现后执行：

```text
npm test -w apps/server
npm run build -w apps/server
npm run ci:test
npm run ci:build
```

手动验收前必须停止主工作树中的旧 server/MCP 进程，并从 `feature/conflux-productization` 启动；否则运行中的 `apps/server/dist/index.js` 仍可能来自旧工作树，无法验证本分支行为。

## 7. 兼容与发布策略

- 不新增必需环境变量。
- 不改变默认数据目录 `~/.muiltchat`。
- metadata 兼容旧 JSON；旧行没有租约字段时保持旧行为。
- 新版本首次连接时逐步写入租约字段，不需要一次性回填历史会话。
- 不在本次提交中加入窗口句柄探测或桌面端专用逻辑。

## 8. 验收标准

1. Codex MCP 正常连接且处于 idle 时，会话保持 `active`，不依赖 Codex 进程扫描是否在某次快照中出现。
2. Codex 终端关闭导致 stdin 断开后，会话在一次 close 处理内变为 `stale`，不等待两分钟 TTL。
3. 强制杀掉 MCP 进程且没有 close 事件时，会话最多在 90 秒租约 TTL 加一次扫描周期内变为 `stale`。
4. 仅保留 Codex 进程、但 MCP 连接已经断开的场景不会继续被 PID 探测刷新为 active。
5. 重连接管同一会话时，旧连接的延迟 close 不会杀掉新连接状态。
6. Claude Hook 和没有租约的旧会话回归测试保持通过。
7. 运行验证使用的是当前功能分支，而不是主工作树的旧构建产物。
