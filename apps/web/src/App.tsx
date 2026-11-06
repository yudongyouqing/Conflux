import {
  useState,
  useCallback,
  useMemo,
  useReducer,
  lazy,
  Suspense,
  useRef,
  useEffect,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Sidebar, type TabId } from "./components/Sidebar";
import { MessageTab } from "./components/MessageTab";
import { AgentTab } from "./components/AgentTab";
import { WorkspaceTab } from "./components/WorkspaceTab";
import { WorkspaceDetails } from "./components/WorkspaceDetails";
import { DetailPanel } from "./components/DetailPanel";
import { useGraph } from "./hooks";
import { useChatRooms } from "./room-hooks";
import {
  draftsReducer,
  loadWorkspacePreference,
  restoreRoom,
  saveWorkspacePreference,
  targetKey,
  type ConversationTarget,
  type DraftMap,
  type WorkspacePreference,
} from "./workspace-state";
import { ChatRoomWizard } from "./components/ChatRoomWizard";
import { Menu, X } from "lucide-react";
import type { Message, GraphNode, ChatRoom } from "@conflux/shared";

// Low-frequency destinations load on first visit, then stay mounted
// (keep-alive) like every other view. The graph view also lazy-loads so a
// cold start on chat never pulls the React Flow renderer.
const GraphTab = lazy(() =>
  import("./components/GraphTab").then((m) => ({ default: m.GraphTab })),
);
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

const TAB_LABELS: Record<TabId, string> = {
  chat: "聊天",
  graph: "图谱",
  messages: "消息流",
  agents: "Agents",
  runtimes: "运行时",
  settings: "设置",
};

