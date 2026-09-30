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
    description: "圈子内自由对话",
    members: ["node-a", "node-b", "node-c"],
  });
  assert.ok(room.id > 0);
  assert.equal(room.members.length, 3);
  assert.ok(room.members.includes("node-a"));

  const list = listChatRooms(db);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "代码审查");

  const members = roomMembers(db, room.id);
  assert.equal(members.length, 3);
  assert.ok(members.includes("node-b"));

  assert.ok(deleteChatRoom(db, room.id));
  assert.equal(roomMembers(db, room.id).length, 0);
});

test("mutual exclusivity: joining a new room removes from old", () => {
  const db = freshDb();
  registerSession(db, { id: "shared", name: "共享节点" });
  registerSession(db, { id: "other", name: "另一个" });

  const room1 = createChatRoom(db, {
    name: "room-1",
    members: ["shared", "other"],
  });
  assert.ok(roomMembers(db, room1.id).includes("shared"));

  registerSession(db, { id: "third", name: "第三个" });
  const room2 = createChatRoom(db, {
    name: "room-2",
    members: ["shared", "third"],
  });
  assert.ok(!roomMembers(db, room1.id).includes("shared"), "旧房间不再持有");
  assert.ok(roomMembers(db, room2.id).includes("shared"), "新房间持有");
});
