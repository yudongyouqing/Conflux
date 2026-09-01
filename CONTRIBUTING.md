# 贡献指南 / Contributing

Conflux 欢迎 Issue、文档改进和 Pull Request。中文说明在前，英文说明在后。

## 中文

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

### 数据与敏感信息

不要提交 `data.db`、SQLite WAL/SHM 文件、`.muiltchat`、`.electron-dev`、构建产物、`.env` 或真实 API key。导出文件只应使用脱敏后的 Conflux data bundle。分享日志前请删除 API key、Bearer token、私钥、个人路径和数据库内容。

提交前运行：

```bash
npm run check:secrets
git diff --check
```

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

Use Conventional Commit subjects such as `feat:`, `fix:`, `docs:`, `test:`, `build:`, and `ci:` so release notes remain easy to generate.
