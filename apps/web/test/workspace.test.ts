import assert from "node:assert/strict";
import { after, afterEach, mock, test } from "node:test";
import { JSDOM } from "jsdom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { createElement } from "react";
import type { ChatRoom, Graph, GraphNode, Message } from "@conflux/shared";
import App from "../src/App.tsx";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  localStorage: dom.window.localStorage,
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });

const { cleanup, render, fireEvent, waitFor, act, within } = await import("@testing-library/react");

afterEach(() => {
  cleanup();
  mock.restoreAll();
  dom.window.localStorage.clear();
});
after(() => dom.window.close());

// ---- fixtures ------------------------------------------------------------

function sessionNode(id: string, name: string, overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    name,
    status: "active",
    type: "session",
    context_count: 0,
    pending_inbox: 0,
    ...overrides,
  };
}

function chatRoom(
  id: number,
  name: string,
  members: string[] = [],
  times: { created?: string; updated?: string } = {},
): ChatRoom {
  return {
    id,
    name,
    description: null,
    members,
    created_at: times.created ?? "2026-11-05T02:00:00Z",
    updated_at: times.updated ?? "2026-11-05T02:00:00Z",
  };
}

interface ApiState {
  rooms: ChatRoom[];
  roomsStatus?: number;
  graph: Graph;
  roomTasks: Array<Record<string, unknown>>;
  roomMessages: Array<Record<string, unknown>>;
  peerMessages: Message[];
  defer?: { urlPattern: RegExp; resolve: (r: Response) => void };
  calls: Array<{ url: string; method: string; body?: unknown }>;
}

function mockApi(state: ApiState) {
  return mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    state.calls.push({ url, method, body });

    const deferred = state.defer;
    if (deferred && method === "GET" && deferred.urlPattern.test(url)) {
      return new Promise<Response>((resolve) => {
        deferred.resolve = resolve;
      });
    }

    if (url === "/chat-rooms" && method === "POST") {
      const name = String(body?.name ?? "未命名");
      const room = chatRoom(900 + state.rooms.length + 1, name, body?.members ?? [], {
        created: "2026-11-05T05:00:00Z",
        updated: "2026-11-05T05:00:00Z",
      });
      state.rooms = [...state.rooms, room];
      return Response.json({ room });
    }
    if (url === "/chat-rooms") {
      if (state.roomsStatus) return new Response("list failed", { status: state.roomsStatus });
      return Response.json({ rooms: state.rooms });
    }
    if (method === "DELETE" && /^\/chat-rooms\/\d+$/.test(url)) {
      const id = Number(url.split("/")[2]);
      state.rooms = state.rooms.filter((r) => r.id !== id);
      return Response.json({ ok: true });
    }
    if (/^\/chat-rooms\/\d+\/join$/.test(url) && method === "POST") {
      const roomId = Number(url.split("/")[2]);
      state.rooms = state.rooms.map((r) =>
        r.id === roomId ? { ...r, members: [...r.members, String(body?.session_id)] } : r,
      );
      return Response.json({ ok: true });
    }
    if (url === "/chat-rooms/leave") {
      const leaver = String(body?.session_id);
      state.rooms = state.rooms.map((r) => ({
        ...r,
        members: r.members.filter((m) => m !== leaver),
      }));
      return Response.json({ ok: true });
    }
    if (/^\/chat-rooms\/\d+\/orchestrate$/.test(url)) {
      return Response.json({ tasks: state.roomTasks, status: [] });
    }
    if (/^\/chat-rooms\/\d+\/(summon|broadcast)$/.test(url)) {
      return Response.json({ task_id: 1, injected: true, method: "queue", room_id: 1, members: [], message_ids: [] });
    }
    if (/^\/chat-rooms\/\d+\/messages$/.test(url)) {
      return Response.json({ messages: state.roomMessages });
    }
    if (url.startsWith("/web/peer-messages")) {
      return Response.json({ messages: state.peerMessages });
    }
    if (url === "/web/ask") {
      const message: Message = {
        id: 99,
        from_session: "web-console",
        to_session: String(body?.to_session),
        question: String(body?.question),
        reply: null,
        status: "pending",
        created_at: "2026-11-05T05:00:00Z",
        replied_at: null,
      };
      return Response.json({ message });
    }
    if (url === "/graph?status=all") return Response.json(state.graph);
    if (url === "/healthz") return Response.json({ ok: true });
    if (url === "/messages/inbox") return Response.json({ messages: [] });
    if (url.startsWith("/context/query")) return Response.json({ entries: [] });
    return Response.json({});
  });
}

