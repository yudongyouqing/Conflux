# 配置迁移、发布与开源交付实现计划

> 面向 AI 代理的工作者：必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（- [ ]）语法跟踪进度。

**目标：** 让陌生用户可以在 Windows 上安装、升级、迁移旧 muiltchat 数据、导入导出协作记录，并通过 CI 复现构建和测试。

**架构：** 兼容层集中处理 Conflux 新名称与 muiltchat 旧名称，默认数据仍读取 ~/.muiltchat；显式迁移由版本化 manifest、可回滚备份和事务导入组成。Electron Builder 负责安装包，GitHub Actions 负责 server、web、desktop 测试及未签名构建，敏感信息检查在提交和发布前执行。

**技术栈：** TypeScript、Node.js fs/path、SQLite WAL、Zod、Commander、Electron Builder、GitHub Actions、Node node:test。

---

## 依赖与边界

本计划依赖阶段一的生产 server、Electron Builder 基础和阶段二的 runtime_instances 数据表。迁移操作不删除旧目录、不覆盖原数据库；导入前先解析和校验，事务失败时回滚。自动更新、代码签名和远程同步不属于本计划。

## 文件清单

创建：

- apps/server/src/core/config-migration.ts：名称兼容、数据目录迁移和备份标记。
- apps/server/src/core/data-transfer.ts：版本化导出、校验、冲突策略和事务导入。
- apps/server/src/test/config-migration.test.ts、data-transfer.test.ts：迁移和导入导出回归测试。
- scripts/check-secrets.cjs、scripts/check-secrets.test.cjs：发布前敏感信息扫描及测试。
- .github/workflows/ci.yml、.github/workflows/release.yml：检查和发布流水线。
- CONTRIBUTING.md、CHANGELOG.md：贡献指南和变更记录入口。
- docs/MIGRATION.md、docs/TROUBLESHOOTING.md：迁移和故障排查文档。

修改：

- apps/server/src/config.ts：引入 CONFLUX_HOME 和兼容路径解析。
- apps/server/src/core/db.ts：提供 checkpoint、备份前检查和迁移失败错误。
- apps/server/src/http/server.ts：增加导入导出和数据迁移路由。
- apps/server/src/cli/commands.ts：增加 conflux migrate/export/import 命令，并保留 muiltchat 命令树。
- apps/server/package.json：同时声明 conflux 和 muiltchat bin。
- package.json、package-lock.json：增加检查、CI、桌面发布脚本。
- .mcp.json：默认 server key 改为 conflux，保留兼容配置说明。
- README.md、docs/README.en.md：同步安装、迁移、构建、故障排查和发布状态。
- LICENSE：更新项目版权主体为 Conflux contributors。
- apps/desktop/electron-builder.yml：补充应用 ID、版本、Windows NSIS 和跨平台目录构建配置。

### 任务 1：实现名称和数据目录兼容层

**文件：** apps/server/src/core/config-migration.ts、apps/server/src/test/config-migration.test.ts、apps/server/src/config.ts、apps/server/src/cli/commands.ts、apps/server/package.json、.mcp.json。

- [ ] 步骤 1：编写环境优先级和旧目录保留测试

`ts
test("prefers explicit directory, then Conflux, then legacy environment", () => {
  assert.equal(
    resolveDataHome({
      override: "C:/explicit",
      env: { CONFLUX_HOME: "C:/conflux", MUILTCHAT_HOME: "C:/legacy" },
    }),
    "C:/explicit"
  );
  assert.equal(
    resolveDataHome({
      env: { CONFLUX_HOME: "C:/conflux", MUILTCHAT_HOME: "C:/legacy" },
    }),
    "C:/conflux"
  );
  assert.equal(
    resolveDataHome({ env: { MUILTCHAT_HOME: "C:/legacy" } }),
    "C:/legacy"
  );
});

test("keeps the legacy directory and writes a reversible migration marker", () => {
  const result = migrateDataDir({
    from: "C:/legacy/.muiltchat",
    to: "C:/conflux/.conflux",
    copyFile: fakeCopyFile,
    writeMarker: fakeWriteMarker,
  });
  assert.equal(result.sourcePreserved, true);
  assert.equal(result.marker.version, 1);
  assert.equal(result.marker.source, "C:/legacy/.muiltchat");
});
`

- [ ] 步骤 2：运行测试确认兼容层尚未实现

运行：npm test -w apps/server -- --test-name-pattern="Conflux|legacy directory"。

预期：因 CONFLUX_HOME 和迁移函数不存在而失败。

- [ ] 步骤 3：实现目录解析和显式迁移

