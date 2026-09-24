/** Deterministic fixture for the screenshot rig (#113). Runs via tsx. */
import { openDb } from "../../apps/server/src/core/db.js";
import { resolveConfig } from "../../apps/server/src/config.js";
import { registerSession } from "../../apps/server/src/core/sessions.js";
import { askSession, replyAsk } from "../../apps/server/src/core/messages.js";
import { publishContext } from "../../apps/server/src/core/context.js";

const home = process.argv[2];
if (!home) {
  console.error("usage: tsx seed-core.ts <CONFLUX_HOME>");
  process.exit(2);
}
process.env.CONFLUX_HOME = home;
const db = openDb(resolveConfig("global"));
const S: [string, string, string, string, string, boolean][] = [
  ["cap-claude-conflux", "Conflux", "P0", "图谱工作台：Electron+React 工作空间开发", "claude", true],
  ["cap-claude-voice", "voice-agent", "P1", "TAPD 话术校验需求开发中", "claude", false],
  ["cap-codex-mica", "winGhostty", "P1", "Mica 终端 M1-B 冒烟测试", "codex", false],
  ["cap-agent-recall", "AgentRecall", "P2", "会话记忆检索实验", "claude", false],
];
for (const [id, dir, pr, desc, runtime, busy] of S) {
  registerSession(db, {
    id,
    name: dir,
    description: desc,
    project_dir: "/Users/dev/code/" + dir,
    metadata: {
      source: "claude-hook",
      priority: pr,
      runtime,
      busy,
      named: true,
      agent_card: { skills: ["typescript", "electron", dir === "winGhostty" ? "rust" : "node"] },
    },
  });
}
registerSession(db, { id: "web-console", name: "Web 控制台", description: "浏览器界面身份" });
askSession(db, {
  from_session: "cap-claude-conflux",
  to_session: "cap-codex-mica",
  question: "M1-B 冒烟清单在哪台机器跑？",
});
replyAsk(db, 1, "cap-codex-mica", "Windows 真机，13 条清单已过 9 条。");
publishContext(db, {
  session_id: "cap-claude-conflux",
  title: "唤醒系统架构",
  content: "三分诊（忙/空闲/离线）→ 策略 → 统一 spawn；提示词走 stdin。",
  tags: ["wake", "architecture"],
});
console.log("seeded", home);