function makeState(overrides: Partial<ApiState> = {}): ApiState {
  return {
    rooms: [],
    graph: { nodes: [], edges: [] },
    roomTasks: [],
    roomMessages: [],
    peerMessages: [],
    calls: [],
    ...overrides,
  };
}

function mountApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const view = render(createElement(QueryClientProvider, { client }, createElement(App)));
  return { ...view, client };
}

const ROOM_A = chatRoom(7, "房间 A", ["peer-1"], {
  created: "2026-11-05T02:00:00Z",
  updated: "2026-11-05T02:00:00Z",
});
const ROOM_B = chatRoom(9, "房间 B", ["peer-2"], {
  created: "2026-11-05T03:00:00Z",
  updated: "2026-11-05T03:00:00Z",
});

function rememberRoom(lastRoom: { id: number; createdAt: string } | null) {
  dom.window.localStorage.setItem(
    "conflux.workspace.v1",
    JSON.stringify({ version: 1, lastRoom, detailsOpen: false }),
  );
}

// ---- shell: default view, restore, failures, guide -----------------------

test("cold start opens the chat workspace with the newest room and no inbox preflight", async () => {
  const state = makeState({
    rooms: [ROOM_A, ROOM_B],
    graph: { nodes: [sessionNode("peer-1", "Codex · 项目A")], edges: [] },
  });
  mockApi(state);
  const view = mountApp();

  await waitFor(() => assert.ok(view.getByRole("heading", { name: "房间 B" })));
  assert.ok(!view.queryByRole("heading", { name: "房间 A" }));
  // chat is the default surface — the room heading lives on the active one
  expectContains(view, "房间 B");
  // the hidden activity view is not mounted at boot: no inbox side effect
  assert.equal(state.calls.some((c) => c.url === "/messages/inbox"), false);
  // room threads use the real ids only
  assert.equal(state.calls.some((c) => c.url.includes("/chat-rooms/0/")), false);
});

function expectContains(view: { container: HTMLElement }, text: string): string {
  const active = view.container.querySelector('.tab-surface[data-active="true"]')?.textContent ?? "";
  assert.ok(active.includes(text), `active surface should contain ${text}`);
  return active;
}

test("a remembered room is restored only when its creation time still matches", async () => {
  rememberRoom({ id: 7, createdAt: "2026-11-05T02:00:00Z" });
  const state = makeState({ rooms: [ROOM_A, ROOM_B] });
  mockApi(state);
  const view = mountApp();
  await waitFor(() => assert.ok(view.getByRole("heading", { name: "房间 A" })));
});

test("a remembered room id with a stale creation time falls back to the newest room", async () => {
  rememberRoom({ id: 7, createdAt: "2020-01-01T00:00:00Z" });
  const state = makeState({ rooms: [ROOM_A, ROOM_B] });
  mockApi(state);
  const view = mountApp();
  await waitFor(() => assert.ok(view.getByRole("heading", { name: "房间 B" })));
});

test("room list failure shows an error with retry, never the empty guide", async () => {
  const state = makeState({ roomsStatus: 500 });
  mockApi(state);
  const view = mountApp();

  await waitFor(() => assert.ok(view.getByRole("alert")));
  assert.match(view.getByRole("alert").textContent ?? "", /失败/);
  assert.ok(!view.queryByText("还没有聊天室"));

  state.roomsStatus = undefined;
  state.rooms = [ROOM_B];
  fireEvent.click(view.getByRole("button", { name: "重试" }));
  await waitFor(() => assert.ok(view.getByRole("heading", { name: "房间 B" })));
  assert.equal(state.calls.filter((c) => c.url === "/chat-rooms").length >= 2, true);
});

