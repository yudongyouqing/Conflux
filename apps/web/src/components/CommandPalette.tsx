import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentThread } from "@conflux/shared";
import {
  Columns2,
  Contrast,
  Folder,
  GitBranch,
  Globe,
  History,
  Link2,
  Network,
  PanelLeft,
  Plus,
  Search,
  Settings,
  Terminal,
  Users,
} from "lucide-react";
import type { MainScreen } from "./ActivityRail";
import type { PaseoToolTab } from "./PaseoToolPane";
import { RuntimeGlyph } from "./brand-icons";

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  threads: AgentThread[];
  activeThreadId: string | null;
  localHostname: string;
  isSplit: boolean;
  sidebarCollapsed: boolean;
  onSelectThread: (threadId: string) => void;
  onOpenCompanion: (threadId: string) => void;
  onSelectTool: (tool: PaseoToolTab) => void;
  onSelectScreen: (screen: MainScreen) => void;
  onOpenNewWorkspace: () => void;
  onOpenConnect: () => void;
  onOpenHistory: () => void;
  onToggleSplit: () => void;
  onToggleSidebar: () => void;
  onToggleTheme: () => void;
}

interface PaletteItem {
  id: string;
  group: "工作区与同伴" | "当前工作区工具" | "快捷操作";
  title: string;
  subtitle?: string;
  keywords: string;
  badge?: string;
  shortcut?: string;
  runtime?: AgentThread["runtime"];
  icon?: typeof Search;
  secondaryAction?: {
    label: string;
    onClick: () => void;
  };
  onRun: () => void;
}

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || "");
}

function shortDir(workdir: string): string {
  const cleaned = workdir.replace(/[\\/]+$/, "");
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || cleaned;
}

