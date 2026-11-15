import { useMemo, useState } from "react";
import {
  Network,
  MessagesSquare,
  History,
  Bot,
  Boxes,
  Settings,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { useDaemonHealth } from "../hooks";
import type { ChatRoom, GraphNode } from "@conflux/shared";
import { sessionStatusAppearance } from "./StatusDot";
import { ChatRoomList } from "./ChatRoomList";

export type TabId = "chat" | "graph" | "messages" | "assistants" | "settings";

interface SidebarProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  /** live graph nodes — the recent-session list body */
  sessions: GraphNode[];
  /** chat rooms owned by the workspace (App lifts the list query) */
  rooms: readonly ChatRoom[];
  selectedRoomId: number | null;
  selectedSessionId: string | null;
  onSelectRoom: (id: number) => void;
  onSelectSession: (id: string) => void;
  onCreateRoom: () => void;
  mobileOpen?: boolean;
  onCloseMobile?: () => void;
}

/** The home list only surfaces sessions active in the last N days — the
 * graph tab and the activity log keep the full history. */
const RECENT_WINDOW_DAYS = 10;
const OLDER_BUCKET_LABEL = `${RECENT_WINDOW_DAYS} 天内`;

/** Calendar-day bucket for the heartbeat timestamp, following the sidebar
 * convention of the major chat clients (今天 / 昨天 / 最近 7 天). Returns
 * null outside the recency window — the home list does not render those.
 * A missing/unparsable timestamp is NOT treated as old: registration always
 * stamps a heartbeat, so only legacy rows lack one — hide nothing we cannot
 * prove stale. */
function timeGroup(ts: string | null | undefined, now = new Date()): string | null {
  if (!ts) return "今天";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "今天";
  const day = 86_400_000;
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.floor((startOf(now) - startOf(d)) / day);
  if (diff <= 0) return "今天";
  if (diff === 1) return "昨天";
  if (diff < 7) return "最近 7 天";
  if (diff < RECENT_WINDOW_DAYS) return OLDER_BUCKET_LABEL;
  return null;
}

const GROUP_ORDER = ["今天", "昨天", "最近 7 天", OLDER_BUCKET_LABEL];
const GROUP_PREVIEW = 10;

