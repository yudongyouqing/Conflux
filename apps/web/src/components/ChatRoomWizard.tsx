import { useState } from "react";
import { X, Plus, Users } from "lucide-react";
import type { GraphNode } from "@conflux/shared";

interface ChatRoomWizardProps {
  sessions: GraphNode[];
  onClose: () => void;
  onCreated: () => void;
}

/**
 * Create a chat room (#137 UI): pick participants, define the flow steps
 * (who asks whom, in what order). The topology is a step list — loops are
 * just repeated steps (A→B, B→A, B→C supports a review cycle).
 */
export function ChatRoomWizard({ sessions, onClose, onCreated }: ChatRoomWizardProps) {
  const [name, setName] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const selectable = sessions.filter((s) => s.type === "session" && s.id !== "web-console");

  const toggleMember = (id: string) => {
    setError(null);
    setMembers((prev) =>
      prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id],
    );
  };

  const create = async () => {
    if (!name.trim()) return setError("请填写聊天室名称");
    if (members.length < 2) return setError("至少选择 2 个成员");
    setPending(true);
    setError(null);
    try {
      const { api } = await import("../api");
      await api.chatRooms.create({ name: name.trim(), members });
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建失败");
    } finally {
      setPending(false);
    }
  };


  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
      <div className="w-[480px] bg-surface border border-line rounded-2xl shadow-overlay p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users size={16} className="text-accent" />
            <h3 className="text-ink font-semibold text-sm">创建聊天室</h3>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-ink-faint hover:bg-tile-hover hover:text-ink">
            <X size={16} />
          </button>
        </div>

        {/* name */}
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="聊天室名称，如「代码审查」「每日站会」"
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
                  onClick={() => toggleMember(s2.id)}
                  className={`flex items-center gap-2 px-2.5 py-2 rounded-lg border text-xs transition-colors ${
                    selected
                      ? "border-accent bg-accent-soft text-accent"
                      : "border-line text-ink-muted hover:bg-tile-hover"
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${s2.status === "active" ? "bg-emerald-500" : "bg-ink-faint/50"}`} />
                  <span className="truncate">{s2.name}</span>
                  {selected && <Plus size={11} className="ml-auto rotate-45" />}
                </button>
              );
            })}
          </div>
        </div>

        {error && <div className="text-xs text-red-600">{error}</div>}

        <button
          onClick={create}
          disabled={pending || !name.trim() || members.length < 2}
          className="w-full py-2 rounded-lg bg-accent text-white text-xs font-medium hover:bg-accent-deep disabled:opacity-50"
        >
          {pending ? "创建中…" : `创建聊天室（${members.length} 人）`}
        </button>
      </div>
    </div>
  );
}
