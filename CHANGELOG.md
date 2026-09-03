# 更新日志 / Changelog

所有重要变化都会记录在这里。当前版本线仍在积极开发中。

## [0.2.0] - Unreleased

### 新增

- 增加 Conflux Electron 桌面客户端开发壳、单实例、托盘、服务生命周期管理和窗口安全边界。
- 支持 Claude Code 与 Codex 的会话身份、进程存活探测、恢复继承和异步协作消息。
- 增加版本化数据导出/导入，支持 `skip`、`overwrite` 和 `copy` 冲突策略，并以事务保证回滚。
- 增加 `conflux` CLI 与 MCP 命名，同时保留 `muiltchat` 兼容入口。
- 增加旧数据目录迁移、状态 marker、SQLite 锁/损坏诊断和仓库敏感信息扫描。
- 增加跨平台 CI、Windows 未签名 NSIS 安装包和未打包目录构建流程。

### 改进

- Web、HTTP、MCP、CLI 和 Electron 继续共享同一套 server core 业务规则。
- 默认数据仍读取 `~/.muiltchat`，迁移不会删除源目录，卸载不会删除用户数据目录。
- 错误响应提供稳定错误码，原始异常只写入服务日志，不写入审计结果或导出文件。

### 兼容性

- 继续支持 `MUILTCHAT_HOME`、旧 MCP key、旧 CLI 名称和已有 SQLite 数据。
- 新项目和文档优先使用 `Conflux`、`CONFLUX_HOME` 和 `conflux` MCP key。

## English

## [0.2.0] - Unreleased

### Added

- Electron desktop development shell with single-instance behavior, tray support, service lifecycle management, and a secure window boundary.
- Claude Code and Codex session identity, process liveness detection, resume lineage, and asynchronous collaboration messages.
- Versioned data export/import with `skip`, `overwrite`, and `copy` conflict strategies and transactional rollback.
- The `conflux` CLI and MCP name while retaining the `muiltchat` compatibility entry point.
- Legacy data-directory migration, migration markers, actionable SQLite diagnostics, and repository secret scanning.
- Cross-platform CI plus unsigned Windows NSIS and unpacked directory build workflows.

### Changed

- Web, HTTP, MCP, CLI, and Electron continue to share the server core business rules.
- The default data directory remains `~/.muiltchat`; migration preserves the source and uninstall leaves user data in place.
- HTTP errors expose stable codes while raw exceptions stay in server logs and out of audit results and exports.

### Compatibility

- `MUILTCHAT_HOME`, the legacy MCP key, the legacy CLI name, and existing SQLite data remain supported.
- New projects and documentation prefer `Conflux`, `CONFLUX_HOME`, and the `conflux` MCP key.
