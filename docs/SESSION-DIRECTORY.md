# 会话列表与 MCP 引用

Conflux 已有 MCP 会话工具。会话目录提供面向用户的入口，列出所有**可见、已登记**的会话，包括 active、stale 和 ended；不会扫描尚未登记的客户端历史聊天。失效的临时占位会话继续遵循现有隐藏规则。

## 安装两个客户端的命令

从已构建的源码运行：

```sh
npm run build
node apps/server/dist/index.js commands install --client all
```

已安装包含此功能的 Conflux CLI 时，也可以运行：

```sh
conflux commands install --client all
```

安装器只创建本技能，不修改 MCP 连接、hooks 或其他客户端设置：

- Codex：`$CODEX_HOME/skills/conflux/SKILL.md`，默认 `~/.codex/skills/conflux/SKILL.md`。
- Claude Code：`$CLAUDE_CONFIG_DIR/skills/conflux/SKILL.md`，默认 `~/.claude/skills/conflux/SKILL.md`。

`--client codex` 或 `--client claude` 可单独安装。重复安装相同内容不改文件；发现不同内容时默认退出，全部目标预检通过才开始写入。显式加 `--force` 才会备份原文件后替换，备份路径会打印出来。

客户端还须连接到更新后的 Conflux MCP 服务。安装技能不会热更新已运行的 MCP 进程；请重连该服务，必要时重启客户端。技能文件随 npm 包和桌面资源分发；旧安装包不会自动获得本功能。

## 使用

| 客户端 | 入口 |
| --- | --- |
| Codex | 桌面版输入 `/` 选择 `conflux`；也可输入 `$conflux list`，CLI/IDE 使用 `/skills` |
| Claude Code（安装技能后） | `/conflux list` |
| Claude Code（MCP 提示词） | `/conflux:list`；兼容形式 `/mcp__conflux__list` |

MCP 提示词可传状态参数，例如 `/mcp__conflux__list active`；省略时显示全部可见状态。技能中的 `list` 默认显示全部可见状态。

目录包含名称、状态、runtime、项目、完整 ID、当前会话标记和资源 URI。同名会话分别显示，发送消息时以完整 ID 定位，不能截断 ID 或只凭同名标题猜测。

Claude Code 支持从 `@` 菜单选择 MCP 资源。若连接名是 `conflux`，引用形如：

```text
@conflux:conflux://sessions/id-<URL-encoded-session-id>
```

直接使用目录工具返回的 URI，避免自行拼接特殊字符。引用只附加会话身份信息，**不会向目标发送消息**；如果要发消息，还需明确说明目标与内容。Codex 的原生 `@` 菜单由客户端控制，本实现不保证它与 Claude Code 一样显示会话资源；仍可通过完整 ID 选择 Conflux 消息工具的目标。

入口遵循各客户端实际支持的格式：服务端不能统一把内置菜单改名为 `/conflux list`。官方参考：[Codex 技能](https://learn.chatgpt.com/docs/build-skills)、[Claude Code MCP 资源和提示词](https://code.claude.com/docs/en/mcp#use-mcp-resources)。

## 协议与验证

终端标题（例如 Ghostty 自动改名）不是会话身份。目标名称、标题或缩写不明确时，助手可调用只读工具 `find_session_candidates`，传入描述及已知的 `project_dir`、`runtime` 提示。完整 ID 精确匹配才直接定位；其他情况返回最多三个候选及匹配原因、项目、运行时、状态、最近活跃时间。低相关结果只是近期备选，不表示找到了原会话。

Conflux 技能要求助手主动打开宿主的选项问答，让用户选候选或补充线索；宿主无该能力时使用编号列表。用户选择前不发送或唤醒，选择后重新确认完整 ID 仍然存在。此交互由 Codex/Claude Code 的助手执行，MCP 服务不能强制宿主显示弹窗。

- `list_session_directory`：默认 all 的只读 MCP 工具，返回 Markdown 目录及结构化 sessions。
- `find_session_candidates`：只读候选查询；不会通过候选分数自动授权发消息，也不会操作 Ghostty 标题。
- MCP prompt `list`：实时读取目录，生成列表提示词。
- `conflux://sessions`：完整目录 JSON 资源。
- `conflux://sessions/id-{sessionId}`：单个可见会话的身份 JSON，不包含消息正文或上下文内容。固定前缀避免 `.`、`..` 等 ID 被当作路径片段。

每次请求读取当前数据库，沿用 MCP 身份认领、租约和审计机制。主动读取目录及现有心跳周期会检查目录变化，变化时发出资源列表更新通知；客户端是否立即刷新仍由宿主决定。命令或资源中的名称和项目路径均作为不可信数据呈现，不当作指令执行。

自动测试覆盖 SDK 发现、过滤、同名/特殊 ID、未知资源、数据刷新和无消息写入，以及真实 stdio 子进程接线。安装器在隔离临时目录验证。协议测试不等于已在两个真实客户端上逐项验收菜单与补全。
