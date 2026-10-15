import { useState, useEffect } from "react";
import { Users, Plus, X, ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import type { ChatRoom, GraphNode } from "@conflux/shared";
import { api } from "../api";

interface ChatRoomListProps {
  sessions: GraphNode[];
  onRoomChange: () => void;
}

/**
 * Chat room management panel (#137): shows rooms with expandable member
 * lists. Click "+" to add a member (picks from unroomed sessions), click
 * member to remove. Delete room releases all members.
 */
export function ChatRoomList({ sessions, onRoomChange }: ChatRoomListProps) {
  const [rooms, setRooms] = useState<ChatRoom[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [addingTo, setAddingTo] = useState<number | null>(null);

  const refresh = () =>
    api.chatRooms.list().then((r) => setRooms(r.rooms)).catch(() => {});

  useEffect(() => { refresh(); }, []);

  if (rooms.length === 0) return null;

  const nameOf = (id: string) => sessions.find((s) => s.id === id)?.name ?? id.slice(0, 8);
  const unroomed = sessions.filter(
    (s) => s.type === "session" && s.id !== "web-console" &&
    !rooms.some((r) => r.members?.includes(s.id)),
  );

  const join = async (roomId: number, sessionId: string) => {
    await api.chatRooms.join(roomId, sessionId);
    await refresh();
    onRoomChange();
  };

  const leave = async (sessionId: string) => {
    await api.chatRooms.leave(sessionId);
    await refresh();
    onRoomChange();
  };

  const remove = async (roomId: number) => {
    await api.chatRooms.delete(roomId);
    await refresh();
    onRoomChange();
  };

  return (
    <div className="px-2 pb-2 flex-shrink-0">
      <div className="text-2xs font-medium text-ink-faint px-2 py-1">
        聊天室 · {rooms.length}
      </div>
      {rooms.map((room) => {
        const isOpen = expanded === room.id;
        const members = room.members ?? [];
        return (
          <div key={room.id} className="mb-1">
            <button
              onClick={() => setExpanded(isOpen ? null : room.id)}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-ink hover:bg-tile-hover transition-colors"
            >
              {isOpen ? (
                <ChevronDown size={11} className="text-ink-faint" />
              ) : (
                <ChevronRight size={11} className="text-ink-faint" />
              )}
              <Users size={12} className="text-accent flex-shrink-0" />
              <span className="truncate flex-1 text-left">{room.name}</span>
              <span className="text-ink-faint">{members.length}</span>
            </button>

            {isOpen && (
              <div className="ml-4 mt-0.5 space-y-0.5">
                {members.map((mid) => (
                  <div
                    key={mid}
                    className="flex items-center gap-2 px-2 py-1 rounded-lg text-xs text-ink-muted hover:bg-tile-hover group"
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${
                      sessions.find((s) => s.id === mid)?.status === "active" ? "bg-emerald-500" : "bg-ink-faint/50"
                    }`} />
                    <span className="truncate flex-1">{nameOf(mid)}</span>
                    <button
                      onClick={() => leave(mid)}
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-ink-faint hover:text-red-500 transition-opacity"
                      title="移出"
                    >
                      <X size={10} />
                    </button>
                  </div>
                ))}

                {/* add member */}
                {addingTo === room.id ? (
                  <div className="px-2 py-1 space-y-0.5 max-h-32 overflow-y-auto">
                    {unroomed.map((s) => (
                      <button
                        key={s.id}
                        onClick={() => { join(room.id, s.id); setAddingTo(null); }}
                        className="w-full flex items-center gap-2 px-2 py-1 rounded-lg text-xs text-ink-muted hover:bg-tile-hover"
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${
                          s.status === "active" ? "bg-emerald-500" : "bg-ink-faint/50"
                        }`} />
                        <span className="truncate">{s.name}</span>
                      </button>
                    ))}
                    {unroomed.length === 0 && (
                      <div className="text-2xs text-ink-faint px-2 py-1">没有可加入的会话</div>
                    )}
                    <button
                      onClick={() => setAddingTo(null)}
                      className="w-full text-2xs text-ink-faint hover:text-ink px-2 py-1"
                    >
                      取消
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1 px-2">
                    <button
                      onClick={() => setAddingTo(room.id)}
                      className="flex items-center gap-1 text-2xs text-accent hover:text-accent-deep px-1.5 py-1 rounded"
                    >
                      <Plus size={10} /> 拉人
                    </button>
                    <button
                      onClick={() => remove(room.id)}
                      className="flex items-center gap-1 text-2xs text-ink-faint hover:text-red-500 px-1.5 py-1 rounded ml-auto"
                    >
                      <Trash2 size={10} /> 删除
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
