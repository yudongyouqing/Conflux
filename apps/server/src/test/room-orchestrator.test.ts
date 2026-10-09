import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers.js";
import type { DB } from "../core/db.js";
import { registerSession } from "../core/sessions.js";
import { createChatRoom } from "../core/chat-rooms.js";
import {
  summonAgent,
  writeResult,
  readRoom,
  roomStatus,
  createTask,
} from "../core/room-orchestrator.js";

const cleanups: Array<() => void> = [];
after(() => cleanups.forEach((c) => c()));
function freshDb(): DB {
  const { db, cleanup } = makeDb();
  cleanups.push(cleanup);
  return db;
}

function setup(db: DB) {
  registerSession(db, { id: "web-console", name: "Web 控制台" });
  registerSession(db, { id: "agent-b", name: "Agent B" });
  registerSession(db, { id: "agent-c", name: "Agent C" });
  return createChatRoom(db, { name: "测试房间", members: ["agent-b", "agent-c"] });
}

test("summon → write result → initiator notified when all done", () => {
  const db = freshDb();
  const room = setup(db);

  // Human summons two agents in parallel
  const { task: t1 } = summonAgent(db, {
    room_id: room.id,
    initiator_session_id: "web-console",
    executor_session_id: "agent-b",
    prompt: "分析代码",
  });
  const { task: t2 } = summonAgent(db, {
    room_id: room.id,
    initiator_session_id: "web-console",
    executor_session_id: "agent-c",
    prompt: "架构建议",
  });

  assert.equal(t1.status, "pending");
  assert.equal(t2.status, "pending");

  // Agent B writes result
  const r1 = writeResult(db, {
    task_id: t1.id,
    executor_session_id: "agent-b",
    result: "B 的分析结果",
  });
  assert.equal(r1.task.status, "done");
  assert.equal(r1.allDone, false, "C 还没完成");

  // Agent C writes result → all done
  const r2 = writeResult(db, {
    task_id: t2.id,
    executor_session_id: "agent-c",
    result: "C 的架构建议",
  });
  assert.equal(r2.task.status, "done");
  assert.equal(r2.allDone, true, "全部完成");
  assert.equal(r2.summonedInitiator, true, "人类发起者不需要注入");

  // Room shared thread has both results
  const roomData = readRoom(db, room.id);
  assert.equal(roomData.tasks.length, 2);
  assert.ok(roomData.tasks.some((t) => t.result?.includes("B 的分析结果")));
  assert.ok(roomData.tasks.some((t) => t.result?.includes("C 的架构建议")));

  // Status shows all done
  const status = roomStatus(db, room.id);
  assert.ok(status.some((s) => s.executor_session_id === "agent-b" && s.status === "done"));
});

test("cascade: executor can summon other agents mid-execution", () => {
  const db = freshDb();
  const room = setup(db);
  registerSession(db, { id: "agent-d", name: "Agent D" });

  // Human summons B
  const { task: tB } = summonAgent(db, {
    room_id: room.id,
    initiator_session_id: "web-console",
    executor_session_id: "agent-b",
    prompt: "需要 D 的数据",
  });

  // B cascades: summons D (B is now the initiator for D's task)
  const { task: tD } = summonAgent(db, {
    room_id: room.id,
    initiator_session_id: "agent-b",
    executor_session_id: "agent-d",
    prompt: "提供数据",
  });

  // D completes → B is notified (B's sub-task done)
  const rD = writeResult(db, {
    task_id: tD.id,
    executor_session_id: "agent-d",
    result: "D 的数据",
  });
  assert.equal(rD.allDone, true, "B 的子任务全完成");

  // B completes with D's data → human's task done
  const rB = writeResult(db, {
    task_id: tB.id,
    executor_session_id: "agent-b",
    result: "B 综合了 D 的数据",
  });
  assert.equal(rB.allDone, true);
});

test("executor mismatch is rejected", () => {
  const db = freshDb();
  const room = setup(db);
  const { task } = summonAgent(db, {
    room_id: room.id,
    initiator_session_id: "web-console",
    executor_session_id: "agent-b",
    prompt: "test",
  });
  assert.throws(
    () => writeResult(db, { task_id: task.id, executor_session_id: "agent-c", result: "wrong" }),
    /not the executor/,
  );
});
