import { Network, MessageSquare, Bot } from "lucide-react";
import { useDaemonHealth } from "../hooks";

export type TabId = "graph" | "messages" | "agents";

interface HeaderProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
}

export function Header({ activeTab, onTabChange }: HeaderProps) {
  const health = useDaemonHealth();
  const online = health.data?.ok === true;

  return (
    <header className="flex items-center gap-4 px-4 py-2 border-b border-slate-700 bg-slate-900 flex-shrink-0">
      <div className="flex items-center gap-2">
        <span className="text-white font-bold text-sm tracking-tight">
          muiltchat
        </span>
        <span
          className={`w-2 h-2 rounded-full ${online ? "bg-green-500" : "bg-red-500"}`}
          title={online ? "daemon 在线" : "daemon 离线"}
        />
        <span className="text-[10px] text-slate-500">
          {online ? "online" : "offline"}
        </span>
      </div>

      <nav className="flex items-center gap-1">
        <button
          onClick={() => onTabChange("graph")}
          className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors ${
            activeTab === "graph"
              ? "bg-slate-700 text-white"
              : "text-slate-400 hover:text-slate-200 hover:bg-slate-800"
          }`}
        >
          <Network size={14} /> 图拓扑
        </button>
        <button
          onClick={() => onTabChange("messages")}
          className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors ${
            activeTab === "messages"
              ? "bg-slate-700 text-white"
              : "text-slate-400 hover:text-slate-200 hover:bg-slate-800"
          }`}
        >
          <MessageSquare size={14} /> 消息流
        </button>
        <button
          onClick={() => onTabChange("agents")}
          className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors ${
            activeTab === "agents"
              ? "bg-slate-700 text-white"
              : "text-slate-400 hover:text-slate-200 hover:bg-slate-800"
          }`}
        >
          <Bot size={14} /> Agents
        </button>
      </nav>
    </header>
  );
}
