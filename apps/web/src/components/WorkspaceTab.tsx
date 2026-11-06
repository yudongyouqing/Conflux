import { useEffect, useRef, useState, lazy, Suspense } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Loader2, Plus, RefreshCw, Users, MessageSquare, Network, Bot, Info, Globe } from "lucide-react";
import type { ChatRoom, Graph, GraphNode } from "@conflux/shared";
import type { ConversationTarget, Draft } from "../workspace-state";
import { scopeGraphToRoom } from "../graph-scope";
import type { TabId } from "./Sidebar";
import { RoomChat } from "./RoomChat";
import { PeerConversation } from "./PeerConversation";

// Same lazy chunk the main graph tab uses — a chat-first cold start never
// pulls the React Flow renderer.
const GraphTab = lazy(() =>
  import("./GraphTab").then((m) => ({ default: m.GraphTab })),
);

export interface WorkspaceTabProps {
  target: ConversationTarget;
  active: boolean;
  /** The workspace's room-list query — drives loading/error/empty states. */
  roomsQuery: UseQueryResult<{ rooms: ChatRoom[] }, Error>;
  rooms: readonly ChatRoom[];
  sessions: readonly GraphNode[];
  onSelectTarget: (target: ConversationTarget) => void;
  onOpenTab: (tab: TabId) => void;
  /** graph-tab node inspection for the session header action */
  onInspectSession: (sessionId: string) => void;
  onCreateRoom: () => void;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  draft: Draft;
  onDraftChange: (target: ConversationTarget, text: string) => void;
  onDraftSubmitted: (targetKey: string, revision: number) => void;
  /** Directed executor for the current room target (workspace-owned). */
  executorId: string | null;
  onExecutorChange: (id: string | null) => void;
  /** shared graph data for the room/global graph views */
  graph?: Graph;
  graphLoading?: boolean;
  graphError?: string | null;
  /** workspace-graph node click opens details only (explicit action converses) */
  onGraphNodeSelect: (sessionId: string) => void;
  /** graph edge click keeps the existing edge channel view */
  onOpenGraphEdge: (edge: { id: number; from: string; to: string }) => void;
}

/**
 * The chat-first workspace surface: target header, conversation body and
 * the tri-state empty view (loading / error+retry / guide). The graph view
 * arrives beside conversations in a later stage; the shell already keeps
 * the target, drafts and details owned one level up.
 */