test("the empty guide creates a room and selects it immediately", async () => {
  const state = makeState();
  mockApi(state);
  const view = mountApp();
  await waitFor(() => assert.ok(view.getByText("还没有聊天室")));

  fireEvent.click(view.getByRole("button", { name: "创建聊天室" }));
  const dialog = await view.findByRole("dialog");
  const nameInput = await within(dialog).findByPlaceholderText(/聊天室名称/);
  fireEvent.change(nameInput, { target: { value: "代码审查" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "创建空聊天室" }));

  const createCall = await waitFor(() => {
    const call = state.calls.find((c) => c.url === "/chat-rooms" && c.method === "POST");
    assert.ok(call);
    return call;
  });
  assert.equal((createCall.body as { name: string }).name, "代码审查");
  await waitFor(() => assert.ok(view.getByRole("heading", { name: "代码审查" })));
});

test("deleting the current room selects the next room, and the last deletion returns to the guide", async () => {
  rememberRoom({ id: 7, createdAt: "2026-11-05T02:00:00Z" });
  const state = makeState({
    rooms: [ROOM_A, ROOM_B],
    graph: {
      nodes: [sessionNode("peer-1", "审查员一"), sessionNode("peer-2", "审查员二")],
      edges: [],
    },
  });
  mockApi(state);
  const view = mountApp();
  await waitFor(() => assert.ok(view.getByRole("heading", { name: "房间 A" })));

  fireEvent.click(view.getByRole("button", { name: "详情" }));
  fireEvent.click(await view.findByRole("button", { name: "删除房间" }));
  fireEvent.click(await view.findByRole("button", { name: "确认删除" }));

  await waitFor(() => assert.ok(view.getByRole("heading", { name: "房间 B" })));
  assert.equal(state.calls.some((c) => c.method === "DELETE" && c.url === "/chat-rooms/7"), true);

  // delete the last remaining room → back to the guide, no ghost selection
  fireEvent.click(view.getByRole("button", { name: "删除房间" }));
  fireEvent.click(await view.findByRole("button", { name: "确认删除" }));
  await waitFor(() => assert.ok(view.getByText("还没有聊天室")));
});

test("background room refreshes never steal the user's selection", async () => {
  rememberRoom({ id: 7, createdAt: "2026-11-05T02:00:00Z" });
  const state = makeState({ rooms: [ROOM_A, ROOM_B] });
  mockApi(state);
  const view = mountApp();
  await waitFor(() => assert.ok(view.getByRole("heading", { name: "房间 A" })));

  // a background refresh arrives where room B is now the newest plus a new room
  state.rooms = [
    ROOM_A,
    ROOM_B,
    chatRoom(11, "房间 C", [], { created: "2026-11-05T06:00:00Z", updated: "2026-11-05T06:00:00Z" }),
  ];
  await act(async () => {
    await view.client.invalidateQueries({ queryKey: ["chat-rooms"] });
  });
  await waitFor(() => assert.ok(view.getByRole("button", { name: /房间 C/ })));
  assert.ok(view.getByRole("heading", { name: "房间 A" }));
});

test("selecting a recent session opens its peer conversation on the chat surface", async () => {
  const state = makeState({
    rooms: [ROOM_A],
    graph: {
      nodes: [
        sessionNode("peer-1", "Codex · 项目A", { chat_room_id: 7 }),
        sessionNode("peer-9", "独立会话"),
      ],
      edges: [],
    },
  });
  mockApi(state);
  const view = mountApp();
  await waitFor(() => assert.ok(view.getByRole("button", { name: /独立会话/ })));

  fireEvent.click(view.getByRole("button", { name: /独立会话/ }));
  await waitFor(() => assert.ok(view.getByRole("heading", { name: /与 独立会话 的对话/ })));
  await waitFor(() =>
    assert.equal(
      state.calls.some((c) => c.url === "/web/peer-messages?peer=peer-9"),
      true,
    ),
  );
  // session conversations speak over web ask, never a fake room id
  assert.equal(state.calls.some((c) => c.url.includes("/chat-rooms/0/")), false);
});

// ---- room conversation behavior ------------------------------------------

