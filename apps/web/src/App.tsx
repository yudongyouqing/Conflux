import { useState, useCallback, useMemo, lazy, Suspense, useRef } from "react";
import { Sidebar, type TabId } from "./components/Sidebar";
import { GraphTab } from "./components/GraphTab";
import { MessageTab } from "./components/MessageTab";
import { AgentTab } from "./components/AgentTab";
import { DetailPanel } from "./components/DetailPanel";
import { useGraph } from "./hooks";
import { X } from "lucide-react";
import type { Message, GraphNode } from "@conflux/shared";

// Low-frequency destinations load on first visit, then stay mounted
// (keep-alive) like every other view.
const RuntimesTab = lazy(() =>
  import("./components/RuntimesTab").then((m) => ({ default: m.RuntimesTab })),
);
const SettingsTab = lazy(() =>
  import("./components/SettingsTab").then((m) => ({ default: m.SettingsTab })),
);

const DRAWER_DEFAULT = 320;
const DRAWER_MIN = 280;
const DRAWER_MAX = 560;
const DRAWER_WIDTH_KEY = "conflux.drawer-width";

function initialDrawerWidth(): number {
  const v = Number(localStorage.getItem(DRAWER_WIDTH_KEY));
  return Number.isFinite(v) && v >= DRAWER_MIN && v <= DRAWER_MAX ? v : DRAWER_DEFAULT;
}

export default function App() {
  const [tab, setTab] = useState<TabId>("graph");
  // views mount on first visit and never unmount — viewport zoom, scroll
  // positions and query caches survive tab switches (#107)
  const [visited, setVisited] = useState<ReadonlySet<TabId>>(new Set(["graph"]));
  const switchTab = useCallback((next: TabId) => {
    setTab(next);
    setVisited((prev) => (prev.has(next) ? prev : new Set(prev).add(next)));
  }, []);

  const [selectedSession, setSelectedSession] = useState<GraphNode | null>(null);
  const [selectedMessage, setSelectedMessage] = useState<Message | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<{ id: number; from: string; to: string } | null>(
    null,
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerWidth, setDrawerWidth] = useState(initialDrawerWidth);
  const graph = useGraph();

  const nodeMap = useMemo(() => {
    const m = new Map<string, GraphNode>();
    graph.data?.nodes.forEach((n) => m.set(n.id, n));
    return m;
  }, [graph.data]);

  const sessionNameLookup = useCallback((id: string) => nodeMap.get(id)?.name, [nodeMap]);

  const sessionStatusLookup = useCallback((id: string) => nodeMap.get(id)?.status, [nodeMap]);

  const handleSelectSession = useCallback(
    (sid: string | null) => {
      setSelectedMessage(null);
      setSelectedEdge(null);
      if (!sid) {
        setSelectedSession(null);
        return;
      }
      const node = graph.data?.nodes.find((n) => n.id === sid) ?? null;
      setSelectedSession(node);
      if (node) setDrawerOpen(true);
    },
    [graph.data],
  );

  // sidebar list click: inspect the node on the graph view
  const handleSidebarSelect = useCallback(
    (sid: string) => {
      switchTab("graph");
      handleSelectSession(sid);
    },
    [switchTab, handleSelectSession],
  );

  const handleSelectMessage = useCallback((msg: Message | null) => {
    setSelectedSession(null);
    setSelectedEdge(null);
    setSelectedMessage(msg);
    if (msg) setDrawerOpen(true);
  }, []);

  const handleSelectEdge = useCallback(
    (edge: { id: number; from: string; to: string } | null) => {
      setSelectedSession(null);
      setSelectedMessage(null);
      setSelectedEdge(edge);
      if (edge) setDrawerOpen(true);
    },
    [],
  );

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    setSelectedSession(null);
    setSelectedMessage(null);
    setSelectedEdge(null);
  }, []);

  // ---- drawer resize (left-edge handle, rAF-free pointer math) ----------
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const onHandleDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startW: drawerWidth };
      const move = (ev: PointerEvent) => {
        if (!dragRef.current) return;
        const next = dragRef.current.startW - (ev.clientX - dragRef.current.startX);
        setDrawerWidth(Math.min(DRAWER_MAX, Math.max(DRAWER_MIN, next)));
      };
      const up = () => {
        dragRef.current = null;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        setDrawerWidth((w) => {
          try {
            localStorage.setItem(DRAWER_WIDTH_KEY, String(w));
          } catch {
            /* private mode — width just won't persist */
          }
          return w;
        });
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [drawerWidth],
  );
  const resetDrawerWidth = useCallback(() => {
    setDrawerWidth(DRAWER_DEFAULT);
    try {
      localStorage.setItem(DRAWER_WIDTH_KEY, String(DRAWER_DEFAULT));
    } catch {
      /* ignore */
    }
  }, []);

  const surface = (id: TabId, children: React.ReactNode) => (
    <div className="tab-surface" data-active={tab === id} aria-hidden={tab !== id}>
      {children}
    </div>
  );

  return (
    <div className="flex h-full bg-paper">
      <Sidebar
        activeTab={tab}
        onTabChange={switchTab}
        sessions={graph.data?.nodes ?? []}
        selectedSessionId={selectedSession?.id ?? null}
        onSelectSession={handleSidebarSelect}
      />
      <div className="flex flex-1 overflow-hidden min-w-0">
        <main className="relative flex-1 overflow-hidden">
          {surface(
            "graph",
            <GraphTab
              onSelectSession={handleSelectSession}
              selectedSessionId={selectedSession?.id ?? null}
              onSelectEdge={handleSelectEdge}
              selectedEdge={selectedEdge}
            />,
          )}
          {surface(
            "messages",
            <MessageTab
              onSelectMessage={handleSelectMessage}
              selectedMessageId={selectedMessage?.id ?? null}
            />,
          )}
          {surface("agents", <AgentTab />)}
          {surface(
            "runtimes",
            visited.has("runtimes") ? (
              <Suspense fallback={<RoutePending />}>
                <RuntimesTab />
              </Suspense>
            ) : null,
          )}
          {surface(
            "settings",
            visited.has("settings") ? (
              <Suspense fallback={<RoutePending />}>
                <SettingsTab />
              </Suspense>
            ) : null,
          )}
        </main>
        {/* The detail rail belongs to the graph view (node/edge/channel
         * inspection); messages own their full-screen view, the rest are
         * self-contained. Closable + resizable (#107). */}
        {tab === "graph" && drawerOpen && (
          <aside
            className="relative border-l border-line bg-surface overflow-hidden flex-shrink-0"
            style={{ width: `min(${drawerWidth}px, 45vw)` }}
          >
            <div
              onPointerDown={onHandleDown}
              onDoubleClick={resetDrawerWidth}
              title="拖动调宽 · 双击复位"
              className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-accent/30 active:bg-accent/50 z-10"
            />
            <button
              onClick={closeDrawer}
              title="关闭"
              aria-label="关闭详情面板"
              className="absolute right-2.5 top-2.5 z-10 p-1 rounded-md text-ink-faint hover:bg-paper hover:text-ink"
            >
              <X size={14} />
            </button>
            <DetailPanel
              session={selectedSession}
              message={selectedMessage}
              edge={selectedEdge}
              sessionNameLookup={sessionNameLookup}
              sessionStatusLookup={sessionStatusLookup}
              onOpenEdge={handleSelectEdge}
            />
          </aside>
        )}
      </div>
    </div>
  );
}

function RoutePending() {
  return (
    <div className="h-full flex items-center justify-center text-xs text-ink-faint">加载中…</div>
  );
}
