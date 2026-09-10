# 贡献指南 / Contributing

Conflux 欢迎 Issue、文档改进和 Pull Request。中文说明在前，英文说明在后。

## 中文

### 新功能开发流程（从想法到合并）

一个功能的标准生命周期，每步都有明确产出与验证手段：

1. **需求确认** — 一句话说清"谁、在哪、做什么、期望结果"。
2. **方案设计** — 涉及核心逻辑或 UI 大改时先写简短设计说明（数据从哪来、边界在哪）。
3. **测试先行** — 会话生命周期相关缺陷先写可复现测试再修。
4. **实现** — 业务逻辑只写在 core/，接口层做薄适配（见修改边界）。
5. **本地验证** — 跑完整验证链（见下），完成声明必须附实际命令与结果。
6. **提交** — 在 feat/fix 分支上以 Conventional Commits + 中文正文说明"为什么"（见分支策略）。
7. **PR + CI** — 分支推远端开 PR 到 main，CI 全绿才可合并；合并后删除分支。
8. **文档同步** — README 中英双语按需更新（双语同步是仓库约定）。

### UI 开发规范

- **安静容器，彩色身份卡**：分组框/瓦片用细边框近透明底，视觉重量留给会话卡。
- **类型身份系统**：claude=橙(Terminal)、codex=石墨(Code2)、web=蓝(Globe)、内置智能体=靛(Bot)。
- **渐进式披露**：总览恒定密度（目录=一枚瓦片），详情点击下钻；画布管结构，内容按需展开。
- **色彩语义**：绿=状态灯专用；琥珀脉冲=正在回复（busy）；中性灰=元数据。
- **UI 改动必须截图验证**：playwright 截图 + 几何断言（boundingBox 测间距/重叠）比肉眼可靠；美学改动建议加视觉模型评审。
- 布局常量改动同步核对：卡片 CSS 尺寸 ↔ layout.ts 的 NODE_* ↔ GraphTab 的 CELL_*。

### 平台陷阱清单（Windows 实测）

| 陷阱                      | 规则                                                     |
| ------------------------- | -------------------------------------------------------- |
| cmd 参数截断              | 长/含引号换行的内容（提示词、摘要）一律走 stdin          |
| codex 净化 MCP 子进程环境 | 身份冒用走 pid 钉扎（core/wake/launcher.ts），别指望 env |
| codex 线程写锁            | TUI 开着时无法 resume 该会话——唤醒策略据此分诊           |
| CRLF                      | 仓库源码 LF（.gitattributes 归一）；脚本匹配内容要容忍   |
|                           |
| Claude hooks 跑 dist      | 改 hook 逻辑后必须 npm run build 才生效                  |
| node --test glob          | Node 21+ 特性，CI 与本地统一 Node 22                     |
| 同步 IO 卡帧              | 高频事件路径（拖拽 pointermove）禁止同步 localStorage 写 |

### 开发环境

- Node.js 22 LTS，npm 9 或更高版本。
- Windows 目录打包需要 Visual Studio C++ Build Tools；没有本地工具链时使用 GitHub Actions 的 Windows runner。
- 不需要外部数据库服务。测试使用临时 SQLite 数据库。

### 开始开发

```bash
git clone https://github.com/yudongyouqing/Conflux.git
cd Conflux
npm ci
```

常用验证命令：

```bash
npm test -w apps/server
npm run build
npm run test:desktop
node --test scripts/release-config.test.cjs
npm run check:secrets
```

`npm run ci:test` 会串行运行 server、desktop 和发布配置测试；`npm run ci:build` 会构建 shared、server 和 web。修改 Electron 构建配置时，还可以运行 `npm run package:desktop:dir` 生成当前平台的未打包目录。

### 修改边界

- `apps/server/src/core` 是业务规则的唯一来源；HTTP、MCP 和 CLI 应复用这里的操作。
- `apps/web` 通过 HTTP API 访问数据，不直接访问 SQLite 或 Electron Node API。
- Electron 专属能力放在 `apps/desktop`，preload 只暴露必要的最小接口。
- 涉及会话生命周期的修复，先增加可复现测试，再修改实现。
- 保持现有 `muiltchat` 兼容入口、环境变量和数据目录行为，除非变更说明明确要求调整。

模块速查：唤醒系统在 core/wake/（提示词必须 stdin）；rollout 读取与标题策略分离（codex-rollout / codex-titles）；四条 ask 路径统一走 core/ask.ts；进程识别令牌表在 core/runtime-identity.ts（live.ts 内嵌副本需同步）。

### 数据与敏感信息

不要提交 `data.db`、SQLite WAL/SHM 文件、`.muiltchat`、`.electron-dev`、构建产物、`.env` 或真实 API key。导出文件只应使用脱敏后的 Conflux data bundle。分享日志前请删除 API key、Bearer token、私钥、个人路径和数据库内容。

