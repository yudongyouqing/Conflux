# Hooks Backfill（issue #75）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `hooks install` 后反向扫描仍存活的 Claude Code 会话并补录进 Conflux 图谱，消除"装了 hooks 也检测不到存量会话"的假阴性。

**Architecture:** 新增 `core/hooks-backfill.ts`（唯一业务规则源）：进程侧存活 pid（复用 `probeRuntimePids`）与转录侧 jsonl 候选双向鉴定（cwd 相等 + 时间线 lastActivity ≥ 进程启动），通过 `registerSession` 与 `session-start` 同路径注册，并写 `claude-current:<pid>` 映射供 MCP 认领。CLI 增加 `hooks backfill` 子命令并在 `install` 成功后自动执行（best-effort）。全部 IO 可注入，核心逻辑纯函数化。

**Tech Stack:** TypeScript (Node ≥22)、better-sqlite3、commander、node:test + tsx、lsof/ps（进程 cwd 与启动时间）。

**Spec:** https://github.com/yudongyouqing/Conflux/issues/75（方案草案 + 验收标准）；配套 https://github.com/yudongyouqing/Conflux/issues/76 不在本计划范围。补录配方已于 2026-09-20 在 macOS 手工验证（转录鉴定 → `registerSession` 注册 → 存活探测接管）。

## Global Constraints

- `apps/server/src/core/` 是唯一业务规则源；CLI 只做薄适配（CLAUDE.md 架构边界）。
- 测试先行：会话生命周期相关改动先写可复现测试（CLAUDE.md 关键约定）。
- 仓库源码 LF，工作副本可能 CRLF：Edit 锚点匹配容忍 `\r`。
- 提交信息：中文 Conventional Commits + `(Ref #75)`；分支 `feat/75-hooks-backfill`（已从 origin/dev 创建于 `.worktrees/feat/75-hooks-backfill`）。
- 推送必须显式征得用户同意；feat PR 合并检查绿后停在 open 等人工合并。
- 验证清单：`npm test -w apps/server`、`npm run build`、`npm run lint`（0 error）。
- 单测运行单个文件（在 worktree 根）：`node --import tsx --test apps/server/src/test/hooks-backfill.test.ts`。
- 命名对齐现有代码：metadata 形状与 `session-start` 完全一致（`{source:"claude-hook", claude_pid, busy:false, named:true}`），`findSessionByRuntimePid(db, "claude", pid)` 已兼容 legacy `claude_pid` 行。

## 文件结构

- Create: `apps/server/src/core/hooks-backfill.ts` — 候选解析（纯）、扫描、进程信息、核心匹配/注册、真实 IO 组装
- Create: `apps/server/src/test/hooks-backfill.test.ts` — node:test 单测（makeDb + 注入 fake IO + tmpdir 转录夹具）
- Modify: `apps/server/src/cli/commands.ts` — hooks 段（约 :780-930）加 `backfill` 子命令 + install 尾部自动执行
- Modify: `README.md`、`docs/README.en.md` — Hooks 小节各加一行补录说明

**Interfaces（任务间契约）:**

```ts
// Task 1 产出（core/hooks-backfill.ts）
export interface BackfillCandidate {
  sessionId: string;          // 转录文件名去 .jsonl
  transcriptPath: string;
  projectDir: string | null;  // jsonl 首条 cwd 字段
  lastActivityMs: number | null; // jsonl 最后一条 timestamp
  firstPrompt: string | null; // 首条非 '<' 开头的 user 消息文本
}
export function parseTranscriptCandidate(text: string, transcriptPath: string): BackfillCandidate;
export function scanRecentTranscripts(claudeHome: string): BackfillCandidate[];
export const BACKFILL_WINDOW_MS = 30*24*60*60*1000; // 只看 30 天内 touch 过的转录
export const BACKFILL_PER_DIR = 5;                  // 每个项目目录按 mtime 取最近 5 个

// Task 2 产出
export interface RuntimeProcInfo { pid: number; cwd: string | null; startedAtMs: number | null }
export interface BackfillReport {
  registered: { id: string; pid: number; name: string }[];
  refreshed: number;      // 已有行补绑 pid（不覆盖名称）
  skippedBound: number;   // pid 已被某会话行绑定
  unmatchedPids: number;  // 无法与转录可信关联的存活 pid
}
export interface BackfillIo {
  livePids: Set<number>;
  procInfo(pid: number): Promise<RuntimeProcInfo | null>;
  recentTranscripts(): Promise<BackfillCandidate[]>;
}
export function backfillLiveClaudeSessions(db: DB, io: BackfillIo): Promise<BackfillReport>;

// Task 3 产出（真实 IO 组装 + CLI）
export function resolveClaudeHome(): string;  // CLAUDE_CONFIG_DIR || ~/.claude
export function runtimeProcInfo(pid: number): Promise<RuntimeProcInfo | null>; // lsof+ps；win32 → null
export function runBackfill(db: DB, claudeHome?: string): Promise<BackfillReport>;
```