保留现有优先级中的 explicit data-dir 最高；之后读取 CONFLUX_HOME，再读取 MUILTCHAT_HOME，再读取项目范围目录，最后回退到 ~/.muiltchat。没有显式迁移命令时，不创建 ~/.conflux，也不移动 ~/.muiltchat。

config-migration.ts 的 manifest 固定为：

`ts
export interface MigrationMarker {
  version: 1;
  source: string;
  destination: string;
  copied_at: string;
  source_preserved: true;
}
`

migrateDataDir 先对 SQLite 执行 WAL checkpoint，再复制 data.db、配置文件和已确认的 sidecar；旧目录始终保留。目标已有文件时拒绝覆盖并返回冲突列表。成功后写入 destination/.conflux-migration.json，失败时删除本次创建的目标临时目录而不触碰 source。

- [ ] 步骤 4：接入 CLI 和 MCP 命名兼容

server package 的 bin 同时声明 conflux 和 muiltchat，两个入口调用同一个 buildCli。Commander 根据 argv[0] 显示对应名称，但子命令和参数一致。根 .mcp.json 默认 key 改为 conflux；文档明确旧的 muiltchat key 仍可手动使用，避免同一配置同时启动两个 server。

增加命令：

`text
conflux path
conflux migrate --from <legacy-dir> --to <conflux-dir>
conflux migrate --status
`

- [ ] 步骤 5：运行配置回归和构建

运行：

`powershell
npm test -w apps/server -- --test-name-pattern="Conflux|legacy|migration"
npm run build -w apps/server
`

预期：环境优先级、旧目录保留、重复迁移冲突测试通过，server 构建成功。

- [ ] 步骤 6：Commit

`powershell
git add apps/server/src/core/config-migration.ts apps/server/src/test/config-migration.test.ts apps/server/src/config.ts apps/server/src/cli/commands.ts apps/server/package.json .mcp.json
git commit -m "feat: add conflux configuration compatibility"
`

### 任务 2：实现版本化数据导出和事务导入

**文件：** apps/server/src/core/data-transfer.ts、apps/server/src/test/data-transfer.test.ts、apps/server/src/core/db.ts、apps/server/src/http/server.ts、apps/server/src/cli/commands.ts、packages/shared/src/index.ts、apps/web/src/api.ts、apps/web/src/components/SettingsTab.tsx。

- [ ] 步骤 1：编写导出、校验和冲突测试

`ts
test("exports sessions, context, messages, agents, and runtime presets", () => {
  const db = openTestDb();
  seedAllResources(db);
  const bundle = exportData(db, { scope: "global", includeSecrets: false });
  assert.equal(bundle.format, "conflux-data");
  assert.equal(bundle.version, 1);
  assert.ok(bundle.sessions.length > 0);
  assert.ok(bundle.context_entries.length > 0);
  assert.ok(bundle.runtime_agents[0].api_key_configured);
  assert.equal("api_key" in bundle.runtime_agents[0], false);
});

test("imports with skip, overwrite, and copy conflict strategies in a transaction", () => {
  const db = openTestDb();
  seedSession(db, { id: "same", name: "old" });
  const bundle = validBundleWithSession({ id: "same", name: "new" });
  assert.equal(importData(db, bundle, { conflict: "skip" }).skipped, 1);
  assert.equal(getSession(db, "same")!.name, "old");
  assert.equal(importData(db, bundle, { conflict: "overwrite" }).overwritten, 1);
  assert.equal(getSession(db, "same")!.name, "new");
  assert.equal(importData(db, bundle, { conflict: "copy" }).copied, 1);
  assert.ok(listSessions(db, { status: "all" }).some((s) => s.name === "new"));
});
`

- [ ] 步骤 2：运行测试确认 transfer 模块尚未实现

运行：npm test -w apps/server -- --test-name-pattern="exports|imports"。

预期：因导出格式和导入函数不存在而失败。

- [ ] 步骤 3：实现严格格式和敏感字段策略

data-transfer.ts 使用 Zod 校验顶层 format、version、scope、数组字段、时间戳和枚举；无效 bundle 在事务开始前拒绝。格式固定为：

`ts
interface ConfluxDataBundle {
  format: "conflux-data";
  version: 1;
  exported_at: string;
  scope: "global" | "project";
  sessions: Session[];
  context_entries: ContextEntry[];
  messages: Message[];
  edges: GraphEdge[];
  agents: Agent[];
  conversations: Conversation[];
  turns: Turn[];
  runtime_agents: Array<Omit<RuntimeAgent, "api_key"> & {
    api_key_configured: boolean;
  }>;
}
`

默认 exportData 永远不写 api_key；includeSecrets 只允许 CLI 显式传入并要求二次确认，HTTP 和 UI 不支持导出明文 key。日志、审计和错误只记录 bundle 版本、scope、数量和冲突数量。

