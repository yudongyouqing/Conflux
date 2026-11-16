import { Users, Plus } from "lucide-react";
import type { ChatRoom } from "@conflux/shared";

export interface RoomNavigationProps {
  rooms: readonly ChatRoom[];
  selectedRoomId: number | null;
  onSelectRoom: (id: number) => void;
  onCreateRoom: () => void;
}

/**
 * Controlled room navigation for the sidebar: the workspace owns the room
 * list and the current selection — this component only renders what it is
 * given and never keeps a second copy of the rooms.
 */
export function ChatRoomList({
  rooms,
  selectedRoomId,
  onSelectRoom,
  onCreateRoom,
}: RoomNavigationProps) {
  return (
    <div className="px-2 pt-2 flex-shrink-0">
      <div className="flex items-center justify-between px-2 py-1">
        <span className="text-2xs font-medium text-ink-faint">聊天室 · {rooms.length}</span>
        <button
          type="button"
          onClick={onCreateRoom}
          aria-label="新建聊天室"
          title="新建聊天室"
          className="p-1 rounded-lg text-ink-faint hover:bg-tile-hover hover:text-accent transition-colors"
        >
          <Plus size={13} />
        </button>
      </div>
      <div className="space-y-0.5">
        {rooms.map((room) => {
          const selected = room.id === selectedRoomId;
          const members = room.members ?? [];
          return (
            <button
              key={room.id}
              type="button"
              onClick={() => onSelectRoom(room.id)}
              aria-current={selected ? "true" : undefined}
              title={room.description ?? room.name}
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs transition-colors text-left ${
                selected ? "bg-accent-soft text-accent" : "text-ink hover:bg-tile-hover"
              }`}
            >
              <Users size={12} className={selected ? "text-accent" : "text-ink-faint"} />
              <span className="truncate flex-1">{room.name}</span>
              <span className="text-2xs text-ink-faint flex-shrink-0">{members.length}</span>
            </button>
          );
        })}
        {rooms.length === 0 && (
          <button
            type="button"
            onClick={onCreateRoom}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-accent hover:bg-accent-soft transition-colors text-left"
          >
            <Plus size={12} />
            创建第一个聊天室
          </button>
        )}
      </div>
    </div>
  );
}