test("slow room A responses cannot reach room B after the switch", async () => {
  rememberRoom({ id: 7, createdAt: "2026-11-05T02:00:00Z" });
  const state = makeState({
    rooms: [ROOM_A, ROOM_B],
    graph: { nodes: [sessionNode("peer-1", "成员一"), sessionNode("peer-2", "成员二")], edges: [] },
    defer: { urlPattern: /^\/chat-rooms\/7\/messages$/, resolve: () => {} },
  });
  mockApi(state);
  const view = mountApp();

  // wait for the deferred room-7 read to be in flight, then move to room B
  await waitFor(() => assert.ok(view.getByRole("heading", { name: "房间 A" })));
  await waitFor(() => assert.ok(state.defer?.resolve));

  fireEvent.click(view.getByRole("button", { name: /房间 B/ }));
  await waitFor(() =>
    assert.equal(view.getByRole("heading", { name: "房间 B" }).textContent, "房间 B"),
  );
  assert.ok(!view.queryByText("只属于 A 的结果"));
  state.defer!.resolve(Response.json({ messages: [{ id: 5, room_id: 7, question: "只属于 A 的结果" }] }));
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(!view.queryByText("只属于 A 的结果"));
  assert.ok(view.getByRole("heading", { name: "房间 B" }));
});

test("room broadcast submits once per click and keeps newer typing after completion", async () => {
  rememberRoom({ id: 7, createdAt: "2026-11-05T02:00:00Z" });
  let releaseSend!: (r: Response) => void;
  const state = makeState({
    rooms: [ROOM_A],
    graph: { nodes: [sessionNode("peer-1", "成员一")], edges: [] },
  });
  const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    state.calls.push({ url, method, body });
    if (url === "/chat-rooms/7/broadcast") {
      return new Promise<Response>((resolve) => {
        releaseSend = resolve;
      });
    }
    if (url === "/chat-rooms") return Response.json({ rooms: state.rooms });
    if (url === "/graph?status=all") return Response.json(state.graph);
    if (url === "/healthz") return Response.json({ ok: true });
    if (/^\/chat-rooms\/7\/(orchestrate|messages)$/.test(url)) return Response.json({ tasks: [], status: [], messages: [] });
    return Response.json({});
  });
  void fetchMock;
  const view = mountApp();
  const input = await view.findByPlaceholderText(/广播/);

  fireEvent.change(input, { target: { value: "检查构建" } });
  fireEvent.click(view.getByRole("button", { name: "广播" }));
  // while the request is in flight the button is disabled — a second click
  // (real users hit the disabled state; the handler guard is the backstop)
  // must not produce a second request
  await waitFor(() =>
    assert.equal((view.getByRole("button", { name: "广播" }) as HTMLButtonElement).disabled, true),
  );
  fireEvent.click(view.getByRole("button", { name: "广播" }));
  await waitFor(() => assert.equal(state.calls.filter((c) => c.url === "/chat-rooms/7/broadcast").length, 1));

  // typing continues while the request is in flight
  fireEvent.change(input, { target: { value: "检查构建与测试" } });
  releaseSend(Response.json({ room_id: 7, members: ["peer-1"], message_ids: [12] }));
  await waitFor(() => assert.equal((input as HTMLInputElement).value, "检查构建与测试"));
  const sent = state.calls.find((c) => c.url === "/chat-rooms/7/broadcast");
  assert.deepEqual(sent?.body, { prompt: "检查构建", sender_session_id: "web-console" });
});