- [ ] 步骤 4：实现事务导入和接口

导入顺序为 sessions、agents/runtime_agents、edges、context_entries、conversations/turns、messages；所有外键资源先验证，导入在一个 SQLite transaction 中执行。skip 保留本地记录，overwrite 使用 bundle id 更新，copy 给冲突记录生成新的 UUID 或自增 id 并建立映射，确保外键仍指向副本。

增加 HTTP GET /data/export、POST /data/import 和 CLI data export、data import --conflict skip|overwrite|copy。web 设置页提供下载和选择 JSON 文件的入口，导入前显示 scope、版本和数量，成功后刷新所有查询。

- [ ] 步骤 5：运行数据迁移测试

运行：

`powershell
npm test -w apps/server -- --test-name-pattern="export|import|transfer"
npm run build -w packages/shared
npm run build -w apps/server
npm run build -w apps/web
`

预期：格式校验、敏感字段、三种冲突策略和事务回滚测试通过，三处构建成功。

- [ ] 步骤 6：Commit

`powershell
git add apps/server/src/core/data-transfer.ts apps/server/src/test/data-transfer.test.ts apps/server/src/core/db.ts apps/server/src/http/server.ts apps/server/src/cli/commands.ts packages/shared/src/index.ts apps/web/src/api.ts apps/web/src/components/SettingsTab.tsx
git commit -m "feat: add versioned data import and export"
`

### 任务 3：建立故障诊断和敏感信息扫描

**文件：** scripts/check-secrets.cjs、scripts/check-secrets.test.cjs、docs/TROUBLESHOOTING.md、apps/server/src/core/db.ts、apps/server/src/http/server.ts、package.json、README.md、docs/README.en.md。

- [ ] 步骤 1：编写扫描器和错误映射测试

`js
test("flags credential-shaped values but allows documented variable names", () => {
  assert.deepEqual(scanText("OPENAI_API_KEY=your-key-here"), []);
  assert.match(
    scanText("OPENAI_API_KEY=sk-live-12345678901234567890")[0],
    /credential/
  );
});

test("maps database errors to actionable public messages", () => {
  assert.deepEqual(publicError({ code: "SQLITE_BUSY" }), {
    code: "DATA_LOCKED",
    message: "数据库正在被另一个进程使用，请稍后重试或关闭重复的 Conflux 实例。",
  });
});
`

- [ ] 步骤 2：运行测试确认扫描器和错误码尚未实现

运行：node --test scripts/check-secrets.test.cjs。

预期：模块缺失或正例未被识别。

- [ ] 步骤 3：实现扫描和服务端稳定错误响应

扫描器读取显式传入的文件列表，忽略 node_modules、dist、数据库和测试占位符；匹配 OpenAI/Anthropic key 形状、Bearer token、私钥头和常见云凭据值。只输出路径、行号和类别，不输出匹配内容。根脚本增加 check:secrets。

HTTP error handler 将 SQLITE_BUSY、SQLITE_CORRUPT、EADDRINUSE、404、409 分别映射为稳定 code 和中文 message；原始错误只写 logger。数据库打开、checkpoint、migration 失败时响应包含 dataDir、恢复动作和是否保留源目录。

- [ ] 步骤 4：补齐中英文故障排查文档

README 中文优先说明 127.0.0.1:9527、Electron 与浏览器入口不能同时使用、端口冲突、MCP 配置重启和 ~/.muiltchat 数据位置。TROUBLESHOOTING.md 覆盖同一问题的命令、预期输出和恢复动作；docs/README.en.md 同步英文命令与兼容名称。

- [ ] 步骤 5：运行扫描、测试和文档命令

运行：

`powershell
node --test scripts/check-secrets.test.cjs
npm run check:secrets
npm test -w apps/server
npm run build
`

预期：扫描退出码为 0，不报告真实凭据；server 测试和根构建通过。

- [ ] 步骤 6：Commit

`powershell
git add scripts/check-secrets.cjs scripts/check-secrets.test.cjs docs/TROUBLESHOOTING.md apps/server/src/core/db.ts apps/server/src/http/server.ts package.json README.md docs/README.en.md
git commit -m "docs: add diagnostics and secret checks"
`

### 任务 4：配置 CI 和 Electron 发布流水线

**文件：** .github/workflows/ci.yml、.github/workflows/release.yml、package.json、package-lock.json、apps/desktop/electron-builder.yml、README.md、docs/README.en.md。

- [ ] 步骤 1：编写 workflow 静态断言