export function CommandPalette({
  open,
  onClose,
  threads,
  activeThreadId,
  localHostname,
  isSplit,
  sidebarCollapsed,
  onSelectThread,
  onOpenCompanion,
  onSelectTool,
  onSelectScreen,
  onOpenNewWorkspace,
  onOpenConnect,
  onOpenHistory,
  onToggleSplit,
  onToggleSidebar,
  onToggleTheme,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const mac = useMemo(() => isMacPlatform(), []);
  const modKey = mac ? "⌘" : "Ctrl+";

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedIndex(0);
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  const allItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [];

    for (const t of threads) {
      const host = t.host || localHostname;
      const dir = shortDir(t.workdir);
      const isActive = t.id === activeThreadId;
      items.push({
        id: `thread-${t.id}`,
        group: "工作区与同伴",
        title: t.name,
        subtitle: `${host} · ${dir}${t.worktree_branch ? ` (${t.worktree_branch})` : ""}`,
        keywords: `${t.name} ${host} ${t.workdir} ${t.runtime} ${t.worktree_branch ?? ""} ${t.id}`,
        badge: isActive ? "当前" : t.kind === "external" ? "外部" : undefined,
        runtime: t.runtime,
        secondaryAction: !isActive
          ? {
              label: "右侧对比",
              onClick: () => {
                onOpenCompanion(t.id);
                onClose();
              },
            }
          : undefined,
        onRun: () => {
          onSelectThread(t.id);
          onClose();
        },
      });
    }

    if (activeThreadId) {
      const toolEntries: Array<{ id: PaseoToolTab; title: string; subtitle: string; icon: typeof GitBranch }> = [
        { id: "git", title: "打开 Git & PR", subtitle: "变更、行内 Diff 批注、Checks 与 Review", icon: GitBranch },
        { id: "term", title: "打开嵌入式终端", subtitle: "在当前工作区目录运行命令", icon: Terminal },
        { id: "files", title: "打开文件浏览器", subtitle: "浏览与查看工作区源码文件", icon: Folder },
        { id: "preview", title: "打开本地预览", subtitle: "自动检测并预览本机开发服务", icon: Globe },
        { id: "peer", title: "右侧并排同伴对比", subtitle: "双 Agent 分屏同屏查看与协作", icon: Users },
      ];
      for (const tool of toolEntries) {
        items.push({
          id: `tool-${tool.id}`,
          group: "当前工作区工具",
          title: tool.title,
          subtitle: tool.subtitle,
          keywords: `${tool.title} ${tool.subtitle} ${tool.id}`,
          icon: tool.icon,
          onRun: () => {
            onSelectTool(tool.id);
            onClose();
          },
        });
      }
    }

    items.push(
      {
        id: "action-new-workspace",
        group: "快捷操作",
        title: "新建工作区",
        subtitle: "直连目录、Worktree 新分支或检出 PR",
        keywords: "new workspace 新建 工作区 worktree pr",
        icon: Plus,
        onRun: () => {
          onOpenNewWorkspace();
          onClose();
        },
      },
      {
        id: "action-graph",
        group: "快捷操作",
        title: "MCP 实时通话图谱",
        subtitle: "查看跨主机 Agent 实时互调连线与审计",
        keywords: "graph mesh mcp 图谱 拓扑 互调",
        icon: Network,
        onRun: () => {
          onSelectScreen("graph");
          onClose();
        },
      },
      {
        id: "action-connect",
        group: "快捷操作",
        title: "接入本机 / 远程 Agent",
        subtitle: "复制 MCP 端点与原目录 Hook 唤醒命令",
        keywords: "connect remote mcp hook 接入 远程 mac",
        icon: Link2,
        onRun: () => {
          onOpenConnect();
          onClose();
        },
      },
      {
        id: "action-history",
        group: "快捷操作",
        title: "通话历史记录",
        subtitle: "查看所有跨 Agent 互调历史",
        keywords: "history calls 通话 历史",
        icon: History,
        onRun: () => {
          onOpenHistory();
          onClose();
        },
      },
      {
        id: "action-split",
        group: "快捷操作",
        title: isSplit ? "关闭分屏" : "开启双栏分屏",
        subtitle: "切换对话与工具/同伴的并排视图",
        keywords: "split 分屏",
        icon: Columns2,
        onRun: () => {
          onToggleSplit();
          onClose();
        },
      },
      {
        id: "action-sidebar",
        group: "快捷操作",
        title: sidebarCollapsed ? "展开左侧工作区栏" : "收起左侧工作区栏",
        subtitle: "释放主工作区宽度",
        keywords: "sidebar 侧边栏 折叠 展开",
        shortcut: `${modKey}B`,
        icon: PanelLeft,
        onRun: () => {
          onToggleSidebar();
          onClose();
        },
      },
      {
        id: "action-theme",
        group: "快捷操作",
        title: "切换明 / 暗色主题",
        subtitle: "在 Paseo Dark 与 Paseo Light 之间切换",
        keywords: "theme dark light 主题 暗色 亮色",
        icon: Contrast,
        onRun: () => {
          onToggleTheme();
          onClose();
        },
      },
      {
        id: "action-settings",
        group: "快捷操作",
        title: "打开系统设置",
        subtitle: "主题、CLI 路径探测与防循环护栏",
        keywords: "settings 设置 护栏 cli",
        icon: Settings,
        onRun: () => {
          onSelectScreen("settings");
          onClose();
        },
      },
    );

    return items;
  }, [
    threads,
    activeThreadId,
    localHostname,
    isSplit,
    sidebarCollapsed,
    modKey,
    onSelectThread,
    onOpenCompanion,
    onSelectTool,
    onSelectScreen,
    onOpenNewWorkspace,
    onOpenConnect,
    onOpenHistory,
    onToggleSplit,
    onToggleSidebar,
    onToggleTheme,
    onClose,
  ]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allItems;
    const tokens = q.split(/\s+/).filter(Boolean);
    return allItems.filter((item) => {
      const hay = `${item.title} ${item.subtitle ?? ""} ${item.keywords}`.toLowerCase();
      return tokens.every((tok) => hay.includes(tok));
    });
  }, [allItems, query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((idx) => (filtered.length === 0 ? 0 : (idx + 1) % filtered.length));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((idx) =>
          filtered.length === 0 ? 0 : (idx - 1 + filtered.length) % filtered.length,
        );
        return;
      }
      if (e.key === "Enter" && !e.isComposing) {
        const picked = filtered[selectedIndex];
        if (picked) {
          e.preventDefault();
          picked.onRun();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, filtered, selectedIndex, onClose]);

  useEffect(() => {
    if (!open || !listRef.current) return;
    const activeEl = listRef.current.querySelector<HTMLElement>("[data-selected='true']");
    activeEl?.scrollIntoView({ block: "nearest" });
  }, [open, selectedIndex]);

  if (!open) return null;

  // Group filtered items preserving order
  const groups: Array<{ name: PaletteItem["group"]; items: Array<{ item: PaletteItem; flatIdx: number }> }> = [];
  filtered.forEach((item, flatIdx) => {
    let g = groups.find((entry) => entry.name === item.group);
    if (!g) {
      g = { name: item.group, items: [] };
      groups.push(g);
    }
    g.items.push({ item, flatIdx });
  });

  return (
    <div
      data-testid="command-palette"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/40 px-4 pt-[12vh] backdrop-blur-[2px]"
    >
      <div className="flex max-h-[70vh] w-full max-w-[540px] flex-col overflow-hidden rounded-xl border border-line-strong bg-surface shadow-overlay">
        {/* Search Input */}
        <div className="flex items-center gap-2.5 border-b border-line px-3.5 py-2.5">
          <Search className="h-4 w-4 shrink-0 text-ink-faint" />
          <input
            ref={inputRef}
            type="text"
            data-testid="command-palette-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="跳转工作区、切换工具或执行命令…"
            className="min-w-0 flex-1 bg-transparent text-xs text-ink placeholder:text-ink-faint focus:outline-none"
          />
          <kbd className="rounded border border-line bg-elev px-1.5 py-0.5 font-mono text-2xs text-ink-faint">
            Esc
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1.5">
          {groups.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-ink-faint">
              没有匹配「{query}」的工作区或命令
            </div>
          ) : (
            groups.map((group) => (
              <div key={group.name} className="mb-1.5 last:mb-0">
                <div className="px-3.5 py-1 text-2xs font-semibold text-ink-faint">
                  {group.name}
                </div>
                {group.items.map(({ item, flatIdx }) => {
                  const selected = flatIdx === selectedIndex;
                  const Icon = item.icon;
                  return (
                    <div
                      key={item.id}
                      data-testid={`palette-item-${item.id}`}
                      data-selected={selected ? "true" : "false"}
                      onMouseEnter={() => setSelectedIndex(flatIdx)}
                      onClick={() => item.onRun()}
                      className={`mx-1.5 flex cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 py-1.5 transition-colors ${
                        selected ? "bg-tile-active text-ink" : "text-ink-muted hover:bg-tile-hover"
                      }`}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center text-ink-muted">
                          {item.runtime ? (
                            <RuntimeGlyph runtime={item.runtime} size={14} />
                          ) : Icon ? (
                            <Icon className="h-3.5 w-3.5" />
                          ) : null}
                        </span>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-xs font-medium text-ink">
                              {item.title}
                            </span>
                            {item.badge && (
                              <span className="rounded bg-elev px-1.5 py-0.2 font-mono text-2xs text-ink-faint">
                                {item.badge}
                              </span>
                            )}
                          </div>
                          {item.subtitle && (
                            <div className="truncate font-mono text-2xs text-ink-faint">
                              {item.subtitle}
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-1.5">
                        {item.secondaryAction && (
                          <button
                            type="button"
                            data-testid={`palette-companion-${item.id}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              item.secondaryAction?.onClick();
                            }}
                            className="rounded border border-line-strong bg-elev px-1.5 py-0.5 text-2xs text-ink-muted hover:bg-surface hover:text-ink"
                          >
                            {item.secondaryAction.label}
                          </button>
                        )}
                        {item.shortcut && (
                          <kbd className="rounded border border-line bg-elev px-1.5 py-0.5 font-mono text-2xs text-ink-faint">
                            {item.shortcut}
                          </kbd>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer Hints */}
        <div className="flex items-center justify-between border-t border-line bg-paper px-3.5 py-1.5 text-2xs text-ink-faint">
          <div className="flex items-center gap-3">
            <span>↑↓ 选择</span>
            <span>↵ 执行</span>
            <span>Esc 关闭</span>
          </div>
          <span className="font-mono">{modKey}K</span>
        </div>
      </div>
    </div>
  );
}
