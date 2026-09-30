import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers.js";
import type { DB } from "../core/db.js";
import { registerSession } from "../core/sessions.js";
import {
  createChatRoom,
  listChatRooms,
  getChatRoom,
  deleteChatRoom,
  roomMembers,
} from "../core/chat-rooms.js";

const cleanups: Array<() => void> = [];
after(() => cleanups.forEach((c) => c()));
function freshDb(): DB {
  const { db, cleanup } = makeDb();
  cleanups.push(cleanup);
  return db;
}

test("create, list, get, delete a chat room with topology", () => {
  const db = freshDb();
  registerSession(db, { id: "node-a", name: "A" });
  registerSession(db, { id: "node-b", name: "B" });
  registerSession(db, { id: "node-c", name: "C" });

  const room = createChatRoom(db, {
    name: "代码审查",
    description: "开发⇄审查→合并",
    topology: [
      { from: "node-a", to: "node-b", order: 1 },
      { from: "node-b", to: "node-a", order: 2 },
      { from: "node-b", to: "node-c", order: 3 },
    ],
  });
  assert.ok(room.id > 0);
  assert.equal(room.topology.length, 3);

  const list = listChatRooms(db);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "代码审查");

  const got = getChatRoom(db, room.id);
  assert.ok(got);
  assert.equal(got!.topology[0].from, "node-a");

  // members claimed
  const members = roomMembers(db, room.id);
  assert.equal(members.length, 3);
  assert.ok(members.some((m) => m.id === "node-a" && m.stepOrder === 1));

  // delete releases members
  assert.ok(deleteChatRoom(db, room.id));
  assert.equal(roomMembers(db, room.id).length, 0);
  assert.equal(listChatRooms(db).length, 0);
});

test("mutual exclusivity: joining a new room removes from old", () => {
  const db = freshDb();
  registerSession(db, { id: "shared", name: "共享节点" });
  registerSession(db, { id: "other", name: "另一个" });

  const room1 = createChatRoom(db, {
    name: "room-1",
    topology: [{ from: "shared", to: "other", order: 1 }],
  });
  // shared is in room 1
  assert.ok(roomMembers(db, room1.id).some((m) => m.id === "shared"));

  // create room 2 claiming shared — should steal from room 1
  registerSession(db, { id: "third", name: "第三个" });
  const room2 = createChatRoom(db, {
    name: "room-2",
    topology: [{ from: "shared", to: "third", order: 1 }],
  });
  // shared now in room 2 only
  assert.ok(!roomMembers(db, room1.id).some((m) => m.id === "shared"), "旧房间不再持有");
  assert.ok(roomMembers(db, room2.id).some((m) => m.id === "shared"), "新房间持有");
});
