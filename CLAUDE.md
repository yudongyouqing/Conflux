# CLAUDE.md

Conflux（内部名 muiltchat）：本地优先的 AI 编程会话协作工作空间。Electron 桌面壳 + React 工作空间 + Fastify/SQLite 内核，MCP/HTTP/CLI 三接口共用同一 core。

## 常用命令

```bash
npm run dev:desktop        # Electron 开发模式（唯一推荐入口，自动起 server+vite）
npm run dev:all            # 纯浏览器开发（与 dev:desktop 互斥，端口冲突）
npm test -w apps/server    # server 回归测试（core 层）
node --test apps/desktop/test/dev-services.test.cjs apps/desktop/test/runtime-config.test.cjs apps/desktop/test/security.test.cjs
npm run build              # shared → server → web 全量构建
npm run lint               # eslint（server/web/shared 源码）
npm run format             # prettier
```

端口：API 9527（`/docs` 有 OpenAPI）、Vite 5173。数据目录 `~/.muiltchat`（`MUILTCHAT_HOME` 覆盖）。

## 架构边界（改代码前必读）

- `apps/server/src/core/` 是**唯一业务规则源**；HTTP/MCP/CLI 都是薄适配层，不写业务逻辑。
- HTTP 路由按资源拆在 `src/http/routes/*.ts`，共享 `ServerContext`（DB + 错误映射 + 审计助手），`server.ts` 只做引导。
- 唤醒系统独立在 `core/wake/`：`index.ts` 三分诊（忙/空闲/离线）→ `claude.ts`/`codex.ts` 策略 → `launcher.ts` 统一 spawn。提示词一律经 **stdin** 投递（cmd 引号/换行会截断命令行参数——血泪教训）。
- Codex 的 rollout 读取在 `core/codex-rollout.ts`（纯 IO），标题/busy 派生策略在 `core/codex-titles.ts`。
- 四条 ask 路径统一走 `core/ask.ts` 的 `askAndMaybeWake`。
- 进程识别令牌表在 `core/runtime-identity.ts`（live.ts 祖先回溯脚本内嵌了一份副本，改动时需同步）。

## 关键约定

- **MCP stdout 只输出 JSON-RPC**，日志一律 stderr（`src/log.ts` 的 pino sink）。
- Claude hooks 跑的是 `apps/server/dist/` 编译产物——改 hook 相关逻辑后必须 `npm run build` 才生效。
- 平台陷阱：仓库源码行尾 LF（`.gitattributes` 归一），但工作副本常为 CRLF；写脚本改文件时锚点匹配要容忍 `\r`。
- Codex 硬约束：TUI 打开时线程写锁生效，任何进程无法 resume 该会话（"already has an active writer"）；且 codex 给 MCP 子进程净化环境——身份冒用走 pid 钉扎（`wake/launcher.ts`），不走 env。
- 测试先行：涉及会话生命周期的缺陷先写可复现测试再修；完成声明须附实际跑过的命令与结果。

## 验证清单（提交前）

1. `npm test -w apps/server`
2. `node --test apps/desktop/test/*.test.cjs`（改动桌面运行时时）
3. `npm run build`
4. `npm run lint`（保持 0 error）
5. UI 改动：`npx playwright screenshot` 截图自查（playwright 已是 devDependency）
