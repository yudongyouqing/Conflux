import { useState } from "react";
import { X, Plus, Users } from "lucide-react";
import type { ChatRoom, GraphNode } from "@conflux/shared";
import { useCreateRoom } from "../room-hooks";

interface ChatRoomWizardProps {
  sessions: GraphNode[];
  onClose: () => void;
  /** Receives the created room so the workspace can select it by its
   * real id + creation time (never by list position or display name). */
  onCreated: (room: ChatRoom) => void;
}

/**
 * Create a chat room: pick a name and participants. Empty rooms are
 * allowed — members can be added later from the room details.
 */
export function ChatRoomWizard({ sessions, onClose, onCreated }: ChatRoomWizardProps) {
  const [name, setName] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const create = useCreateRoom();

  const selectable = sessions.filter((s) => s.type === "session" && s.id !== "web-console");

  const toggleMember = (id: string) => {
    setError(null);
    setMembers((prev) => (prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]));
  };

  const submit = () => {
    if (!name.trim()) {
      setError("请填写聊天室名称");
      return;
    }
    setError(null);
    create.mutate(
      { name: name.trim(), members },
      {
        onSuccess: (data) => {
          onCreated(data.room);
          onClose();
        },
        onError: (e) => setError(e instanceof Error ? e.message : "创建失败"),
      },
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="创建聊天室"
        className="w-[480px] max-w-[92vw] bg-surface border border-line rounded-2xl shadow-overlay p-5 space-y-4"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users size={16} className="text-accent" />
            <h3 className="text-ink font-semibold text-sm">创建聊天室</h3>
          </div>
          <button
            onClick={onClose}
            aria-label="关闭创建聊天室"
            className="p-1.5 rounded-lg text-ink-faint hover:bg-tile-hover hover:text-ink"
          >
            <X size={16} />
          </button>
        </div>

        {/* name */}
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="聊天室名称，如「代码审查」「每日站会」"
          aria-label="聊天室名称"
          className="w-full px-3 py-2 rounded-lg border border-line text-xs text-ink bg-surface placeholder-ink-faint focus:border-accent outline-none"
        />

        {/* member selection */}
        <div className="space-y-2">
          <div className="text-2xs font-medium text-ink-muted">选择成员（{members.length} 人）</div>
          <div className="grid grid-cols-2 gap-1.5 max-h-48 overflow-y-auto">
            {selectable.map((s2) => {
              const selected = members.includes(s2.id);
              return (
                <button
                  key={s2.id}
                  type="button"
                  onClick={() => toggleMember(s2.id)}
                  aria-pressed={selected}
                  className={`flex items-center gap-2 px-2.5 py-2 rounded-lg border text-xs transition-colors ${
                    selected
                      ? "border-accent bg-accent-soft text-accent"
                      : "border-line text-ink-muted hover:bg-tile-hover"
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${s2.status === "active" ? "bg-emerald-500" : "bg-ink-faint/50"}`}
                  />
                  <span className="truncate">{s2.name}</span>
                  {selected && <Plus size={11} className="ml-auto rotate-45" />}
                </button>
              );
            })}
            {selectable.length === 0 && (
              <div className="col-span-2 text-2xs text-ink-faint text-center py-3">
                还没有可选会话，可先创建空聊天室
              </div>
            )}
          </div>
        </div>

        {error && (
          <div role="alert" className="text-xs text-danger">
            {error}
          </div>
        )}

        <button
          type="button"
          onClick={submit}
          disabled={create.isPending || !name.trim()}
          className="w-full py-2 rounded-lg bg-accent text-on-accent text-xs font-medium hover:bg-accent-deep disabled:opacity-50"
        >
          {create.isPending
            ? "创建中…"
            : members.length > 0
              ? `创建聊天室（${members.length} 人）`
              : "创建空聊天室"}
        </button>
      </div>
    </div>
  );
}
