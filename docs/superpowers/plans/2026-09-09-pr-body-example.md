# PR: Electron 桌面线 + 跨会话对话闭环 + 解耦重构 + 工作流画布

> 分支：`refactor/wake-decouple` → `main`（29 个提交，含 `feature/electron-desktop` 全部历史）

## 一、Codex 会话身份（3 commits）

- **标题系统**：从 `~/.codex` 的 rollout 记录 + session_index 派生标题——优先 Codex 自维护的 thread_name，回退首条真实指令摘要（跳过 environment_context/AGENTS 注入等合成块）；分层匹配（盖章绝对绑定 → cwd 精确 → 时间窗 → resume 续写检测），认领制防抢占
- **resume 支持**：`codex resume` 会把新对话追加到旧 rollout，匹配器三层覆盖此场景
- 解决"所有 Codex 会话都叫 server"的问题

## 二、跨会话对话闭环（6 commits)

- **busy 状态位**：Claude 用 UserPromptSubmit→Stop 事件对、Codex 用 rollout mtime 新鲜度推导"正在回复中"，全 UI 徽标
- **@ 提及对话**：详情抽屉「发起对话通道」+ 消息流入口；半角/全角 @；恰好一个目标（0 个拦截提示、重复自动替换）
- **A 联系 B**：`/web/ask` 支持任意发起方身份（"让会话 A 去问会话 B"），带校验
- **自动应答三分诊**：忙→等本轮；离线→无头 resume 真实对话（完整上下文，回复落在 CLI 可见的历史）；在线空闲→Codex 线程写锁下的摘要注入应答
- **两个硬核根因修复**：codex exec 审批策略拒绝 MCP 工具（旁路旗标）；codex 净化 MCP 子进程环境导致 env 冒名失效（BFS 全后代 pid 钉扎）；唤醒提示词经 stdin 投递（cmd 引号/换行截断）

## 三、解耦重构（5 commits）

- `core/wake/`：唤醒系统独立模块（commands/launcher/claude/codex/index）
- `core/codex-rollout.ts`：rollout 纯读取层与标题策略分离
- `core/ask.ts`：四条 ask 路径收敛为 `askAndMaybeWake` 单一入口
- `core/runtime-identity.ts`：三份漂移的进程识别规则收敛为单一令牌表
- `http/`：1345 行 server.ts 拆为共享上下文 + 7 个资源路由模块（纯引导 206 行）

## 四、图拓扑画布（3 commits）

- Dify/n8n 风格节点：类型身份系统（claude=橙/codex=石墨/web=蓝/agent=靛，图标块 + 顶部条带 + 结构分区）
- 连线：实线轨道 + 流动珠点动画 + 箭头 + 中点胶囊；同源边扇形展开
- 布局修复：节点尺寸同步（消压叠）、视图切换自动 reframe、无连线网格降级 + 引导提示

## 五、工具链

- 技能：webapp-testing / code-reviewer / pr-creator（skills-lock 登记）
- playwright 转 devDependency（UI 截图验证 + 后续回归测试）

## 验证

- server **163/163**、desktop **50/50**、tsc 零错、构建通过
- 关键链路真实端到端验证：标题自动出现、@ 提问→空闲唤醒→以目标身份 reply_ask→通道可见
- 图改造经 Playwright 截图 + 视觉模型三轮评审迭代

## 破坏性

无——HTTP/MCP/CLI 接口语义保持；`/web/ask` 新增可选 `from_session` 字段为纯扩展。
