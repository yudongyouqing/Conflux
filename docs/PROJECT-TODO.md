# 项目状态与待办

截至 2026-11-01。此文档是当前待办入口；`superpowers/plans/` 是历史实施记录，其中的复选框不自动反映当前状态。标记完成指功能或交付物存在，不代表所有旧计划中的手工验收步骤均已核验。

## 交付分层（2026-11-01 用 gh 与远端提交核对）

- **已发布安装包**：v0.2.0（tag `b4fd521`，2026-10-28 发布，三平台、未签名）。不含其后任何改动，仍带旧 `muiltchat` CLI 和 `MUILTCHAT_*` 变量。
- **已合入 main、尚未发布**：main `85fcc28e` 领先 v0.2.0 tag 40 个提交，含旧 CLI/环境变量移除（破坏性，见 CHANGELOG Unreleased）、发布工作流修复、图谱长路径性能与 CI 强化（经 PR #240、#247、#256）。
- **仅在 dev**：dev `a13ac11` 领先 main 12 个提交，含服务器/SQLite 性能基线（#259）、MCP 会话目录与 Conflux 技能（#261）、消息重试/受管实例/语义主题（#265）。这些功能不在 v0.2.0 安装包中，也未进 main。

## 已交付

- [x] Electron 桌面壳、运行时服务和健康探测（对应 2026-08-29、2026-08-30 runtime、2026-09-02 watchdog 计划）。
- [x] Codex 和 MCP 存活检测（对应 2026-08-30 和 2026-09-02 liveness 计划）。
- [x] 配置迁移和发布基础（对应 2026-08-30 open-source delivery 计划）；协作工作区旧设计仅部分能力存在，见下方。
- [x] 应用主题、channel watch、当前会话/消息界面和通道代码高亮（旧 Workbench 合并已回退，主题已有后续替代）。
- [x] Hooks 存量会话补录（对应 2026-09-20 计划）。
- [x] v0.2.0 tag 和三个平台的未签名安装包已发布；发布工作流修复随后经 PR #240、#247 合入 main，均晚于该安装包（见上方交付分层）。
- [x] 建立链、树和无边图的 Node 构图基线及生产构建浏览器基准；CI 自动保存图谱呈现、缩放响应和长任务样本。

## 待办

- [ ] 在 Windows、macOS Apple Silicon、Linux 实机验证 v0.2.0 安装、启动和退出清理；记录环境及结果，见 [发布验收](https://github.com/yudongyouqing/Conflux/issues/267)。
- [ ] 可选后续：配置 Windows 签名和 macOS 签名及公证。用户已选择继续使用未签名版本；此项不阻塞当前发布，自动更新仍需实机验收。
- [x] 发布工作流修复及本批改动已通过 PR #240 合入 main。
- [ ] 在下次发布时验证完整自动化链路及安装/自动更新实机验收。发布准备 [#222](https://github.com/yudongyouqing/Conflux/issues/222) 已随 v0.2.0 完成并于 2026-10-30 关闭；剩余验收由 [#267](https://github.com/yudongyouqing/Conflux/issues/267) 跟踪，不再指向旧 issue。
- [x] 下一版本移除旧 `muiltchat` CLI 和 `MUILTCHAT_*` 变量，更新内部调用及迁移通知；现有数据目录保留。
- [x] 补充服务器 HTTP 和 SQLite 基准、原始样本、CPU/内存及存储记录，并在 CI 保存报告；见 [性能基线](PERFORMANCE.md)。
- [x] 补充跨进程 SQLite 写锁竞争与长时运行验证：HTTP 服务与外部写进程共用同一临时库，IPC 握手确认锁持有/释放，覆盖读隔离、释放恢复、短/生产超时分类、双写者完整性与写者异常退出回滚；另有一次 30 分钟本机 soak 记录内存、CPU、数据库/WAL 时间序列。CI 仅短 smoke，报告见[性能基线](PERFORMANCE.md)（2026-11-01）。
- [x] 保持锁等待期间 HTTP 可用：HTTP 服务连接的等待预算改为事件循环可让出的重试（ServerContext.write → retryOnBusy，写闭包在 BEGIN IMMEDIATE 内原子重试，总预算仍 10 秒；CLI/MCP 连接行为不变）；独立探针实测写等待 10.04 秒期间 28/28 探针成功、最大延迟 48ms，桌面服务监控（15 秒间隔、2 秒超时）不再出现误判窗口。进程相关路由（实例停止/恢复/启动/列表）刻意不进重试包裹，持锁时快速 DATA_LOCKED。见[性能基线](PERFORMANCE.md)覆盖边界与 `http-lock-contention`、`busy-retry` 测试。
- [ ] 在真实业务数据和多种设备上复测浏览器、服务器/数据库基准与长时运行，再决定回归阈值；现有竞争与 soak 结果均为单机单次观测，不构成阈值或泄漏结论。
- [x] 核查 12 份历史实现计划并记录证据、回退和替代情况，见 [历史计划验收核查](PLAN-ACCEPTANCE.md)。
- [x] 明确旧方案去留：正式归档已回退的 Workbench 合并方案，保留独立会话/消息入口；旧协作工作区不再整套实施，聚合首页与快照暂缓。
- [x] 按[协作控制新设计](superpowers/specs/2026-10-30-collaboration-controls-design.md)实现消息唤醒结果、手动重试及受管运行实例的停止/恢复；保持已读/回复状态独立，覆盖进程归属和并发恢复边界。验证范围见[本批记录](COLLABORATION-VALIDATION.md)，真实宿主流程另行验收。
- [x] 完善浅色/深色色板和语义状态色，保留已有自定义主题；通过默认色板对比度、持久化与桌面/窄屏浏览器验证，截图见[协作控制](COLLABORATION-CONTROLS.md)。
- [x] 增加 MCP 会话目录、资源引用和 Codex/Claude Code 的 Conflux 技能入口，见[会话目录](SESSION-DIRECTORY.md)。
- [x] 补充目标会话不明确时的候选查找与技能选项确认规则；终端标题变化时依据完整 ID、项目、运行时和活跃时间定位，用户选择前不发送。SDK/stdio 通过；真实宿主问答展示保留在手工验收中。
- [x] 运行实例进程级 E2E：可控 claude/codex 形态子进程走生产检查/终止路径（PowerShell CIM、/proc、ps、taskkill/SIGTERM），覆盖 PID+创建令牌绑定、注册超时、失联仍在、PID 复用、归属不匹配、重复恢复、启动失败、延迟退出与特殊字符路径，见 #273；套件串行执行（test:process-e2e）。真实 Codex/Claude Code 宿主验收仍开放。
- [ ] 补充真实 MCP 宿主的候选问答和实例启动/停止/恢复、桌面故障注入/托盘退出、backfill CLI 幂等验收；主题/高亮已补隔离浏览器记录，原生外观联动仍需实测，具体步骤见验收核查表。
- [x] 分离 channel watch 的启动与更新等待：启动允许 15 秒、消息更新仍限 3 秒，提前退出立即报告诊断；补充慢启动和失败回归，见 [#242](https://github.com/yudongyouqing/Conflux/issues/242)。
- [x] 普通 CI 纳入完整桌面测试、lint、发布配置测试与设计令牌检查，见 [#244](https://github.com/yudongyouqing/Conflux/issues/244)。

`2026-09-09-pr-body-example.md` 是 PR 正文示例，不是实施计划。
