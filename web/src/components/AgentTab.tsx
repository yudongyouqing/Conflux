import { useState } from "react";
import { Plus, Trash2, Bot, ChevronDown, ChevronUp, MessageSquare } from "lucide-react";
import { useAgents, useCreateAgent, useDeleteAgent } from "../hooks";
import { ChatPanel } from "./ChatPanel";
import type { Agent } from "../types";

const PROVIDERS = ["anthropic", "openai", "google", "mistral", "local"];

export function AgentTab() {
  const { data, isLoading } = useAgents();
  const createMut = useCreateAgent();
  const deleteMut = useDeleteAgent();

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    name: "",
    description: "",
    provider: "anthropic",
    model: "",
    system_prompt: "",
  });
  const [expanded, setExpanded] = useState<number | null>(null);
  const [chatAgent, setChatAgent] = useState<Agent | null>(null);

  const agents = data?.agents ?? [];

  if (chatAgent) {
    return <ChatPanel agent={chatAgent} onBack={() => setChatAgent(null)} />;
  }

  function handleCreate() {
    if (!form.name || !form.model || !form.system_prompt) return;
    createMut.mutate(
      {
        name: form.name,
        system_prompt: form.system_prompt,
        model_config: {
          provider: form.provider,
          model: form.model,
        },
        description: form.description || undefined,
      },
      {
        onSuccess: () => {
          setShowForm(false);
          setForm({ name: "", description: "", provider: "anthropic", model: "", system_prompt: "" });
        },
      }
    );
  }

  return (
    <div className="flex flex-col h-full bg-slate-900">
      <div className="flex items-center justify-between p-3 border-b border-slate-700">
        <span className="text-sm text-slate-300 font-medium">
          Agents ({agents.length})
        </span>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors"
        >
          <Plus size={12} /> 新建 Agent
        </button>
      </div>

      {showForm && (
        <div className="p-4 border-b border-slate-700 bg-slate-800/50 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <input
              placeholder="名称 *"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="bg-slate-800 text-slate-200 text-xs rounded px-2 py-1.5 border border-slate-600 outline-none focus:border-blue-500"
            />
            <input
              placeholder="描述"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="bg-slate-800 text-slate-200 text-xs rounded px-2 py-1.5 border border-slate-600 outline-none focus:border-blue-500"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <select
              value={form.provider}
              onChange={(e) => setForm({ ...form, provider: e.target.value })}
              className="bg-slate-800 text-slate-200 text-xs rounded px-2 py-1.5 border border-slate-600 outline-none focus:border-blue-500"
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
            <input
              placeholder="模型 * (如 claude-sonnet-4-20250514)"
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
              className="bg-slate-800 text-slate-200 text-xs rounded px-2 py-1.5 border border-slate-600 outline-none focus:border-blue-500"
            />
          </div>
          <textarea
            placeholder="System Prompt *"
            value={form.system_prompt}
            onChange={(e) => setForm({ ...form, system_prompt: e.target.value })}
            rows={4}
            className="w-full bg-slate-800 text-slate-200 text-xs rounded px-2 py-1.5 border border-slate-600 outline-none focus:border-blue-500 resize-y font-mono"
          />
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={() => setShowForm(false)}
              className="px-3 py-1 rounded text-xs text-slate-400 hover:text-slate-200"
            >
              取消
            </button>
            <button
              onClick={handleCreate}
              disabled={!form.name || !form.model || !form.system_prompt || createMut.isPending}
              className="px-3 py-1 rounded text-xs font-medium bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 text-white transition-colors"
            >
              {createMut.isPending ? "创建中..." : "创建"}
            </button>
          </div>
          {createMut.isError && (
            <div className="text-xs text-red-400">{(createMut.error as Error).message}</div>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {isLoading && (
          <div className="text-slate-500 text-sm text-center mt-8">加载中...</div>
        )}
        {!isLoading && agents.length === 0 && !showForm && (
          <div className="text-slate-600 text-sm text-center mt-8">
            暂无 Agent。点击"新建 Agent"创建一个。
          </div>
        )}
        {agents.map((agent) => (
          <AgentCard
            key={agent.id}
            agent={agent}
            expanded={expanded === agent.id}
            onToggle={() => setExpanded(expanded === agent.id ? null : agent.id)}
            onChat={() => setChatAgent(agent)}
            onDelete={() => deleteMut.mutate(agent.id)}
          />
        ))}
      </div>
    </div>
  );
}

function AgentCard({
  agent,
  expanded,
  onToggle,
  onChat,
  onDelete,
}: {
  agent: Agent;
  expanded: boolean;
  onToggle: () => void;
  onChat: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/50 overflow-hidden">
      <div className="flex items-center gap-2 p-3 cursor-pointer" onClick={onToggle}>
        <Bot size={16} className="text-blue-400 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm text-slate-200 font-medium truncate">{agent.name}</div>
          <div className="flex items-center gap-2 text-[10px] text-slate-500 mt-0.5">
            <span className="px-1.5 py-0.5 rounded bg-slate-700 text-slate-400">
              {agent.model_config.provider}
            </span>
            <span>{agent.model_config.model}</span>
          </div>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onChat(); }}
          className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium bg-blue-600/80 hover:bg-blue-500 text-white transition-colors"
        >
          <MessageSquare size={10} /> 对话
        </button>
        {expanded ? (
          <ChevronUp size={14} className="text-slate-500" />
        ) : (
          <ChevronDown size={14} className="text-slate-500" />
        )}
      </div>
      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          {agent.description && (
            <div className="text-xs text-slate-400">{agent.description}</div>
          )}
          <div>
            <div className="text-[10px] text-slate-500 mb-1">System Prompt</div>
            <pre className="text-[11px] text-slate-400 font-mono whitespace-pre-wrap bg-slate-900/50 p-2 rounded border border-slate-700 max-h-40 overflow-y-auto">
              {agent.system_prompt}
            </pre>
          </div>
          <div className="flex items-center justify-between text-[10px] text-slate-600">
            <span>ID: {agent.id} · 更新于 {new Date(agent.updated_at).toLocaleString()}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="flex items-center gap-1 text-red-400/70 hover:text-red-400"
            >
              <Trash2 size={11} /> 删除
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
