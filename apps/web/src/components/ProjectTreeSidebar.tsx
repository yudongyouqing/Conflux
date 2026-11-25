import { useState } from "react";
import type { AgentThread, Project, Room, WorkflowDefinition } from "@conflux/shared";
import {
  ChevronDown,
  ChevronRight,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  GitBranch,
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
      return "bg-accent animate-pulse";
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
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});

  const globalRooms = rooms.filter((r) => r.project_id === null);
  const unassignedThreads = threads.filter((t) => t.project_id === null);

  const selectAndClose = (view: ActiveView) => {
    onSelectView(view);
    onCloseMobile();
  };

  const renderThreadRow = (thread: AgentThread, indented = true) => {
    const active = activeView.kind === "thread" && activeView.threadId === thread.id;
    const pendingCount = thread.pending_approvals ?? 0;

    return (
      <button
        key={thread.id}
        type="button"
        data-testid={`sidebar-thread-${thread.id}`}
        title={thread.worktree_branch ? `${thread.name} (${thread.worktree_branch})` : thread.name}
        onClick={() => selectAndClose({ kind: "thread", threadId: thread.id })}
        className={`group flex w-full items-center gap-2 rounded-md py-1.5 text-left transition-colors ${
          indented ? "pl-5 pr-2" : "px-2"
        } ${
          active
            ? "bg-tile-active font-medium text-ink"
            : "text-ink-muted hover:bg-tile-hover hover:text-ink"
        }`}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${stateDotClass(thread.state)}`} />
        <RuntimeGlyph runtime={thread.runtime} size={13} className="shrink-0 opacity-75" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] leading-snug">{thread.name}</span>
            {thread.kind === "external" && (
              <span
                data-testid={`external-badge-${thread.id}`}
                className="inline-flex shrink-0 items-center gap-0.5 rounded bg-info-soft px-1 text-2xs text-info"
              >
                <Terminal className="h-2.5 w-2.5" />
                外部
              </span>
            )}
          </div>
          {thread.worktree_branch && (
            <div className="flex items-center gap-1 truncate font-mono text-2xs text-ink-faint">
              <GitBranch className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate">{thread.worktree_branch}</span>
            </div>
          )}
        </div>
        {pendingCount > 0 && (
          <span
            data-testid={`sidebar-approval-badge-${thread.id}`}
            className="shrink-0 animate-pulse rounded-full bg-warning-soft px-1.5 font-mono text-2xs font-medium text-warning tabular-nums"
          >
            {pendingCount}
          </span>
        )}
      </button>
    );
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
        className={`mobile-sidebar flex h-full w-[244px] shrink-0 flex-col bg-paper select-none ${
          mobileOpen ? "is-open" : ""
        }`}
      >
        {/* Quiet Linear workspace title row */}
        <div className="flex h-12 shrink-0 items-center justify-between px-3">
          <button
            type="button"
            onClick={() => selectAndClose({ kind: "graph" })}
            className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1 hover:bg-tile-hover transition-colors"
          >
            <span className="h-2 w-2 rounded-full bg-accent" />
            <span className="truncate text-[13.5px] font-semibold tracking-tight text-ink">
              Conflux
            </span>
          </button>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => onNewAgentForProject(projects[0]?.id ?? null)}
              title="新建 Agent 线程"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-muted hover:bg-tile-hover hover:text-ink transition-colors"
            >
              <Plus className="h-4 w-4" />
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

        <div className="flex-1 space-y-5 overflow-y-auto px-2 pb-3 pt-1">
          {/* Primary global navigation */}
          <nav className="space-y-0.5">
            <button
              type="button"
              data-testid="nav-graph-btn"
              onClick={() => selectAndClose({ kind: "graph" })}
              className={`flex h-7 w-full items-center gap-2 rounded-md px-2 text-[13px] transition-colors ${
                activeView.kind === "graph"
                  ? "bg-tile-active font-medium text-ink"
                  : "text-ink-muted hover:bg-tile-hover hover:text-ink"
              }`}
            >
              <Network className="h-3.5 w-3.5 shrink-0 opacity-75" />
              <span className="truncate">态势图谱</span>
              <span className="ml-auto text-2xs text-ink-faint tabular-nums">{threads.length}</span>
            </button>

            <button
              type="button"
              data-testid="nav-global-workflows-btn"
              onClick={() => selectAndClose({ kind: "workflow", projectId: null })}
              className={`flex h-7 w-full items-center gap-2 rounded-md px-2 text-[13px] transition-colors ${
                activeView.kind === "workflow" && activeView.projectId === null
                  ? "bg-tile-active font-medium text-ink"
                  : "text-ink-muted hover:bg-tile-hover hover:text-ink"
              }`}
            >
              <Workflow className="h-3.5 w-3.5 shrink-0 opacity-75" />
              <span className="truncate">工作流</span>
              {workflows.length > 0 && (
                <span className="ml-auto text-2xs text-ink-faint tabular-nums">
                  {workflows.length}
                </span>
              )}
            </button>

            {/* Global rooms */}
            <div className="pt-2">
              <div className="group flex items-center justify-between px-2 py-1">
                <span className="text-2xs font-medium text-ink-faint">协作房间</span>
                <button
                  type="button"
                  data-testid="new-global-room-btn"
                  onClick={() => onNewRoomClick(null)}
                  title="新建跨项目协作房间"
                  className="rounded p-0.5 text-ink-faint opacity-70 hover:bg-tile-hover hover:text-ink hover:opacity-100 transition-colors"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>
              {globalRooms.map((room) => {
                const active = activeView.kind === "room" && activeView.roomId === room.id;
                return (
                  <button
                    key={room.id}
                    type="button"
                    data-testid={`sidebar-room-${room.id}`}
                    onClick={() => selectAndClose({ kind: "room", roomId: room.id })}
                    className={`flex h-7 w-full items-center gap-2 rounded-md px-2 text-[13px] transition-colors ${
                      active
                        ? "bg-tile-active font-medium text-ink"
                        : "text-ink-muted hover:bg-tile-hover hover:text-ink"
                    }`}
                  >
                    <MessageSquareText className="h-3.5 w-3.5 shrink-0 opacity-75" />
                    <span className="truncate">{room.name}</span>
                    <span className="ml-auto text-2xs text-ink-faint tabular-nums">
                      {room.members.length}
                    </span>
                  </button>
                );
              })}
            </div>
          </nav>

          {/* Flat Linear Project Tree */}
          <section>
            <div className="mb-1 flex items-center justify-between px-2">
              <span className="text-2xs font-medium text-ink-faint">项目</span>
              <button
                type="button"
                data-testid="add-project-btn"
                onClick={onAddProjectClick}
                title="添加项目目录"
                className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-2xs text-ink-faint hover:bg-tile-hover hover:text-ink transition-colors"
              >
                <FolderPlus className="h-3 w-3" />
                <span>添加</span>
              </button>
            </div>

            {projects.length === 0 ? (
              <button
                type="button"
                onClick={onAddProjectClick}
                className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-xs text-ink-faint hover:bg-tile-hover hover:text-ink transition-colors"
              >
                <FolderPlus className="h-3.5 w-3.5" />
                <span>添加第一个项目目录</span>
              </button>
            ) : (
              <div className="space-y-1">
                {projects.map((project) => {
                  const isCollapsed = Boolean(collapsed[project.id]);
                  const projectThreads = threads.filter((t) => t.project_id === project.id);
                  const projectRooms = rooms.filter((r) => r.project_id === project.id);
                  const projectWorkflows = workflows.filter((w) => w.project_id === project.id);

                  return (
                    <div key={project.id} data-testid={`sidebar-project-${project.id}`}>
                      <div className="group flex h-7 items-center gap-0.5 rounded-md px-1 hover:bg-tile-hover transition-colors">
                        <button
                          type="button"
                          onClick={() =>
                            setCollapsed((prev) => ({ ...prev, [project.id]: !prev[project.id] }))
                          }
                          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                        >
                          {isCollapsed ? (
                            <ChevronRight className="h-3 w-3 shrink-0 text-ink-faint" />
                          ) : (
                            <ChevronDown className="h-3 w-3 shrink-0 text-ink-faint" />
                          )}
                          {project.is_git_repo ? (
                            <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
                          ) : (
                            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
                          )}
                          <span className="truncate text-[13px] font-medium text-ink">
                            {project.name}
                          </span>
                        </button>
                        <button
                          type="button"
                          data-testid={`project-new-agent-${project.id}`}
                          onClick={() => onNewAgentForProject(project.id)}
                          title="在此项目下新建 Agent"
                          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-faint opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-tile-active hover:text-ink transition-opacity"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                      </div>

                      {!isCollapsed && (
                        <div className="mt-0.5 space-y-0.5">
                          {projectThreads.length === 0 ? (
                            <button
                              type="button"
                              onClick={() => onNewAgentForProject(project.id)}
                              className="flex h-7 w-full items-center gap-1.5 rounded-md pl-6 pr-2 text-xs text-ink-faint hover:bg-tile-hover hover:text-ink"
                            >
                              <Plus className="h-3 w-3" />
                              <span>新建 Agent</span>
                            </button>
                          ) : (
                            projectThreads.map((t) => renderThreadRow(t, true))
                          )}

                          {projectRooms.map((room) => {
                            const active = activeView.kind === "room" && activeView.roomId === room.id;
                            return (
                              <button
                                key={room.id}
                                type="button"
                                data-testid={`sidebar-room-${room.id}`}
                                onClick={() => selectAndClose({ kind: "room", roomId: room.id })}
                                className={`flex h-7 w-full items-center gap-2 rounded-md pl-5 pr-2 text-xs transition-colors ${
                                  active
                                    ? "bg-tile-active font-medium text-ink"
                                    : "text-ink-muted hover:bg-tile-hover hover:text-ink"
                                }`}
                              >
                                <MessageSquareText className="h-3 w-3 shrink-0 opacity-75" />
                                <span className="truncate">{room.name}</span>
                              </button>
                            );
                          })}

                          {(projectWorkflows.length > 0 || projectThreads.length > 0) && (
                            <div className="flex items-center gap-2 pl-5 pt-0.5 text-2xs text-ink-faint">
                              <button
                                type="button"
                                onClick={() => onNewRoomClick(project.id)}
                                className="hover:text-ink transition-colors"
                              >
                                + 房间
                              </button>
                              <button
                                type="button"
                                onClick={() => selectAndClose({ kind: "workflow", projectId: project.id })}
                                className={`transition-colors ${
                                  activeView.kind === "workflow" && activeView.projectId === project.id
                                    ? "font-medium text-accent"
                                    : "hover:text-ink"
                                }`}
                              >
                                工作流{projectWorkflows.length > 0 ? ` (${projectWorkflows.length})` : ""}
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {unassignedThreads.length > 0 && (
            <section>
              <div className="mb-1 px-2 text-2xs font-medium text-ink-faint">其他线程</div>
              <div className="space-y-0.5">
                {unassignedThreads.map((t) => renderThreadRow(t, false))}
              </div>
            </section>
          )}
        </div>

        {/* Quiet status footer */}
        <div className="flex h-9 shrink-0 items-center justify-between border-t border-line/70 px-3 text-2xs text-ink-faint">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-success" />
            本地服务在线
          </span>
          <span className="font-mono tabular-nums">{threads.length} threads</span>
        </div>
      </aside>
    </>
  );
}