`js
test("CI workflow runs server tests, builds, desktop tests, and secret scan", () => {
  const ci = readFile(".github/workflows/ci.yml");
  assert.match(ci, /npm test -w apps\\/server/);
  assert.match(ci, /npm run build/);
  assert.match(ci, /test:desktop/);
  assert.match(ci, /check:secrets/);
});

test("release workflow builds Windows artifacts from a version tag", () => {
  const release = readFile(".github/workflows/release.yml");
  assert.match(release, /tags:/);
  assert.match(release, /windows-latest/);
  assert.match(release, /electron-builder/);
});
`

- [ ] 步骤 2：运行静态断言确认 workflow 尚未存在

运行：node --test scripts/check-secrets.test.cjs。

预期：workflow 断言在实现前失败；保持测试文件可执行。

- [ ] 步骤 3：实现 CI 矩阵

ci.yml 在 push、pull_request 和 workflow_dispatch 触发；Windows job 运行 npm ci、server 测试、shared/server/web 构建、desktop 测试和 check:secrets；Linux/macOS job 运行 npm ci、server 测试和构建，确保核心不依赖 Windows。失败时保留日志，禁止上传数据库和环境变量。

release.yml 只对 v* tag 触发，在 Windows runner 构建未签名 NSIS 和目录包，使用 actions/upload-artifact 上传安装包；版本来自 package.json/tag 校验，构建前运行完整测试和 secret scan。没有配置签名密钥时不得伪造签名状态。

- [ ] 步骤 4：实现发布脚本和 Builder 元数据

根 package 增加 ci:test、ci:build、package:desktop:dir；Builder 设置 appId 为 com.conflux.desktop、productName 为 Conflux、artifactName 包含版本和平台，Windows target 使用 nsis，Linux/macOS 支持目录构建。README 的发布章节写明安装包为未签名版本和数据目录不会随卸载删除。

- [ ] 步骤 5：本地复现 CI 命令

运行：

`powershell
npm ci
npm run check:secrets
npm test -w apps/server
npm run build
npm run test:desktop
npm run package:desktop -- --dir
`

预期：本地命令与 Windows CI 顺序一致，所有退出码为 0，dist 和 release 产物不进入 Git。

- [ ] 步骤 6：Commit

`powershell
git add .github/workflows/ci.yml .github/workflows/release.yml package.json package-lock.json apps/desktop/electron-builder.yml README.md docs/README.en.md
git commit -m "ci: add cross-platform desktop release checks"
`

### 任务 5：完成开源文档和发布验收

**文件：** CONTRIBUTING.md、CHANGELOG.md、docs/MIGRATION.md、README.md、docs/README.en.md、LICENSE、.mcp.json、.github/workflows/*.yml。

- [ ] 步骤 1：补齐贡献和迁移文档

CONTRIBUTING.md 明确 Node/npm 版本、npm ci、server/web/desktop 测试、代码风格、禁止提交数据库和密钥、PR 检查项及 Conventional Commit 示例。MIGRATION.md 给出旧 MCP key、旧 CLI、MUILTCHAT_HOME、~/.muiltchat 和显式 migrate 命令的兼容表，并写明源目录保留和备份标记位置。CHANGELOG.md 以 0.2.0 记录 Electron、Codex/Claude liveness、工作区、迁移和构建能力。

- [ ] 步骤 2：同步中英文 README

README.md 保持中文默认，包含 Conflux 首屏定位、Electron 快速启动、浏览器开发入口、MCP 重启提示、数据备份、安装包和故障排查链接。docs/README.en.md 与中文 README 的命令、状态和兼容说明同步，语言切换链接保持可用。

- [ ] 步骤 3：运行文档链接和敏感扫描

运行：

`powershell
npm run check:secrets
rg -n "README\\.en|MIGRATION|TROUBLESHOOTING|CONTRIBUTING|CHANGELOG" README.md docs/README.en.md CONTRIBUTING.md docs/MIGRATION.md
`

预期：扫描通过；中文和英文 README 都能找到迁移、排查、贡献和变更日志入口。

- [ ] 步骤 4：执行最终发布验收

运行：

`powershell
npm ci
npm test -w apps/server
npm run build
npm run test:desktop
npm run package:desktop -- --dir
npm run check:secrets
git diff --check
git status --short
`

预期：所有测试、构建、目录打包和扫描成功；工作区只保留计划允许的未提交变更；安装包启动后访问 127.0.0.1:9527，旧数据仍可读取，卸载不会删除数据目录。

- [ ] 步骤 5：Commit

`powershell
git add CONTRIBUTING.md CHANGELOG.md docs/MIGRATION.md README.md docs/README.en.md LICENSE .mcp.json
git commit -m "docs: prepare conflux open source release"
`
