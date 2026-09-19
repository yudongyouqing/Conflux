# 新机开发环境搭建 / New Machine Setup

> 在一台新机器上从零跑起 Conflux 的完整清单。照着做即可，不依赖任何历史会话记忆。

## 中文

### 前置要求

- Node.js **22 LTS**（`node -v` 确认；server 包声明 ≥18 兼容）
- npm ≥ 9
- Git
- Claude Code CLI（AI 协作工作流需要；登录同一账号）
- 仅打包桌面安装包时：Visual Studio C++ Build Tools（better-sqlite3 原生重编）

### ⚠️ 克隆路径不要带空格

`node-gyp` 无法在含空格的路径下重编原生模块（实测：`C:\Project folder\...` 下本地打包直接失败）。建议：

```bash
git clone https://github.com/yudongyouqing/Conflux.git C:\dev\Conflux
cd C:\dev\Conflux
```

### 安装与同步

```bash
npm ci
npm run skills:sync   # ⚠️ 必须跑：.claude/skills/ 是生成产物（已 gitignore）
```

`skills:sync` 把 `.agents/skills/`（编辑源）镜像到 `.claude/skills/`（Claude Code 只读这个路径）。不加这一步，Claude Code 没有任何技能可用。

### 机器本地的三件事（每个新机都要重做）

1. **Claude hooks**：
   ```bash
   npx tsx apps/server/src/index.ts hooks install
   ```
   hooks 写入的是本机仓库的绝对路径，换机必须重装。装完确认 `~/.claude/settings.json`。
2. **会话数据（可选）**：要带走历史会话/消息，把老机器的 `~/.muiltchat` 整个目录拷到新机同位置；或轻装上阵（首次启动自动建新库）。精细迁移用 `conflux data export/import`。
3. **权限授权**：`.claude/settings.local.json` 是机器本地的（已 gitignore），Bash/推送等权限在新机重新批一遍。

### AI 工具挂载

- **Claude Code MCP**：仓库根的 `.mcp.json` 已含 conflux server（相对路径，免配置）；改动后需完全重启 MCP 宿主。
- **Codex**：仓库根的 `.codex/config.toml` 已含项目级挂载（trusted 项目生效）；首次在新目录启动 Codex 需批准信任。

### 验证清单（与 CI 等价）

```bash
npm run build              # shared → server → web
npm test -w apps/server    # server 回归
npm run test:desktop       # 桌面端测试
npm run lint               # 0 error
npm run dev:desktop        # 拉起桌面端
```

全部通过即环境就绪。

---

## English

### Requirements

- Node.js **22 LTS** (`node -v`; the server package declares ≥18 compatibility)
- npm ≥ 9
- Git
- Claude Code CLI (for the AI workflow; sign in with the same account)
- Visual Studio C++ Build Tools only when packaging the desktop installer (better-sqlite3 native rebuild)

### ⚠️ Clone path must not contain spaces

`node-gyp` cannot rebuild native modules under a path with spaces (verified: local packaging fails under `C:\Project folder\...`). Prefer:

```bash
git clone https://github.com/yudongyouqing/Conflux.git C:\dev\Conflux
cd C:\dev\Conflux
```

### Install & sync

```bash
npm ci
npm run skills:sync   # ⚠️ required: .claude/skills/ is a generated artifact (gitignored)
```

`skills:sync` mirrors `.agents/skills/` (the editing source) into `.claude/skills/` (the only path Claude Code reads). Without it, Claude Code has no skills.

### Three machine-local things (redo on every new machine)

1. **Claude hooks**: `npx tsx apps/server/src/index.ts hooks install` — the hook command embeds this clone's absolute path, so reinstall per machine; verify `~/.claude/settings.json`.
2. **Session data (optional)**: copy the old machine's `~/.muiltchat` directory to the same location to keep history, or start fresh (the database is created on first launch). Fine-grained migration: `conflux data export/import`.
3. **Permission grants**: `.claude/settings.local.json` is machine-local (gitignored) — approve Bash/push permissions again on the new machine.

### AI tool mounting

- **Claude Code MCP**: the repo-root `.mcp.json` already defines the conflux server (relative paths, zero config); fully restart the MCP host after any change.
- **Codex**: the repo-root `.codex/config.toml` carries the project-scope mount (trusted projects only); approve project trust on first launch in a new directory.

### Verification checklist (CI-equivalent)

```bash
npm run build
npm test -w apps/server
npm run test:desktop
npm run lint
npm run dev:desktop
```

All green → environment ready.
