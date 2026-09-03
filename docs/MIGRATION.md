# 迁移指南 / Migration Guide

Conflux 以兼容方式接收旧版 `muiltchat` 数据。普通启动不会删除、移动或覆盖旧数据；迁移必须显式执行。

## 中文

### 兼容关系

| 旧配置 | 新推荐配置 | 行为 |
| --- | --- | --- |
| CLI `muiltchat` | CLI `conflux` | 两个入口调用同一套命令树，旧入口继续可用。 |
| MCP key `muiltchat` | MCP key `conflux` | 旧 key 可以继续使用，但同一 `.mcp.json` 只保留一个 key。 |
| `MUILTCHAT_HOME` | `CONFLUX_HOME` | 新变量优先；未设置时继续读取旧变量。 |
| `~/.muiltchat` | 显式目标目录 | 默认仍读取旧目录，不会自动创建 `~/.conflux`。 |
| npm package `muiltchat` | 公开项目名 `Conflux` | 内部 package 和兼容 bin 暂不强制重命名。 |

目录解析优先级为：CLI `--data-dir`、`CONFLUX_HOME`、`MUILTCHAT_HOME`、已有项目目录 `.muiltchat`，最后是全局 `~/.muiltchat`。

### 只读检查当前目录

```powershell
npx tsx apps/server/src/index.ts path
```

### 显式迁移

先停止 Electron、server 和 MCP 宿主，再执行：

```powershell
npx tsx apps/server/src/index.ts migrate `
  --from "$env:USERPROFILE\.muiltchat" `
  --to "$env:USERPROFILE\.conflux"
```

检查 marker：

```powershell
npx tsx apps/server/src/index.ts migrate `
  --status `
  --to "$env:USERPROFILE\.conflux"
```

成功后，目标目录包含 `.conflux-migration.json`，其中记录版本、源目录、目标目录、复制时间和 `source_preserved: true`。源目录始终保留。目标已有同名文件时命令返回冲突，不会覆盖文件；中途失败会清理本次创建的临时目录。

### 备份、导出和恢复

迁移前建议完整复制旧目录，包含 `data.db`、`data.db-wal`、`data.db-shm` 和配置文件。服务可正常启动时，也可以生成不含 API key 的 bundle：

```powershell
npx tsx apps/server/src/index.ts data export `
  --output .\conflux-backup.json
```

导入到新的数据目录：

```powershell
npx tsx apps/server/src/index.ts `
  --data-dir "$env:USERPROFILE\.conflux-recovered" `
  data import `
  --file .\conflux-backup.json `
  --conflict copy
```

导入会先验证 bundle 格式，再在一个 SQLite 事务中写入。失败时整体回滚。`skip` 保留本地记录，`overwrite` 使用 bundle 记录覆盖冲突项，`copy` 创建副本并重建内部外键。

### MCP 迁移后的重启

如果修改了 `.mcp.json` 的 server key 或路径，必须完全重启 MCP 宿主。刷新 Conflux 页面不会重建 stdio 连接。不要同时保留 `conflux` 和 `muiltchat` 两个 key，否则会启动两份 server 并产生重复会话。

## English

Conflux reads legacy `muiltchat` data without destructive changes. A normal startup does not move, delete, or overwrite the old directory. Migration is explicit and reversible.

| Legacy | Recommended | Behavior |
| --- | --- | --- |
| CLI `muiltchat` | CLI `conflux` | Both names use the same command tree. |
| MCP key `muiltchat` | MCP key `conflux` | Keep exactly one key in a project `.mcp.json`. |
| `MUILTCHAT_HOME` | `CONFLUX_HOME` | The new variable takes precedence; the old one remains supported. |
| `~/.muiltchat` | An explicit destination | The legacy default remains active; `~/.conflux` is not created automatically. |
| npm package `muiltchat` | Public project name `Conflux` | Compatibility package and bin names remain available. |

The data-directory precedence is `--data-dir`, `CONFLUX_HOME`, `MUILTCHAT_HOME`, an existing project `.muiltchat`, and finally `~/.muiltchat`.

Stop Electron, the server, and the MCP host before running the explicit migration commands shown above. Migration copies `data.db` and its SQLite sidecars, writes `.conflux-migration.json`, preserves the source, refuses destination conflicts, and cleans its temporary staging directory after a failure.

Before migrating, make a complete copy of the source directory. A running service can create a secret-free bundle with `data export`; import it into a new directory with `data import --file ... --conflict copy`. Bundle validation happens before one SQLite transaction, so a failed import rolls back as a whole.

Restart the MCP host completely after changing `.mcp.json`. Reloading the web page does not recreate a stdio connection, and keeping both MCP keys creates duplicate servers and sessions.
