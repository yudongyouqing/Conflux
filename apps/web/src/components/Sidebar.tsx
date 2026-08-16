import { Network, MessageSquare, Bot, Boxes, ListTree, Terminal, Settings } from "lucide-react";
import { useDaemonHealth } from "../hooks";

export type TabId = "graph" | "sessions" | "messages" | "agents" | "runtimes" | "settings";

interface SidebarProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
}

export function Sidebar({ activeTab, onTabChange }: SidebarProps) {
  const health = useDaemonHealth();
  const online = health.data?.ok === true;

  const navItems = [
    { id: "graph" as const, icon: Network, label: "图拓扑" },
    { id: "sessions" as const, icon: ListTree, label: "会话" },
    { id: "messages" as const, icon: MessageSquare, label: "消息流" },
    { id: "agents" as const, icon: Bot, label: "Agents" },
    { id: "runtimes" as const, icon: Terminal, label: "运行时" },
    { id: "settings" as const, icon: Settings, label: "设置" },
  ];

  return (
    <aside className="w-56 bg-white border-r border-gray-200 flex flex-col flex-shrink-0">
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-5 h-14 border-b border-gray-100">
        <div className="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center">
          <Boxes size={15} className="text-white" />
        </div>
        <span className="font-semibold text-[15px] text-gray-900 tracking-tight">
          muiltchat
        </span>
      </div>

      {/* Nav */}
      <nav className="flex-1 p-2 space-y-0.5">
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = activeTab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onTabChange(item.id)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium transition-colors ${
                active
                  ? "bg-blue-50 text-blue-600"
                  : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
              }`}
            >
              <Icon size={16} className={active ? "text-blue-600" : "text-gray-400"} />
              {item.label}
            </button>
          );
        })}
      </nav>

      {/* Status */}
      <div className="p-4 border-t border-gray-100">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span
            className={`w-2 h-2 rounded-full ${online ? "bg-emerald-500" : "bg-red-500"}`}
          />
          {online ? "daemon 在线" : "daemon 离线"}
        </div>
      </div>
    </aside>
  );
}
