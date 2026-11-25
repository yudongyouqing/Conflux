import { useEffect, useState } from "react";
import { ArrowRightLeft, ExternalLink, FolderPlus, GitBranch, GitPullRequest, MessageSquarePlus, Play, Square, Terminal, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import {
  useCreateProject,
  useResolveApproval,
  useTemplates,
  useThreadDetail,
  useWorkspaceTree,
} from "./hooks";
import { useLiveEvents } from "./use-live-events";
import { BUILTIN_THEMES, setActiveCustomTheme } from "./theme";
import { TopBar } from "./components/TopBar";
import { ProjectTreeSidebar, type ActiveView } from "./components/ProjectTreeSidebar";
import { NewAgentModal } from "./components/NewAgentModal";
import { AgentWorkbench } from "./components/AgentWorkbench";
import { RightInspector } from "./components/RightInspector";
import { RoomView } from "./components/RoomView";
import { WorkflowView } from "./components/WorkflowView";
import { GraphOverview } from "./components/GraphOverview";
import { SettingsView } from "./components/SettingsView";

const DARK_THEME_NAME = BUILTIN_THEMES[5].name;

function ActiveThreadInspector({
  threadId,
  allThreads,
  onOpenForkModal,
  onSelectThread,
}: {
  threadId: string;
  allThreads: ReturnType<typeof useWorkspaceTree>["data"] extends infer D
    ? D extends { threads: infer T }
      ? T
      : never
    : never;
  onOpenForkModal: () => void;
  onSelectThread: (threadId: string) => void;
}) {
  const qc = useQueryClient();
  const detail = useThreadDetail(threadId);
  const thread = detail.data?.thread;
  if (!thread) return null;

  return (
    <RightInspector
      thread={thread}
      checkpoints={detail.data?.checkpoints ?? []}
      allThreads={allThreads}
      onRollbackCheckpoint={async (cpId) => {
        await api.rollbackCheckpoint(thread.id, cpId);
        void qc.invalidateQueries({ queryKey: ["thread-detail", thread.id] });
        void qc.invalidateQueries({ queryKey: ["thread-git-status", thread.id] });
        void qc.invalidateQueries({ queryKey: ["thread-git-diff", thread.id] });
      }}
      onOpenForkModal={onOpenForkModal}
      onSelectThread={onSelectThread}
    />
  );
}

export default function App() {
  useLiveEvents(true);
  const qc = useQueryClient();
  const treeQuery = useWorkspaceTree();
  const templatesQuery = useTemplates();
  const createProject = useCreateProject();
  const resolveApproval = useResolveApproval();

  const projects = treeQuery.data?.projects ?? [];
  const threads = treeQuery.data?.threads ?? [];
  const rooms = treeQuery.data?.rooms ?? [];
  const workflows = treeQuery.data?.workflows ?? [];
  const pendingApprovals = treeQuery.data?.pending_approvals ?? [];
  const cliProbes = treeQuery.data?.cli_probes ?? [];
  const templates = templatesQuery.data?.templates ?? [];

  const [activeView, setActiveView] = useState<ActiveView>({ kind: "graph" });
  const [initializedSelection, setInitializedSelection] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth >= 1280 : true,
  );
  const [newAgentModal, setNewAgentModal] = useState<{ open: boolean; projectId: number | null }>({
    open: false,
    projectId: null,
  });
  const [forkModalOpen, setForkModalOpen] = useState(false);

  // Add project dialog (web fallback or manual path)
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [projectPathInput, setProjectPathInput] = useState("");
  const [projectNameInput, setProjectNameInput] = useState("");
  const [projectError, setProjectError] = useState<string | null>(null);

  // New room dialog
  const [newRoomState, setNewRoomState] = useState<{ open: boolean; projectId: number | null }>({
    open: false,
    projectId: null,
  });
  const [roomNameInput, setRoomNameInput] = useState("");
  const [roomMemberIds, setRoomMemberIds] = useState<string[]>([]);

  const [isDark, setIsDark] = useState<boolean>(() =>
    typeof document !== "undefined" ? document.documentElement.dataset.theme === "dark" : false,
  );

  // Auto-open first thread once data arrives
  useEffect(() => {
    if (initializedSelection || treeQuery.isLoading) return;
    if (threads.length > 0) {
      setActiveView({ kind: "thread", threadId: threads[0].id });
    }
    setInitializedSelection(true);
  }, [initializedSelection, treeQuery.isLoading, threads]);

  const applyThemeChoice = (themeName: string | null) => {
    setActiveCustomTheme(themeName);
    setIsDark(document.documentElement.dataset.theme === "dark");
  };

  const handleToggleTheme = () => {
    const nextDark = !isDark;
    setActiveCustomTheme(nextDark ? DARK_THEME_NAME : null);
    setIsDark(nextDark);
  };

  const handleAddProjectClick = async () => {
    const picker =
      window.confluxDesktop?.pickProjectDirectory ?? window.confluxDesktop?.pickDirectory;
    if (picker) {
      const picked = await picker();
      if (picked) {
        await createProject.mutateAsync({ root_path: picked });
        return;
      }
    }
    setProjectError(null);
    setAddProjectOpen(true);
  };

  const handleSubmitProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectPathInput.trim()) return;
    setProjectError(null);
    try {
      await createProject.mutateAsync({
        root_path: projectPathInput.trim(),
        name: projectNameInput.trim() || undefined,
      });
      setProjectPathInput("");
      setProjectNameInput("");
      setAddProjectOpen(false);
    } catch (err) {
      setProjectError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSubmitRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!roomNameInput.trim()) return;
    const res = await api.createRoom({
      name: roomNameInput.trim(),
      project_id: newRoomState.projectId,
      members: roomMemberIds,
    });
    setRoomNameInput("");
    setRoomMemberIds([]);
    setNewRoomState({ open: false, projectId: null });
    void qc.invalidateQueries({ queryKey: ["workspace-tree"] });
    setActiveView({ kind: "room", roomId: res.room.id });
  };

  const activeThread =
    activeView.kind === "thread"
      ? threads.find((x) => x.id === activeView.threadId) ?? null
      : null;

  const handleStopOrResumeActive = async () => {
    if (!activeThread) return;
    if (activeThread.state === "stopped" || activeThread.state === "error") {
      await api.resumeThread(activeThread.id);
    } else {
      await api.stopThread(activeThread.id);
    }
    void qc.invalidateQueries({ queryKey: ["workspace-tree"] });
    void qc.invalidateQueries({ queryKey: ["thread-detail", activeThread.id] });
  };

  // Compute unified TopBar breadcrumb & inline thread actions (single 44px bar, zero double headers)
  let breadcrumb = "态势图谱";
  let subtitle: string | null = null;
  if (activeView.kind === "thread") {
    const p = projects.find((x) => x.id === activeThread?.project_id);
    breadcrumb = activeThread ? `${p ? `${p.name} / ` : ""}${activeThread.name}` : "Agent 工作台";
    subtitle = activeThread?.workdir ?? null;
  } else if (activeView.kind === "room") {
    const r = rooms.find((x) => x.id === activeView.roomId);
    breadcrumb = r ? `协作房间 / ${r.name}` : "协作房间";
  } else if (activeView.kind === "workflow") {
    const p = projects.find((x) => x.id === activeView.projectId);
    breadcrumb = p ? `${p.name} / 工作流` : "工作流";
  } else if (activeView.kind === "settings") {
    breadcrumb = "设置";
  }

  const isStopped = activeThread?.state === "stopped" || activeThread?.state === "error";

  const threadLeftExtra = activeThread ? (
    <div className="hidden items-center gap-1.5 sm:flex">
      <span
        data-testid="workbench-thread-state"
        className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-2xs ${
          activeThread.state === "running"
            ? "bg-accent-soft text-accent"
            : activeThread.state === "waiting_approval"
              ? "bg-warning-soft text-warning"
              : activeThread.state === "idle"
                ? "bg-success-soft text-success"
                : activeThread.state === "error"
                  ? "bg-danger-soft text-danger"
                  : "bg-neutral-soft text-neutral"
        }`}
      >
        {activeThread.state}
      </span>
      {activeThread.kind === "external" && (
        <span className="inline-flex items-center gap-1 rounded bg-info-soft px-1.5 py-0.5 text-2xs text-info">
          <Terminal className="h-3 w-3" />
          外部终端
        </span>
      )}
      {activeThread.worktree_branch && (
        <span className="inline-flex max-w-[180px] items-center gap-1 truncate rounded bg-tile px-1.5 py-0.5 font-mono text-2xs text-ink-faint">
          <GitBranch className="h-3 w-3 shrink-0" />
          <span className="truncate">{activeThread.worktree_branch}</span>
        </span>
      )}
      {activeThread.pr_url && (
        <a
          href={activeThread.pr_url}
          target="_blank"
          rel="noreferrer"
          data-testid="topbar-pr-link"
          className="inline-flex items-center gap-1 rounded bg-accent-soft px-1.5 py-0.5 font-mono text-2xs font-medium text-accent hover:underline"
        >
          <GitPullRequest className="h-3 w-3 shrink-0" />
          <span>{activeThread.pr_url.match(/\/pull\/(\d+)/)?.[1] ? `PR #${activeThread.pr_url.match(/\/pull\/(\d+)/)![1]}` : "PR"}</span>
          <ExternalLink className="h-2.5 w-2.5 shrink-0" />
        </a>
      )}
    </div>
  ) : null;

  const threadRightExtra = activeThread ? (
    <div className="hidden items-center gap-0.5 sm:flex">
      <button
        type="button"
        data-testid="workbench-fork-btn"
        onClick={() => setForkModalOpen(true)}
        title="原地换引擎接力 (Fork & Handoff)"
        className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-ink-muted hover:bg-tile-hover hover:text-ink transition-colors"
      >
        <ArrowRightLeft className="h-3.5 w-3.5" />
        <span className="hidden lg:inline">接力</span>
      </button>
      {activeThread.kind === "managed" && (
        <button
          type="button"
          data-testid="workbench-stop-resume-btn"
          onClick={() => void handleStopOrResumeActive()}
          title={isStopped ? "恢复进程" : "停止进程"}
          className={`inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs transition-colors ${
            isStopped
              ? "bg-success-soft text-success"
              : "text-ink-muted hover:bg-tile-hover hover:text-danger"
          }`}
        >
          {isStopped ? (
            <>
              <Play className="h-3 w-3" />
              <span className="hidden lg:inline">恢复</span>
            </>
          ) : (
            <>
              <Square className="h-3 w-3" />
              <span className="hidden lg:inline">停止</span>
            </>
          )}
        </button>
      )}
      <span className="mx-1 h-4 w-px bg-line" />
    </div>
  ) : null;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-paper text-ink">
      <ProjectTreeSidebar
        projects={projects}
        threads={threads}
        rooms={rooms}
        workflows={workflows}
        activeView={activeView}
        mobileOpen={mobileSidebarOpen}
        onCloseMobile={() => setMobileSidebarOpen(false)}
        onSelectView={setActiveView}
        onAddProjectClick={() => void handleAddProjectClick()}
        onNewAgentForProject={(projectId) => setNewAgentModal({ open: true, projectId })}
        onNewRoomClick={(projectId) => {
          setRoomMemberIds(
            threads
              .filter((t) => projectId === null || t.project_id === projectId)
              .slice(0, 4)
              .map((t) => t.id),
          );
          setNewRoomState({ open: true, projectId });
        }}
      />

      {/* Linear inset workspace frame */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden md:py-2 md:pr-2">
        <div className="workspace-frame flex min-h-0 flex-1 flex-col overflow-hidden bg-surface md:rounded-[10px] md:border md:border-line">
          <TopBar
            breadcrumb={breadcrumb}
            subtitle={subtitle}
            leftExtra={threadLeftExtra}
            rightExtra={threadRightExtra}
            pendingApprovals={pendingApprovals}
            isDark={isDark}
            onToggleTheme={handleToggleTheme}
            onOpenNewAgent={() =>
              setNewAgentModal({
                open: true,
                projectId:
                  activeView.kind === "thread"
                    ? (activeThread?.project_id ?? projects[0]?.id ?? null)
                    : (projects[0]?.id ?? null),
              })
            }
            onOpenSettings={() => setActiveView({ kind: "settings" })}
            onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
            showInspectorToggle={activeView.kind === "thread"}
            inspectorOpen={inspectorOpen}
            onToggleInspector={() => setInspectorOpen((v) => !v)}
            onResolveApproval={(params) => resolveApproval.mutateAsync(params)}
            onSelectThread={(threadId) => setActiveView({ kind: "thread", threadId })}
          />

          <main className="relative flex min-h-0 flex-1 overflow-hidden">
            {activeView.kind === "thread" && (
              <>
                <AgentWorkbench
                  threadId={activeView.threadId}
                  cliProbes={cliProbes}
                  allThreads={threads}
                  onResolveApproval={(params) => resolveApproval.mutateAsync(params)}
                  onSelectThread={(threadId) => setActiveView({ kind: "thread", threadId })}
                  forkModalOpen={forkModalOpen}
                  onSetForkModalOpen={setForkModalOpen}
                />
                {inspectorOpen && (
                  <ActiveThreadInspector
                    threadId={activeView.threadId}
                    allThreads={threads}
                    onOpenForkModal={() => setForkModalOpen(true)}
                    onSelectThread={(threadId) => setActiveView({ kind: "thread", threadId })}
                  />
                )}
              </>
            )}

            {activeView.kind === "room" && (
              <RoomView
                roomId={activeView.roomId}
                allThreads={threads}
                onSelectThread={(threadId) => setActiveView({ kind: "thread", threadId })}
                onResolveApproval={(params) => resolveApproval.mutateAsync(params)}
              />
            )}

            {activeView.kind === "workflow" && (
              <WorkflowView
                projectId={activeView.projectId}
                workflows={workflows}
                allThreads={threads}
                onSelectThread={(threadId) => setActiveView({ kind: "thread", threadId })}
              />
            )}

            {activeView.kind === "graph" && (
              <GraphOverview
                onSelectThread={(threadId) => setActiveView({ kind: "thread", threadId })}
                onNewAgentClick={() =>
                  setNewAgentModal({ open: true, projectId: projects[0]?.id ?? null })
                }
              />
            )}

            {activeView.kind === "settings" && (
              <SettingsView cliProbes={cliProbes} onSelectTheme={applyThemeChoice} />
            )}
          </main>
        </div>
      </div>

      {/* Modals */}
      <NewAgentModal
        open={newAgentModal.open}
        onClose={() => setNewAgentModal({ open: false, projectId: null })}
        projects={projects}
        defaultProjectId={newAgentModal.projectId}
        cliProbes={cliProbes}
        templates={templates}
        onCreated={(thread) => {
          void qc.invalidateQueries({ queryKey: ["workspace-tree"] });
          setActiveView({ kind: "thread", threadId: thread.id });
        }}
      />

      {addProjectOpen && (
        <div
          data-testid="add-project-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4"
        >
          <div className="w-full max-w-md rounded-xl border border-line-strong bg-surface p-4 shadow-overlay">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-[13.5px] font-semibold text-ink">
                <FolderPlus className="h-4 w-4 text-ink-muted" />
                添加项目目录
              </h2>
              <button
                type="button"
                onClick={() => setAddProjectOpen(false)}
                className="rounded-md p-1 text-ink-muted hover:bg-tile-hover"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={(e) => void handleSubmitProject(e)} className="mt-3.5 space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-ink-muted">目录路径</label>
                <input
                  type="text"
                  required
                  data-testid="add-project-path-input"
                  value={projectPathInput}
                  onChange={(e) => setProjectPathInput(e.target.value)}
                  placeholder="C:\Project folder\my-project"
                  className="w-full rounded-md border border-line bg-paper/60 px-2.5 py-1.5 font-mono text-xs text-ink focus:border-accent focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-ink-muted">显示名称（可选）</label>
                <input
                  type="text"
                  value={projectNameInput}
                  onChange={(e) => setProjectNameInput(e.target.value)}
                  placeholder="留空默认目录名"
                  className="w-full rounded-md border border-line bg-paper/60 px-2.5 py-1.5 text-xs text-ink focus:border-accent focus:outline-none"
                />
              </div>
              {projectError && <div className="text-xs text-danger">{projectError}</div>}
              <div className="flex justify-end gap-2 border-t border-line pt-3">
                <button
                  type="button"
                  onClick={() => setAddProjectOpen(false)}
                  className="rounded-md px-3 py-1.5 text-xs text-ink-muted hover:bg-tile-hover"
                >
                  取消
                </button>
                <button
                  type="submit"
                  data-testid="add-project-submit-btn"
                  className="rounded-md bg-accent px-3.5 py-1.5 text-xs font-medium text-on-accent hover:bg-accent-deep"
                >
                  添加
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {newRoomState.open && (
        <div
          data-testid="new-room-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4"
        >
          <div className="w-full max-w-md rounded-xl border border-line-strong bg-surface p-4 shadow-overlay">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-[13.5px] font-semibold text-ink">
                <MessageSquarePlus className="h-4 w-4 text-ink-muted" />
                新建{newRoomState.projectId === null ? "跨项目" : "项目"}房间
              </h2>
              <button
                type="button"
                onClick={() => setNewRoomState({ open: false, projectId: null })}
                className="rounded-md p-1 text-ink-muted hover:bg-tile-hover"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={(e) => void handleSubmitRoom(e)} className="mt-3.5 space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-ink-muted">房间名称</label>
                <input
                  type="text"
                  required
                  value={roomNameInput}
                  onChange={(e) => setRoomNameInput(e.target.value)}
                  placeholder="例如：架构联调室"
                  className="w-full rounded-md border border-line bg-paper/60 px-2.5 py-1.5 text-xs text-ink focus:border-accent focus:outline-none"
                />
              </div>
              {threads.length > 0 && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-ink-muted">初始成员</label>
                  <div className="max-h-36 space-y-0.5 overflow-y-auto rounded-md border border-line bg-paper/60 p-1.5">
                    {threads.map((t) => {
                      const checked = roomMemberIds.includes(t.id);
                      return (
                        <label
                          key={t.id}
                          className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs text-ink hover:bg-tile-hover"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) =>
                              setRoomMemberIds((prev) =>
                                e.target.checked
                                  ? [...prev, t.id]
                                  : prev.filter((id) => id !== t.id),
                              )
                            }
                          />
                          <span>{t.name}</span>
                          <span className="ml-auto font-mono text-2xs text-ink-faint">
                            {t.runtime}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
              <div className="flex justify-end gap-2 border-t border-line pt-3">
                <button
                  type="button"
                  onClick={() => setNewRoomState({ open: false, projectId: null })}
                  className="rounded-md px-3 py-1.5 text-xs text-ink-muted hover:bg-tile-hover"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="rounded-md bg-accent px-3.5 py-1.5 text-xs font-medium text-on-accent hover:bg-accent-deep"
                >
                  创建
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