---

### Task 1: 转录候选解析与扫描

**Files:**
- Create: `apps/server/src/core/hooks-backfill.ts`
- Test: `apps/server/src/test/hooks-backfill.test.ts`

**Interfaces:**
- Consumes: 无（首个任务；仅 node 内置 + 相对导入类型）
- Produces: `BackfillCandidate`、`parseTranscriptCandidate`、`scanRecentTranscripts`、`BACKFILL_WINDOW_MS`、`BACKFILL_PER_DIR`（Task 2/3 按上文签名引用）

- [ ] **Step 1: 写失败测试**

新建 `apps/server/src/test/hooks-backfill.test.ts`：

```ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDb } from "./helpers.js";
import {
  parseTranscriptCandidate,
  scanRecentTranscripts,
} from "../core/hooks-backfill.js";

const { db, cleanup } = makeDb();
after(cleanup);

const T0 = Date.parse("2026-09-20T01:00:00.000Z");

function line(j: unknown): string {
  return JSON.stringify(j) + "\n";
}

test("parseTranscriptCandidate extracts cwd, first prompt, last activity, session id", () => {
  const text =
    line({ type: "user", cwd: "/Users/x/proj", timestamp: "2026-09-20T00:00:01.000Z",
           message: { content: [{ type: "text", text: "帮我运行起来这个项目" }] } }) +
    line({ type: "assistant", timestamp: "2026-09-20T00:00:05.000Z" }) +
    "not-json-garbage\n" +
    line({ type: "user", timestamp: "2026-09-20T00:30:00.000Z",
           message: { content: "<command-name>/rename</command-name>" } });
  const c = parseTranscriptCandidate(text, "/fake/projects/-p/abc123.jsonl");
  assert.equal(c.sessionId, "abc123");
  assert.equal(c.projectDir, "/Users/x/proj");
  assert.equal(c.firstPrompt, "帮我运行起来这个项目");
  assert.equal(c.lastActivityMs, Date.parse("2026-09-20T00:30:00.000Z"));
});

test("parseTranscriptCandidate tolerates missing fields", () => {
  const c = parseTranscriptCandidate("garbage\n", "/x/deadbeef.jsonl");
  assert.equal(c.sessionId, "deadbeef");
  assert.equal(c.projectDir, null);
  assert.equal(c.firstPrompt, null);
  assert.equal(c.lastActivityMs, null);
});

test("scanRecentTranscripts reads per-dir latest N within window, skips old files", () => {
  const home = mkdtempSync(join(tmpdir(), "backfill-home-"));
  const old = join(home, "projects", "-old-", "old1.jsonl");
  const freshA = join(home, "projects", "-old-", "a.jsonl");
  const freshB = join(home, "projects", "-other-", "b.jsonl");
  mkdirSync(join(home, "projects", "-old-"), { recursive: true });
  mkdirSync(join(home, "projects", "-other-"), { recursive: true });
  const body = line({ type: "user", cwd: "/old", timestamp: "2026-09-20T00:00:00.000Z",
                      message: { content: "hello" } });
  for (const p of [old, freshA, freshB]) writeFileSync(p, body, "utf8");
  const past = new Date(T0 - 40 * 24 * 60 * 60 * 1000); // 40 天前 → 窗口外
  require("node:fs").utimesSync(old, past, past);
  const found = scanRecentTranscripts(home);
  const ids = found.map((c) => c.sessionId).sort();
  assert.deepEqual(ids, ["a", "b"]);
  rmSync(home, { recursive: true, force: true });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --import tsx --test apps/server/src/test/hooks-backfill.test.ts`
Expected: FAIL（`Cannot find module '../core/hooks-backfill.js'`）

- [ ] **Step 3: 最小实现**

