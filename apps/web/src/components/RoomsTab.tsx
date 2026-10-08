import { useState, useEffect, useCallback } from "react";
import { Users, Plus, X, Trash2, MessageSquare } from "lucide-react";
import type { ChatRoom, GraphNode } from "@conflux/shared";
import { api } from "../api";
import { ChatRoomWizard } from "./ChatRoomWizard";
import { RoomChat } from "./RoomChat";
import { StatusDot } from "./StatusDot";

interface RoomsTabProps {
  sessions: GraphNode[];
}

/**
 * Dedicated chat rooms view (#137): rooms as cards, not graph overlays.
 * Each card shows members with status dots, add/remove controls, and the
 * room's conversation channel (messages between members).
 */
export function RoomsTab({ sessions }: RoomsTabProps) {
  const [rooms, setRooms] = useState<ChatRoom[]>([]);
  const [wizardOpen, setWizardOpen] = useState(false);
    const [addingTo, setAddingTo] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chatRoomId, setChatRoomId] = useState<number | null>(null);
  const [chatPeer, setChatPeer] = useState<GraphNode | null>(null);

  const refresh = useCallback(() => {
    api.chatRooms.list().then((r) => setRooms(r.rooms)).catch((e) => setError(e.message));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const nameOf = (id: string) => sessions.find((s) => s.id === id)?.name ?? id.slice(0, 8);
  const roomedIds = new Set(rooms.flatMap((r) => r.members ?? []));
  const unroomed = sessions.filter(
    (s) => s.type === "session" && s.id !== "web-console" && !roomedIds.has(s.id),
  );

  const join = async (roomId: number, sessionId: string) => {
    await api.chatRooms.join(roomId, sessionId);
    setAddingTo(null);
    refresh();
  };

  const leave = async (sessionId: string) => {
    await api.chatRooms.leave(sessionId);
    refresh();
  };

  const remove = async (roomId: number) => {
    await api.chatRooms.delete(roomId);
    refresh();
  };

  // direct chat: a peer is picked, show conversation (skip room selection)
  if (chatPeer) {
    const room = rooms.find((r) => (r.members ?? []).includes(chatPeer.id));
    return (
      <RoomChat
        roomName={room?.name ?? "对话"}
        members={[chatPeer]}
        onBack={() => setChatPeer(null)}
      />
    );
  }

  // legacy: room-level chat (unused but kept for potential group view)
  if (chatRoomId !== null) {
    const room = rooms.find((r) => r.id === chatRoomId);
    if (room) {
      const memberSessions = (room.members ?? [])
        .map((id) => sessions.find((s) => s.id === id))
        .filter((s): s is GraphNode => !!s);
      return (
        <RoomChat
          roomName={room.name}
          members={memberSessions}
          onBack={() => setChatRoomId(null)}
        />
      );
    }
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-2xl mx-auto space-y-5">
        {/* header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-ink font-semibold text-base flex items-center gap-2">
              <Users size={16} className="text-accent" /> 聊天室
            </h2>
            <p className="text-xs text-ink-muted mt-0.5">
              圈子内自由对话：任何成员可以向任何成员提问，圈外隔离
            </p>
          </div>
          <button
            onClick={() => setWizardOpen(true)}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-accent text-white text-xs font-medium hover:bg-accent-deep"
          >
            <Plus size={14} />
            新建聊天室
          </button>
        </div>

        {error && <div className="text-xs text-red-600">{error}</div>}

        {/* room cards */}
        {rooms.length === 0 ? (
          <div className="text-center py-16 text-ink-faint">
            <Users size={32} className="mx-auto mb-3 opacity-30" />
            <p className="text-sm">还没有聊天室</p>
            <p className="text-xs mt-1">创建一个，把相关会话拉进来协作</p>
          </div>
        ) : (
          <div className="space-y-3">
            {rooms.map((room) => {
              const members = room.members ?? [];
                            return (
                <div
                  key={room.id}
                  onClick={() => setChatRoomId(room.id)}
                  className="bg-surface rounded-xl p-4 shadow-sm cursor-pointer hover:shadow-[0_4px_16px_rgba(37,99,235,0.12)] transition-shadow"
                >
                  {/* room header */}
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-accent-soft flex items-center justify-center flex-shrink-0">
                      <Users size={14} className="text-accent" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-ink font-medium text-sm">{room.name}</div>
                      <div className="text-2xs text-ink-faint">
                        {members.length} 成员
                        {room.description ? ` · ${room.description}` : ""}
                      </div>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); remove(room.id); }}
                      className="p-1.5 rounded-lg text-ink-faint hover:text-red-500 hover:bg-tile-hover"
                      title="删除房间"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>

                  {/* members grid */}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {members.map((mid) => {
                      const session = sessions.find((s) => s.id === mid);
                      return (
                        <div
                          key={mid}
                          onClick={(e) => { e.stopPropagation(); if (session) setChatPeer(session); }}
                          className="group flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-tile hover:bg-accent-soft hover:text-accent text-xs text-ink cursor-pointer transition-colors"
                        >
                          <StatusDot
                            status={session?.status ?? "stale"}
                            busy={session?.busy}
                          />
                          <span>{nameOf(mid)}</span>
                          <button
                            onClick={(e) => { e.stopPropagation(); leave(mid); }}
                            className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-ink-faint hover:text-red-500 transition-opacity"
                            title="移出"
                          >
                            <X size={10} />
                          </button>
                        </div>
                      );
                    })}

                    {/* add member button */}
                    <button
                      onClick={(e) => { e.stopPropagation(); setAddingTo(addingTo === room.id ? null : room.id); }}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-dashed border-line text-xs text-accent hover:bg-accent-soft"
                    >
                      <Plus size={11} /> 拉人
                    </button>
                  </div>

                  {/* add member picker */}
                  {addingTo === room.id && (
                    <div className="mt-2 p-2 rounded-lg bg-tile max-h-40 overflow-y-auto space-y-0.5">
                      {unroomed.map((s) => (
                        <button
                          key={s.id}
                          onClick={(e) => { e.stopPropagation(); join(room.id, s.id); }}
                          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-ink-muted hover:bg-tile-hover"
                        >
                          <StatusDot status={s.status} busy={s.busy} />
                          <span className="truncate">{s.name}</span>
                          <Plus size={11} className="ml-auto text-accent" />
                        </button>
                      ))}
                      {unroomed.length === 0 && (
                        <div className="text-2xs text-ink-faint text-center py-2">没有可拉入的会话</div>
                      )}
                    </div>
                  )}

                  {/* room conversations (expandable) */}
                  <div className="mt-3 flex items-center gap-1.5 text-2xs text-accent">
                    <MessageSquare size={11} />
                    点击房间进入对话
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {wizardOpen && (
          <ChatRoomWizard
            sessions={sessions}
            onClose={() => setWizardOpen(false)}
            onCreated={refresh}
          />
        )}
      </div>
    </div>
  );
}
