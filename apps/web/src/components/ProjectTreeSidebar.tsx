import { useMemo, useState } from "react";
import type { AgentThread, Project, Room, WorkflowDefinition } from "@conflux/shared";
import {
  FolderGit2,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitPullRequest,
  MessageSquareText,
  Network,
  Plus,
  Terminal,
  Workflow,
  X,
} from "lucide-react";
import { RuntimeGlyph } from "./brand-icons";

export type ActiveView =
  | { kind: "thread"; threadId: string }
  | { kind: "room"; roomId: number }
  | { kind: "workflow"; projectId: number | null; workflowId?: number }
  | { kind: "graph" }
  | { kind: "settings" };

type InboxFilter = "all" | "approval" | "running";

interface ProjectTreeSidebarProps {
  projects: Project[];
  threads: AgentThread[];
  rooms: Room[];
  workflows: WorkflowDefinition[];
  activeView: ActiveView;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  onSelectView: (view: ActiveView) => void;
  onAddProjectClick: () => void;
  onNewAgentForProject: (projectId: number | null) => void;
  onNewRoomClick: (projectId: number | null) => void;
}

function stateDotClass(state: AgentThread["state"]): string {
  switch (state) {
    case "running":
      return "bg-info animate-pulse";
    case "waiting_approval":
      return "bg-warning animate-pulse";
    case "idle":
      return "bg-success";
    case "error":
      return "bg-danger";
    default:
      return "bg-neutral";
  }
}

function extractPrNumber(prUrl: string | null | undefined): string | null {
  if (!prUrl) return null;
  const m = /\/pull\/(\d+)/.exec(prUrl);
  return m ? `#${m[1]}` : "PR";
}

function threadSummaryLine(thread: AgentThread, projectName: string | null): string {
  const pending = thread.pending_approvals ?? 0;
  if (pending > 0) {
    return `等待确认：${pending} 项操作待审批`;
  }
  if (thread.state === "running") {
    return `正在执行中… ${thread.model ?? thread.runtime}`;
  }
  if (thread.state === "error") {
    return "执行出现异常，点击查看日志或恢复";
  }
  if (thread.state === "stopped") {
    return "进程已停止，点击进入并恢复";
  }
  if (thread.instructions && thread.instructions.trim().length > 0) {
    return thread.instructions.trim();
  }
  const parts = [projectName, thread.model ?? thread.runtime].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "空闲就绪，随时接收指令";
}