新建 `apps/server/src/core/hooks-backfill.ts`：

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir, platform } from "node:os";

/**
 * Backfill for sessions that were already running when hooks got installed:
 * such sessions never saw SessionStart, so nothing registered them and the
 * graph looks empty even though claude/codex processes are alive. We match
 * live runtime pids against recent transcript files (cwd equality + timeline
 * "transcript activity after process start") and register the winners
 * through the same registerSession path SessionStart uses.
 *
 * Verified by hand on 2026-09-20 before this module existed (issue #75).
 */

// ---- types (consumed by later tasks; see plan interfaces block) ----------

export interface BackfillCandidate {
  sessionId: string;
  transcriptPath: string;
  projectDir: string | null;
  lastActivityMs: number | null;
  firstPrompt: string | null;
}

// ---- candidate parsing ----------------------------------------------------

/** First line of a prompt, squeezed to a short display name (hook parity). */
// (imported lazily from live.js in Task 2 — kept out of Task 1 scope)

/**
 * Parse one Claude Code transcript into a backfill candidate. Pure: text in,
 * candidate out. Malformed lines are skipped; the cwd field of any entry
 * names the project dir; the last timestamp wins for activity.
 */
export function parseTranscriptCandidate(
  text: string,
  transcriptPath: string,
): BackfillCandidate {
  let projectDir: string | null = null;
  let firstPrompt: string | null = null;
  let lastActivityMs: number | null = null;
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let j: {
      cwd?: unknown;
      timestamp?: unknown;
      type?: unknown;
      message?: { content?: unknown };
    };
    try {
      j = JSON.parse(trimmed);
    } catch {
      continue; // malformed line — skip
    }
    if (projectDir === null && typeof j.cwd === "string" && j.cwd) projectDir = j.cwd;
    if (typeof j.timestamp === "string") {
      const t = Date.parse(j.timestamp);
      if (!Number.isNaN(t)) lastActivityMs = t;
    }
    if (firstPrompt === null && j.type === "user") {
      const c = j.message?.content;
      let textContent: string | null = null;
      if (typeof c === "string") textContent = c;
      else if (Array.isArray(c)) {
        const parts = c
          .filter(
            (p): p is { type: "text"; text: string } =>
              !!p && typeof p === "object" &&
              (p as { type?: unknown }).type === "text" &&
              typeof (p as { text?: unknown }).text === "string",
          )
          .map((p) => p.text);
        if (parts.length > 0) textContent = parts.join(" ");
      }
      if (textContent) {
        const t = textContent.trim();
        // '<'-prefixed entries are command wrappers (/rename etc.), not prose
        if (t && !t.startsWith("<")) firstPrompt = t;
      }
    }
  }
  return {
    sessionId: basename(transcriptPath).replace(/\.jsonl$/, ""),
    transcriptPath,
    projectDir,
    lastActivityMs,
    firstPrompt,
  };
}

// ---- scanning ---------------------------------------------------------------

/** Only transcripts touched within this window are candidates. */
export const BACKFILL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Take the most recent N files per project dir (mtime desc). */
export const BACKFILL_PER_DIR = 5;

/**
 * Scan ~/.claude/projects/<dir>/*.jsonl for recent candidates. Scan-only —
 * no process knowledge here; matching lives in backfillLiveClaudeSessions.
 */
