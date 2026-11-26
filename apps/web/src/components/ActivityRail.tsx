import {
  Contrast,
  History,
  Link2,
  Network,
  PanelLeft,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
} from "lucide-react";

export type MainScreen = "workspace" | "graph" | "settings";

interface ActivityRailProps {
  screen: MainScreen;
  activeCallCount: number;
  sidebarCollapsed: boolean;
  onSelectScreen: (screen: MainScreen) => void;
  onOpenHistory: () => void;
  onOpenConnect: () => void;
  onToggleTheme: () => void;
  onToggleSidebar: () => void;
}

export function ActivityRail({
  screen,
  activeCallCount,
  sidebarCollapsed,
  onSelectScreen,
  onOpenHistory,
  onOpenConnect,
  onToggleTheme,
  onToggleSidebar,
}: ActivityRailProps) {
  const btnCls = (active: boolean) =>
    `relative flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
      active
        ? "bg-tile-active text-ink before:absolute before:-left-[7px] before:top-[7px] before:bottom-[7px] before:w-[2.5px] before:rounded-full before:bg-ink"
        : "text-ink-faint hover:bg-tile-hover hover:text-ink"
    }`;

  return (
    <nav
      data-testid="activity-rail"
      aria-label="主功能导航"
      className="flex w-[46px] shrink-0 select-none flex-col items-center gap-1.5 border-r border-line bg-rail py-2.5"
    >
      <div
        title="Conflux"
        className="mb-1.5 flex h-7 w-7 items-center justify-center rounded-[7px] bg-accent text-[13px] font-bold text-on-accent"
      >
        C
      </div>

      <button
        type="button"
        data-testid="rail-workspace-btn"
        title="工作区 (Paseo IDE)"
        aria-label="工作区"
        onClick={() => onSelectScreen("workspace")}
        className={btnCls(screen === "workspace")}
      >
        <PanelLeft className="h-4 w-4" />
      </button>

      <button
        type="button"
        data-testid="rail-graph-btn"
        title="MCP 实时通话图谱"
        aria-label="MCP 实时通话图谱"
        onClick={() => onSelectScreen("graph")}
        className={btnCls(screen === "graph")}
      >
        <Network className="h-4 w-4" />
        {activeCallCount > 0 && (
          <span
            data-testid="rail-active-calls-badge"
            className="absolute right-0.5 top-0.5 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-success px-1 font-mono text-2xs font-bold leading-none text-on-accent"
          >
            {activeCallCount}
          </span>
        )}
      </button>

      <button
        type="button"
        data-testid="rail-history-btn"
        title="通话历史"
        aria-label="通话历史"
        onClick={onOpenHistory}
        className={btnCls(false)}
      >
        <History className="h-4 w-4" />
      </button>

      <div className="flex-1" />

      <button
        type="button"
        data-testid="rail-connect-btn"
        title="接入本机 / 远程 Agent (MCP + 原目录唤醒)"
        aria-label="接入远程 Agent"
        onClick={onOpenConnect}
        className={btnCls(false)}
      >
        <Link2 className="h-4 w-4" />
      </button>

      <button
        type="button"
        data-testid="rail-settings-btn"
        title="系统设置"
        aria-label="系统设置"
        onClick={() => onSelectScreen("settings")}
        className={btnCls(screen === "settings")}
      >
        <Settings className="h-4 w-4" />
      </button>

      <button
        type="button"
        data-testid="theme-toggle-btn"
        title="切换明 / 暗色主题"
        aria-label="切换明暗主题"
        onClick={onToggleTheme}
        className={btnCls(false)}
      >
        <Contrast className="h-4 w-4" />
      </button>

      <button
        type="button"
        data-testid="rail-sidebar-toggle-btn"
        title="展开 / 收起侧边栏 (⌘B)"
        aria-label="展开或收起侧边栏"
        onClick={onToggleSidebar}
        className={btnCls(false)}
      >
        {sidebarCollapsed ? (
          <PanelLeftOpen className="h-4 w-4" />
        ) : (
          <PanelLeftClose className="h-4 w-4" />
        )}
      </button>
    </nav>
  );
}
