# 历史计划验收核查

核查日期：2026-10-28；代码基线：`5f45ba4`（已通过 PR #240 进入 main）。范围为 `superpowers/plans/` 中 12 份实现计划；PR 正文示例不计入。

本表区分当前回归、历史执行记录、后续替代与缺失实现。测试通过不能证明过去曾执行手工步骤；原复选框也不作为独立证据。这里没有重新启动真实 Codex/Claude MCP 宿主、安装桌面包或注入桌面进程故障。

## 逐计划结果

| 历史计划 | 已核实证据 | 验收结论与剩余项 |
| --- | --- | --- |
| [08-29 Electron 开发壳](superpowers/plans/2026-08-29-electron-desktop.md) | `apps/desktop/src/dev-services.cjs`、`runtime-config.cjs` 及同名测试；09-02 MCP 计划附有窗口已加载的历史记录 | 服务模块有自动覆盖；未找到本计划独立的启动/退出实测结果。原“关闭窗口即释放端口”已过时，当前是关闭隐藏、托盘退出，不能按原条件验收。 |
| [08-30 Codex 存活](superpowers/plans/2026-08-30-codex-liveness.md) | `core/liveness.ts`、`core/live.ts`、`mcp/server.ts`；`liveness.test.ts`、`http-liveness.test.ts` | 识别、关联和 reconcile 有自动覆盖；未发现可归属于本计划的真实双宿主连续在线/退出日志，不能声称本次实机复测完成。旧环境变量说明已由 #239 的新名称取代。 |
| [08-30 协作工作区](superpowers/plans/2026-08-30-collaboration-workspace.md) | 当前有会话、消息、上下文、runtime agents；但检索不到计划中的 `getWorkspaceSnapshot`、`WorkspaceHome`、`QueryState`、`message-delivery.ts`、`runtime_instances` 或其对应提交 | **部分能力存在，整份计划未落地。** 当前 `MessageStatus` 仅含 pending/seen/replied/read，并无该计划要求的 queued/failed 消息状态。不能仅因当前产品有协作功能而标记完成；需决定是否继续这一旧设计。 |
| [08-30 Electron 运行时基础](superpowers/plans/2026-08-30-electron-runtime-foundation.md) | `runtime-paths.cjs`、`port-diagnostics.cjs`、`production-services.cjs`、`security.cjs`、`tray.cjs`；数据库身份字段及桌面测试 | 模块和身份字段已实现；单实例聚焦、窗口五秒打开、真机托盘退出后清理端口仍缺当前人工记录。“关窗口释放端口”条件需按托盘行为改写。 |
| [08-30 开源交付](superpowers/plans/2026-08-30-open-source-delivery.md) | 计划内列出 `4bc2f6b`、`b3c682e`、`8ddb28d`、`21bb42f`、`3afe27a`、`8f103a9`；迁移/导入导出测试；v0.2.0 Release 和三平台构建记录 | 实现和构建交付有证据；原记录已明确本机 native rebuild 被工具链/路径阻塞。CI 打包成功不等于安装实测。旧 CLI/env 兼容设计已由 #239 有意移除，数据目录迁移仍保留。 |
| [09-02 UI watchdog](superpowers/plans/2026-09-02-electron-health-watchdog.md) | `renderer-watchdog.cjs`、`service-health.cjs`；`renderer-watchdog.test.cjs`、`service-health.test.cjs`、`main-wiring.test.cjs` | 状态机、健康探测及接线有自动覆盖；接线测试包含源码检查，不等同 Electron 真机故障注入。未找到本计划要求的当前 Renderer 卡死/崩溃、服务故障与退出清理完整手工记录。 |
| [09-02 MCP 租约](superpowers/plans/2026-09-02-mcp-connection-liveness.md) | 计划“执行记录（2026-09-02）”，提交 `af89b94`、`b52843e`；`mcp-liveness.test.ts` | **存在有边界的历史执行记录**：worktree MCP 子进程握手、17 秒后心跳更新、stdin close 后断开；记录明确“真实 Codex 宿主重载仍需用户完全重启”。不能把已勾选步骤解读为所有真实宿主场景均完成。 |
| [09-11 双主题](superpowers/plans/2026-09-11-app-dual-theme.md) | 原实现 `6880f95`；后续 `e8cb824`、PR #96/#97；当前 `theme.ts`、`theme.test.ts` | **原验收部分已被替代**：`installTheme` 已移除旧 system/light/dark 偏好监听，当前为内置/自定义色板并联动原生外观。原三段选择、system 跟随验收不应继续作为未完成任务。现有截图和测试不等于全界面视觉逐项验收。 |
| [09-11 channel show/watch](superpowers/plans/2026-09-11-cli-channel-watch.md) | `cli/channel-watch.ts`；`channel-cli.test.ts`、`channel-watch.test.ts`、`channel-watch-e2e.test.ts` | 初始/新增消息快照、本地与 HTTP 路径、SIGINT 有自动化覆盖；本次并行回归初始快照超时一次，已记录 [#242](https://github.com/yudongyouqing/Conflux/issues/242)。旧计划指定“当前 channel #26”的本机 smoke 无可归属记录，该数据编号已不适合作为当前验收前提。 |
| [09-16 侧栏消息合并](superpowers/plans/2026-09-16-sidebar-message-merge.md) | `6d5a168` 曾创建 Workbench；`1256736` 明确回退；当前保留 `MessageTab.tsx`，无 `WorkbenchTab.tsx` | **已实现后回退，不能标完成。** 当前布局和 E2E 是后续产品状态，不能代替旧 Workbench 两态截图与删除旧导航的验收。是否重做需重新确认产品方向。 |
| [09-17 通道代码高亮](superpowers/plans/2026-09-17-channel-highlight.md) | `MarkdownText.tsx`、`markdown-highlight.test.ts`；实现 `0182e29`、合并 PR #25 | 高亮 token、围栏与行内代码分流有自动覆盖。截图文件存在，但不能据此确认某张图验收过所有高亮/对比度情形；视觉核查仍需补记录。 |
| [09-20 hooks backfill](superpowers/plans/2026-09-20-hooks-backfill.md) | 计划开头声明 2026-09-20 macOS 手工验证过“配方”；`c2f36a5` 接入 CLI；`hooks-backfill.test.ts` | 历史声明只支持配方级验证。没有找到 CLI 完成后“3 个进程 already tracked”、二次执行与 `hooks install` 重装的实际输出，不能将这三项勾为实机完成。 |

`2026-09-09-pr-body-example.md` 是 PR 正文样例，没有独立实施验收义务。

## 手工步骤的明确边界

| 项目 | 当前判定 | 后续有效验收方式 |
| --- | --- | --- |
| 开发/打包窗口启动、单实例聚焦、托盘退出清理 | 实现存在；部分历史启动记录；缺完整实测 | 使用独立临时数据目录，记录启动时间、窗口加载、第二次启动聚焦、托盘退出后所属 PID 和端口消失。关窗口隐藏不算退出。 |
| Renderer ping/pong、卡死/恢复/崩溃与服务故障 | 自动测试存在；缺真实 Electron 故障记录 | 在隔离实例注入故障并保存日志、截图、恢复/退出结果。 |
| 真正 Codex/Claude 宿主重载、idle、关闭和重连 | 仅子进程协议历史记录与当前自动覆盖 | 两个真实宿主分别保存连接代际、心跳、close/reconnect 行为；不可把测试 MCP 子进程当成宿主。 |
| 协作工作区的全链路手工流程 | 旧计划关键模块缺失 | 先决定旧设计是否继续，不能直接要求对不存在的 WorkspaceHome 和消息重试状态验收。 |
| 原三段主题/system 跟随 | 已被色板方案替代 | 对当前色板做持久化、刷新、原生外观和桌面/窄屏视觉记录，不恢复旧测试来迎合旧计划。 |
| 旧 Workbench 两态 | 实现已回退 | 不再当成“只缺验收”；需要新需求决策。 |
| channel #26、真实 backfill 进程数 | 历史机器数据缺记录 | CLI 自动 E2E 可复现；真机 backfill 应记录实际机器进程和幂等结果，不复用旧编号/预期数量。 |
| 安装包、签名及更新 | 三平台构建交付；安装/更新未实测；签名由用户暂缓 | 单独按发布验收处理，不混入历史计划完成率。 |

## 证据定位

- [MCP 历史执行记录](superpowers/plans/2026-09-02-mcp-connection-liveness.md)及 `git show af89b94`。
- [backfill 配方声明](superpowers/plans/2026-09-20-hooks-backfill.md)与 CLI 实现提交 `c2f36a5`。
- `git log -- apps/web/src/components/WorkbenchTab.tsx` 可看到创建与回退两个提交。
- [截图生成脚本](../scripts/capture/capture.mjs)及 `docs/assets/screenshots/` 证明截图交付物存在；未将它们当作全部手工验收通过的证据。
- [当前 E2E](../scripts/e2e/web-smoke.mjs)仅覆盖隔离数据下的图谱、消息发送、Agent 创建和窄屏流程；没有启动 Electron 或真实外部 Agent。

本次核查未重试此前被自动审批拒绝的 Windows 打包应用隔离启动；该实机验收仍未执行。缺少记录表示“未证实”，并不自动表示功能有缺陷。

## 本次重新执行的回归

在上述代码基线上执行，未改动产品实现或放宽测试期限：

| 命令 | 实际结果 |
| --- | --- |
| `npm test -w apps/server`（与构建/Web 回归并行） | 274 项中 273 通过、1 失败；channel watch 初始快照 3000ms 超时。 |
| `node --import tsx --test apps/server/src/test/channel-watch-e2e.test.ts`（单独复测） | 2 通过、0 失败。 |
| `npm test -w apps/server`（不与其他构建/测试并行，再测） | 274 通过、0 失败。首次失败没有被抹去，根因尚未确定，继续跟踪 #242。 |
| `npm run test:desktop` | 58 通过、0 失败；属于模块/接线覆盖，不代表启动了真实 Electron。 |
| `npm test -w apps/web` | 34 通过、0 失败。 |
| `npm run build` | 退出码 0；有已有 Vite 弃用/包体积警告。 |
| `npm run test:e2e:web` | 退出码 0，隔离浏览器 smoke 通过；非真实 MCP 宿主或桌面安装验收。 |
| `node --test scripts/release-config.test.cjs` | 3 通过、0 失败；不代表执行了签名/公证。 |

本次自动回归证明的是当前基线上的这些测试结果，不追认任何缺少证据的历史手工执行。