test("directed sends carry the full session id even for duplicate display names", async () => {
  rememberRoom({ id: 7, createdAt: "2026-11-05T02:00:00Z" });
  const state = makeState({
    rooms: [chatRoom(7, "房间 A", ["full-id-aaaa", "full-id-bbbb"], ROOM_A)],
    graph: {
      nodes: [
        sessionNode("full-id-aaaa", "重名助手", { chat_room_id: 7 }),
        sessionNode("full-id-bbbb", "重名助手", { chat_room_id: 7 }),
      ],
      edges: [],
    },
  });
  mockApi(state);
  const view = mountApp();
  const input = await view.findByPlaceholderText(/^@某成员/);
  const composer = view.container.querySelector(".room-composer") as HTMLElement;

  fireEvent.change(input, { target: { value: "@重名助手" } });
  const options = await within(composer).findAllByRole("button", { name: /重名助手/ });
  assert.equal(options.length, 2);
  fireEvent.click(options[0]);
  fireEvent.change(input, { target: { value: "@重名助手 检查构建" } });
  fireEvent.click(view.getByRole("button", { name: "召唤" }));

  await waitFor(() => {
    const call = state.calls.find((c) => c.url === "/chat-rooms/7/summon");
    assert.ok(call);
    assert.equal((call.body as { executor_session_id: string }).executor_session_id, "full-id-aaaa");
    assert.equal((call.body as { prompt: string }).prompt, "@重名助手 检查构建");
  });
});

test("an empty room blocks sending and points at member management", async () => {
  const state = makeState({ rooms: [chatRoom(7, "空房间", [])] });
  mockApi(state);
  const view = mountApp();
  await waitFor(() => assert.ok(view.getByRole("heading", { name: "空房间" })));

  // no composer at all until members exist — broadcast/summon are impossible
  assert.ok(!view.queryByRole("button", { name: "广播" }));
  assert.ok(!view.queryByPlaceholderText(/@/));
  assert.ok(view.getAllByRole("button", { name: "添加成员" }).length >= 1);
});

