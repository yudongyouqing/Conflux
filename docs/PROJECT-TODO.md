# 项目状态与待办

截至 2026-10-28。此文档是当前待办入口；`superpowers/plans/` 是历史实施记录，其中的复选框不自动反映当前状态。标记完成指功能或交付物存在，不代表所有旧计划中的手工验收步骤均已核验。

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
- [ ] 配置 Windows 签名和 macOS 签名及公证，验证签名安装包及自动更新。当前 v0.2.0 安装包未签名。
- [ ] 在用户确认的里程碑中将发布工作流修复从 dev 合入 main，并在下次发布验证完整自动化链路。[发布准备 issue](https://github.com/yudongyouqing/Conflux/issues/222) 保持开放，直到相关收尾确定。
- [x] 下一版本移除旧 `muiltchat` CLI 和 `MUILTCHAT_*` 变量，更新内部调用及迁移通知；现有数据目录保留。
- [ ] 在真实业务数据和多种设备上复测浏览器基准，并补充服务器/数据库性能数据，再决定回归阈值；见 [性能基线](PERFORMANCE.md)。
- [x] 核查 12 份历史实现计划并记录证据、回退和替代情况，见 [历史计划验收核查](PLAN-ACCEPTANCE.md)。
- [ ] 决定是否继续旧协作工作区设计（聚合快照、消息投递重试、runtime_instances）及是否重做 Workbench；不得继续笼统标为已交付。
- [ ] 补充真实 MCP 宿主、桌面故障注入/托盘退出、backfill CLI 幂等和当前主题/高亮视觉验收记录，具体步骤见验收核查表。
- [ ] 调查本次 Windows 并行回归中的 channel watch 启动超时，见 [#242](https://github.com/yudongyouqing/Conflux/issues/242)。

`2026-09-09-pr-body-example.md` 是 PR 正文示例，不是实施计划。
