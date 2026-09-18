import { useState } from "react";
import { Plus, Trash2, Bot, ChevronDown, ChevronUp, MessageSquare } from "lucide-react";
import { useAgents, useCreateAgent, useDeleteAgent } from "../hooks";
import { ChatPanel } from "./ChatPanel";
import type { Agent } from "@conflux/shared";

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
          setForm({
            name: "",
            description: "",
            provider: "anthropic",
            model: "",
            system_prompt: "",
          });
        },
      },
    );
  }

  return (
    <div className="flex flex-col h-full bg-paper">
      <div className="flex items-center justify-between p-4 bg-white border-b border-line">
        <span className="text-sm text-ink font-medium">
          Agents <span className="text-ink-faint font-normal">({agents.length})</span>
        </span>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors shadow-sm"
        >
          <Plus size={13} /> 创建 Agent
        </button>
      </div>

      {showForm && (
        <div className="p-4 bg-white border-b border-line space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <input
              placeholder="名称 *"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="bg-white text-ink text-xs rounded-lg px-3 py-2 border border-line outline-none focus:border-blue-500"
            />
            <input
              placeholder="描述"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="bg-white text-ink text-xs rounded-lg px-3 py-2 border border-line outline-none focus:border-blue-500"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <select
              value={form.provider}
              onChange={(e) => setForm({ ...form, provider: e.target.value })}
              className="bg-white text-ink text-xs rounded-lg px-3 py-2 border border-line outline-none focus:border-blue-500"
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <input
              placeholder="模型 * (如 claude-sonnet-4-5)"
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
              className="bg-white text-ink text-xs rounded-lg px-3 py-2 border border-line outline-none focus:border-blue-500"
            />
          </div>
          <textarea
            placeholder="System Prompt *"
            value={form.system_prompt}
            onChange={(e) => setForm({ ...form, system_prompt: e.target.value })}
            rows={4}
            className="w-full bg-white text-ink text-xs rounded-lg px-3 py-2 border border-line outline-none focus:border-blue-500 resize-y font-mono"
          />
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={() => setShowForm(false)}
              className="px-3 py-1.5 rounded-lg text-xs text-ink-muted hover:text-ink hover:bg-paper"
            >
              取消
            </button>
            <button
              onClick={handleCreate}
              disabled={!form.name || !form.model || !form.system_prompt || createMut.isPending}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-500 disabled:bg-paper disabled:text-ink-faint text-white transition-colors"
            >
              {createMut.isPending ? "创建中..." : "创建"}
            </button>
          </div>
          {createMut.isError && (
            <div className="text-xs text-red-500">{(createMut.error as Error).message}</div>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {isLoading && <div className="text-ink-faint text-sm text-center mt-8">加载中...</div>}
        {!isLoading && agents.length === 0 && !showForm && (
          <div className="text-ink-faint text-sm text-center mt-12">
            暂无 Agent。点击"创建 Agent"新建一个。
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
    <div className="rounded-xl border border-line bg-white overflow-hidden hover:shadow-sm transition-shadow">
      <div className="flex items-center gap-3 p-4 cursor-pointer" onClick={onToggle}>
        <div className="w-9 h-9 rounded-lg bg-indigo-600 flex items-center justify-center flex-shrink-0">
          <Bot size={17} className="text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm text-ink font-medium truncate">{agent.name}</div>
          <div className="flex items-center gap-2 text-[10px] text-ink-muted mt-0.5">
            <span className="px-1.5 py-0.5 rounded-md bg-paper text-ink-muted border border-line">
              {agent.model_config.provider}
            </span>
            <span>{agent.model_config.model}</span>
          </div>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onChat();
          }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors shadow-sm"
        >
          <MessageSquare size={12} /> 对话
        </button>
        {expanded ? (
          <ChevronUp size={14} className="text-ink-faint" />
        ) : (
          <ChevronDown size={14} className="text-ink-faint" />
        )}
      </div>
      {expanded && (
        <div className="px-4 pb-4 space-y-3">
          {agent.description && <div className="text-xs text-ink-muted">{agent.description}</div>}
          <div>
            <div className="text-[10px] text-ink-faint mb-1.5">System Prompt</div>
            <pre className="text-[11px] text-ink-muted font-mono whitespace-pre-wrap bg-paper p-3 rounded-lg border border-line max-h-40 overflow-y-auto">
              {agent.system_prompt}
            </pre>
          </div>
          <div className="flex items-center justify-between text-[10px] text-ink-faint">
            <span>
              ID: {agent.id} · 更新于 {new Date(agent.updated_at).toLocaleString()}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="flex items-center gap-1 text-red-500/70 hover:text-red-500"
            >
              <Trash2 size={11} /> 删除
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
