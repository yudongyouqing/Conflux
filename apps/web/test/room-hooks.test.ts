import assert from "node:assert/strict";
import { after, afterEach, mock, test } from "node:test";
import { JSDOM } from "jsdom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { createElement, type ReactNode } from "react";
import {
  useChatRooms,
  useRoomMessages,
  useRoomTasks,
  useCreateRoom,
  useJoinRoom,
  useLeaveRoom,
  useDeleteRoom,
  useRoomSummon,
  useRoomBroadcast,
} from "../src/room-hooks.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });

const { cleanup, renderHook, waitFor } = await import("@testing-library/react");

afterEach(() => {
  cleanup();
  mock.restoreAll();
});
after(() => dom.window.close());

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
}

function setupHook<T, P>(callback: (props: P) => T, initialProps: P) {
  const queryClient = makeClient();
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  const rendered = renderHook(callback, { wrapper, initialProps });
  return { ...rendered, queryClient };
}

test("room list uses the chat-rooms key, five-second polling and the query signal", async () => {
  const requests: Array<{ url: string; signal?: AbortSignal }> = [];
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), signal: init?.signal });
    return Response.json({ rooms: [] });
  });
  const { result, queryClient } = setupHook(() => useChatRooms(), undefined);

  await waitFor(() => assert.deepEqual(result.current.data, { rooms: [] }));

  assert.equal(requests[0].url, "/chat-rooms");
  // the query's own AbortSignal must reach fetch so target switches cancel
  // in-flight room reads instead of letting them land on the wrong cache
  assert.ok(requests[0].signal instanceof AbortSignal);
  const query = queryClient
    .getQueryCache()
    .getAll()
    .find((q) => q.queryKey[0] === "chat-rooms")!;
  assert.equal(query.options.refetchInterval, 5000);
  assert.equal(
    queryClient.getQueryCache().getAll().filter((q) => q.queryKey[0] === "chat-rooms").length,
    1,
  );
});

test("slow room A responses are cancelled once the user moves to room B", async () => {
  let resolveA!: (value: Response) => void;
  let signalA: AbortSignal | undefined;
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/chat-rooms/1/messages") {
      signalA = init?.signal;
      return new Promise<Response>((resolve) => {
        resolveA = resolve;
      });
    }
    return Response.json({ messages: [{ id: 2, room_id: 2, question: "只属于 B 的结果" }] });
  });

  const { result, rerender, queryClient } = setupHook(
    (roomId: number) => useRoomMessages(roomId),
    1,
  );
  await waitFor(() => assert.ok(signalA));
  rerender(2);
  await waitFor(() => assert.equal(result.current.data?.messages[0]?.room_id, 2));

  // the target switch must cancel the stale read, not merely ignore it
  assert.equal(signalA?.aborted, true);
  resolveA(Response.json({ messages: [{ id: 1, room_id: 1, question: "只属于 A 的结果" }] }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(result.current.data?.messages[0]?.question, "只属于 B 的结果");
  assert.equal(queryClient.getQueryState(["room-messages", 1])?.data, undefined);
});

test("room thread queries stay silent for missing or invalid room ids", async () => {
  const calls: string[] = [];
  mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    calls.push(String(input));
    return Response.json({ messages: [] });
  });
  const a = setupHook((id: number | null) => useRoomMessages(id), null);
  const b = setupHook((id: number) => useRoomTasks(id), 0);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls, []);
  a.unmount();
  b.unmount();
});

test("room tasks use their own query key with three-second polling", async () => {
  mock.method(globalThis, "fetch", async () => Response.json({ tasks: [], status: [] }));
  const { result, queryClient } = setupHook((id: number) => useRoomTasks(id), 5);
  await waitFor(() => assert.deepEqual(result.current.data, { tasks: [], status: [] }));
  const query = queryClient.getQueryCache().getAll().find((q) => q.queryKey[0] === "room-tasks")!;
  assert.deepEqual(query.queryKey, ["room-tasks", 5]);
  assert.equal(query.options.refetchInterval, 3000);
});

test("room mutations fire exactly once and do not auto-retry on failure", async () => {
  let calls = 0;
  mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response("server down", { status: 500 });
  });
  const { result } = setupHook(() => useCreateRoom(), undefined);
  await assert.rejects(result.current.mutateAsync({ name: "审查", members: [] }));
  assert.equal(calls, 1);
});

test("create, join, leave and delete invalidate the room list and shared graph only", async () => {
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "DELETE" && url === "/chat-rooms/4") return Response.json({ ok: true });
    if (url === "/chat-rooms/leave") return Response.json({ ok: true });
    if (url === "/chat-rooms/3/join") return Response.json({ ok: true });
    return Response.json({ room: { id: 4, name: "新房间", description: null, members: [], created_at: "2026-11-05T02:00:00Z", updated_at: "2026-11-05T02:00:00Z" } });
  });
  const { result, queryClient } = setupHook(
    () => ({ create: useCreateRoom(), join: useJoinRoom(), leave: useLeaveRoom(), del: useDeleteRoom() }),
    undefined,
  );

  const created = await result.current.create.mutateAsync({ name: "新房间", members: [] });
  assert.equal(created.room.id, 4);

  for (const mutation of [result.current.join, result.current.leave, result.current.del]) {
    for (const key of ["chat-rooms", "graph", "sessions", "peer-messages", "room-messages"]) {
      queryClient.setQueryData([key, "probe"], {});
    }
    queryClient.setQueryData(["chat-rooms", "probe"], {});
    if (mutation === result.current.join) await mutation.mutateAsync({ roomId: 3, sessionId: "s1" });
    else if (mutation === result.current.leave) await mutation.mutateAsync("s1");
    else await mutation.mutateAsync(4);
    assert.equal(queryClient.getQueryState(["chat-rooms", "probe"])?.isInvalidated, true);
    assert.equal(queryClient.getQueryState(["graph", "probe"])?.isInvalidated, true);
    assert.equal(queryClient.getQueryState(["sessions", "probe"])?.isInvalidated, false);
    assert.equal(queryClient.getQueryState(["peer-messages", "probe"])?.isInvalidated, false);
    assert.equal(queryClient.getQueryState(["room-messages", "probe"])?.isInvalidated, false);
  }
});

test("summon and broadcast invalidate only the submitting room's thread and tasks", async () => {
  mock.method(globalThis, "fetch", async () => Response.json({ task_id: 9, injected: true, method: "queue" }));
  const { result, queryClient } = setupHook(
    () => ({ summon: useRoomSummon(), broadcast: useRoomBroadcast() }),
    undefined,
  );

  for (const run of [
    () => result.current.summon.mutateAsync({ roomId: 7, executorSessionId: "s1", prompt: "检查构建" }),
    () => result.current.broadcast.mutateAsync({ roomId: 7, prompt: "全员周报" }),
  ]) {
    for (const roomId of [7, 8]) {
      queryClient.setQueryData(["room-messages", roomId], {});
      queryClient.setQueryData(["room-tasks", roomId], {});
    }
    await run();
    for (const key of ["room-messages", "room-tasks"]) {
      assert.equal(queryClient.getQueryState([key, 7])?.isInvalidated, true, `${key} 7`);
      assert.equal(queryClient.getQueryState([key, 8])?.isInvalidated, false, `${key} 8`);
    }
  }
});
