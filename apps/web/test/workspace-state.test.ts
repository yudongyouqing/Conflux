import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatRoom } from "@conflux/shared";
import {
  targetKey,
  restoreRoom,
  draftsReducer,
  loadWorkspacePreference,
  saveWorkspacePreference,
  WORKSPACE_PREFERENCE_KEY,
  type DraftMap,
} from "../src/workspace-state.ts";

function room(overrides: Partial<ChatRoom> & Pick<ChatRoom, "id">): ChatRoom {
  return {
    name: `房间 ${overrides.id}`,
    description: null,
    members: [],
    created_at: "2026-11-05T02:00:00Z",
    updated_at: "2026-11-05T02:00:00Z",
    ...overrides,
  };
}

test("restoreRoom returns the remembered room when id and creation time match", () => {
  const rooms = [room({ id: 7 }), room({ id: 9, created_at: "2026-11-05T03:00:00Z" })];
  const restored = restoreRoom(rooms, { id: 7, createdAt: "2026-11-05T02:00:00Z" });
  assert.equal(restored?.id, 7);
});

test("room id reused with a different creation time is not restored", () => {
  const rooms = [
    { id: 7, name: "新房间", description: null, members: [],
      created_at: "2026-11-05T02:00:00Z", updated_at: "2026-11-05T02:00:00Z" },
    { id: 9, name: "最近房间", description: null, members: [],
      created_at: "2026-11-05T03:00:00Z", updated_at: "2026-11-05T03:00:00Z" },
  ];
  const restored = restoreRoom(rooms, { id: 7, createdAt: "2026-11-04T02:00:00Z" });
  assert.equal(restored?.id, 9);
});

test("restoreRoom without memory picks the newest updated_at, ties by id descending", () => {
  const rooms = [
    room({ id: 3, updated_at: "2026-11-05T01:00:00Z" }),
    room({ id: 12, updated_at: "2026-11-05T04:00:00Z" }),
    room({ id: 8, updated_at: "2026-11-05T04:00:00Z" }),
  ];
  assert.equal(restoreRoom(rooms, null)?.id, 12);
  assert.equal(restoreRoom([], null), null);
});

test("targetKey separates rooms from sessions even with equal identifiers", () => {
  assert.equal(targetKey({ kind: "room", id: 7 }), "room:7");
  assert.equal(targetKey({ kind: "session", id: "7" }), "session:7");
  assert.notEqual(targetKey({ kind: "room", id: 7 }), targetKey({ kind: "session", id: "7" }));
  assert.equal(targetKey({ kind: "session", id: "full-session-id" }), "session:full-session-id");
});

test("draft edits bump the revision and submitted clears only the sent revision", () => {
  let drafts: DraftMap = {};
  drafts = draftsReducer(drafts, { type: "edit", targetKey: "room:7", text: "检查构建" });
  assert.deepEqual(drafts["room:7"], { text: "检查构建", revision: 1 });

  // typing continues while the request is in flight → revision moves on
  drafts = draftsReducer(drafts, { type: "edit", targetKey: "room:7", text: "检查构建与测试" });
  drafts = draftsReducer(drafts, { type: "submitted", targetKey: "room:7", revision: 1 });
  assert.equal(drafts["room:7"]?.text, "检查构建与测试");

  // resubmitting the exact snapshot clears it
  drafts = draftsReducer(drafts, { type: "submitted", targetKey: "room:7", revision: 2 });
  assert.deepEqual(drafts["room:7"], { text: "", revision: 2 });
});

test("submitted for one target never touches another target's draft", () => {
  let drafts: DraftMap = {};
  drafts = draftsReducer(drafts, { type: "edit", targetKey: "room:7", text: "房间草稿" });
  drafts = draftsReducer(drafts, { type: "edit", targetKey: "session:peer-1", text: "单聊草稿" });
  drafts = draftsReducer(drafts, { type: "submitted", targetKey: "room:7", revision: 1 });
  assert.equal(drafts["room:7"]?.text, "");
  assert.equal(drafts["session:peer-1"]?.text, "单聊草稿");
  // unknown target is a no-op, not an invented entry
  drafts = draftsReducer(drafts, { type: "submitted", targetKey: "session:ghost", revision: 1 });
  assert.equal(drafts["session:ghost"], undefined);
});

const validPreference = JSON.stringify({
  version: 1,
  lastRoom: { id: 7, createdAt: "2026-11-05T02:00:00Z" },
  detailsOpen: true,
});

test("loadWorkspacePreference reads a valid v1 payload", () => {
  const storage = memoryStorage({ [WORKSPACE_PREFERENCE_KEY]: validPreference });
  assert.deepEqual(loadWorkspacePreference(storage), {
    version: 1,
    lastRoom: { id: 7, createdAt: "2026-11-05T02:00:00Z" },
    detailsOpen: true,
  });
});

test("loadWorkspacePreference survives broken storage: bad JSON, throw, unknown version, wrong types", () => {
  assert.equal(loadWorkspacePreference(memoryStorage({ [WORKSPACE_PREFERENCE_KEY]: "{oops" })), null);
  assert.equal(loadWorkspacePreference(throwingStorage()), null);
  assert.equal(loadWorkspacePreference(memoryStorage()), null);
  assert.equal(
    loadWorkspacePreference(
      memoryStorage({ [WORKSPACE_PREFERENCE_KEY]: JSON.stringify({ version: 99, lastRoom: null, detailsOpen: true }) }),
    ),
    null,
  );
  assert.equal(
    loadWorkspacePreference(
      memoryStorage({ [WORKSPACE_PREFERENCE_KEY]: JSON.stringify({ version: 1, lastRoom: { id: "7" }, detailsOpen: "yes" }) }),
    ),
    null,
  );
  // valid payload with no remembered room still loads
  assert.deepEqual(
    loadWorkspacePreference(
      memoryStorage({ [WORKSPACE_PREFERENCE_KEY]: JSON.stringify({ version: 1, lastRoom: null, detailsOpen: false }) }),
    ),
    { version: 1, lastRoom: null, detailsOpen: false },
  );
});

test("saveWorkspacePreference persists and never throws on storage failure", () => {
  const storage = memoryStorage();
  saveWorkspacePreference(
    { version: 1, lastRoom: { id: 9, createdAt: "2026-11-05T03:00:00Z" }, detailsOpen: false },
    storage,
  );
  assert.deepEqual(JSON.parse(storage.data[WORKSPACE_PREFERENCE_KEY]), {
    version: 1,
    lastRoom: { id: 9, createdAt: "2026-11-05T03:00:00Z" },
    detailsOpen: false,
  });
  // a full disk / disabled storage must not break the interaction
  saveWorkspacePreference({ version: 1, lastRoom: null, detailsOpen: true }, throwingStorage());
});

function memoryStorage(initial: Record<string, string> = {}) {
  return {
    data: { ...initial },
    getItem(key: string) {
      return key in this.data ? this.data[key] : null;
    },
    setItem(key: string, value: string) {
      this.data[key] = value;
    },
  };
}

function throwingStorage() {
  return {
    getItem() {
      throw new Error("storage unavailable");
    },
    setItem() {
      throw new Error("storage unavailable");
    },
  };
}
