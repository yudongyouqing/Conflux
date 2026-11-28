/** Deterministic fixture for the screenshot rig and browser smoke tests. Runs via tsx. */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { WEB_CONSOLE_ID, type RuntimeId } from "@conflux/shared";
import { openDb, stopWalCheckpoint } from "../../apps/server/src/core/db.js";
import { resolveConfig } from "../../apps/server/src/config.js";
import { ensureProjectForDir } from "../../apps/server/src/core/projects.js";
import { insertThread } from "../../apps/server/src/core/threads/store.js";
import { askThread, replyMessage } from "../../apps/server/src/core/messages.js";
import { publishContext } from "../../apps/server/src/core/context.js";

async function seed(home: string) {
  const db = openDb(resolveConfig("global", home));
  const addThread = (id: string, name: string, dir: string, runtime: RuntimeId) => {
    const workdir = join(home, "projects", dir);
    mkdirSync(workdir, { recursive: true });
    return insertThread(db, {
      id,
      name,
      project_id: ensureProjectForDir(db, workdir)!.id,
      workdir,
      kind: "external",
      runtime,
    });
  };
  try {
    const conflux = addThread("cap-claude-conflux", "Conflux", "Conflux", "claude");
    addThread("cap-claude-voice", "voice-agent", "voice-agent", "claude");
    const mica = addThread("cap-codex-mica", "winGhostty", "winGhostty", "codex");
    addThread("cap-agent-recall", "AgentRecall", "AgentRecall", "claude");
    const { message } = await askThread(db, {
      from_thread: conflux.id,
      to_thread: mica.id,
      question: "M1-B 冒烟清单在哪台机器跑？",
    });
    replyMessage(db, message.id, mica.id, "Windows 真机，13 条清单已过 9 条。");
    publishContext(db, {
      thread_id: conflux.id,
      project_id: conflux.project_id,
      title: "唤醒系统架构",
      content: "三分诊（忙/空闲/离线）→ 策略 → 统一 spawn；提示词走 stdin。",
      tags: ["wake", "architecture"],
    });
    if (process.argv.includes("--controls")) {
      await askThread(db, {
        from_thread: WEB_CONSOLE_ID,
        to_thread: conflux.id,
        question: "隔离测试：待处理的同伴通话",
      });
    }
    if (process.argv.includes("--chat-first")) {
      // External threads receive messages in the MCP inbox without launching a CLI.
      addThread("cap-chat-first", "验收会话", "smoke-room", "codex");
      addThread("cap-chat-twin", "验收会话", "smoke-room", "codex");
    }
    console.log("seeded", home);
  } finally {
    stopWalCheckpoint(db);
    db.close();
  }
}

const home = process.argv[2];
if (!home) {
  console.error("usage: tsx seed-core.ts <CONFLUX_HOME> [--controls] [--chat-first]");
  process.exitCode = 2;
} else {
  seed(home).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
