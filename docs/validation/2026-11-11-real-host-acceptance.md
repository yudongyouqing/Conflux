# 真实宿主分库验收记录（2026-11-10—11）

追踪：[真实宿主验收 #288](https://github.com/yudongyouqing/Conflux/issues/288)。本轮发现并修复的 hook 目录选择缺陷：[issue #316](https://github.com/yudongyouqing/Conflux/issues/316)。

**结论：** Windows 上的真实 Claude Code 房间唤醒/resume/写回，以及真实 Codex CLI 邮件唤醒/房间写回/原消息回复均取得成功证据。验收过程中发现 `hooks dispatch` 忽略显式数据目录，成功闭环基于包含该修复的源码候选；本记录不表示 #288 全矩阵或桌面安装验收完成。

机器可核对的记录见 [real-host-evidence.json](2026-11-11-real-host-evidence.json)。

## 环境和版本边界

| 项目 | 实际使用 |
| --- | --- |
| 基线 | dev `d9b5dfb82c47e41e11d2595ae0d7601772b7fc8e` |
| 修复候选 | `ed55d68bc70e49e7a6a524428e7551655510b4cb`；记录采集时尚未合入 dev |
| Claude 宿主 | Claude Code 2.1.278；用户既有 provider 路由实际返回 `glm-5.3[1m]` |
| Codex 宿主 | Codex CLI 0.164.0；私有配置使用用户原有的 `gpt-6.1-sol` 配置 |
| 数据与宿主目录 | 全新临时 A/B 库、工作目录、CLAUDE_CONFIG_DIR 和 CODEX_HOME |
| 构建 | 重新构建 shared/server/web；JSON 记录关键 dist 文件 SHA-256 |

使用的是厂商真实 CLI，不是 CLI 形态测试替身。房间、库标记和控制台发起者是验收 fixture，不据此声称存在其他真实用户会话。

## 隔离方法

1. A 是编排库，B 是单独创建的错误默认库；两个库各有唯一标记，B 不含待完成任务。
2. MCP 挂载 argv 明确使用 `--data-dir A`。Claude 项目配置和 Codex 私有用户配置中的默认 Conflux 挂载故意指向 B，覆盖参数必须把真实执行者带回 A。
3. 宿主使用私有配置目录；空配置时两个客户端都未认证，随后仅在私有目录复用本机登录凭据。仅修改 HOME 不足以隔离当前 Windows Codex，因此显式设置 CODEX_HOME。
4. 私有 Claude hooks 的命令显式包含 `--data-dir A`；没有安装或覆盖用户日常 hooks。已连接的日常 Conflux MCP 和真实用户库不用于本轮验收。
5. Codex 生产唤醒使用一个临时 `.cmd` 适配器恢复私有 CODEX_HOME，然后转发给真实原生 Codex 二进制；适配器不模拟模型或 MCP。真实 CLI 发出的 thread ID 被显式绑定到测试会话，**不据此宣称自动 rollout/thread 绑定已验收**。
6. 测试库直接核对真实任务、消息和 MCP 审计记录。B 的记录在各闭环期间不变；仅以文件大小或 mtime 不变不能得出相同结论。

## 已完成的真实闭环

### Claude Code：hooks、空闲心跳、关闭后 resume、房间写回

- 真实 CLI 会话 `0432df85-ce2d-4be5-99b3-5265f12e943e` 在测试 hooks 与 MCP 中使用相同 ID；真实 transcript 存在于私有 Claude 目录。
- 宿主空闲时，MCP 心跳从 `2026-11-10T07:07:24.937Z` 更新到 `2026-11-10T07:07:39.940Z`。
- 关闭原 CLI 后，通过隔离 HTTP server 的房间 summon 路由调用生产唤醒逻辑，真实 Claude resume 原会话。
- 房间 2、任务 2 被真实 MCP `room_write` 完成，结果为 `HOST288_ROOM_WRITE_fb3dc1a2-63e1-4ec7-bf30-47b59040643a`。
- 审计中的调用方与原会话 ID 一致；该任务恰好一条 `room_write` 审计。唤醒进程 38312 已退出，B 没有测试任务、消息或新会话。

### Codex CLI：真实 MCP、生产邮件唤醒、原消息重试

- 真实 Codex 首先通过 MCP 注册 `8dba5574-ff2f-442d-bf2f-797afecec8db`，目录能看到 A 的标记，不能看到 B 的标记。
- 初次生产唤醒遇到真实账号 usage limit，保留为未完成；没有购买额度或用 fixture 代替模型。
- 额度可用后，对原消息 1 执行生产重试路径；真实 CLI 完成任务 1 的 `room_write`，再通过 `reply_ask` 回复同一消息。
- 结果为 `HOST288_CODEX_ROOM_WRITE_b8e17bb2-2645-4c25-a88e-a6ffccca2000`，回复为相同标记加 `_ACK`；重试前后消息总数都是 **1**。
- MCP 写回和回复审计调用方均为原目标会话；B 没有测试消息、任务或新会话。
- 本项验证的是**生产邮件唤醒后处理房间任务**，没有把 Codex 的 `room_summon` headless fallback 标为通过。
- 原验收脚本曾从累计日志中误选上一轮 PID。补核验按完整会话 ID 和本轮时间窗口定位到本轮 launcher 29892、被 pin 的真实 Codex PID 10156，均已退出。保留此证据修正，不用原脚本输出宣称退出耗时上界。

## 原生 CLI 界面检查

| 行为 | 结果与范围 |
| --- | --- |
| Claude `/conflux` | 技能菜单可见，实际执行 `/conflux list` 并返回测试目录和完整 ID |
| Claude `/conflux:list` | 原生补全中显示 MCP prompt 入口 |
| Claude `@conflux:` | 原生菜单显示目录资源和单会话资源；未把显示当成已附加/读取 |
| Claude 重名目标 | 实际调用候选查找，原生 AskUserQuestion 显示两条同名会话和一条弱匹配，含完整 ID、项目、状态、活跃时间和匹配理由 |
| 选择前不联系 | 候选检查前后 messages 为 0、room_tasks 为 2，没有自动发送或召唤 |
| 候选选择收尾 | **部分**：Other 自由输入/取消流程未在有界 TUI 运行内完成；超时进程被清理，不记为优雅关闭或选择完成 |
| Codex `/skills` | List skills 中实际显示 conflux |
| Codex `/mcp` | 显示 conflux connected（25 tools） |
| Codex `/mcp verbose` | 显示会话资源与 `conflux://sessions/id-{sessionId}` 模板；不据此承诺原生 @ 补全 |

界面检查通过独立 PTY 驱动厂商原生 TUI；不覆盖 Codex 桌面版菜单。Codex 原生宿主还自动提供 codex_apps/worktrees 服务，本轮没有调用这些服务执行动作。

## 发现与修复：hook 忽略显式目录

失败时，MCP 连接 A，而 `node ... --data-dir A hooks dispatch <event>` 仍按环境打开 B。原因是 dispatcher 固定调用 `resolveConfig("global")`，未读取 Command 的全局选项。

修复使用 `optsWithGlobals()` 和已有 scope 归一化，显式 dataDir 优先于环境，并在成功或异常结束时关闭连接。新增真实 CLI 子进程回归覆盖 `session-start`、`prompt`、`stop`：修复前 0/3，修复后 3/3；prompt/stop 在 A/B 都有同一 ID 的情况下，断言仅更新 A。

```powershell
# 从 apps/server 目录运行；测试自行创建临时目录，无需宿主登录
node --import tsx --test src/test/hook-cli-datadir.test.ts
```

| 验证 | 结果 |
| --- | --- |
| server 全套 | 353/353，0 失败 |
| shared/server/web 构建 | 退出码 0 |
| lint | 0 error、8 个已有 warning |
| 改动文件密钥扫描、diff 空白检查 | 通过 |

## 失败与清理

- 原 hook 分库失败、Codex usage-limit 失败均保留；没有把失败轮次覆盖成成功。
- 早期 Claude task 已完成，但验收脚本读错 PID 日志路径；修正后完整重跑成功。Codex 的累计日志 PID 选择错误已按本轮时间补核验。
- 原生 TUI 中有等待输入时触发超时清理的轮次；仅将可观察到的菜单和问答显示列为证据。
- 测试进程只按自身记录或本轮独有路径识别；收尾时测试标记进程为 0，临时宿主 profile 和凭据副本已移除。隔离 A/B 库及脱敏日志留作证据，原有用户目录未清理。
- 原始本机记录位于 `test-results/host-acceptance-2026-11-10/`；已提交 JSON 仅含测试标记、ID、时间、审计摘要与 hash，不含登录凭据或任务 token 明文。

## 仍需完成

#288 保持开放：原生候选选择/取消后的完整续接、Ghostty 专用标题重写、资源实际附加/读取，以及更广的真实宿主重连/停止/恢复矩阵尚未完成。macOS/Linux 实机和 #302 A13 安装/快捷方式验收不属于本轮通过结论。

修复 PR 合并前，应继续区分 dev 基线与 `ed55d68` 候选；不能将候选上的真实闭环记为已发布安装包能力。