export function WorkspaceTab({
  target,
  active,
  roomsQuery,
  rooms,
  sessions,
  onSelectTarget,
  onOpenTab,
  onInspectSession,
  onCreateRoom,
  detailsOpen,
  onToggleDetails,
  draft,
  onDraftChange,
  onDraftSubmitted,
  executorId,
  onExecutorChange,
  graph,
  graphLoading,
  graphError,
  onGraphNodeSelect,
  onOpenGraphEdge,
}: WorkspaceTabProps) {
  const detailsButtonRef = useRef<HTMLButtonElement>(null);
  // The graph is a per-workspace view of the SAME target: switching between
  // chat and graph must not touch the target, drafts or members. Session
  // targets have no room graph, so they always land back on chat.
  const [view, setView] = useState<"chat" | "graph">("chat");
  const [graphScope, setGraphScope] = useState<"room" | "global">("room");
  useEffect(() => {
    if (target?.kind !== "room") {
      setView("chat");
      setGraphScope("room");
    }
  }, [target?.kind]);

  // Esc closes the details drawer and hands focus back to its trigger
  useEffect(() => {
    if (!detailsOpen || !active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onToggleDetails();
        detailsButtonRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailsOpen, active, onToggleDetails]);

  if (target === null) {
    if (roomsQuery.isLoading) {
      return (
        <div className="h-full flex items-center justify-center text-xs text-ink-faint gap-2">
          <Loader2 size={14} className="animate-spin" /> 正在加载聊天室…
        </div>
      );
    }
    if (roomsQuery.isError) {
      return (
        <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center">
          <div role="alert" className="text-xs text-danger">
            聊天室加载失败：{(roomsQuery.error as Error).message}
          </div>
          <button
            type="button"
            onClick={() => roomsQuery.refetch()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-accent text-on-accent text-xs font-medium hover:bg-accent-deep"
          >
            <RefreshCw size={13} /> 重试
          </button>
        </div>
      );
    }
    return (
      <div className="h-full flex flex-col items-center justify-center px-6 text-center">
        <div className="w-12 h-12 rounded-2xl bg-surface border border-line flex items-center justify-center mb-4">
          <Users size={20} className="text-ink-faint" />
        </div>
        <div className="text-sm text-ink font-medium">还没有聊天室</div>
        <p className="text-xs text-ink-faint mt-1 max-w-xs">
          创建一个聊天室，把相关会话拉进来协作；圈子内自由对话，圈外隔离
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2 mt-5">
          <button
            type="button"
            onClick={onCreateRoom}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-accent text-on-accent text-xs font-medium hover:bg-accent-deep"
          >
            <Plus size={13} /> 创建聊天室
          </button>
          <button
            type="button"
            onClick={() => onOpenTab("graph")}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-line text-ink-muted text-xs hover:bg-tile-hover"
          >
            <Network size={13} /> 接入已有会话
          </button>
          <button
            type="button"
            onClick={() => onOpenTab("runtimes")}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-line text-ink-muted text-xs hover:bg-tile-hover"
          >
            <Bot size={13} /> 配置编码助手
          </button>
        </div>
      </div>
    );
  }

  if (target.kind === "room") {
    const room = rooms.find((r) => r.id === target.id);
    if (!room) {
      return (
        <div className="h-full flex items-center justify-center text-xs text-ink-faint">
          房间已不可用，正在重新选择…
        </div>
      );
    }
    const members = (room.members ?? [])
      .map((id) => sessions.find((s) => s.id === id))
      .filter((s): s is GraphNode => !!s);
    // plain projection (no memo): the graph object already changes identity
    // only on polls, and hooks can't live inside this conditional branch
    const scopedGraph = graph ? scopeGraphToRoom(graph, room.members ?? []) : undefined;
    return (
      <div className="flex flex-col h-full min-h-0">
        <div className="room-chat-header flex items-center gap-2 px-4 py-3 border-b border-line flex-shrink-0">
          <Users size={14} className="text-accent flex-shrink-0" />
          <h2 className="text-ink font-medium text-sm truncate">{room.name}</h2>
          <span className="text-2xs text-ink-faint flex-shrink-0">{members.length} 成员</span>
          {/* 聊天/图谱 are two views of the SAME room — the toggle never
              touches the target, drafts or members */}
          <div className="flex bg-surface border border-line rounded-lg overflow-hidden text-2xs flex-shrink-0 ml-1">
            {(["chat", "graph"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                aria-pressed={view === v}
                className={`px-2.5 py-1 transition-colors ${
                  view === v
                    ? "bg-accent text-on-accent"
                    : "text-ink-muted hover:bg-tile-hover hover:text-ink"
                }`}
              >
                {v === "chat" ? "聊天" : "图谱"}
              </button>
            ))}
          </div>
          {view === "graph" && (
            <button
              type="button"
              onClick={() => setGraphScope((s) => (s === "room" ? "global" : "room"))}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-2xs flex-shrink-0 text-ink-muted hover:bg-tile-hover hover:text-ink"
              title={graphScope === "room" ? "切换为全局图谱" : "返回当前房间的成员图"}
            >
              <Globe size={12} />
              {graphScope === "room" ? "查看全局图谱" : "返回当前房间"}
            </button>
          )}
          <button
            ref={detailsButtonRef}
            type="button"
            onClick={onToggleDetails}
            aria-pressed={detailsOpen}
            aria-label="详情"
            title="房间详情"
            className={`ml-auto p-1.5 rounded-lg transition-colors flex-shrink-0 ${
              detailsOpen
                ? "bg-accent-soft text-accent"
                : "text-ink-faint hover:bg-tile-hover hover:text-ink"
            }`}
          >
            <Info size={14} />
          </button>
        </div>
        <div className="flex-1 min-h-0">
          {view === "graph" ? (
            <Suspense fallback={<RoutePending />}>
              <GraphTab
                graph={graphScope === "room" ? scopedGraph : graph}
                loading={graphLoading}
                error={graphError}
                scope={graphScope}
                scopeKey={graphScope === "room" ? `room:${room.id}` : "global"}
                active={active}
                onSelectSession={(sid) => {
                  if (sid) onGraphNodeSelect(sid);
                }}
                selectedSessionId={null}
                onSelectEdge={(edge) => {
                  if (edge) onOpenGraphEdge(edge);
                }}
                selectedEdge={null}
              />
            </Suspense>
          ) : (
            <RoomChat
              room={room}
              members={members}
              active={active}
              draft={draft}
              onDraftChange={(text) => onDraftChange(target, text)}
              onSubmitted={onDraftSubmitted}
              onManageMembers={onToggleDetails}
              executorId={executorId}
              onExecutorChange={onExecutorChange}
            />
          )}
        </div>
      </div>
    );
  }

  // session (peer) target
  const node = sessions.find((s) => s.id === target.id);
  const peerName = node?.name ?? target.id.slice(0, 8);
  const roomOf =
    node?.chat_room_id != null ? rooms.find((r) => r.id === node.chat_room_id) : undefined;
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="room-chat-header flex items-center gap-2 px-4 py-3 border-b border-line flex-shrink-0">
        <MessageSquare size={14} className="text-accent flex-shrink-0" />
        <h2 className="text-ink font-medium text-sm truncate">与 {peerName} 的对话</h2>
        <div className="ml-auto flex items-center gap-1 flex-shrink-0">
          {roomOf && (
            <button
              type="button"
              onClick={() => onSelectTarget({ kind: "room", id: roomOf.id })}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-2xs text-ink-muted hover:bg-tile-hover hover:text-ink"
              title={`进入 ${roomOf.name}`}
            >
              <Users size={12} /> 进入所属聊天室
            </button>
          )}
          <button
            type="button"
            onClick={() => onInspectSession(target.id)}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-2xs text-ink-muted hover:bg-tile-hover hover:text-ink"
            title="在全局图谱中查看"
          >
            <Network size={12} /> 全局图谱
          </button>
          <button
            ref={detailsButtonRef}
            type="button"
            onClick={onToggleDetails}
            aria-pressed={detailsOpen}
            aria-label="详情"
            title="会话详情"
            className={`p-1.5 rounded-lg transition-colors ${
              detailsOpen
                ? "bg-accent-soft text-accent"
                : "text-ink-faint hover:bg-tile-hover hover:text-ink"
            }`}
          >
            <Info size={14} />
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <PeerConversation
          peerId={target.id}
          peerNode={node}
          active={active}
          draft={draft}
          onDraftChange={(text) => onDraftChange(target, text)}
          onSubmitted={onDraftSubmitted}
        />
      </div>
    </div>
  );
}

function RoutePending() {
  return (
    <div className="h-full flex items-center justify-center text-xs text-ink-faint">加载中…</div>
  );
}
