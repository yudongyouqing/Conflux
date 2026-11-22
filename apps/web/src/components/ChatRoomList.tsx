import { Hash, Plus } from "lucide-react";
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
    <div className="px-2 flex-shrink-0">
      <div className="flex items-center justify-between px-2 py-1">
        <span className="text-2xs font-medium text-ink-faint">
          聊天室 <span className="tabular-nums opacity-80">{rooms.length}</span>
        </span>
        <button
          type="button"
          onClick={onCreateRoom}
          aria-label="新建聊天室"
          title="新建聊天室"
          className="p-1 rounded-md text-ink-faint hover:bg-tile-hover hover:text-ink transition-colors"
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
              className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12.5px] transition-colors text-left ${
                selected
                  ? "bg-accent-soft text-accent font-medium"
                  : "text-ink-muted hover:bg-tile-hover hover:text-ink"
              }`}
            >
              <Hash size={13} className={selected ? "text-accent" : "text-ink-faint"} />
              <span className="truncate flex-1">{room.name}</span>
              <span className="text-2xs text-ink-faint tabular-nums flex-shrink-0">
                {members.length}
              </span>
            </button>
          );
        })}
        {rooms.length === 0 && (
          <button
            type="button"
            onClick={onCreateRoom}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs text-accent hover:bg-accent-soft transition-colors text-left"
          >
            <Plus size={12} />
            创建第一个聊天室
          </button>
        )}
      </div>
    </div>
  );
}