提交前运行：

```bash
npm run check:secrets
git diff --check
```

### 分支策略（强制）

- **禁止直接在 main 上开发**。任何新功能、缺陷修复、重构都必须先开分支，再提交 PR 合并——main 随时保持可发布、CI 可过。
- **分支从最新的 main 切出**，命名体现意图与范围：

| 前缀      | 用途                 | 示例                   |
| --------- | -------------------- | ---------------------- |
| feat/     | 新功能               | feat/mention-composer  |
| fix/      | 缺陷修复             | fix/edge-label-gap     |
| refactor/ | 重构（不含行为变化） | refactor/wake-decouple |
| docs/     | 纯文档               | docs/api-reference     |
| chore/    | 工具链/依赖/CI       | chore/lint-setup       |

- **一个分支一个主题**：混入无关改动会让评审与回滚都变难；顺手修的小问题另开 fix 分支。
- **分支生命周期短**：长期分支合主干前 rebase main 解冲突；合并后立即删除远端与本地分支。
- 纯笔误/文档错字等一行业内改动可以例外直接进 main，但必须保证 CI 绿。

### dev → main 两级流向（强制）

日常开发目标是 **dev**；main 只接受来自 dev 的合并，发布节奏由此控制：

- 功能/修复分支的 PR 一律以 **dev** 为 base（dev 有与 main 相同的 CI 检查保护）。
- dev → main 走独立 PR，由 **main-merge-gate** 工作流强制只放行 dev 来源
  （该检查是 main 的必需 status check，其它来源分支的 PR 会直接红）。
- dev 与 main 同受 branch protection：三 CI 检查必需 + 管理员同约束 + 禁 force push。
- 以上策略已在 GitHub **branch protection** 层面强制（main：三个 CI 检查必需 + 管理员同样受约束 + 禁 force push/删除）。紧急热修时到 Settings → Branches 临时放宽。

### Pull Request 检查项

- 说明用户可观察到的行为变化和兼容性影响。
- 为新行为补充 server、web 或 desktop 测试。
- 通过 `npm test -w apps/server`、`npm run build` 和 `npm run test:desktop`。
- 修改 workflow、发布配置或示例时通过 `npm run check:secrets`。
- 不在 PR 中提交数据库、凭据、个人路径或无关格式化变更。

### Commit 约定

提交主题使用 Conventional Commits，例如：

```text
feat: add session export
fix: preserve pending message timestamps
docs: update migration guide
test: cover Codex liveness recovery
build: package the desktop client
ci: run checks on Windows and macOS
```

## English

Issues, documentation improvements, and pull requests are welcome. The repository uses Node.js 22 LTS and npm 9 or newer. Windows directory packaging requires Visual Studio C++ Build Tools; GitHub Actions provides the Windows build environment when the native toolchain is unavailable locally.

Install dependencies with `npm ci`, then run `npm test -w apps/server`, `npm run build`, `npm run test:desktop`, `node --test scripts/release-config.test.cjs`, and `npm run check:secrets`. `npm run ci:test` runs the test checks in sequence, while `npm run ci:build` builds the shared, server, and web packages.

Keep business rules in `apps/server/src/core`, keep the web app on the HTTP boundary, and expose only minimal desktop capabilities from preload. Add a regression test before changing session lifecycle behavior. Preserve the `muiltchat` compatibility entry points, environment variables, and data directory unless a change explicitly updates them.

Never commit SQLite files, `.muiltchat`, `.electron-dev`, build output, `.env` files, or real credentials. Export bundles must not contain API keys. Redact credentials, personal paths, and database contents before sharing logs. A pull request should explain user-visible behavior, include focused tests, pass the server suite, build, desktop tests, secret scan, and `git diff --check`.

All work happens on purpose-named branches (feat/, fix/, refactor/, docs/, chore/) cut from the latest main; direct commits to main are only allowed for trivial typo-level fixes, and branches are deleted right after merge. Feature work follows an eight-step flow: clarify the request, sketch the design, write a reproducing test for lifecycle bugs, implement in core, run the local verification chain, commit with a rationale, merge only with green CI, and sync both READMEs. UI changes require Playwright screenshot verification plus geometry assertions; the design language is quiet containers with colored identity cards and progressive disclosure. Platform rules: wake prompts ride stdin (cmd quoting corrupts them), Codex MCP children get a scrubbed environment (identity rides pid pinning), source line endings are LF, and hot event paths must not perform synchronous I/O.

Use Conventional Commit subjects such as `feat:`, `fix:`, `docs:`, `test:`, `build:`, and `ci:` so release notes remain easy to generate.
