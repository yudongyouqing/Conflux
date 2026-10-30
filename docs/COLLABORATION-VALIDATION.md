# 协作控制与主题验证记录

日期：2026-10-30；Windows 本机，基于 dev `8085e4d` 的本批源码。说明见[设计](superpowers/specs/2026-10-30-collaboration-controls-design.md)和[使用指南](COLLABORATION-CONTROLS.md)。

| 验证 | 结果 |
| --- | --- |
| `npm test -w apps/server` | 311 项通过，0 失败；含 HTTP、实际 CLI 命令树、stdio MCP、schema 13 升级、旧 v8 身份迁移。 |
| `npm test -w apps/web` | 61 项通过，0 失败；含重试/实例控件、缓存刷新、主题恢复、状态语义和默认色板对比度。 |
| `npm run test:desktop` | 58 项通过，0 失败；模块/接线验证。 |
| `node --test scripts/performance/*.test.cjs` | 9 项通过，0 失败；使用本批已构建 server。 |
| `node --test scripts/release-config.test.cjs` | 3 项通过，0 失败。 |
| `npm run build` | 成功；保留已有 Vite 插件弃用、包体积和重复静态/动态导入提示。 |
| `npm run lint` | 0 错误，7 个已有未使用变量警告；所新增实例实现无警告。 |
| `npm run check:tokens`、`npm run check:secrets` | 通过。 |
| `npm run test:e2e:web` | 通过；1440×900 与 390×844，浅/深色设置和图谱、刷新后主题保留、原消息重试、实例列表/禁用停止及窄屏导航。 |

回归覆盖重试权限、原地更新、读状态/claim 竞态、有效 claim 互斥和过期恢复；覆盖 PID 复用、归属变化、停止信号延迟、同对话重复恢复、失联及注册超时实例的恢复占位、预设配置变化和密钥不泄露。进程操作使用注入适配器，不启动或结束用户真实 CLI。

另外在本机通过实际 Node 子进程验证源码 `--import` loader 的 file URL；实际 `cmd.exe` 与 `powershell.exe` 参数探针验证百分号、双引号、感叹号、管道、尖帽号及带空格/尾反斜杠的值逐字保留。探针仅输出人工测试参数，没有调用真实模型。

独立复核发现的首次发送竞态、tmux 目标变化、Codex thread 绑定、恢复占位及延迟停止问题均补了回归。浏览器运行还发现并修复新实例接口的 Vite 代理遗漏，以及控制台 inbox 请求漏身份 header。

初轮完整 server 为 305/306：旧迁移测试仍断言 schema 13，本批升级至 14 后该断言不再适用；更新预期后聚焦迁移 17/17，最终完整 311/311。开发中浏览器曾读到主题组件尚未写完的导出；文件稳定后重新执行完整流程通过。没有将中途失败记作通过。

首次远端 Web job 在全新检出中未构建 shared，运行时导入因此失败；本地已有构建产物，未暴露此依赖。已将 shared 构建纳入 Web 的 `pretest` 生命周期，独立执行 `npm test -w apps/web` 会先构建依赖，再跑 61 项测试；不依赖其他 CI job 或本机构建缓存。

截图见[使用指南](COLLABORATION-CONTROLS.md)中的链接。注册中和失败实例由隔离 fixture 创建，自动唤醒关闭；不据此声称完成真实 Codex/Claude Code 启动、停止、恢复、宿主选项问答或 Electron 安装验收。原生外观、各平台实际终端与安装/更新仍在[项目待办](PROJECT-TODO.md)中。