export function scanRecentTranscripts(claudeHome: string): BackfillCandidate[] {
  const projectsDir = join(claudeHome, "projects");
  const cutoff = Date.now() - BACKFILL_WINDOW_MS;
  const out: BackfillCandidate[] = [];
  let dirs: string[] = [];
  try {
    dirs = readdirSync(projectsDir);
  } catch {
    return out; // no projects dir — nothing to scan
  }
  for (const dir of dirs) {
    const full = join(projectsDir, dir);
    let files: string[] = [];
    try {
      files = readdirSync(full).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue; // unreadable dir — skip
    }
    const recent = files
      .map((f) => {
        const p = join(full, f);
        try {
          return { p, mtimeMs: statSync(p).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((x): x is { p: string; mtimeMs: number } => x !== null && x.mtimeMs >= cutoff)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, BACKFILL_PER_DIR);
    for (const { p } of recent) {
      try {
        out.push(parseTranscriptCandidate(readFileSync(p, "utf8"), p));
      } catch {
        // unreadable file — skip
      }
    }
  }
  return out;
}
```

注意：测试里 `require("node:fs")` 改为顶部 `import { utimesSync } from "node:fs"`（ESM 无 require，实现时直接用具名导入）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --import tsx --test apps/server/src/test/hooks-backfill.test.ts`
Expected: 3 passing

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/core/hooks-backfill.ts apps/server/src/test/hooks-backfill.test.ts
git commit -m "feat(server): 转录补录候选——jsonl 纯解析 + 项目目录近窗扫描 (Ref #75)"
```

---

### Task 2: 核心匹配与注册

**Files:**
- Modify: `apps/server/src/core/hooks-backfill.ts`
- Modify: `apps/server/src/test/hooks-backfill.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 1 的 `BackfillCandidate`；core 既有 `registerSession`/`getSession`/`mergeSessionMeta`（`core/sessions.js`）、`findSessionByRuntimePid`/`promptExcerpt`（`core/live.js`）、`getSetting`/`setSetting`（`core/app-settings.js`）、`HOOK_SESSION_DESCRIPTION`（`@conflux/shared`）
- Produces: `RuntimeProcInfo`、`BackfillReport`、`BackfillIo`、`backfillLiveClaudeSessions(db, io)`（Task 3 按上文签名引用）

- [ ] **Step 1: 追加失败测试**

在 `hooks-backfill.test.ts` 追加：

```ts
import {
  backfillLiveClaudeSessions,
  type BackfillCandidate,
  type BackfillIo,
} from "../core/hooks-backfill.js";
import { registerSession } from "../core/sessions.js";
import { getSetting } from "../core/app-settings.js";
import { HOOK_SESSION_DESCRIPTION } from "@conflux/shared";

const START = T0 - 60 * 60 * 1000;      // 进程 1h 前启动
const ACTIVE = T0 - 10 * 60 * 1000;     // 转录 10min 前活跃

function candidate(partial: Partial<BackfillCandidate>): BackfillCandidate {
  return {
    sessionId: "sess-1",
    transcriptPath: "/fake/sess-1.jsonl",
    projectDir: "/Users/x/proj",
    lastActivityMs: ACTIVE,
    firstPrompt: "帮我运行起来这个项目",
    ...partial,
  };
}

function io(pids: number[], proc: Record<number, { cwd: string; startedAtMs: number } | null>,
            transcripts: BackfillCandidate[]): BackfillIo {
  return {
    livePids: new Set(pids),
    procInfo: async (pid) => {
      const p = proc[pid];
      return p ? { pid, cwd: p.cwd, startedAtMs: p.startedAtMs } : null;
    },
    recentTranscripts: async () => transcripts,
  };
}

test("registers a live session from a matching transcript", async () => {
  const r = await backfillLiveClaudeSessions(
    db, io([100], { 100: { cwd: "/Users/x/proj", startedAtMs: START } }, [candidate({})]),
  );
  assert.equal(r.registered.length, 1);
  assert.deepEqual(r.registered[0], { id: "sess-1", pid: 100, name: "帮我运行起来这个项目" });
  const row = db.prepare("SELECT * FROM sessions WHERE id='sess-1'").get() as any;
  assert.equal(row.project_dir, "/Users/x/proj");
  assert.equal(JSON.parse(row.metadata).claude_pid, 100);
  assert.equal(JSON.parse(row.metadata).source, "claude-hook");
  assert.equal(row.description, HOOK_SESSION_DESCRIPTION);
  assert.equal(getSetting(db, "claude-current:100"), "sess-1");
});

test("second run is idempotent: pid already bound → skip, no duplicate row", async () => {
  const r = await backfillLiveClaudeSessions(
    db, io([100], { 100: { cwd: "/Users/x/proj", startedAtMs: START } }, [candidate({})]),
  );
  assert.equal(r.registered.length, 0);
  assert.equal(r.skippedBound, 1);
  const n = (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id='sess-1'").get() as any).n;
  assert.equal(n, 1);
});

test("existing pid-less row gets its pid merged, name untouched", async () => {
  registerSession(db, {
    id: "sess-2", name: "手动起的名字",
    metadata: { source: "claude-hook", named: true },
  });
  const r = await backfillLiveClaudeSessions(
    db, io([200], { 200: { cwd: "/Users/x/proj", startedAtMs: START } },
          [candidate({ sessionId: "sess-2" })]),
  );
  assert.equal(r.registered.length, 0);
  assert.equal(r.refreshed, 1);
  const row = db.prepare("SELECT * FROM sessions WHERE id='sess-2'").get() as any;
  assert.equal(row.name, "手动起的名字");
  assert.equal(JSON.parse(row.metadata).claude_pid, 200);
  assert.equal(getSetting(db, "claude-current:200"), "sess-2");
});

test("transcript older than process start → no match", async () => {
  const r = await backfillLiveClaudeSessions(
    db, io([300], { 300: { cwd: "/Users/x/proj", startedAtMs: START } },
          [candidate({ sessionId: "sess-3", lastActivityMs: START - 1000 })]),
  );
  assert.equal(r.registered.length, 0);
  assert.equal(r.unmatchedPids, 1);
});

test("cwd mismatch → no match", async () => {
  const r = await backfillLiveClaudeSessions(
    db, io([301], { 301: { cwd: "/Users/x/other", startedAtMs: START } }, [candidate({ sessionId: "s4" })]),
  );
  assert.equal(r.unmatchedPids, 1);
  assert.equal(r.registered.length, 0);
});

test("several matching candidates → most recent activity wins", async () => {
  const r = await backfillLiveClaudeSessions(
    db, io([400], { 400: { cwd: "/Users/x/proj", startedAtMs: START } }, [
      candidate({ sessionId: "older", lastActivityMs: START + 1000 }),
      candidate({ sessionId: "newer", lastActivityMs: ACTIVE }),
    ]),
  );
  assert.equal(r.registered[0].id, "newer");
});

test("no first prompt → name falls back to basename(cwd)", async () => {
  const r = await backfillLiveClaudeSessions(
    db, io([500], { 500: { cwd: "/Users/x/proj", startedAtMs: START } },
          [candidate({ sessionId: "s5", firstPrompt: null })]),
  );
  assert.equal(r.registered[0].name, "proj");
});

test("procInfo null (unverifiable process) → unmatched, nothing registered", async () => {
  const r = await backfillLiveClaudeSessions(db, io([600], { 600: null }, [candidate({ sessionId: "s6" })]));
  assert.equal(r.unmatchedPids, 1);
  assert.equal(r.registered.length, 0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --import tsx --test apps/server/src/test/hooks-backfill.test.ts`
Expected: FAIL（`backfillLiveClaudeSessions` 未导出）

- [ ] **Step 3: 实现**

在 `hooks-backfill.ts` 追加（顶部补导入 `getSession, mergeSessionMeta, registerSession` from `"./sessions.js"`、`findSessionByRuntimePid, promptExcerpt` from `"./live.js"`、`setSetting` from `"./app-settings.js"`、`HOOK_SESSION_DESCRIPTION` from `"@conflux/shared"`、`type DB` from `"./db.js"`）：

```ts
export interface RuntimeProcInfo {
  pid: number;
  cwd: string | null;
  startedAtMs: number | null;
}

export interface BackfillReport {
  registered: { id: string; pid: number; name: string }[];
  refreshed: number;
  skippedBound: number;
  unmatchedPids: number;
}

export interface BackfillIo {
  livePids: Set<number>;
  procInfo(pid: number): Promise<RuntimeProcInfo | null>;
  recentTranscripts(): Promise<BackfillCandidate[]>;
}

/**
 * Match live claude pids against recent transcripts and register the
 * winners exactly the way SessionStart would (same metadata shape, same
 * claude-current:<pid> marker for MCP adoption). Matching rule: transcript
 * cwd equals the process cwd AND the transcript was active after the
 * process started; the most recently active candidate wins a contested pid.
 * Rows that already exist (prompt-created, pid-less) only get the pid
 * merged — names are never overwritten (issue #75 idempotency clause).
 */
export async function backfillLiveClaudeSessions(
  db: DB,
  io: BackfillIo,
): Promise<BackfillReport> {
  const report: BackfillReport = { registered: [], refreshed: 0, skippedBound: 0, unmatchedPids: 0 };
  const claimed = new Set<string>();
  const transcripts = await io.recentTranscripts();
  for (const pid of io.livePids) {
    if (findSessionByRuntimePid(db, "claude", pid)) {
      report.skippedBound++;
      continue;
    }
    const info = await io.procInfo(pid);
    if (!info || info.cwd === null || info.startedAtMs === null) {
      report.unmatchedPids++;
      continue;
    }
    const matches = transcripts
      .filter(
        (c) =>
          c.projectDir === info.cwd &&
          c.lastActivityMs !== null &&
          c.lastActivityMs >= info.startedAtMs! &&
          !claimed.has(c.sessionId),
      )
      .sort((a, b) => (b.lastActivityMs ?? 0) - (a.lastActivityMs ?? 0));
    const best = matches[0];
    if (!best) {
      report.unmatchedPids++;
      continue;
    }
    claimed.add(best.sessionId);
    const existing = getSession(db, best.sessionId);
    if (existing) {
      mergeSessionMeta(db, best.sessionId, { claude_pid: pid });
      setSetting(db, `claude-current:${pid}`, best.sessionId);
      report.refreshed++;
      continue;
    }
    const name =
      promptExcerpt(best.firstPrompt ?? undefined) ??
      (info.cwd ? basename(info.cwd) : "claude");
    registerSession(db, {
      id: best.sessionId,
      name,
      description: HOOK_SESSION_DESCRIPTION,
      project_dir: best.projectDir,
      metadata: { source: "claude-hook", claude_pid: pid, busy: false, named: true },
    });
    setSetting(db, `claude-current:${pid}`, best.sessionId);
    report.registered.push({ id: best.sessionId, pid, name });
  }
  return report;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --import tsx --test apps/server/src/test/hooks-backfill.test.ts`
Expected: 全部 passing（Task 1 的 3 个 + 本任务 8 个）

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/core/hooks-backfill.ts apps/server/src/test/hooks-backfill.test.ts
git commit -m "feat(server): 会话补录内核——进程↔转录双向鉴定 + pid 绑定注册 (Ref #75)"
```

---

### Task 3: 真实 IO + CLI 接线 + 文档

**Files:**
- Modify: `apps/server/src/core/hooks-backfill.ts`（追加真实适配器）
- Modify: `apps/server/src/cli/commands.ts`（hooks 段：install 尾部 + 新 backfill 子命令）
- Modify: `README.md`、`docs/README.en.md`（Hooks 小节各一行）

**Interfaces:**
- Consumes: Task 2 全部产出；`probeRuntimePids`（`core/liveness.js`）；commands.ts 既有 `openDb`/`resolveConfig`/`logger`
- Produces: `resolveClaudeHome()`、`runtimeProcInfo(pid)`、`runBackfill(db, claudeHome?)`；CLI `conflux hooks backfill`；install 后自动补录

- [ ] **Step 1: 真实适配器（core/hooks-backfill.ts 追加）**

```ts
import { probeRuntimePids } from "./liveness.js";
import { logger } from "../log.js";

const execFileAsync = promisify(execFile);

/** CLAUDE_CONFIG_DIR-aware Claude home, same rule as claudeSettingsPath(). */
export function resolveClaudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/**
 * Process cwd (lsof) + start time (ps lstart, local tz). null fields mean
 * "could not determine" — the matcher treats them as unverifiable. win32
 * returns null outright: Phase 1 is macOS/Linux (issue #75 boundary note).
 */
export async function runtimeProcInfo(pid: number): Promise<RuntimeProcInfo | null> {
  if (platform() === "win32") return null;
  let cwd: string | null = null;
  let startedAtMs: number | null = null;
  try {
    const { stdout } = await execFileAsync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    const line = stdout.split("\n").find((l) => l.startsWith("n/"));
    if (line) cwd = line.slice(1);
  } catch {
    // lsof failed — cwd unknown
  }
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-o", "lstart=", "-p", String(pid)]);
    const t = Date.parse(stdout.trim());
    if (!Number.isNaN(t)) startedAtMs = t;
  } catch {
    // ps failed — start unknown
  }
  if (cwd === null && startedAtMs === null) return null;
  return { pid, cwd, startedAtMs };
}

/** Real-IO composition: live probe + on-demand transcript scan. */
export async function runBackfill(db: DB, claudeHome: string = resolveClaudeHome()): Promise<BackfillReport> {
  const snapshot = await probeRuntimePids();
  const livePids = snapshot?.claude ?? new Set<number>();
  let cache: BackfillCandidate[] | null = null;
  return backfillLiveClaudeSessions(db, {
    livePids,
    procInfo: (pid) => runtimeProcInfo(pid),
    recentTranscripts: async () => (cache ??= scanRecentTranscripts(claudeHome)),
  });
}
```

注意：`logger` 若本任务未用到则不导入（避免 lint unused）。

- [ ] **Step 2: CLI 接线（commands.ts）**

hooks 段 `install` action：签名改 `async function (this: Command)`，在成功 `console.log(...)` 之后追加：

```ts
      // Backfill sessions that were already running before hooks existed —
      // they never saw SessionStart and would otherwise surface as stale or
      // not at all (issue #75). Best-effort: install must not fail here.
      try {
        const report = await runBackfill(openDb(resolveConfig("global")));
        if (report.registered.length > 0 || report.refreshed > 0) {
          console.log(
            `backfilled ${report.registered.length} running session(s)` +
              (report.refreshed > 0 ? `, refreshed pid on ${report.refreshed} existing` : ""),
          );
        }
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "post-install backfill failed (non-fatal)",
        );
      }
```

`uninstall` 之后、`dispatch` 之前插入子命令：

```ts
  hooks
    .command("backfill")
    .description("register still-running Claude Code sessions that predate hooks install")
    .action(async function (this: Command) {
      const report = await runBackfill(openDb(resolveConfig("global")));
      for (const r of report.registered) {
        console.log(`registered ${r.id} (pid ${r.pid}) as "${r.name}"`);
      }
      if (report.refreshed > 0) console.log(`refreshed pid on ${report.refreshed} existing session(s)`);
      if (report.skippedBound > 0) console.log(`${report.skippedBound} process(es) already tracked`);
      if (report.unmatchedPids > 0) console.log(`${report.unmatchedPids} process(es) had no verifiable transcript`);
      if (report.registered.length === 0 && report.refreshed === 0) console.log("nothing to backfill");
    });
```

顶部 import 区追加：`import { runBackfill } from "../core/hooks-backfill.js";`（`logger`/`openDb`/`resolveConfig` 已在该文件使用，确认存在即可）。

- [ ] **Step 3: 回归 + 构建 + lint**

Run: `npm test -w apps/server && npm run build && npm run lint`
Expected: 测试全绿、build 成功、lint 0 error

- [ ] **Step 4: 真机验证（本机就是补录场景）**

```bash
node apps/server/dist/index.js hooks backfill
```
Expected（本机 3 个 claude 会话均已注册过）: `3 process(es) already tracked` + `nothing to backfill`。
再跑一次 `hooks install`（幂等重装）确认尾部自动补录不报错、输出不重复注册。

- [ ] **Step 5: 文档一行**

`README.md` Hooks 小节（"npx tsx apps/server/src/index.ts hooks install" 代码块后）加：

```markdown
`hooks install` 会自动补录安装时已在运行的 Claude Code 会话（也可单独执行 `hooks backfill`）；Codex 会话暂不支持补录。
```

`docs/README.en.md` 对应小节加：

```markdown
`hooks install` also backfills Claude Code sessions that were already running at install time (or run `hooks backfill` standalone); Codex backfill is not supported yet.
```

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/core/hooks-backfill.ts apps/server/src/cli/commands.ts README.md docs/README.en.md
git commit -m "feat(server): hooks backfill 子命令——install 后自动补录存量会话 (Ref #75)"
```

---

## Self-Review 记录

- 规格覆盖：#75 方案 1-5 点 ↔ Task 1（转录侧 2）、Task 2（进程侧 1 + 鉴定 3 + 注册 4 + 幂等 5）、Task 3（CLI + install 自动触发 + CLAUDE_CONFIG_DIR）；验收标准 5 条 ↔ Task 2 测试 1/2/3 + Task 3 真机步骤 4（active 由既有 reconcile 接管，Task 2 测试 1 断言了它依赖的 `claude_pid` 形状）。
- 占位符：无 TBD/TODO；所有代码块可直接落盘（ESM require 已在文中标注改为具名导入）。
- 类型一致性：`BackfillCandidate`/`RuntimeProcInfo`/`BackfillIo`/`BackfillReport` 与 `findSessionByRuntimePid(db, runtime, pid)`（dev 实参顺序）、`promptExcerpt(string|undefined)`、`getSession(db,id)`、`getSetting(db,key)` 签名逐一核对过 dev 源码。
- 已知边界（写入实现的注释）：win32 Phase 1 不支持；同一转录被两个 pid 争抢时 `claimed` 集合保证只注册一次；`lsof`/`ps` 失败按"无法鉴定"计入 unmatchedPids 而非报错。