test("a member leaving keeps the directed target stale and blocks sending instead of widening", async () => {
  rememberRoom({ id: 7, createdAt: "2026-11-05T02:00:00Z" });
  const state = makeState({
    rooms: [chatRoom(7, "房间 A", ["peer-1", "peer-2"], ROOM_A)],
    graph: {
      nodes: [
        sessionNode("peer-1", "成员一", { chat_room_id: 7 }),
        sessionNode("peer-2", "成员二", { chat_room_id: 7 }),
      ],
      edges: [],
    },
  });
  mockApi(state);
  const view = mountApp();
  const input = await view.findByPlaceholderText(/^@某成员/);
  const composer = view.container.querySelector(".room-composer") as HTMLElement;

  fireEvent.change(input, { target: { value: "@成员一" } });
  fireEvent.click(await within(composer).findByRole("button", { name: /成员一/ }));
  await waitFor(() => assert.ok(within(composer).getByText("成员一")));

  // the member leaves through the details panel
  fireEvent.click(view.getByRole("button", { name: "详情" }));
  fireEvent.click(await view.findByRole("button", { name: "移出成员 成员一" }));
  fireEvent.click(await view.findByRole("button", { name: "确认移出" }));
  await waitFor(() =>
    assert.equal(state.calls.some((c) => c.url === "/chat-rooms/leave"), true),
  );

  // the room list refresh drops the member → the directed target goes stale,
  // and BOTH the button and Enter must refuse to send anything anywhere
  await waitFor(() =>
    assert.ok(within(composer).getByText(/已不在房间，请重新选择/)),
  );
  fireEvent.change(input, { target: { value: "还在吗" } });
  const blocked = view.getByRole("button", { name: "召唤" }) as HTMLButtonElement;
  await waitFor(() => assert.equal(blocked.disabled, true));
  fireEvent.keyDown(input, { key: "Enter" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(state.calls.some((c) => c.url === "/chat-rooms/7/summon"), false);
  assert.equal(state.calls.some((c) => c.url === "/chat-rooms/7/broadcast"), false);

  // only an explicit re-decision (clear the target) returns to broadcast
  fireEvent.click(within(composer).getByRole("button", { name: /清除目标/ }));
  fireEvent.click(view.getByRole("button", { name: "广播" }));
  await waitFor(() => {
    const call = state.calls.find((c) => c.url === "/chat-rooms/7/broadcast");
    assert.ok(call);
    assert.equal((call.body as { prompt: string }).prompt, "还在吗");
  });
});

test("a directed target survives room switches and never falls back to broadcast", async () => {
  rememberRoom({ id: 7, createdAt: "2026-11-05T02:00:00Z" });
  const state = makeState({
    rooms: [ROOM_A, ROOM_B],
    graph: {
      nodes: [sessionNode("peer-1", "成员一"), sessionNode("peer-2", "成员二")],
      edges: [],
    },
  });
  mockApi(state);
  const view = mountApp();
  const input = await view.findByPlaceholderText(/^@某成员/);
  const composer = view.container.querySelector(".room-composer") as HTMLElement;

  fireEvent.change(input, { target: { value: "@成员一" } });
  fireEvent.click(await within(composer).findByRole("button", { name: /成员一/ }));
  fireEvent.change(input, { target: { value: "@成员一 仅发给你的检查内容" } });
  assert.ok(view.getByRole("button", { name: "召唤" }));

  // leave the room, come back: text AND the directed target must both survive
  fireEvent.click(view.getByRole("button", { name: /房间 B/ }));
  await view.findByRole("heading", { name: "房间 B" });
  fireEvent.click(view.getByRole("button", { name: /房间 A/ }));
  const returned = await view.findByPlaceholderText(/^@某成员/);
  await waitFor(() =>
    assert.equal((returned as HTMLInputElement).value, "@成员一 仅发给你的检查内容"),
  );
  assert.ok(view.getByRole("button", { name: "召唤" }), "directed target lost on return");

  fireEvent.keyDown(returned, { key: "Enter" });
  await waitFor(() => {
    const summon = state.calls.find((c) => c.url === "/chat-rooms/7/summon");
    assert.ok(summon, "the restored draft must be sent as a summon");
    assert.equal((summon.body as { executor_session_id: string }).executor_session_id, "peer-1");
  });
  assert.equal(state.calls.some((c) => c.url === "/chat-rooms/7/broadcast"), false);
});

test("room send success clears its draft even after switching to a peer mid-flight", async () => {
  rememberRoom({ id: 7, createdAt: "2026-11-05T02:00:00Z" });
  const state = makeState({
    rooms: [ROOM_A],
    graph: { nodes: [sessionNode("peer-1", "独立会话")], edges: [] },
  });
  mockApi(state);
  const fallbackFetch = globalThis.fetch;
  let release!: (value: Response) => void;
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === "/chat-rooms/7/broadcast") {
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    }
    return fallbackFetch(input, init);
  });
  const view = mountApp();
  const input = await view.findByPlaceholderText(/^@某成员/);

  fireEvent.change(input, { target: { value: "已经发出的任务" } });
  fireEvent.click(view.getByRole("button", { name: "广播" }));
  await waitFor(() => assert.equal(typeof release, "function"));

  // the workspace moves on while the request is in flight; the success
  // handling must not depend on the sending component staying alive
  fireEvent.click(view.getByRole("button", { name: /独立会话/ }));
  await view.findByPlaceholderText(/^向 独立会话 提问/);
  await act(async () => {
    release(Response.json({ room_id: 7, members: ["peer-1"], message_ids: [1] }));
    await new Promise((r) => setTimeout(r, 30));
  });

  fireEvent.click(view.getByRole("button", { name: /房间 A/ }));
  const returned = await view.findByPlaceholderText(/^@某成员/);
  await waitFor(() =>
    assert.equal((returned as HTMLInputElement).value, "", "successful old request left its submitted draft behind"),
  );
});

test("the latest selected room survives opening a peer conversation", async () => {
  rememberRoom({ id: 7, createdAt: ROOM_A.created_at });
  const state = makeState({
    rooms: [ROOM_A, ROOM_B],
    graph: {
      nodes: [sessionNode("peer-1", "成员一"), sessionNode("peer-2", "成员二")],
      edges: [],
    },
  });
  mockApi(state);
  const view = mountApp();
  await view.findByRole("heading", { name: "房间 A" });

  fireEvent.click(view.getByRole("button", { name: /房间 B/ }));
  await view.findByRole("heading", { name: "房间 B" });
  await waitFor(() =>
    assert.equal(JSON.parse(localStorage.getItem("conflux.workspace.v1")!).lastRoom.id, 9),
  );

  fireEvent.click(view.getByRole("button", { name: /成员一/ }));
  await view.findByRole("heading", { name: "与 成员一 的对话" });
  assert.equal(
    JSON.parse(localStorage.getItem("conflux.workspace.v1")!).lastRoom.id,
    9,
    "opening a peer overwrote the last selected room",
  );
});

