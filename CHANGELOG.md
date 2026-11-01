# 更新日志 / Changelog

所有重要变化都会记录在这里。当前版本线仍在积极开发中。

## [Unreleased]

### Breaking changes / 不兼容变更

- Remove the `muiltchat` CLI bin and all `MUILTCHAT_*` environment variables. Use `conflux` and equivalent `CONFLUX_*` names before upgrading. Internal desktop, Agent and MCP launchers now use the new names. Existing `.muiltchat` data directories remain in place; no data is moved or deleted. The published v0.2.0 artifacts are unchanged.
- 移除 `muiltchat` 命令入口与全部 `MUILTCHAT_*` 环境变量，升级前请改用 `conflux` 和相同后缀的 `CONFLUX_*`。现有数据目录保持原位，旧版 v0.2.0 安装包不受影响。

### Added / 新增（均在 dev，未随 v0.2.0 发布 / all merged into dev only, not in v0.2.0）

- MCP session directory commands, mention resources, and a Conflux skill entry for Codex and Claude Code.
- MCP 会话目录命令、mention 资源引用，以及 Codex / Claude Code 的 Conflux 技能入口。
- Message wake outcomes with manual retry, and managed runtime instance stop/resume; read/reply states stay independent of delivery retries.
- 消息唤醒结果与手动重试、受管运行实例的停止/恢复；已读/回复状态与投递重试相互独立。
- Refined light/dark semantic palettes with existing custom themes preserved.
- 完善浅色/深色语义色板，保留已有自定义主题。
- Server HTTP and SQLite performance baselines with raw samples retained as CI artifacts.
- 服务器 HTTP 与 SQLite 性能基准，原始样本由 CI 保存为产物。

## [0.2.0] - 2026-10-27

### 新增

- 增加 Conflux Electron 桌面客户端开发壳、单实例、托盘、服务生命周期管理和窗口安全边界。
- 支持 Claude Code 与 Codex 的会话身份、进程存活探测、恢复继承和异步协作消息。
- 增加版本化数据导出/导入，支持 `skip`、`overwrite` 和 `copy` 冲突策略，并以事务保证回滚。
- 增加 `conflux` CLI 与 MCP 命名，同时保留 `muiltchat` 兼容入口。
- 增加旧数据目录迁移、状态 marker、SQLite 锁/损坏诊断和仓库敏感信息扫描。
- 增加跨平台 CI、Windows 未签名 NSIS 安装包和未打包目录构建流程。
- 增加会话优先级 P0/P1/P2：低优先级向高优先级发起提问会被拒绝，支持人工豁免。
- 增加 `search_sessions` 能力检索（MCP 工具 + Web 提问入口），按会话自述能力找到目标。
- 增加主题系统：设计令牌 CSS 变量化、深浅色并入色板、设置页自定义主题导入。
- 增加设置页数据管理：会话/消息/上下文分类清除，清除前自动全量备份（滚动保留 5 份），配套 `data counts` / `data clear` CLI。
- `hooks install` 自动补录安装时已在运行的 Claude Code 会话（`hooks backfill` 可单独触发）。
- 节点命名与终端标签对齐：取项目目录名（同目录自动加序号），`/rename` 后同步为自定义名。
- 增加 `conflux channel show / watch` 命令查看与监听对话通道历史。

### 改进

- Web、HTTP、MCP、CLI 和 Electron 继续共享同一套 server core 业务规则。
- 默认数据仍读取 `~/.muiltchat`，迁移不会删除源目录，卸载不会删除用户数据目录。
- 错误响应提供稳定错误码，原始异常只写入服务日志，不写入审计结果或导出文件。

### 兼容性

- 继续支持 `MUILTCHAT_HOME`、旧 MCP key、旧 CLI 名称和已有 SQLite 数据。
- 新项目和文档优先使用 `Conflux`、`CONFLUX_HOME` 和 `conflux` MCP key。

## English

## [0.2.0] - 2026-10-27

### Added

- Electron desktop development shell with single-instance behavior, tray support, service lifecycle management, and a secure window boundary.
- Claude Code and Codex session identity, process liveness detection, resume lineage, and asynchronous collaboration messages.
- Versioned data export/import with `skip`, `overwrite`, and `copy` conflict strategies and transactional rollback.
- The `conflux` CLI and MCP name while retaining the `muiltchat` compatibility entry point.
- Legacy data-directory migration, migration markers, actionable SQLite diagnostics, and repository secret scanning.
- Cross-platform CI plus unsigned Windows NSIS and unpacked directory build workflows.
- Session priority tiers P0/P1/P2: lower-priority sessions asking higher ones are rejected, with manual override.
- `search_sessions` capability search (MCP tool + web ask entry) to find peers by what they do.
- Theming: design tokens as CSS variables, light/dark folded into the palette, custom theme import in settings.
- Settings-page data management: category-scoped clear of sessions/messages/context with automatic full backup (latest 5 kept), plus `data counts` / `data clear` CLI.
- `hooks install` backfills Claude Code sessions already running at install time (`hooks backfill` runs it standalone).
- Node naming aligned with terminal tabs: project directory name (with collision suffix), `/rename` synced as the custom name.
- `conflux channel show / watch` commands to inspect and watch conversation channel history.

### Changed

- Web, HTTP, MCP, CLI, and Electron continue to share the server core business rules.
- The default data directory remains `~/.muiltchat`; migration preserves the source and uninstall leaves user data in place.
- HTTP errors expose stable codes while raw exceptions stay in server logs and out of audit results and exports.

### Compatibility

- `MUILTCHAT_HOME`, the legacy MCP key, the legacy CLI name, and existing SQLite data remain supported.
- New projects and documentation prefer `Conflux`, `CONFLUX_HOME`, and the `conflux` MCP key.
