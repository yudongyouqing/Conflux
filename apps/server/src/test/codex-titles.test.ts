import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshCodexSessionTitles } from "../core/codex-titles.js";
import { getSession, registerSession } from "../core/sessions.js";
import { makeDb } from "./helpers.js";

const { db, cleanup } = makeDb();
after(cleanup);

const AUTO_DESCRIPTION = "Codex session (auto-registered)";

function fakeCodexHome(): string {
  return mkdtempSync(join(tmpdir(), "muiltchat-codex-home-"));
}

function disposeHome(home: string): void {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // Windows may hold a handle briefly; temp dirs are disposable.
  }
}

function writeRollout(
  home: string,
  opts: { uuid: string; cwd: string; startedAtMs: number; prompts: string[] }
): void {
  const d = new Date(opts.startedAtMs);
  const p = (n: number) => String(n).padStart(2, "0");
  const dir = join(
    home,
    "sessions",
    `${d.getFullYear()}`,
    p(d.getMonth() + 1),
    p(d.getDate())
  );
  mkdirSync(dir, { recursive: true });
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  const lines = [
    {
      timestamp: new Date(opts.startedAtMs).toISOString(),
      ordinal: 0,
      type: "session_meta",
      payload: {
        id: opts.uuid,
        session_id: opts.uuid,
        timestamp: new Date(opts.startedAtMs).toISOString(),
        cwd: opts.cwd,
        originator: "codex-tui",
        source: "cli",
      },
    },
    ...opts.prompts.map((text, i) => ({
      timestamp: new Date(opts.startedAtMs + 1000 * (i + 1)).toISOString(),
      ordinal: i + 1,
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    })),
  ];
  writeFileSync(
    join(dir, `rollout-${stamp}-${opts.uuid}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n"),
    "utf8"
  );
}

function writeSessionIndex(home: string, entries: Array<{ id: string; thread_name: string }>): void {
  writeFileSync(
    join(home, "session_index.jsonl"),
    entries.map((e) => JSON.stringify(e)).join("\n"),
    "utf8"
  );
}

function registerCodexSession(id: string, projectDir: string, metadata: object): void {
  registerSession(db, {
    id,
    name: projectDir.replace(/\\/g, "/").split("/").pop() || "session",
    description: AUTO_DESCRIPTION,
    project_dir: projectDir,
    metadata: { temp: true, runtime: "codex", runtime_pid: 12345, ...metadata },
  });
}

describe("refreshCodexSessionTitles", () => {
  const UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  it("titles from thread_name, describes from last prompt, drops temp", () => {
    const home = fakeCodexHome();
    const cwd = "C:\\Work\\Svc Alpha";
    writeRollout(home, {
      uuid: UUID,
      cwd: "c:\\work\\svc alpha", // case + separators differ — must still match
      startedAtMs: Date.now() - 5_000,
      prompts: [
        "<environment_context>\n  <cwd>C:\\Work\\Svc Alpha</cwd>\n</environment_context>",
        "# AGENTS.md instructions for C:\\Work\\Svc Alpha\nbe helpful",
        "fix the login bug",
        "now polish error messages",
      ],
    });
    writeSessionIndex(home, [{ id: UUID, thread_name: "登录修复任务" }]);
    registerCodexSession("codex-titled", cwd, {});

    const updated = refreshCodexSessionTitles(db, { codexHome: home, onlySessionId: "codex-titled" });
    const s = getSession(db, "codex-titled")!;
    assert.equal(updated, 1);
    assert.equal(s.name, "登录修复任务");
    assert.equal(s.description, "now polish error messages");
    const meta = JSON.parse(s.metadata!);
    assert.equal(meta.named, true);
    assert.equal(meta.codex_session_id, UUID);
    assert.equal(meta.codex_name, "登录修复任务");
    assert.equal(meta.codex_title, "thread");
    assert.equal(meta.temp, undefined);
    disposeHome(home);
  });

  it("falls back to the first real prompt when no thread_name exists", () => {
    const home = fakeCodexHome();
    const cwd = "C:\\Work\\Svc Beta";
    writeRollout(home, {
      uuid: "11111111-2222-3333-4444-555555555555",
      cwd,
      startedAtMs: Date.now() - 5_000,
      prompts: [
        "<environment_context>\nstuff</environment_context>",
        "Another language model started to solve the task. Continue.",
        "refactor the parser module",
      ],
    });
    // index exists but has no entry for this uuid
    writeSessionIndex(home, [{ id: "00000000-0000-0000-0000-000000000000", thread_name: "other" }]);
    registerCodexSession("codex-prompt", cwd, {});

    const updated = refreshCodexSessionTitles(db, { codexHome: home, onlySessionId: "codex-prompt" });
    const s = getSession(db, "codex-prompt")!;
    assert.equal(updated, 1);
    assert.equal(s.name, "refactor the parser module");
    assert.equal(s.description, "refactor the parser module");
    assert.equal(JSON.parse(s.metadata!).codex_title, "prompt");
    disposeHome(home);
  });

  it("picks the rollout nearest the session's created_at among same-cwd candidates", () => {
    const home = fakeCodexHome();
    const cwd = "C:\\Work\\Svc Gamma";
    const near = { uuid: "99999999-8888-7777-6666-555555555555", prompt: "near rollout task" };
    const far = { uuid: "12121212-3434-5656-7878-909090909090", prompt: "far rollout task" };
    // far rollout: started 3 days ago but written LAST (newest mtime) —
    // nearest-start must win over mtime
    writeRollout(home, {
      uuid: far.uuid,
      cwd,
      startedAtMs: Date.now() - 3 * 86_400_000,
      prompts: [far.prompt],
    });
    writeRollout(home, {
      uuid: near.uuid,
      cwd,
      startedAtMs: Date.now() - 8_000,
      prompts: [near.prompt],
    });
    registerCodexSession("codex-near", cwd, {});

    refreshCodexSessionTitles(db, { codexHome: home, onlySessionId: "codex-near" });
    const s = getSession(db, "codex-near")!;
    assert.equal(s.name, near.prompt);
    disposeHome(home);
  });

  it("rebinds to the stamped codex_session_id even when a newer rollout appears", () => {
    const home = fakeCodexHome();
    const cwd = "C:\\Work\\Svc Delta";
    const stamped = "55555555-4444-3333-2222-111111111111";
    writeRollout(home, {
      uuid: stamped,
      cwd,
      startedAtMs: Date.now() - 2 * 86_400_000,
      prompts: ["stamped rollout task"],
    });
    writeRollout(home, {
      uuid: "66666666-7777-8888-9999-000000000000",
      cwd,
      startedAtMs: Date.now() - 5_000,
      prompts: ["new rollout task"],
    });
    registerCodexSession("codex-rebind", cwd, {
      codex_session_id: stamped,
      codex_name: "stamped rollout task",
      named: true,
    });

    refreshCodexSessionTitles(db, { codexHome: home, onlySessionId: "codex-rebind" });
    const s = getSession(db, "codex-rebind")!;
    assert.equal(s.name, "stamped rollout task");
    assert.equal(JSON.parse(s.metadata!).codex_session_id, stamped);
    disposeHome(home);
  });

  it("leaves externally renamed and preset-agent rows alone", () => {
    const home = fakeCodexHome();
    const cwd = "C:\\Work\\Svc Epsilon";
    writeRollout(home, {
      uuid: "abcdefab-cdef-abcd-efab-cdefabcdefab",
      cwd,
      startedAtMs: Date.now() - 5_000,
      prompts: ["some task"],
    });
    // register_session'd row: description no longer the placeholder
    registerSession(db, {
      id: "codex-custom",
      name: "my deliberate name",
      description: "chosen by the model",
      project_dir: cwd,
      metadata: { runtime: "codex", runtime_pid: 1 },
    });
    // runtime-agent preset row: named by its preset
    registerCodexSession("codex-preset", cwd, { agent_id: 7 });

    assert.equal(refreshCodexSessionTitles(db, { codexHome: home, onlySessionId: "codex-custom" }), 0);
    assert.equal(refreshCodexSessionTitles(db, { codexHome: home, onlySessionId: "codex-preset" }), 0);
    assert.equal(getSession(db, "codex-custom")!.name, "my deliberate name");
    assert.equal(getSession(db, "codex-preset")!.name, "Svc Epsilon");
    disposeHome(home);
  });

  it("titles via the created_at window when cwd never matches (global MCP config)", () => {
    const home = fakeCodexHome();
    registerCodexSession("codex-weak", "C:FixedMcpCwd", {});
    db.prepare(
      `UPDATE sessions SET created_at = ? WHERE id = 'codex-weak'`
    ).run(new Date(Date.now() - 10_000).toISOString());
    // rollout lives in a completely different directory, started AFTER the
    // row existed (first prompt comes after codex launch)
    writeRollout(home, {
      uuid: "cacacaca-bcbc-dede-fefe-abababababab",
      cwd: "C:RealWork",
      startedAtMs: Date.now() + 1_000,
      prompts: ["audit the webpack config"],
    });

    const updated = refreshCodexSessionTitles(db, { codexHome: home, onlySessionId: "codex-weak" });
    const s = getSession(db, "codex-weak")!;
    assert.equal(updated, 1);
    assert.equal(s.name, "audit the webpack config");
    disposeHome(home);
  });

  it("claims each rollout for at most one row among concurrent siblings", () => {
    const home = fakeCodexHome();
    const cwd = "C:WorkSvc Twins";
    registerCodexSession("codex-twin-a", cwd, {});
    registerCodexSession("codex-twin-b", cwd, {});
    db.prepare(
      `UPDATE sessions SET created_at = ? WHERE id = 'codex-twin-a'`
    ).run(new Date(Date.now() - 10_000).toISOString());
    writeRollout(home, {
      uuid: "1a1a1a1a-2b2b-3c3c-4d4d-5e5e5e5e5e5e",
      cwd,
      startedAtMs: Date.now() - 5_000,
      prompts: ["first sibling task"],
    });
    writeRollout(home, {
      uuid: "6f6f6f6f-7a7a-8b8b-9c9c-0d0d0d0d0d0d",
      cwd,
      startedAtMs: Date.now() + 2_000,
      prompts: ["second sibling task"],
    });

    const updated = refreshCodexSessionTitles(db, { codexHome: home });
    const a = getSession(db, "codex-twin-a")!;
    const b = getSession(db, "codex-twin-b")!;
    assert.equal(updated, 2);
    assert.equal(a.name, "first sibling task"); // older row takes the earlier rollout
    assert.equal(b.name, "second sibling task");
    assert.notEqual(a.name, b.name);
    db.prepare("DELETE FROM sessions WHERE id IN ('codex-twin-a', 'codex-twin-b')").run();
    disposeHome(home);
  });

  it("claims a rollout written hours after the row was created (long-idle window)", () => {
    const home = fakeCodexHome();
    registerCodexSession("codex-idle", "C:WorkSvc Idle", {});
    db.prepare(
      `UPDATE sessions SET created_at = ? WHERE id = 'codex-idle'`
    ).run(new Date(Date.now() - 3 * 3_600_000).toISOString());
    writeRollout(home, {
      uuid: "d0d0d0d0-c3c3-b4b4-a5a5-e6e6e6e6e6e6",
      cwd: "C:SomewhereElse",
      startedAtMs: Date.now() - 30_000,
      prompts: ["evening task after long idle"],
    });

    const updated = refreshCodexSessionTitles(db, { codexHome: home, onlySessionId: "codex-idle" });
    const s = getSession(db, "codex-idle")!;
    assert.equal(updated, 1);
    assert.equal(s.name, "evening task after long idle");
    disposeHome(home);
  });

  it("prefers the row with the tighter launch gap over an older idle sibling", () => {
    const home = fakeCodexHome();
    const cwd = "C:WorkSvc Race";
    registerCodexSession("codex-old-idle", cwd, {});
    db.prepare(
      `UPDATE sessions SET created_at = ? WHERE id = 'codex-old-idle'`
    ).run(new Date(Date.now() - 3 * 3_600_000).toISOString());
    registerCodexSession("codex-fresh", cwd, {});
    db.prepare(
      `UPDATE sessions SET created_at = ? WHERE id = 'codex-fresh'`
    ).run(new Date(Date.now() - 60_000).toISOString());
    writeRollout(home, {
      uuid: "e1e1e1e1-f2f2-a3a3-b4b4-c5c5c5c5c5c5",
      cwd,
      startedAtMs: Date.now() - 10_000,
      prompts: ["fresh session prompt"],
    });

    const updated = refreshCodexSessionTitles(db, { codexHome: home });
    assert.equal(updated, 1);
    assert.equal(getSession(db, "codex-fresh")!.name, "fresh session prompt");
    const placeholder = cwd.replace(/[\/]+/g, "/").split("/").pop()!;
    assert.equal(getSession(db, "codex-old-idle")!.name, placeholder); // placeholder kept
    db.prepare("DELETE FROM sessions WHERE id IN ('codex-old-idle', 'codex-fresh')").run();
    disposeHome(home);
  });

  it("claims a resumed conversation appending to an old rollout (codex resume)", () => {
    const home = fakeCodexHome();
    const cwd = "C:WorkSvc Resume";
    // original conversation started 5 days ago; the user resumed it today
    // and typed "你好" — new turns were APPENDED to the old file
    writeRollout(home, {
      uuid: "ab12ab12-cd34cd34-ef56ef56-01-0123456789ab".replace(/[^a-f0-9]/g, "").slice(0, 8) + "-aaaa-bbbb-cccc-dddddddddddd",
      cwd,
      startedAtMs: Date.now() - 5 * 86_400_000,
      prompts: ["fix the missing session bug", "帮我启动一下", "你好"],
    });
    registerCodexSession("codex-resume", cwd, {});

    const updated = refreshCodexSessionTitles(db, { codexHome: home, onlySessionId: "codex-resume" });
    const s = getSession(db, "codex-resume")!;
    assert.equal(updated, 1);
    assert.equal(s.name, "fix the missing session bug"); // thread identity = original task
    assert.equal(s.description, "你好"); // latest activity = today's prompt
    disposeHome(home);
  });

  it("ignores old rollouts whose mtime is stale (just history, not a resume)", () => {
    const home = fakeCodexHome();
    const cwd = "C:WorkSvc Hist";
    writeRollout(home, {
      uuid: "99887766-5544-3322-1100-aabbccddeeff",
      cwd,
      startedAtMs: Date.now() - 5 * 86_400_000,
      prompts: ["ancient task"],
    });
    // push mtime 2h back — no one has written to this thread for a while
    const d = new Date(Date.now() - 5 * 86_400_000);
    const p2 = (n: number) => String(n).padStart(2, "0");
    const dayDir = join(home, "sessions", String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()));
    const file = readdirSync(dayDir).find((f) => f.endsWith(".jsonl"))!;
    const stale = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(join(dayDir, file), stale, stale);
    registerCodexSession("codex-hist", cwd, {});

    const updated = refreshCodexSessionTitles(db, { codexHome: home, onlySessionId: "codex-hist" });
    assert.equal(updated, 0);
    const placeholder = cwd.replace(/[\/]+/g, "/").split("/").pop()!;
    assert.equal(getSession(db, "codex-hist")!.name, placeholder);
    disposeHome(home);
  });

  it("toggles busy from the rollout's mtime freshness", () => {
    const home = fakeCodexHome();
    const cwd = "C:WorkSvc Busy";
    const uuid = "3f3f3f3f-4e4e-5d5d-6c6c-7b7b7b7b7b7b";
    writeRollout(home, { uuid, cwd, startedAtMs: Date.now() - 60_000, prompts: ["busy work task"] });
    registerCodexSession("codex-busy", cwd, {});
    refreshCodexSessionTitles(db, { codexHome: home, onlySessionId: "codex-busy" });
    // rollout was just written — fresh mtime means mid-turn
    assert.equal(JSON.parse(getSession(db, "codex-busy")!.metadata!).busy, true);

    // mtime pushed 5 minutes back — idle again
    const p2 = (n: number) => String(n).padStart(2, "0");
    const d = new Date(Date.now() - 60_000);
    const dayDir = join(home, "sessions", String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()));
    const file = readdirSync(dayDir).find((f) => f.endsWith(".jsonl"))!;
    const stale = new Date(Date.now() - 5 * 60_000);
    utimesSync(join(dayDir, file), stale, stale);
    refreshCodexSessionTitles(db, { codexHome: home, onlySessionId: "codex-busy" });
    assert.equal(JSON.parse(getSession(db, "codex-busy")!.metadata!).busy, false);
    disposeHome(home);
  });

  it("keeps managing a row it titled, following thread_name updates", () => {
    const home = fakeCodexHome();
    const cwd = "C:\\Work\\Svc Zeta";
    const uuid = "bbbbbbbb-aaaa-dddd-cccc-eeeeeeeeeeee";
    writeRollout(home, {
      uuid,
      cwd,
      startedAtMs: Date.now() - 60_000,
      prompts: ["draft the migration plan"],
    });
    registerCodexSession("codex-follow", cwd, {});
    refreshCodexSessionTitles(db, { codexHome: home, onlySessionId: "codex-follow" });
    assert.equal(getSession(db, "codex-follow")!.name, "draft the migration plan");

    // codex later summarizes the thread under a better name
    writeSessionIndex(home, [{ id: uuid, thread_name: "数据库迁移计划" }]);
    const updated = refreshCodexSessionTitles(db, { codexHome: home, onlySessionId: "codex-follow" });
    assert.equal(updated, 1);
    assert.equal(getSession(db, "codex-follow")!.name, "数据库迁移计划");
    disposeHome(home);
  });
});
