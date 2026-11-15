import assert from "node:assert/strict";
import { after, afterEach, mock, test } from "node:test";
import { JSDOM } from "jsdom";
import type { GraphNode } from "@conflux/shared";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  localStorage: dom.window.localStorage,
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
const { cleanup } = await import("@testing-library/react");
const liveClients: Array<{ clear(): void }> = [];
afterEach(() => {
  cleanup();
  for (const client of liveClients.splice(0)) client.clear();
  mock.restoreAll();
  dom.window.localStorage.clear();
});
after(() => dom.window.close());

const { render } = await import("@testing-library/react");
const React = await import("react");
const { createElement } = React;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { Sidebar } = await import("../src/components/Sidebar.tsx");

// The home (sidebar) session list is a RECENCY window, not the full index:
// sessions active in the last 10 days appear under client-convention groups
// (今天 / 昨天 / 最近 7 天 / 10 天内); anything older — or never active —
// stays out of the home list and is only a hint away via the graph tab.

const DAY = 86_400_000;
const node = (id: string, daysAgo: number | null): GraphNode =>
  ({
    id,
    name: `会话-${id}`,
    status: "active",
    type: "session",
    context_count: 0,
    pending_inbox: 0,
    ...(daysAgo === null ? {} : { last_heartbeat_at: new Date(Date.now() - daysAgo * DAY).toISOString() }),
  }) as GraphNode;

function mountSidebar(sessions: GraphNode[]) {
  // Sidebar's health badge polls the daemon; keep the test offline.
  mock.method(globalThis, "fetch", async () => Response.json({ ok: true }));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  liveClients.push(client);
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(Sidebar, {
        activeTab: "chat",
        onTabChange: () => {},
        sessions,
        rooms: [],
        selectedRoomId: null,
        selectedSessionId: null,
        onSelectRoom: () => {},
        onSelectSession: () => {},
        onCreateRoom: () => {},
      }),
    ),
  );
}

test("groups recent sessions client-style and counts only in-window ones", async () => {
  const view = mountSidebar([
    node("today", 0),
    node("yesterday", 1),
    node("three-days", 3),
    node("eight-days", 8),
    node("fifteen-days", 15),
    node("no-timestamp", null),
  ]);
  for (const label of ["今天", "昨天", "最近 7 天", "10 天内"]) {
    assert.ok(view.getByText(label, { exact: false }), `group ${label} renders`);
  }
  assert.ok(view.getByText("会话-today"));
  assert.ok(view.getByText("会话-eight-days"));
  assert.ok(view.getByText("会话-no-timestamp"), "missing heartbeat is not assumed stale");
  assert.ok(view.getByText(/最近会话 · 5/), "header counts only in-window sessions");
  assert.ok(view.getByText(/更早的 1 个会话见「图谱」/), "out-of-window hint names the count");
  assert.equal(view.queryByText("会话-fifteen-days"), null, "15-day-old session stays out");
});

test("all sessions stale -> hint only, no empty-state contradiction", async () => {
  const view = mountSidebar([node("old-a", 12), node("old-b", 40)]);
  assert.equal(view.queryByText(/还没有会话/), null);
  assert.ok(view.getByText(/更早的 2 个会话见「图谱」/));
});

test("boundary days land in the right bucket", async () => {
  const view = mountSidebar([node("d2", 2), node("d6", 6), node("d7", 7), node("d9", 9), node("d10", 10)]);
  const groupOf = (id: string) =>
    view.getByText(`会话-${id}`).closest("div.mb-2")?.querySelector("div.flex")?.textContent;
  assert.match(groupOf("d2") ?? "", /最近 7 天/);
  assert.match(groupOf("d6") ?? "", /最近 7 天/);
  assert.match(groupOf("d7") ?? "", /10 天内/);
  assert.match(groupOf("d9") ?? "", /10 天内/);
  assert.equal(view.queryByText("会话-d10"), null, "exactly 10 days old is outside the window");
});