export function Sidebar({
  activeTab,
  onTabChange,
  sessions,
  rooms,
  selectedRoomId,
  selectedSessionId,
  onSelectRoom,
  onSelectSession,
  onCreateRoom,
  mobileOpen = false,
  onCloseMobile,
}: SidebarProps) {
  const health = useDaemonHealth();
  // Electron preload 注入的平台标识；纯浏览器为 undefined（无玻璃/拖拽）
  const isDarwin =
    (globalThis as { confluxDesktop?: { platform?: string } }).confluxDesktop?.platform ===
    "darwin";
  const online = health.data?.ok === true;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Collapsed groups hide their items entirely (header keeps the count) —
  // the chevron in the header toggles this; "显示更多" only ever reveals.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

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
      if (!key) continue; // outside the recency window — not a home-list item
      const arr = g.get(key) ?? [];
      arr.push(s);
      g.set(key, arr);
    }
    return g;
  }, [listable]);

  const recentCount = useMemo(
    () => [...groups.values()].reduce((n, arr) => n + arr.length, 0),
    [groups],
  );
  const outsideWindow = listable.length - recentCount;

  const workViews = [
    { id: "chat" as const, icon: MessagesSquare, label: "聊天" },
    { id: "graph" as const, icon: Network, label: "图谱" },
    { id: "messages" as const, icon: History, label: "活动记录" },
    { id: "assistants" as const, icon: Bot, label: "助手" },
  ];

  return (
    <>
      <button
        type="button"
        aria-label="关闭导航"
        className={`mobile-sidebar-backdrop ${mobileOpen ? "is-open" : ""}`}
        onClick={onCloseMobile}
      />
      <aside
        className={`mobile-sidebar ${mobileOpen ? "is-open" : ""} ${
          isDarwin ? "glass-sidebar" : "bg-paper"
        } w-[248px] border-r border-line flex flex-col flex-shrink-0 min-h-0`}
      >
        {/* Brand — darwin: 红绿灯占顶部空间，logo 放在它们下方 */}
        <div className={`app-drag flex-shrink-0 ${isDarwin ? "pt-[38px]" : ""}`}>
          <div className="flex items-center gap-2.5 h-10 border-b border-line px-4 app-no-drag">
            <div className="w-[26px] h-[26px] rounded-lg bg-accent flex items-center justify-center app-no-drag">
              <Boxes size={14} className="text-on-accent" />
            </div>
            <span className="font-semibold text-sm text-ink tracking-tight">Conflux</span>
          </div>
        </div>

        {/* Work views: compact switcher — navigation gets out of the way */}
        <div className="p-2 flex-shrink-0">
          <div className="grid grid-cols-4 gap-1">
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

        {/* Navigation body: rooms first, then recent sessions */}
        <div className="flex-1 overflow-y-auto min-h-0 pb-2">
          <ChatRoomList
            rooms={rooms}
            selectedRoomId={selectedRoomId}
            onSelectRoom={onSelectRoom}
            onCreateRoom={onCreateRoom}
          />

          <div className="px-4 pb-1 pt-2 text-2xs font-medium text-ink-faint">
            最近会话 · {recentCount}
          </div>
          <div className="px-2">
            {GROUP_ORDER.filter((k) => groups.has(k)).map((group) => {
              const items = groups.get(group)!;
              const open = expanded[group] ?? false;
              const isCollapsed = collapsed[group] ?? false;
              const shown = isCollapsed ? [] : open ? items : items.slice(0, GROUP_PREVIEW);
              const hidden = items.length - shown.length;
              return (
                <div key={group} className="mb-2">
                  <button
                    type="button"
                    aria-expanded={!isCollapsed}
                    onClick={() => setCollapsed((prev) => ({ ...prev, [group]: !isCollapsed }))}
                    className="flex w-full items-center gap-1 px-2 py-1 text-2xs text-ink-faint hover:text-ink transition-colors"
                  >
                    {isCollapsed ? (
                      <ChevronRight size={11} className="text-ink-faint" />
                    ) : (
                      <ChevronDown size={11} className="text-ink-faint" />
                    )}
                    {group}
                    <span className="text-ink-faint/70">{items.length}</span>
                  </button>
                  <div className="space-y-0.5">
                    {shown.map((s) => {
                      const selected = s.id === selectedSessionId;
                      const status = sessionStatusAppearance(s.status, s.busy);
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
                          <span
                            role="img"
                            aria-label={status.label}
                            title={status.label}
                            className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${status.className}`}
                          />
                          <span className="truncate flex-1">{s.name}</span>
                          {s.priority === "P0" && (
                            <span className="text-2xs font-semibold text-warning flex-shrink-0">
                              P0
                            </span>
                          )}
                          {s.priority === "P2" && (
                            <span className="text-2xs text-ink-faint flex-shrink-0">P2</span>
                          )}
                        </button>
                      );
                    })}
                    {!isCollapsed && hidden > 0 && (
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
            {outsideWindow > 0 && (
              <div className="px-2 pt-1 pb-2 text-2xs text-ink-faint">
                更早的 {outsideWindow} 个会话见「图谱」
              </div>
            )}
            {recentCount === 0 && outsideWindow === 0 && (
              <div className="px-2 py-6 text-xs text-ink-faint text-center">
                还没有会话
                <br />
                装 hooks 或挂 MCP 后自动出现
              </div>
            )}
          </div>
        </div>

        {/* Bottom bar: status + low-frequency destinations */}
        <div className="border-t border-line p-2 flex items-center gap-1 flex-shrink-0">
          <span
            className={`w-2 h-2 rounded-full flex-shrink-0 ${online ? "bg-success" : "bg-neutral"}`}
            title={online ? "daemon 在线" : "daemon 离线"}
          />
          <span className="text-2xs text-ink-muted flex-1 truncate">{online ? "在线" : "离线"}</span>
          {(
            [
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
                  active
                    ? "bg-accent-soft text-accent"
                    : "text-ink-faint hover:bg-tile-hover hover:text-ink"
                }`}
              >
                <Icon size={15} />
              </button>
            );
          })}
        </div>
      </aside>
    </>
  );
}