export function ProjectTreeSidebar({
  projects,
  threads,
  rooms,
  workflows,
  activeView,
  mobileOpen,
  onCloseMobile,
  onSelectView,
  onAddProjectClick,
  onNewAgentForProject,
  onNewRoomClick,
}: ProjectTreeSidebarProps) {
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);

  const projectNameById = useMemo(
    () => new Map(projects.map((p) => [p.id, p.name])),
    [projects],
  );

  const scopedThreads = useMemo(
    () =>
      selectedProjectId === null
        ? threads
        : threads.filter((t) => t.project_id === selectedProjectId),
    [threads, selectedProjectId],
  );

  const approvalCount = useMemo(
    () =>
      scopedThreads.filter(
        (t) => (t.pending_approvals ?? 0) > 0 || t.state === "waiting_approval",
      ).length,
    [scopedThreads],
  );

  const runningCount = useMemo(
    () => scopedThreads.filter((t) => t.state === "running").length,
    [scopedThreads],
  );

  const visibleThreads = useMemo(() => {
    if (filter === "approval") {
      return scopedThreads.filter(
        (t) => (t.pending_approvals ?? 0) > 0 || t.state === "waiting_approval",
      );
    }
    if (filter === "running") {
      return scopedThreads.filter((t) => t.state === "running");
    }
    return scopedThreads;
  }, [scopedThreads, filter]);

  const visibleRooms = useMemo(
    () =>
      selectedProjectId === null
        ? rooms
        : rooms.filter((r) => r.project_id === null || r.project_id === selectedProjectId),
    [rooms, selectedProjectId],
  );

  const selectAndClose = (view: ActiveView) => {
    onSelectView(view);
    onCloseMobile();
  };

  return (
    <>
      <button
        type="button"
        aria-label="关闭导航栏"
        onClick={onCloseMobile}
        className={`mobile-sidebar-backdrop ${mobileOpen ? "is-open" : ""}`}
      />
      <aside
        data-testid="project-tree-sidebar"
        className={`mobile-sidebar flex h-full w-[312px] shrink-0 flex-col border-r border-line bg-paper select-none ${
          mobileOpen ? "is-open" : ""
        }`}
      >
        {/* Conductor Mission Control Header */}
        <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-line px-3.5">
          <button
            type="button"
            onClick={() => selectAndClose({ kind: "graph" })}
            className="flex min-w-0 items-center gap-2 rounded-md py-1 text-left transition-colors hover:opacity-85"
          >
            <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-accent" />
            <span className="truncate text-sm font-semibold tracking-tight text-ink">
              Conflux 指挥台
            </span>
          </button>

          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              data-testid="inbox-dispatch-agent-btn"
              onClick={() => onNewAgentForProject(selectedProjectId ?? projects[0]?.id ?? null)}
              className="inline-flex h-7 items-center gap-1 rounded-lg bg-accent px-2.5 text-xs font-semibold text-on-accent hover:bg-accent-deep transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>派发 Agent</span>
            </button>
            <button
              type="button"
              onClick={onCloseMobile}
              aria-label="关闭侧边栏"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-muted hover:bg-tile-hover md:hidden"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Triage Filter Bar (All / Needs Approval / Running) */}
        <div className="grid shrink-0 grid-cols-3 gap-1 border-b border-line px-3 py-2">
          {(
            [
              { id: "all", label: "全部", count: scopedThreads.length },
              { id: "approval", label: "需审批", count: approvalCount },
              { id: "running", label: "运行中", count: runningCount },
            ] as const
          ).map((item) => {
            const active = filter === item.id;
            return (
              <button
                key={item.id}
                type="button"
                data-testid={`inbox-filter-${item.id}`}
                onClick={() => setFilter(item.id)}
                className={`inline-flex h-7 items-center justify-center gap-1 rounded-md px-1.5 text-2xs transition-colors ${
                  active
                    ? "border border-line bg-surface font-semibold text-ink shadow-card"
                    : "text-ink-muted hover:bg-tile-hover hover:text-ink"
                }`}
              >
                <span>{item.label}</span>
                <span
                  className={`font-mono tabular-nums ${
                    item.id === "approval" && item.count > 0 ? "font-semibold text-warning" : "text-ink-faint"
                  }`}
                >
                  ({item.count})
                </span>
              </button>
            );
          })}
        </div>

        {/* Project Scope Pills */}
        <div className="shrink-0 border-b border-line/80 px-3 py-2">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-2xs font-medium text-ink-faint">项目范围</span>
            <button
              type="button"
              data-testid="add-project-btn"
              onClick={onAddProjectClick}
              title="添加项目目录"
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs text-ink-muted hover:bg-tile-hover hover:text-ink transition-colors"
            >
              <FolderPlus className="h-3 w-3" />
              <span>添加项目</span>
            </button>
          </div>

          {projects.length === 0 ? (
            <button
              type="button"
              onClick={onAddProjectClick}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-line-strong bg-surface/60 px-2.5 py-2 text-xs text-ink-muted hover:border-accent hover:text-ink transition-colors"
            >
              <FolderPlus className="h-3.5 w-3.5" />
              <span>添加第一个项目目录</span>
            </button>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              {projects.length > 1 && (
                <button
                  type="button"
                  onClick={() => setSelectedProjectId(null)}
                  className={`inline-flex h-6 items-center rounded-md px-2 text-2xs transition-colors ${
                    selectedProjectId === null
                      ? "bg-tile-active font-medium text-ink"
                      : "bg-tile text-ink-muted hover:bg-tile-hover hover:text-ink"
                  }`}
                >
                  全部项目
                </button>
              )}
              {projects.map((project) => {
                const selected = selectedProjectId === project.id;
                return (
                  <div
                    key={project.id}
                    data-testid={`sidebar-project-${project.id}`}
                    className={`inline-flex h-6 max-w-full items-center rounded-md border transition-colors ${
                      selected
                        ? "border-accent/60 bg-accent-soft text-accent"
                        : "border-line bg-surface/80 text-ink-muted hover:border-line-strong hover:text-ink"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setSelectedProjectId((prev) => (prev === project.id ? null : project.id))
                      }
                      className="inline-flex min-w-0 items-center gap-1 px-2 text-2xs font-medium"
                      title={project.root_path}
                    >
                      {project.is_git_repo ? (
                        <FolderGit2 className="h-3 w-3 shrink-0" />
                      ) : (
                        <FolderOpen className="h-3 w-3 shrink-0" />
                      )}
                      <span className="max-w-[130px] truncate">{project.name}</span>
                    </button>
                    <button
                      type="button"
                      data-testid={`project-new-agent-${project.id}`}
                      onClick={() => onNewAgentForProject(project.id)}
                      title={`在 ${project.name} 下派发新 Agent`}
                      className="inline-flex h-full items-center border-l border-line/70 px-1.5 text-ink-faint hover:text-ink transition-colors"
                    >
                      <Plus className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Rich Thread & Room Card Stream */}
        <div className="flex-1 space-y-2.5 overflow-y-auto p-2.5">
          {visibleThreads.length === 0 ? (
            <div className="rounded-xl border border-dashed border-line-strong bg-surface/50 px-4 py-6 text-center">
              <p className="text-xs text-ink-muted">
                {filter === "approval"
                  ? "当前没有等待审批的线程"
                  : filter === "running"
                    ? "当前没有运行中的线程"
                    : "还没有 Agent 线程"}
              </p>
              {filter === "all" && (
                <button
                  type="button"
                  onClick={() => onNewAgentForProject(selectedProjectId ?? projects[0]?.id ?? null)}
                  className="mt-2.5 inline-flex h-7 items-center gap-1 rounded-lg bg-accent px-3 text-xs font-semibold text-on-accent hover:bg-accent-deep"
                >
                  <Plus className="h-3.5 w-3.5" />
                  派发第一个 Agent
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {visibleThreads.map((thread) => {
                const active = activeView.kind === "thread" && activeView.threadId === thread.id;
                const pendingCount = thread.pending_approvals ?? 0;
                const projName =
                  thread.project_name ??
                  (thread.project_id !== null ? (projectNameById.get(thread.project_id) ?? null) : null);
                const prTag = extractPrNumber(thread.pr_url);

                return (
                  <button
                    key={thread.id}
                    type="button"
                    data-testid={`sidebar-thread-${thread.id}`}
                    onClick={() => selectAndClose({ kind: "thread", threadId: thread.id })}
                    className={`block w-full rounded-[10px] border p-3 text-left transition-colors ${
                      active
                        ? "border-accent bg-surface ring-1 ring-accent"
                        : "border-line bg-surface/80 hover:border-line-strong hover:bg-surface"
                    }`}
                  >
                    {/* Card Row 1: Identity + PR/External badge */}
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span
                          className={`h-2 w-2 shrink-0 rounded-full ${stateDotClass(thread.state)}`}
                        />
                        <RuntimeGlyph
                          runtime={thread.runtime}
                          size={13}
                          className="shrink-0 opacity-80"
                        />
                        <span className="truncate text-[13px] font-semibold text-ink">
                          {thread.name}
                        </span>
                      </div>

                      <div className="flex shrink-0 items-center gap-1">
                        {prTag && (
                          <span className="inline-flex items-center gap-0.5 rounded bg-accent-soft px-1.5 py-0.5 font-mono text-2xs font-medium text-accent">
                            <GitPullRequest className="h-2.5 w-2.5" />
                            {prTag}
                          </span>
                        )}
                        {thread.kind === "external" ? (
                          <span
                            data-testid={`external-badge-${thread.id}`}
                            className="inline-flex items-center gap-0.5 rounded bg-info-soft px-1.5 py-0.5 text-2xs text-info"
                          >
                            <Terminal className="h-2.5 w-2.5" />
                            外部
                          </span>
                        ) : (
                          <span className="font-mono text-2xs text-ink-faint">
                            {thread.runtime}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Card Row 2: Live 1-line summary */}
                    <div
                      className={`mt-1.5 truncate text-xs ${
                        pendingCount > 0 ? "text-warning" : "text-ink-muted"
                      }`}
                    >
                      {threadSummaryLine(thread, projName)}
                    </div>

                    {/* Card Row 3: Branch / workdir + Status Pill */}
                    <div className="mt-2 flex items-center justify-between gap-2 text-2xs">
                      <span className="inline-flex min-w-0 items-center gap-1 truncate font-mono text-ink-faint">
                        {thread.worktree_branch ? (
                          <>
                            <GitBranch className="h-3 w-3 shrink-0" />
                            <span className="truncate">{thread.worktree_branch}</span>
                          </>
                        ) : (
                          <span className="truncate">
                            {projName ? `${projName} (直连)` : "直连工作区"}
                          </span>
                        )}
                      </span>

                      {pendingCount > 0 ? (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-warning-soft px-2 py-0.5 font-semibold text-warning">
                          <span>待审批</span>
                          <span
                            data-testid={`sidebar-approval-badge-${thread.id}`}
                            className="font-mono tabular-nums"
                          >
                            {pendingCount}
                          </span>
                        </span>
                      ) : thread.state === "running" ? (
                        <span className="shrink-0 font-medium text-info">运行中</span>
                      ) : thread.state === "idle" ? (
                        <span className="shrink-0 font-medium text-accent">空闲就绪</span>
                      ) : thread.state === "error" ? (
                        <span className="shrink-0 font-medium text-danger">异常</span>
                      ) : (
                        <span className="shrink-0 text-ink-faint">已停止</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {/* Collaboration Rooms Section */}
          {filter === "all" && (
            <div className="pt-2">
              <div className="mb-1.5 flex items-center justify-between px-1">
                <span className="text-2xs font-medium text-ink-faint">
                  协作房间 ({visibleRooms.length})
                </span>
                <button
                  type="button"
                  data-testid="new-global-room-btn"
                  onClick={() => onNewRoomClick(selectedProjectId)}
                  title="新建协作房间"
                  className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-2xs text-ink-muted hover:bg-tile-hover hover:text-ink transition-colors"
                >
                  <Plus className="h-3 w-3" />
                  <span>新建房间</span>
                </button>
              </div>

              {visibleRooms.length > 0 && (
                <div className="space-y-1.5">
                  {visibleRooms.map((room) => {
                    const active = activeView.kind === "room" && activeView.roomId === room.id;
                    return (
                      <button
                        key={room.id}
                        type="button"
                        data-testid={`sidebar-room-${room.id}`}
                        onClick={() => selectAndClose({ kind: "room", roomId: room.id })}
                        className={`block w-full rounded-[10px] border px-3 py-2.5 text-left transition-colors ${
                          active
                            ? "border-accent bg-surface ring-1 ring-accent"
                            : "border-line bg-surface/70 hover:border-line-strong hover:bg-surface"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-ink">
                            <MessageSquareText className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
                            <span className="truncate">{room.name}</span>
                          </span>
                          <span className="shrink-0 text-2xs text-ink-faint tabular-nums">
                            {room.members.length} 成员
                          </span>
                        </div>
                        <div className="mt-1 truncate text-2xs text-ink-muted">
                          {room.description ?? "多 Agent 双向协作室 · @召唤 / 全员广播"}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Bottom Mission Control Navigation Dock */}
        <div className="shrink-0 border-t border-line bg-paper px-2.5 py-2 space-y-2">
          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              data-testid="nav-graph-btn"
              onClick={() => selectAndClose({ kind: "graph" })}
              className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border text-xs transition-colors ${
                activeView.kind === "graph"
                  ? "border-accent/50 bg-accent-soft font-semibold text-accent"
                  : "border-line bg-surface/70 text-ink-muted hover:border-line-strong hover:text-ink"
              }`}
            >
              <Network className="h-3.5 w-3.5" />
              <span>态势图谱</span>
              <span className="font-mono text-2xs opacity-75 tabular-nums">{threads.length}</span>
            </button>

            <button
              type="button"
              data-testid="nav-global-workflows-btn"
              onClick={() =>
                selectAndClose({ kind: "workflow", projectId: selectedProjectId })
              }
              className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border text-xs transition-colors ${
                activeView.kind === "workflow"
                  ? "border-accent/50 bg-accent-soft font-semibold text-accent"
                  : "border-line bg-surface/70 text-ink-muted hover:border-line-strong hover:text-ink"
              }`}
            >
              <Workflow className="h-3.5 w-3.5" />
              <span>工作流</span>
              {workflows.length > 0 && (
                <span className="font-mono text-2xs opacity-75 tabular-nums">
                  {workflows.length}
                </span>
              )}
            </button>
          </div>

          <div className="flex items-center justify-between px-1 text-2xs text-ink-faint">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-success" />
              <span>本地服务在线</span>
            </span>
            <span className="font-mono tabular-nums">
              {projects.length} 项目 · {threads.length} 线程
            </span>
          </div>
        </div>
      </aside>
    </>
  );
}
