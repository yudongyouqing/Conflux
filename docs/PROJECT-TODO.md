# 项目状态与待办

截至 2026-10-30。此文档是当前待办入口；`superpowers/plans/` 是历史实施记录，其中的复选框不自动反映当前状态。标记完成指功能或交付物存在，不代表所有旧计划中的手工验收步骤均已核验。

## 已交付

- [x] Electron 桌面壳、运行时服务和健康探测（对应 2026-08-29、2026-08-30 runtime、2026-09-02 watchdog 计划）。
- [x] Codex 和 MCP 存活检测（对应 2026-08-30 和 2026-09-02 liveness 计划）。
- [x] 配置迁移和发布基础（对应 2026-08-30 open-source delivery 计划）；协作工作区旧设计仅部分能力存在，见下方。
- [x] 应用主题、channel watch、当前会话/消息界面和通道代码高亮（旧 Workbench 合并已回退，主题已有后续替代）。
- [x] Hooks 存量会话补录（对应 2026-09-20 计划）。
- [x] v0.2.0 tag 和三个平台的安装包已发布；工作流发布修复已合入 dev。
- [x] 建立链、树和无边图的 Node 构图基线及生产构建浏览器基准；CI 自动保存图谱呈现、缩放响应和长任务样本。

## 待办

- [ ] 在 Windows、macOS Apple Silicon、Linux 实机验证 v0.2.0 安装、启动和退出清理；记录环境及结果。
- [ ] 可选后续：配置 Windows 签名和 macOS 签名及公证。用户已选择继续使用未签名版本；此项不阻塞当前发布，自动更新仍需实机验收。
- [x] 发布工作流修复及本批改动已通过 PR #240 合入 main。
- [ ] 在下次发布验证完整自动化链路。[发布准备 issue](https://github.com/yudongyouqing/Conflux/issues/222) 保持开放，直到相关收尾确定。
- [x] 下一版本移除旧 `muiltchat` CLI 和 `MUILTCHAT_*` 变量，更新内部调用及迁移通知；现有数据目录保留。
- [x] 补充服务器 HTTP 和 SQLite 基准、原始样本、CPU/内存及存储记录，并在 CI 保存报告；见 [性能基线](PERFORMANCE.md)。
- [ ] 在真实业务数据和多种设备上复测浏览器及服务器/数据库基准，再决定回归阈值；跨进程写锁竞争和长时间内存增长尚未验证。
- [x] 核查 12 份历史实现计划并记录证据、回退和替代情况，见 [历史计划验收核查](PLAN-ACCEPTANCE.md)。
- [ ] 决定是否继续旧协作工作区设计（聚合快照、消息投递重试、runtime_instances）及是否重做 Workbench；不得继续笼统标为已交付。
- [ ] 补充真实 MCP 宿主、桌面故障注入/托盘退出、backfill CLI 幂等和当前主题/高亮视觉验收记录，具体步骤见验收核查表。
- [x] 分离 channel watch 的启动与更新等待：启动允许 15 秒、消息更新仍限 3 秒，提前退出立即报告诊断；补充慢启动和失败回归，见 [#242](https://github.com/yudongyouqing/Conflux/issues/242)。
- [x] 普通 CI 纳入完整桌面测试、lint、发布配置测试与设计令牌检查，见 [#244](https://github.com/yudongyouqing/Conflux/issues/244)。

`2026-09-09-pr-body-example.md` 是 PR 正文示例，不是实施计划。
