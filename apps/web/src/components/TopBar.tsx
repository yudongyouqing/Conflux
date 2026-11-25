import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ThreadApproval } from "@conflux/shared";
import { Bell, Menu, Moon, PanelRight, Plus, Settings, Sun } from "lucide-react";
import { ApprovalCard, type ResolveApprovalParams } from "./ApprovalCard";

interface TopBarProps {
  breadcrumb: string;
  subtitle?: string | null;
  leftExtra?: ReactNode;
  rightExtra?: ReactNode;
  pendingApprovals: ThreadApproval[];
  isDark: boolean;
  onToggleTheme: () => void;
  onOpenNewAgent: () => void;
  onOpenSettings: () => void;
  onOpenMobileSidebar: () => void;
  showInspectorToggle?: boolean;
  inspectorOpen?: boolean;
  onToggleInspector?: () => void;
  onResolveApproval: (params: ResolveApprovalParams) => Promise<unknown> | void;
  onSelectThread: (threadId: string) => void;
}

export function TopBar({
  breadcrumb,
  subtitle,
  leftExtra,
  rightExtra,
  pendingApprovals,
  isDark,
  onToggleTheme,
  onOpenNewAgent,
  onOpenSettings,
  onOpenMobileSidebar,
  showInspectorToggle = false,
  inspectorOpen = false,
  onToggleInspector,
  onResolveApproval,
  onSelectThread,
}: TopBarProps) {
  const [approvalsOpen, setApprovalsOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!approvalsOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setApprovalsOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [approvalsOpen]);

  return (
    <header className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-line bg-surface px-3.5">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          data-testid="mobile-menu-btn"
          onClick={onOpenMobileSidebar}
          aria-label="打开导航栏"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-muted hover:bg-tile-hover hover:text-ink md:hidden"
        >
          <Menu className="h-4 w-4" />
        </button>
        <div
          data-testid="topbar-breadcrumb"
          title={subtitle ?? undefined}
          className="truncate text-[13px] font-medium text-ink"
        >
          {breadcrumb}
        </div>
        {leftExtra}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {rightExtra}

        {/* Global Pending Approvals Inbox */}
        <div className="relative" ref={popoverRef}>
          <button
            type="button"
            data-testid="global-approvals-btn"
            onClick={() => setApprovalsOpen((v) => !v)}
            title="全局待审批收件箱"
            className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs transition-colors ${
              pendingApprovals.length > 0
                ? "bg-warning-soft font-medium text-warning"
                : "text-ink-muted hover:bg-tile-hover hover:text-ink"
            }`}
          >
            <Bell className={`h-3.5 w-3.5 ${pendingApprovals.length > 0 ? "animate-pulse" : ""}`} />
            <span
              data-testid="global-approvals-count"
              className="font-mono text-2xs tabular-nums"
            >
              {pendingApprovals.length}
            </span>
          </button>

          {approvalsOpen && (
            <div
              data-testid="global-approvals-popover"
              className="absolute right-0 top-9 z-50 w-[min(92vw,400px)] rounded-xl border border-line-strong bg-surface p-3 shadow-overlay"
            >
              <div className="mb-2 flex items-center justify-between px-0.5">
                <span className="text-xs font-medium text-ink">
                  待审批（{pendingApprovals.length}）
                </span>
                <span className="text-2xs text-ink-faint">可直接原地处理</span>
              </div>
              {pendingApprovals.length === 0 ? (
                <div className="rounded-lg bg-tile px-3 py-5 text-center text-xs text-ink-faint">
                  当前没有待处理审批
                </div>
              ) : (
                <div className="max-h-96 space-y-2 overflow-y-auto">
                  {pendingApprovals.map((ap) => (
                    <ApprovalCard
                      key={ap.id}
                      approval={ap}
                      compact
                      onResolve={onResolveApproval}
                      onJumpToThread={(tid) => {
                        setApprovalsOpen(false);
                        onSelectThread(tid);
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Theme toggle */}
        <button
          type="button"
          data-testid="theme-toggle-btn"
          onClick={onToggleTheme}
          title={isDark ? "切换到浅色主题" : "切换到深色主题"}
          aria-label={isDark ? "切换到浅色主题" : "切换到深色主题"}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-muted hover:bg-tile-hover hover:text-ink transition-colors"
        >
          {isDark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
        </button>

        {showInspectorToggle && onToggleInspector && (
          <button
            type="button"
            data-testid="toggle-inspector-btn"
            onClick={onToggleInspector}
            title={inspectorOpen ? "收起右侧检查栏" : "展开右侧 Git Diff / 记忆栏"}
            className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
              inspectorOpen
                ? "bg-tile-active text-ink"
                : "text-ink-muted hover:bg-tile-hover hover:text-ink"
            }`}
          >
            <PanelRight className="h-3.5 w-3.5" />
          </button>
        )}

        <button
          type="button"
          data-testid="topbar-settings-btn"
          onClick={onOpenSettings}
          title="系统设置"
          aria-label="系统设置"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-muted hover:bg-tile-hover hover:text-ink transition-colors"
        >
          <Settings className="h-3.5 w-3.5" />
        </button>

        <button
          type="button"
          data-testid="topbar-new-agent-btn"
          onClick={onOpenNewAgent}
          className="ml-1 inline-flex h-7 items-center gap-1 rounded-md bg-accent px-2.5 text-xs font-medium text-on-accent hover:bg-accent-deep transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">新建</span>
        </button>
      </div>
    </header>
  );
}
