import assert from "node:assert/strict";
import { after, afterEach, mock, test } from "node:test";
import { JSDOM } from "jsdom";
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@conflux/shared";
import { ChatPanel } from "../src/components/ChatPanel.tsx";
import { SettingsTab } from "../src/components/SettingsTab.tsx";
import { api } from "../src/api.ts";
import { useWakeStream } from "../src/use-wake-stream.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(cb, 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
const { cleanup, render, renderHook, fireEvent, waitFor, act } = await import("@testing-library/react");
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach((c) => c.clear()); mock.restoreAll(); });
after(() => dom.window.close());
const agent = { id: 1, name: "Fixture", model_config: { provider: "openai", model: "test" } } as Agent;

test("chat ignores IME confirmation, aborts on back and releases input after transport failure", async () => {
  let calls = 0;
  let signal: AbortSignal | undefined;
  let fail: (error: Error) => void = () => {};
  mock.method(api, "streamChat", async (...args: Parameters<typeof api.streamChat>) => {
    calls++;
    signal = args[8];
    await new Promise<void>((_resolve, reject) => { fail = reject; });
  });
  const view = render(createElement(ChatPanel, { agent, onBack: () => {} }));
  const input = view.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "你好" } });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  assert.equal(calls, 0);
  fireEvent.keyDown(input, { key: "Enter" });
  assert.equal(calls, 1);
  await act(async () => { fail(new Error("connection lost")); });
  await waitFor(() => assert.equal(input.disabled, false));
  assert.ok(view.getByText("connection lost"));
  fireEvent.change(input, { target: { value: "retry" } });
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.click(view.getByRole("button", { name: "返回" }));
  assert.equal(signal?.aborted, true);
  await act(async () => { fail(new DOMException("aborted", "AbortError")); });
});

test("hidden settings do not poll and import invalidates every workspace cache and refreshes counts", async () => {
  const calls: string[] = [];
  let count = 1;
  mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input); calls.push(url);
    if (url === "/data/counts") return Response.json({ sessions: count++, messages: 0, contextEntries: 0 });
    if (url === "/data/import") return Response.json({ imported: 1, skipped: 0, overwritten: 0, copied: 0 });
    return Response.json({ terminal: { terminal: "wt", claude_path: "", codex_path: "" }, options: [], wake_active_count: 0 });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  const node = (active: boolean) => createElement(QueryClientProvider, { client }, createElement(SettingsTab, { active }));
  const view = render(node(false));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.deepEqual(calls, []);
  view.rerender(node(true));
  await waitFor(() => assert.ok(view.getByText("数据清除")));
  for (const key of ["sessions", "chat-rooms", "room-messages", "room-tasks", "runtime-instances"]) client.setQueryData([key], {});
  mock.method(window, "confirm", () => true);
  const file = { text: async () => JSON.stringify({ format: "conflux", version: 1, sessions: [] }) };
  fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [file] } });
  await waitFor(() => assert.ok(view.getByText(/导入完成/)));
  for (const key of ["sessions", "chat-rooms", "room-messages", "room-tasks", "runtime-instances"]) assert.equal(client.getQueryState([key])?.isInvalidated, true, key);
  assert.equal(calls.filter((url) => url === "/data/counts").length, 2);
});

test("wake stream distinguishes historical output and resets replay on reconnect", () => {
  let source: FakeSource;
  class FakeSource extends dom.window.EventTarget {
    onerror: (() => void) | null = null;
    closed = false;
    constructor(_url: string) { super(); source = this; }
    close() { this.closed = true; }
    emit(type: string, data: unknown = {}) { this.dispatchEvent(new dom.window.MessageEvent(type, { data: JSON.stringify(data) })); }
  }
  const old = globalThis.EventSource;
  Object.assign(globalThis, { EventSource: FakeSource });
  try {
    const view = renderHook(() => useWakeStream("worker"));
    act(() => source.emit("start"));
    assert.equal(view.result.current.live, false);
    act(() => { source.emit("chunk", "history\n[wake ended 2026-11-18T00:00:00Z]\n"); source.emit("ended"); });
    assert.equal(view.result.current.live, false);
    act(() => { source.emit("start"); source.emit("chunk", "history\n[wake ended 2026-11-18T00:00:00Z]\n"); source.emit("ended"); });
    assert.equal(view.result.current.text.match(/history/g)?.length, 1);
    act(() => source.emit("chunk", "x".repeat(300000)));
    assert.ok(view.result.current.text.length <= 256 * 1024);
    view.unmount();
    assert.equal(source.closed, true);
  } finally { Object.assign(globalThis, { EventSource: old }); }
});
