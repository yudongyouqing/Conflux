import { useMemo, useState } from "react";
import {
  Network,
  MessageSquare,
  Bot,
  Boxes,
  Terminal,
  Settings,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { useDaemonHealth } from "../hooks";
import type { GraphNode } from "@conflux/shared";

export type TabId = "graph" | "messages" | "agents" | "runtimes" | "settings";

interface SidebarProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  /** live graph nodes — the session list body (#107) */
  sessions: GraphNode[];
  selectedSessionId: string | null;
  onSelectSession: (id: string) => void;
}

/** Calendar-day bucket for the heartbeat timestamp. */
function timeGroup(ts: string | null | undefined, now = new Date()): string {
  if (!ts) return "更早";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "更早";
  const day = 86_400_000;
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.floor((startOf(now) - startOf(d)) / day);
  if (diff <= 0) return "今天";
  if (diff === 1) return "昨天";
  if (diff < 7) return "本周";
  return "更早";
}

const GROUP_ORDER = ["今天", "昨天", "本周", "更早"];
const GROUP_PREVIEW = 10;

function statusDot(node: GraphNode): string {
  if (node.status !== "active") return "bg-ink-faint/60";
  return node.busy ? "bg-amber-500" : "bg-emerald-500";
}

export function Sidebar({
  activeTab,
  onTabChange,
  sessions,
  selectedSessionId,
  onSelectSession,
}: SidebarProps) {
  const health = useDaemonHealth();
  const online = health.data?.ok === true;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // real sessions only; the web console is a UI identity, not a peer
  const listable = useMemo(
    () =>
      sessions
        .filter((s) => s.type === "session" && s.id !== "web-console")
        .sort((a, b) => (b.last_heartbeat_at ?? "").localeCompare(a.last_heartbeat_at ?? "")),
    [sessions],
  );

  const groups = useMemo(() => {
    const g = new Map<string, GraphNode[]>();
    for (const s of listable) {
      const key = timeGroup(s.last_heartbeat_at);
      const arr = g.get(key) ?? [];
      arr.push(s);
      g.set(key, arr);
    }
    return g;
  }, [listable]);

  const workViews = [
    { id: "graph" as const, icon: Network, label: "图谱" },
    { id: "messages" as const, icon: MessageSquare, label: "消息流" },
    { id: "agents" as const, icon: Bot, label: "Agents" },
  ];

  return (
    <aside className="w-60 bg-paper border-r border-line flex flex-col flex-shrink-0 min-h-0">
      {/* Brand */}
      <div className="flex items-center gap-2.5 px-4 h-12 border-b border-line flex-shrink-0">
        <div className="w-[26px] h-[26px] rounded-lg bg-accent flex items-center justify-center">
          <Boxes size={14} className="text-white" />
        </div>
        <span className="font-semibold text-sm text-ink tracking-tight">Conflux</span>
      </div>

      {/* Work views: compact switcher — navigation gets out of the way */}
      <div className="p-2 flex-shrink-0">
        <div className="grid grid-cols-3 gap-1">
          {workViews.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onTabChange(item.id)}
                aria-pressed={active}
                className={`flex flex-col items-center gap-1 py-2 rounded-lg text-2xs font-medium transition-colors ${
                  active
                    ? "bg-accent-soft text-accent"
                    : "text-ink-muted hover:bg-tile-hover hover:text-ink"
                }`}
              >
                <Icon size={16} className={active ? "text-accent" : "text-ink-faint"} />
                {item.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Session list: the sidebar's main body (#107) */}
      <div className="px-3 pb-1 pt-2 text-2xs font-medium text-ink-faint flex-shrink-0">
        会话 · {listable.length}
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-2 min-h-0">
        {GROUP_ORDER.filter((k) => groups.has(k)).map((group) => {
          const items = groups.get(group)!;
          const open = expanded[group] ?? false;
          const shown = open ? items : items.slice(0, GROUP_PREVIEW);
          const hidden = items.length - shown.length;
          return (
            <div key={group} className="mb-2">
              <div className="flex items-center gap-1 px-2 py-1 text-2xs text-ink-faint">
                {open ? (
                  <ChevronDown size={11} className="text-ink-faint" />
                ) : (
                  <ChevronRight size={11} className="text-ink-faint" />
                )}
                {group}
                <span className="text-ink-faint/70">{items.length}</span>
              </div>
              <div className="space-y-0.5">
                {shown.map((s) => {
                  const selected = s.id === selectedSessionId;
                  return (
                    <button
                      key={s.id}
                      onClick={() => onSelectSession(s.id)}
                      title={s.description || s.name}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs transition-colors text-left ${
                        selected
                          ? "bg-accent-soft text-accent"
                          : "text-ink hover:bg-tile-hover"
                      }`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusDot(s)}`} />
                      <span className="truncate flex-1">{s.name}</span>
                      {s.priority === "P0" && (
                        <span className="text-[10px] font-semibold text-red-500 flex-shrink-0">
                          P0
                        </span>
                      )}
                      {s.priority === "P2" && (
                        <span className="text-[10px] text-ink-faint flex-shrink-0">P2</span>
                      )}
                    </button>
                  );
                })}
                {hidden > 0 && (
                  <button
                    onClick={() => setExpanded((prev) => ({ ...prev, [group]: true }))}
                    className="w-full px-2 py-1 text-left text-2xs text-ink-faint hover:text-ink"
                  >
                    显示更多 {hidden} 个
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {listable.length === 0 && (
          <div className="px-2 py-6 text-xs text-ink-faint text-center">
            还没有会话
            <br />
            装 hooks 或挂 MCP 后自动出现
          </div>
        )}
      </div>

      {/* Bottom bar: status + low-frequency destinations */}
      <div className="border-t border-line p-2 flex items-center gap-1 flex-shrink-0">
        <span
          className={`w-2 h-2 rounded-full flex-shrink-0 ${online ? "bg-emerald-500" : "bg-red-500"}`}
          title={online ? "daemon 在线" : "daemon 离线"}
        />
        <span className="text-2xs text-ink-muted flex-1 truncate">
          {online ? "在线" : "离线"}
        </span>
        {(
          [
            { id: "runtimes" as const, icon: Terminal, label: "运行时" },
            { id: "settings" as const, icon: Settings, label: "设置" },
          ] as const
        ).map(({ id, icon: Icon, label }) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              onClick={() => onTabChange(id)}
              title={label}
              aria-label={label}
              aria-pressed={active}
              className={`p-1.5 rounded-lg transition-colors ${
                active ? "bg-accent-soft text-accent" : "text-ink-faint hover:bg-tile-hover hover:text-ink"
              }`}
              }`}
            >
              <Icon size={15} />
            </button>
          );
        })}
      </div>
    </aside>
  );
}