export default function App() {
  // ---- shell ---------------------------------------------------------------
  const [tab, setTab] = useState<TabId>("chat");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // views mount on first visit and never unmount — viewport zoom, scroll
  // positions and query caches survive tab switches (#107)
  const [visited, setVisited] = useState<ReadonlySet<TabId>>(new Set(["chat"]));
  const switchTab = useCallback((next: TabId) => {
    setTab(next);
    setMobileNavOpen(false);
    setVisited((prev) => (prev.has(next) ? prev : new Set(prev).add(next)));
  }, []);

  // ---- workspace selection (chat-first owner) ------------------------------
  const preferenceRef = useRef<WorkspacePreference>(
    loadWorkspacePreference() ?? { version: 1, lastRoom: null, detailsOpen: true },
  );
  const [target, setTarget] = useState<ConversationTarget>(null);
  const [drafts, dispatchDrafts] = useReducer(draftsReducer, {} as DraftMap);
  // directed @-targets per room key — memory-only like drafts, so a room
  // switch (and back) keeps both the text and where it was aimed
  const [directedExecutors, setDirectedExecutors] = useState<Record<string, string>>({});
  const [wizardOpen, setWizardOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(preferenceRef.current.detailsOpen);

  const graph = useGraph();
  const roomsQuery = useChatRooms();
  const rooms = useMemo(() => roomsQuery.data?.rooms ?? [], [roomsQuery.data]);
  const sessions = useMemo(() => graph.data?.nodes ?? [], [graph.data]);

  // Restore only from a SUCCESSFUL room list: an error response is not
  // "no rooms" and must never clear a selection. After the first restore,
  // later refreshes only repair a selection whose room disappeared.
  const selectionInitedRef = useRef(false);
  const selectionReadyRef = useRef(false);
  useEffect(() => {
    if (!roomsQuery.isSuccess) return;
    if (!selectionInitedRef.current) {
      selectionInitedRef.current = true;
      selectionReadyRef.current = true;
      const restored = restoreRoom(rooms, preferenceRef.current.lastRoom);
      setTarget(restored ? { kind: "room", id: restored.id } : null);
      return;
    }
    setTarget((current) => {
      if (current?.kind === "room" && !rooms.some((r) => r.id === current.id)) {
        const next = restoreRoom(rooms, null);
        return next ? { kind: "room", id: next.id } : null;
      }
      return current;
    });
  }, [roomsQuery.isSuccess, rooms]);

  // Persist the last selected room (id + creation time) and details
  // preference. The remembered room tracks every actual room selection in
  // a live ref — opening a peer afterwards must keep the room memory, not
  // rewind it to whatever the boot-time snapshot held. Writes never throw
  // into the interaction; wait for the first successful list so a boot
  // failure cannot clobber the memory.
  const lastRoomRef = useRef(preferenceRef.current.lastRoom);
  useEffect(() => {
    if (!selectionReadyRef.current) return;
    if (target?.kind === "room") {
      const room = rooms.find((r) => r.id === target.id);
      if (room) lastRoomRef.current = { id: room.id, createdAt: room.created_at };
    }
    saveWorkspacePreference({ version: 1, lastRoom: lastRoomRef.current, detailsOpen });
  }, [target, rooms, detailsOpen]);

  const openRoom = useCallback((id: number) => {
    setTarget({ kind: "room", id });
    setTab("chat");
    setMobileNavOpen(false);
  }, []);

  const openSession = useCallback((id: string) => {
    setTarget({ kind: "session", id });
    setTab("chat");
    setMobileNavOpen(false);
  }, []);

  const handleRoomCreated = useCallback((room: ChatRoom) => {
    setTarget({ kind: "room", id: room.id });
    // remember the server's real creation time immediately — the list
    // refetch may still be in flight when the persist effect runs
    lastRoomRef.current = { id: room.id, createdAt: room.created_at };
  }, []);

  // Repair after delete: only when the deleted room is STILL the current
  // target does the selection fall back to the next valid room.
  const handleRoomDeleted = useCallback(
    (roomId: number) => {
      setTarget((current) => {
        if (current?.kind !== "room" || current.id !== roomId) return current;
        const remaining = rooms.filter((r) => r.id !== roomId);
        const next = restoreRoom(remaining, null);
        return next ? { kind: "room", id: next.id } : null;
      });
    },
    [rooms],
  );

  const targetDraft = useMemo(
    () =>
      target
        ? (drafts[targetKey(target)] ?? { text: "", revision: 0 })
        : { text: "", revision: 0 },
    [drafts, target],
  );

  const handleDraftChange = useCallback((t: ConversationTarget, text: string) => {
    if (!t) return;
    dispatchDrafts({ type: "edit", targetKey: targetKey(t), text });
  }, []);

  const handleDraftSubmitted = useCallback((key: string, revision: number) => {
    dispatchDrafts({ type: "submitted", targetKey: key, revision });
  }, []);

  const currentExecutor = target ? (directedExecutors[targetKey(target)] ?? null) : null;
  const handleExecutorChange = useCallback((t: ConversationTarget, executorId: string | null) => {
    if (!t) return;
    const key = targetKey(t);
    setDirectedExecutors((prev) => {
      if (executorId == null) {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return prev[key] === executorId ? prev : { ...prev, [key]: executorId };
    });
  }, []);

  const toggleDetails = useCallback(() => {
    setDetailsOpen((v) => !v);
    // narrow screens: nav and details drawers are mutually exclusive
    setMobileNavOpen(false);
  }, []);

  // ---- graph-tab inspection state (unchanged behavior) ----------------------
  const [selectedSession, setSelectedSession] = useState<GraphNode | null>(null);
  const [selectedMessage, setSelectedMessage] = useState<Message | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<{ id: number; from: string; to: string } | null>(
    null,
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerWidth, setDrawerWidth] = useState(initialDrawerWidth);

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

  // "在全局图谱中查看" from a workspace conversation: inspect on the graph
  const inspectSessionOnGraph = useCallback(
    (sid: string) => {
      switchTab("graph");
      handleSelectSession(sid);
    },
    [switchTab, handleSelectSession],
  );

  // a channel initiated from session details keeps its graph edge view
  const openGraphEdge = useCallback(
    (edge: { id: number; from: string; to: string }) => {
      switchTab("graph");
      setSelectedSession(null);
      setSelectedMessage(null);
      setSelectedEdge(edge);
      setDrawerOpen(true);
    },
    [switchTab],
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
    (e: ReactPointerEvent<HTMLDivElement>) => {
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

  const surface = (id: TabId, children: ReactNode) => (
    <div className="tab-surface" data-active={tab === id} aria-hidden={tab !== id}>
      {children}
    </div>
  );

  return (
    <div className="flex h-full bg-paper">
      <Sidebar
        activeTab={tab}
        onTabChange={switchTab}
        sessions={sessions}
        rooms={rooms}
        selectedRoomId={target?.kind === "room" ? target.id : null}
        selectedSessionId={target?.kind === "session" ? target.id : null}
        onSelectRoom={openRoom}
        onSelectSession={openSession}
        onCreateRoom={() => setWizardOpen(true)}
        mobileOpen={mobileNavOpen}
        onCloseMobile={() => setMobileNavOpen(false)}
      />
      <div className="relative flex flex-1 overflow-hidden min-w-0">
        <main className="relative flex-1 overflow-hidden mobile-main">
          <div className="mobile-topbar">
            <button
              type="button"
              className="mobile-menu-button"
              aria-label="打开导航"
              onClick={() => {
                setMobileNavOpen(true);
                setDetailsOpen(false);
              }}
            >
              <Menu size={18} />
            </button>
            <span>{TAB_LABELS[tab]}</span>
          </div>
          {surface(
            "chat",
            <WorkspaceTab
              target={target}
              active={tab === "chat"}
              roomsQuery={roomsQuery}
              rooms={rooms}
              sessions={sessions}
              onSelectTarget={setTarget}
              onOpenTab={switchTab}
              onInspectSession={inspectSessionOnGraph}
              onCreateRoom={() => setWizardOpen(true)}
              detailsOpen={detailsOpen}
              onToggleDetails={toggleDetails}
              draft={targetDraft}
              onDraftChange={handleDraftChange}
              onDraftSubmitted={handleDraftSubmitted}
              executorId={currentExecutor}
              onExecutorChange={(id) => handleExecutorChange(target, id)}
            />,
          )}
          {surface(
            "graph",
            visited.has("graph") ? (
              <Suspense fallback={<RoutePending />}>
                <GraphTab
                  onSelectSession={handleSelectSession}
                  selectedSessionId={selectedSession?.id ?? null}
                  onSelectEdge={handleSelectEdge}
                  selectedEdge={selectedEdge}
                />
              </Suspense>
            ) : null,
          )}
          {surface(
            "messages",
            visited.has("messages") ? (
              <MessageTab
                onSelectMessage={handleSelectMessage}
                selectedMessageId={selectedMessage?.id ?? null}
              />
            ) : null,
          )}
          {surface("agents", visited.has("agents") ? <AgentTab /> : null)}
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

        {/* Workspace details rail: inline column on wide screens, overlay
         * drawer below 1280px; Esc returns focus to the header trigger. */}
        {tab === "chat" && detailsOpen && target && (
          <aside className="workspace-details border-l border-line bg-surface" aria-label="详情面板">
            <WorkspaceDetails
              target={target}
              rooms={rooms}
              sessions={sessions}
              onClose={() => setDetailsOpen(false)}
              onRoomDeleted={handleRoomDeleted}
              onOpenSession={openSession}
              onOpenGraphEdge={openGraphEdge}
            />
          </aside>
        )}

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
            {/* top drag strip — the whole window should be grabbable here */}
            <div className="absolute left-0 right-0 top-0 h-10 app-drag z-[5]" />
            <button
              onClick={closeDrawer}
              title="关闭"
              aria-label="关闭详情面板"
              className="absolute right-3 top-3 z-10 p-1.5 rounded-lg text-ink-faint hover:bg-tile-hover hover:text-ink app-no-drag"
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

      {wizardOpen && (
        <ChatRoomWizard
          sessions={sessions}
          onClose={() => setWizardOpen(false)}
          onCreated={handleRoomCreated}
        />
      )}
    </div>
  );
}

function RoutePending() {
  return (
    <div className="h-full flex items-center justify-center text-xs text-ink-faint">加载中…</div>
  );
}
