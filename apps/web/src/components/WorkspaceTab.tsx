import { useEffect, useRef } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Loader2, Plus, RefreshCw, Users, MessageSquare, Network, Bot, Info } from "lucide-react";
import type { ChatRoom, GraphNode } from "@conflux/shared";
import type { ConversationTarget, Draft } from "../workspace-state";
import type { TabId } from "./Sidebar";
import { RoomChat } from "./RoomChat";
import { PeerConversation } from "./PeerConversation";

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
}: WorkspaceTabProps) {
  const detailsButtonRef = useRef<HTMLButtonElement>(null);

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
    return (
      <div className="flex flex-col h-full min-h-0">
        <div className="room-chat-header flex items-center gap-2 px-4 py-3 border-b border-line flex-shrink-0">
          <Users size={14} className="text-accent flex-shrink-0" />
          <h2 className="text-ink font-medium text-sm truncate">{room.name}</h2>
          <span className="text-2xs text-ink-faint flex-shrink-0">{members.length} 成员</span>
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
