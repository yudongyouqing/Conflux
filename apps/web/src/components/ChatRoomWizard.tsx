import { useState } from "react";
import { X, Plus, Trash2, ArrowRight, Users } from "lucide-react";
import type { GraphNode, TopologyStep } from "@conflux/shared";

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
  const [steps, setSteps] = useState<TopologyStep[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [fromSel, setFromSel] = useState("");
  const [toSel, setToSel] = useState("");

  const selectable = sessions.filter((s) => s.type === "session" && s.id !== "web-console");
  const nameOf = (id: string) => selectable.find((s) => s.id === id)?.name ?? id.slice(0, 8);

  const addStep = () => {
    if (!fromSel || !toSel || fromSel === toSel) {
      setError("请选择两个不同的会话");
      return;
    }
    setError(null);
    setSteps((prev) => [...prev, { from: fromSel, to: toSel, order: prev.length + 1 }]);
    setFromSel("");
    setToSel("");
  };

  const removeStep = (order: number) => {
    setSteps((prev) => prev.filter((s) => s.order !== order).map((s, i) => ({ ...s, order: i + 1 })));
  };

  const create = async () => {
    if (!name.trim()) return setError("请填写聊天室名称");
    if (steps.length === 0) return setError("至少需要一步流程");
    setPending(true);
    setError(null);
    try {
      const { api } = await import("../api");
      await api.chatRooms.create({ name: name.trim(), topology: steps });
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建失败");
    } finally {
      setPending(false);
    }
  };

  const selectCls =
    "flex-1 px-2.5 py-1.5 rounded-lg border border-line text-xs text-ink bg-surface focus:border-accent outline-none";

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

        {/* topology steps */}
        <div className="space-y-2">
          <div className="text-2xs font-medium text-ink-muted">流程步骤（谁 → 谁，按顺序）</div>

          {steps.map((step) => (
            <div key={step.order} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-tile text-xs">
              <span className="text-ink-faint w-4">{step.order}</span>
              <span className="text-ink font-medium">{nameOf(step.from)}</span>
              <ArrowRight size={11} className="text-ink-faint" />
              <span className="text-ink font-medium">{nameOf(step.to)}</span>
              <button
                onClick={() => removeStep(step.order)}
                className="ml-auto p-0.5 rounded text-ink-faint hover:text-red-500"
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}

          {/* add step row */}
          <div className="flex items-center gap-1.5">
            <select value={fromSel} onChange={(e) => setFromSel(e.target.value)} className={selectCls}>
              <option value="">发起方…</option>
              {selectable.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            <ArrowRight size={12} className="text-ink-faint flex-shrink-0" />
            <select value={toSel} onChange={(e) => setToSel(e.target.value)} className={selectCls}>
              <option value="">接收方…</option>
              {selectable.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            <button
              onClick={addStep}
              disabled={!fromSel || !toSel}
              className="p-1.5 rounded-lg text-accent hover:bg-accent-soft disabled:opacity-40 flex-shrink-0"
              title="添加步骤"
            >
              <Plus size={14} />
            </button>
          </div>
        </div>

        {error && <div className="text-xs text-red-600">{error}</div>}

        <button
          onClick={create}
          disabled={pending || !name.trim() || steps.length === 0}
          className="w-full py-2 rounded-lg bg-accent text-white text-xs font-medium hover:bg-accent-deep disabled:opacity-50"
        >
          {pending ? "创建中…" : `创建聊天室（${steps.length} 步）`}
        </button>
      </div>
    </div>
  );
}