test("ime composition Enter never submits", async () => {
  rememberRoom({ id: 7, createdAt: "2026-11-05T02:00:00Z" });
  const state = makeState({
    rooms: [ROOM_A],
    graph: { nodes: [sessionNode("peer-1", "成员一")], edges: [] },
  });
  mockApi(state);
  const view = mountApp();
  const input = await view.findByPlaceholderText(/^@某成员/);
  fireEvent.change(input, { target: { value: "拼音输入中" } });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true } as never);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(state.calls.some((c) => c.url === "/chat-rooms/7/broadcast"), false);
  assert.equal((input as HTMLInputElement).value, "拼音输入中");
});

// ---- peer conversation ----------------------------------------------------

test("peer conversation sends over web ask with the full id and clears only the sent draft", async () => {
  const state = makeState({
    graph: { nodes: [sessionNode("peer-full-id", "Codex · 项目A")], edges: [] },
  });
  mockApi(state);
  const view = mountApp();
  await waitFor(() => assert.ok(view.getByRole("button", { name: /Codex · 项目A/ })));
  fireEvent.click(view.getByRole("button", { name: /Codex · 项目A/ }));

  const input = await view.findByPlaceholderText(/^向 Codex · 项目A 提问/);
  fireEvent.change(input, { target: { value: "检查构建" } });
  fireEvent.click(view.getByRole("button", { name: "发送" }));
  await waitFor(() =>
    assert.equal(state.calls.some((c) => c.url === "/web/ask"), true),
  );
  const sent = state.calls.find((c) => c.url === "/web/ask");
  assert.deepEqual(sent?.body, { to_session: "peer-full-id", question: "检查构建" });
  assert.equal(state.calls.some((r) => r.url.includes("/chat-rooms/0/")), false);
  await waitFor(() => assert.equal((input as HTMLInputElement).value, ""));
});

test("drafts are isolated per target and survive switching rooms and conversations", async () => {
  const state = makeState({
    rooms: [ROOM_A, ROOM_B],
    graph: {
      nodes: [
        sessionNode("peer-1", "成员一", { chat_room_id: 7 }),
        sessionNode("peer-2", "成员二", { chat_room_id: 9 }),
        sessionNode("solo-1", "独立会话"),
      ],
      edges: [],
    },
  });
  mockApi(state);
  const view = mountApp();
  // newest room B restored first; type there, then A, then the peer — every
  // target must keep exactly its own draft
  const roomBInput = await view.findByPlaceholderText(/^@某成员/);
  fireEvent.change(roomBInput, { target: { value: "房间 B 的草稿" } });

  fireEvent.click(view.getByRole("button", { name: /房间 A/ }));
  const roomAInput = await view.findByPlaceholderText(/^@某成员/);
  await waitFor(() => assert.equal((roomAInput as HTMLInputElement).value, ""));
  fireEvent.change(roomAInput, { target: { value: "房间 A 的草稿" } });

  fireEvent.click(view.getByRole("button", { name: /独立会话/ }));
  const peerInput = await view.findByPlaceholderText(/^向 独立会话 提问/);
  fireEvent.change(peerInput, { target: { value: "单聊草稿" } });

  fireEvent.click(view.getByRole("button", { name: /房间 A/ }));
  const backInput = await view.findByPlaceholderText(/^@某成员/);
  await waitFor(() => assert.equal((backInput as HTMLInputElement).value, "房间 A 的草稿"));

  fireEvent.click(view.getByRole("button", { name: /房间 B/ }));
  const backB = await view.findByPlaceholderText(/^@某成员/);
  await waitFor(() => assert.equal((backB as HTMLInputElement).value, "房间 B 的草稿"));

  fireEvent.click(view.getByRole("button", { name: /独立会话/ }));
  const backPeer = await view.findByPlaceholderText(/^向 独立会话 提问/);
  await waitFor(() => assert.equal((backPeer as HTMLInputElement).value, "单聊草稿"));
});
