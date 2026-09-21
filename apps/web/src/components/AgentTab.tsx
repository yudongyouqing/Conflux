import { useState } from "react";
import { Plus, Trash2, Bot, ChevronDown, ChevronUp, MessageSquare } from "lucide-react";
import { useAgents, useDeleteAgent } from "../hooks";
import { ChatPanel } from "./ChatPanel";
import { CreateAgentWizard } from "./CreateAgentWizard";
import type { Agent } from "@conflux/shared";

export function AgentTab() {
  const { data, isLoading } = useAgents();
  const deleteMut = useDeleteAgent();

  const [wizardOpen, setWizardOpen] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [chatAgent, setChatAgent] = useState<Agent | null>(null);

  const agents = data?.agents ?? [];

  if (chatAgent) {
    return <ChatPanel agent={chatAgent} onBack={() => setChatAgent(null)} />;
  }

  return (
    <div className="flex flex-col h-full bg-paper">
      <div className="flex items-center justify-between p-4 bg-surface border-b border-line">
        <span className="text-sm text-ink font-medium">
          Agents <span className="text-ink-faint font-normal">({agents.length})</span>
        </span>
        <button
          onClick={() => setWizardOpen(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-accent hover:bg-accent-deep text-white transition-colors shadow-sm"
        >
          <Plus size={13} /> 创建智能体
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {isLoading && <div className="text-ink-faint text-sm text-center mt-8">加载中...</div>}
        {!isLoading && agents.length === 0 && (
          <div className="text-ink-faint text-sm text-center mt-12">
            暂无智能体。点「创建智能体」新建，或去「运行时」页启动真正的 CLI agent。
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

      <CreateAgentWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />
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
    <div className="rounded-xl border border-line bg-surface overflow-hidden hover:shadow-sm transition-shadow">
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
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-accent hover:bg-accent-deep text-white transition-colors shadow-sm"
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
