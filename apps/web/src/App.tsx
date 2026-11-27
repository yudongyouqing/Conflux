import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  Columns2,
  Folder,
  GitBranch,
  Globe,
  MessageSquare,
  Terminal,
  Users,
  X,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import type { IncomingCallMode } from "@conflux/shared";
import { api } from "./api";
import {
  useGraph,
  useMeshCalls,
  useNetworkInfo,
  useThreadGitStatus,
  useThreadPrDetail,
  useWorkspaceTree,
} from "./hooks";
import { useLiveEvents } from "./use-live-events";
import { BUILTIN_THEMES, setActiveCustomTheme } from "./theme";
import { ActivityRail, type MainScreen } from "./components/ActivityRail";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { AgentWorkbench } from "./components/AgentWorkbench";
import { PaseoToolPane, type PaseoToolTab } from "./components/PaseoToolPane";
import {
  incomingModeClass,
  incomingModeLabel,
  LiveMeshGraph,
} from "./components/LiveMeshGraph";
import { NewWorkspaceModal } from "./components/NewWorkspaceModal";
import {
  CallHistoryModal,
  ConnectRemoteModal,
} from "./components/ConnectAndHistoryModals";
import { CommandPalette } from "./components/CommandPalette";
import { SettingsView } from "./components/SettingsView";

const PASEO_DARK_THEME = BUILTIN_THEMES[0].name;
const PASEO_LIGHT_THEME = BUILTIN_THEMES[1].name;
const SPLIT_RATIO_STORAGE_KEY = "conflux.split-ratio";
const MIN_SPLIT_PCT = 28;
const MAX_SPLIT_PCT = 72;

type SingleToolTab = Exclude<PaseoToolTab, "peer">;
type LeftTab = "chat" | SingleToolTab;

function clampSplitPct(value: number): number {
  if (!Number.isFinite(value)) return 49;
  return Math.min(MAX_SPLIT_PCT, Math.max(MIN_SPLIT_PCT, Math.round(value * 10) / 10));
}

function loadInitialSplitPct(): number {
  try {
    const raw = window.localStorage.getItem(SPLIT_RATIO_STORAGE_KEY);
    if (!raw) return 49;
    return clampSplitPct(Number(raw));
  } catch {
    return 49;
  }
}

function nextCallMode(m: IncomingCallMode): IncomingCallMode {
  if (m === "auto") return "ask";
  if (m === "ask") return "dnd";
  return "auto";
}

function shortDirName(workdir: string): string {
  const cleaned = workdir.replace(/[\\/]+$/, "");
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || cleaned;
}

export default function App() {
  useLiveEvents(true);
  const qc = useQueryClient();

  const treeQuery = useWorkspaceTree();
  const graphQuery = useGraph();
  const networkQuery = useNetworkInfo();
  const activeCallsQuery = useMeshCalls("active");
  const allCallsQuery = useMeshCalls("all");
  const historyCallsQuery = useMeshCalls("history");

  const projects = treeQuery.data?.projects ?? [];
  const threads = treeQuery.data?.threads ?? [];
  const cliProbes = treeQuery.data?.cli_probes ?? [];
  const activeCalls = activeCallsQuery.data?.calls ?? [];
  const allCalls = allCallsQuery.data?.calls ?? [];
  const historyCalls = historyCallsQuery.data?.calls ?? [];
  const network = networkQuery.data;
  const localHostname = network?.hostname ?? "localhost";

  const [screen, setScreen] = useState<MainScreen>("workspace");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [companionThreadId, setCompanionThreadId] = useState<string | null>(null);
  const [isSplit, setIsSplit] = useState(true);
  const [leftTab, setLeftTab] = useState<LeftTab>("chat");
  const [rightTool, setRightTool] = useState<PaseoToolTab>("git");
  const [splitPct, setSplitPct] = useState<number>(() => loadInitialSplitPct());
  const [isResizingSplit, setIsResizingSplit] = useState(false);
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const splitPctRef = useRef<number>(splitPct);
  splitPctRef.current = splitPct;
  const [forkModalOpen, setForkModalOpen] = useState(false);
  const [companionForkModalOpen, setCompanionForkModalOpen] = useState(false);

  const [newWsModal, setNewWsModal] = useState<{ open: boolean; prefillDir?: string }>({
    open: false,
  });
  const [connectOpen, setConnectOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const [isDark, setIsDark] = useState<boolean>(() =>
    typeof document !== "undefined" ? document.documentElement.dataset.theme !== "light" : true,
  );

  // Auto-select first local managed workspace (falling back to first live peer)
  useEffect(() => {
    if (activeThreadId && threads.some((t) => t.id === activeThreadId)) return;
    if (threads.length > 0) {
      const preferred = threads.find((t) => t.kind === "managed") ?? threads[0];
      setActiveThreadId(preferred.id);
    }
  }, [activeThreadId, threads]);

  // Keep companion peer thread pointed at a different live workspace when available
  useEffect(() => {
    const others = threads.filter((t) => t.id !== activeThreadId);
    if (others.length === 0) {
      if (companionThreadId !== null) setCompanionThreadId(null);
      return;
    }
    if (!companionThreadId || !others.some((t) => t.id === companionThreadId)) {
      setCompanionThreadId(others[0].id);
    }
  }, [threads, activeThreadId, companionThreadId]);

  // Global ⌘B / Ctrl+B (sidebar) and ⌘K / Ctrl+K (command palette) shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key === "b") {
        e.preventDefault();
        setSidebarCollapsed((v) => !v);
      } else if (key === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleStartSplitResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !splitContainerRef.current) return;
    e.preventDefault();
    const container = splitContainerRef.current;
    setIsResizingSplit(true);

    const onPointerMove = (ev: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return;
      const rightPx = rect.right - ev.clientX;
      const pct = clampSplitPct((rightPx / rect.width) * 100);
      setSplitPct(pct);
    };

    const onPointerUp = () => {
      setIsResizingSplit(false);
      try {
        window.localStorage.setItem(SPLIT_RATIO_STORAGE_KEY, String(splitPctRef.current));
      } catch {
        // ignore storage quota failures
      }
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }, []);

  const handleResetSplitRatio = useCallback(() => {
    setSplitPct(50);
    try {
      window.localStorage.setItem(SPLIT_RATIO_STORAGE_KEY, "50");
    } catch {
      // ignore storage quota failures
    }
  }, []);

  const activeThread = useMemo(
    () => threads.find((t) => t.id === activeThreadId) ?? null,
    [threads, activeThreadId],
  );

  const companionPeers = useMemo(
    () => threads.filter((t) => t.id !== activeThreadId),
    [threads, activeThreadId],
  );

  const companionThread = useMemo(
    () => companionPeers.find((t) => t.id === companionThreadId) ?? companionPeers[0] ?? null,
    [companionPeers, companionThreadId],
  );

  const gitStatus = useThreadGitStatus(activeThread?.id ?? null);
  const prDetail = useThreadPrDetail(activeThread?.id ?? null);

  const changedCount = gitStatus.data?.files.length ?? 0;
  const diffTotals = useMemo(() => {
    let add = 0;
    let del = 0;
    for (const f of gitStatus.data?.files ?? []) {
      add += f.additions ?? 0;
      del += f.deletions ?? 0;
    }
    return { add, del };
  }, [gitStatus.data]);

  const previewPortLabel = useMemo(() => {
    const url = activeThread?.preview_url;
    if (!url) return "";
    const m = url.match(/:(\d{2,5})/);
    return m ? ` :${m[1]}` : "";
  }, [activeThread?.preview_url]);

  const handleToggleTheme = () => {
    const nextDark = !isDark;
    setActiveCustomTheme(nextDark ? PASEO_DARK_THEME : PASEO_LIGHT_THEME);
    setIsDark(nextDark);
  };

  const handleApplyThemeChoice = (themeName: string | null) => {
    setActiveCustomTheme(themeName);
    setIsDark(document.documentElement.dataset.theme !== "light");
  };

  const handleEnterWorkspace = (threadId: string) => {
    setActiveThreadId(threadId);
    setScreen("workspace");
    if (isSplit) setLeftTab("chat");
  };

  const handleToggleSplit = (force?: boolean) => {
    const next = typeof force === "boolean" ? force : !isSplit;
    setIsSplit(next);
    if (next) {
      setLeftTab("chat");
    }
  };

  const handleCycleActiveCallMode = async () => {
    if (!activeThread) return;
    const next = nextCallMode(activeThread.incoming_call_mode ?? "auto");
    await api.setIncomingCallMode(activeThread.id, next);
    void qc.invalidateQueries({ queryKey: ["workspace-tree"] });
    void qc.invalidateQueries({ queryKey: ["graph"] });
  };

  const handleSendPromptToActiveAgent = async (promptText: string) => {
    if (!activeThread || !promptText.trim()) return;
    if (activeThread.kind === "external") {
      await api.createMeshCall({ to_thread: activeThread.id, question: promptText.trim() });
    } else {
      await api.sendPrompt(activeThread.id, { prompt: promptText.trim(), delivery_mode: "queue" });
    }
    if (!isSplit) setLeftTab("chat");
    void qc.invalidateQueries({ queryKey: ["thread-detail", activeThread.id] });
    void qc.invalidateQueries({ queryKey: ["thread-events", activeThread.id] });
    void qc.invalidateQueries({ queryKey: ["mesh-calls"] });
  };

  const handleOpenCompanionPeer = (threadId: string) => {
    setScreen("workspace");
    if (threadId === activeThreadId) {
      return;
    }
    setCompanionThreadId(threadId);
    setIsSplit(true);
    setLeftTab("chat");
    setRightTool("peer");
  };

  const handleSelectToolFromPalette = (tool: PaseoToolTab) => {
    setScreen("workspace");
    if (tool === "peer") {
      setIsSplit(true);
      setLeftTab("chat");
      setRightTool("peer");
      return;
    }
    if (isSplit) {
      setRightTool(tool);
    } else {
      setLeftTab(tool);
    }
  };

  const baseToolTabDefs: Array<{
    id: SingleToolTab;
    label: string;
    icon: typeof GitBranch;
  }> = [
    {
      id: "git",
      label: changedCount > 0 ? `Git & PR (${changedCount})` : "Git & PR",
      icon: GitBranch,
    },
    { id: "term", label: "终端", icon: Terminal },
    { id: "files", label: "文件", icon: Folder },
    { id: "preview", label: `预览${previewPortLabel}`, icon: Globe },
  ];

  const splitToolTabDefs: Array<{
    id: PaseoToolTab;
    label: string;
    icon: typeof GitBranch;
  }> = [
    ...baseToolTabDefs,
    {
      id: "peer",
      label: companionPeers.length > 0 ? `同伴 (${companionPeers.length})` : "同伴",
      icon: Users,
    },
  ];

  const prChecksSummary = useMemo(() => {
    const pr = prDetail.data?.pr;
    if (!pr) return null;
    const passed = pr.checks.filter((c) => c.status === "pass").length;
    return { number: pr.number, passed, total: pr.checks.length };
  }, [prDetail.data]);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-rail text-ink">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* 1. Far-Left 46px Paseo Activity Rail */}
        <ActivityRail
          screen={screen}
          activeCallCount={activeCalls.length}
          sidebarCollapsed={sidebarCollapsed}
          onSelectScreen={setScreen}
          onOpenCommandPalette={() => setPaletteOpen(true)}
          onOpenHistory={() => setHistoryOpen(true)}
          onOpenConnect={() => setConnectOpen(true)}
          onToggleTheme={handleToggleTheme}
          onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
        />

        {/* 2. Smooth Collapsible 272px Host -> Dir -> Workspace Sidebar */}
        <WorkspaceSidebar
          collapsed={sidebarCollapsed}
          projects={projects}
          threads={threads}
          activeCalls={activeCalls}
          activeThreadId={activeThreadId}
          localHostname={localHostname}
          onSelectThread={handleEnterWorkspace}
          onOpenNewWorkspace={(prefillDir) => setNewWsModal({ open: true, prefillDir })}
        />

        {/* 3. Main Area */}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-surface">
          {/* SCREEN A: FULL PASEO WORKSPACE (ZERO DUPLICATE TABS) */}
          {screen === "workspace" && (
            <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {/* Top 40px IDE Tab Bar */}
              <header className="flex h-10 shrink-0 items-stretch justify-between gap-2 border-b border-line bg-paper pr-3">
                <div
                  data-testid="workspace-top-tabstrip"
                  className="flex min-w-0 items-stretch overflow-x-auto"
                >
                  <div className="flex shrink-0 items-center gap-2 border-r border-line px-3 text-xs text-ink-muted">
                    <strong className="font-semibold text-ink">
                      {activeThread ? activeThread.name : "未选择工作区"}
                    </strong>
                    {activeThread && (
                      <span className="hidden font-mono text-2xs text-ink-faint sm:inline">
                        {shortDirName(activeThread.workdir)} /{" "}
                        {activeThread.worktree_branch || activeThread.base_branch || activeThread.runtime}
                      </span>
                    )}
                  </div>

                  {/* Chat tab always shown */}
                  <button
                    type="button"
                    data-testid="top-tab-chat"
                    onClick={() => setLeftTab("chat")}
                    className={`inline-flex items-center gap-1.5 whitespace-nowrap border-r border-line border-t-2 px-3 text-xs transition-colors ${
                      leftTab === "chat"
                        ? "border-t-ink bg-surface font-semibold text-ink"
                        : "border-t-transparent text-ink-faint hover:bg-tile-hover hover:text-ink"
                    }`}
                  >
                    <MessageSquare className="h-3.5 w-3.5" />
                    <span>对话</span>
                  </button>

                  {/* Zero duplicate tabs: tool tabs appear in top bar ONLY when split is OFF */}
                  {!isSplit &&
                    activeThread &&
                    baseToolTabDefs.map((tab) => {
                      const Icon = tab.icon;
                      const active = leftTab === tab.id;
                      return (
                        <button
                          key={tab.id}
                          type="button"
                          data-testid={`top-tab-${tab.id}`}
                          onClick={() => setLeftTab(tab.id)}
                          className={`inline-flex items-center gap-1.5 whitespace-nowrap border-r border-line border-t-2 px-3 text-xs transition-colors ${
                            active
                              ? "border-t-ink bg-surface font-semibold text-ink"
                              : "border-t-transparent text-ink-faint hover:bg-tile-hover hover:text-ink"
                          }`}
                        >
                          <Icon className="h-3.5 w-3.5" />
                          <span>{tab.label}</span>
                        </button>
                      );
                    })}
                </div>

                {/* Right Controls: Per-node Incoming Call Mode + Split Toggle */}
                {activeThread && (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      data-testid="topbar-call-mode-btn"
                      title="仅控制他人来电策略，不影响主动外呼"
                      onClick={() => void handleCycleActiveCallMode()}
                      className={`h-6 rounded-full border px-2.5 text-2xs font-medium transition-colors ${incomingModeClass(
                        activeThread.incoming_call_mode ?? "auto",
                      )}`}
                    >
                      {incomingModeLabel(activeThread.incoming_call_mode ?? "auto", true)}
                    </button>

                    <button
                      type="button"
                      data-testid="split-toggle-btn"
                      onClick={() => handleToggleSplit()}
                      className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-3 text-2xs transition-colors ${
                        isSplit
                          ? "border-line-strong bg-tile-active font-semibold text-ink"
                          : "border-line-strong bg-elev text-ink-muted hover:text-ink"
                      }`}
                    >
                      <Columns2 className="h-3.5 w-3.5" />
                      <span>{isSplit ? "分屏已开" : "开启分屏"}</span>
                    </button>
                  </div>
                )}
              </header>

              {/* Workspace Split Container */}
              {!activeThread ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
                  <div className="text-sm font-semibold text-ink">还没有打开的工作区</div>
                  <p className="max-w-md text-xs text-ink-faint">
                    点击左侧「+ 新建」选择一个本地目录（支持直连、Worktree 新分支或检出 PR），即可进入全量 Paseo 对话 + Git/PR + 终端 + 文件 + 预览工作区。
                  </p>
                  <button
                    type="button"
                    onClick={() => setNewWsModal({ open: true })}
                    className="h-8 rounded-md bg-accent px-4 text-xs font-semibold text-on-accent hover:bg-accent-deep"
                  >
                    + 新建工作区
                  </button>
                </div>
              ) : (
                <div ref={splitContainerRef} className="flex min-h-0 flex-1 overflow-hidden">
                  {/* LEFT PANE */}
                  <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-surface">
                    <AgentWorkbench
                      threadId={activeThread.id}
                      cliProbes={cliProbes}
                      allThreads={threads}
                      peerCalls={allCalls}
                      onResolveApproval={(params) =>
                        api.resolveApproval(params.threadId, params.approvalId, {
                          decision: params.decision,
                          option_id: params.option_id,
                          answers: params.answers,
                        }).then(() => {
                          void qc.invalidateQueries({ queryKey: ["workspace-tree"] });
                          void qc.invalidateQueries({ queryKey: ["thread-detail", params.threadId] });
                        })
                      }
                      onSelectThread={handleEnterWorkspace}
                      onOpenGraph={() => setScreen("graph")}
                      forkModalOpen={forkModalOpen}
                      onSetForkModalOpen={setForkModalOpen}
                      hidden={!isSplit && leftTab !== "chat"}
                    />

                    {!isSplit && leftTab !== "chat" && (
                      <PaseoToolPane
                        thread={activeThread}
                        tool={leftTab}
                        layout="full"
                        onSendPromptToAgent={handleSendPromptToActiveAgent}
                      />
                    )}
                  </div>

                  {/* DRAGGABLE RESIZE HANDLE */}
                  {isSplit && (
                    <div
                      role="separator"
                      aria-orientation="vertical"
                      aria-label="拖拽调整分屏比例，双击恢复 50/50"
                      title="拖拽调整分屏比例（双击恢复 50/50）"
                      data-testid="split-resize-handle"
                      onPointerDown={handleStartSplitResize}
                      onDoubleClick={handleResetSplitRatio}
                      className={`group relative z-10 flex w-1.5 shrink-0 cursor-col-resize select-none items-center justify-center transition-colors ${
                        isResizingSplit ? "bg-accent/40" : "bg-transparent hover:bg-line-strong"
                      }`}
                    >
                      <span
                        className={`h-8 w-[2px] rounded-full transition-colors ${
                          isResizingSplit
                            ? "bg-accent"
                            : "bg-line group-hover:bg-ink-faint"
                        }`}
                      />
                    </div>
                  )}

                  {/* RIGHT RESIZABLE SPLIT PANE (Owns Git & PR | Terminal | Files | Preview | Companion Peer) */}
                  <div
                    data-testid="paseo-split-right"
                    data-open={isSplit ? "true" : "false"}
                    style={{ ["--split-w" as string]: `${splitPct}%` }}
                    className={`paseo-split-right flex shrink-0 flex-col bg-paper ${
                      isResizingSplit ? "is-resizing" : ""
                    }`}
                  >
                    <div className="flex h-9 shrink-0 items-center justify-between border-b border-line bg-rail px-2">
                      <div className="flex items-center gap-1 overflow-x-auto">
                        {splitToolTabDefs.map((tab) => {
                          const Icon = tab.icon;
                          const active = rightTool === tab.id;
                          return (
                            <button
                              key={tab.id}
                              type="button"
                              data-testid={`split-tab-${tab.id}`}
                              onClick={() => setRightTool(tab.id)}
                              className={`inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-2xs transition-colors ${
                                active
                                  ? "bg-elev font-semibold text-ink"
                                  : "text-ink-faint hover:bg-tile-hover hover:text-ink"
                              }`}
                            >
                              <Icon className="h-3.5 w-3.5" />
                              <span>{tab.label}</span>
                            </button>
                          );
                        })}
                      </div>
                      <button
                        type="button"
                        title="关闭分屏"
                        onClick={() => handleToggleSplit(false)}
                        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-faint hover:bg-tile-hover hover:text-ink"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    {isSplit && rightTool !== "peer" && (
                      <PaseoToolPane
                        thread={activeThread}
                        tool={rightTool}
                        layout="split"
                        onSendPromptToAgent={handleSendPromptToActiveAgent}
                      />
                    )}

                    {isSplit && rightTool === "peer" && (
                      <div
                        data-testid="companion-peer-pane"
                        className="flex min-h-0 flex-1 flex-col overflow-hidden bg-surface"
                      >
                        {companionThread ? (
                          <>
                            <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-line bg-paper px-2.5">
                              <div className="flex min-w-0 items-center gap-1.5">
                                <span className="text-2xs text-ink-faint">同伴</span>
                                <select
                                  data-testid="companion-peer-select"
                                  value={companionThread.id}
                                  onChange={(e) => setCompanionThreadId(e.target.value)}
                                  className="h-6 max-w-[220px] rounded border border-line-strong bg-elev px-1.5 text-2xs font-medium text-ink focus:outline-none"
                                >
                                  {companionPeers.map((peer) => (
                                    <option key={peer.id} value={peer.id}>
                                      {peer.name} · {peer.host || localHostname}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <button
                                type="button"
                                data-testid="companion-promote-btn"
                                title="将该同伴切换到左侧主工作区"
                                onClick={() => handleEnterWorkspace(companionThread.id)}
                                className="inline-flex h-6 shrink-0 items-center gap-1 rounded border border-line bg-elev px-2 text-2xs text-ink-muted hover:border-line-strong hover:text-ink"
                              >
                                <span>设为主工作区</span>
                                <ArrowUpRight className="h-3 w-3" />
                              </button>
                            </div>
                            <AgentWorkbench
                              threadId={companionThread.id}
                              cliProbes={cliProbes}
                              allThreads={threads}
                              peerCalls={allCalls}
                              onResolveApproval={(params) =>
                                api.resolveApproval(params.threadId, params.approvalId, {
                                  decision: params.decision,
                                  option_id: params.option_id,
                                  answers: params.answers,
                                }).then(() => {
                                  void qc.invalidateQueries({ queryKey: ["workspace-tree"] });
                                  void qc.invalidateQueries({ queryKey: ["thread-detail", params.threadId] });
                                })
                              }
                              onSelectThread={handleEnterWorkspace}
                              onOpenGraph={() => setScreen("graph")}
                              forkModalOpen={companionForkModalOpen}
                              onSetForkModalOpen={setCompanionForkModalOpen}
                            />
                          </>
                        ) : (
                          <div className="flex flex-1 flex-col items-center justify-center gap-2.5 p-6 text-center">
                            <div className="text-xs font-semibold text-ink">还没有其他在线同伴</div>
                            <p className="max-w-xs text-2xs text-ink-faint">
                              新建第二个本地工作区，或接入远程 Mac / Linux 上的 Agent，即可在这里双屏并行查看对话与互调。
                            </p>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => setNewWsModal({ open: true })}
                                className="h-7 rounded-md bg-accent px-3 text-2xs font-semibold text-on-accent hover:bg-accent-deep"
                              >
                                + 新建工作区
                              </button>
                              <button
                                type="button"
                                onClick={() => setConnectOpen(true)}
                                className="h-7 rounded-md border border-line-strong bg-elev px-3 text-2xs text-ink-muted hover:text-ink"
                              >
                                接入远程 Agent
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </section>
          )}

          {/* SCREEN B: CONFLUX LIVE MCP TOPOLOGY GRAPH */}
          {screen === "graph" && (
            <LiveMeshGraph
              graph={graphQuery.data ?? { nodes: [], edges: [] }}
              activeCalls={activeCalls}
              allCalls={allCalls}
              localHostname={localHostname}
              onEnterWorkspace={handleEnterWorkspace}
            />
          )}

          {/* SCREEN C: SETTINGS */}
          {screen === "settings" && (
            <SettingsView cliProbes={cliProbes} onSelectTheme={handleApplyThemeChoice} />
          )}
        </main>
      </div>

      {/* 4. Bottom 24px Native Paseo Status Bar */}
      <footer
        data-testid="paseo-statusbar"
        className="flex h-6 shrink-0 select-none items-center justify-between gap-4 border-t border-line bg-rail px-2.5 font-mono text-2xs text-ink-faint"
      >
        <div className="flex items-center gap-3 overflow-hidden">
          <span className="truncate">
            ⎇ {gitStatus.data?.branch || activeThread?.worktree_branch || activeThread?.base_branch || "—"}
          </span>
          {(diffTotals.add > 0 || diffTotals.del > 0) && (
            <span>
              <span className="text-success">+{diffTotals.add}</span>{" "}
              <span className="text-danger">-{diffTotals.del}</span>
            </span>
          )}
          {prChecksSummary && (
            <span className={prChecksSummary.passed < prChecksSummary.total ? "text-warning" : "text-success"}>
              PR #{prChecksSummary.number} · {prChecksSummary.passed}/{prChecksSummary.total} checks
            </span>
          )}
          {previewPortLabel && <span>●{previewPortLabel}</span>}
        </div>

        <div className="hidden items-center gap-3 sm:flex">
          {cliProbes
            .filter((p) => p.available && p.runtime !== "acp")
            .slice(0, 3)
            .map((p) => (
              <span key={p.runtime}>
                {p.label.split(" ")[0]} {p.version || "ok"}
              </span>
            ))}
          <span className="text-success">
            ● MCP {network ? `${network.preferred_ip}:${network.port}` : "localhost:9527"}
          </span>
        </div>
      </footer>

      {/* Modals */}
      <NewWorkspaceModal
        open={newWsModal.open}
        onClose={() => setNewWsModal({ open: false })}
        projects={projects}
        defaultDir={newWsModal.prefillDir}
        cliProbes={cliProbes}
        onCreated={(thread) => {
          void qc.invalidateQueries({ queryKey: ["workspace-tree"] });
          handleEnterWorkspace(thread.id);
        }}
      />

      <ConnectRemoteModal
        open={connectOpen}
        onClose={() => setConnectOpen(false)}
        network={network}
      />

      <CallHistoryModal
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        calls={historyCalls}
      />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        threads={threads}
        activeThreadId={activeThreadId}
        localHostname={localHostname}
        isSplit={isSplit}
        sidebarCollapsed={sidebarCollapsed}
        onSelectThread={handleEnterWorkspace}
        onOpenCompanion={handleOpenCompanionPeer}
        onSelectTool={handleSelectToolFromPalette}
        onSelectScreen={setScreen}
        onOpenNewWorkspace={() => setNewWsModal({ open: true })}
        onOpenConnect={() => setConnectOpen(true)}
        onOpenHistory={() => setHistoryOpen(true)}
        onToggleSplit={() => handleToggleSplit()}
        onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
        onToggleTheme={handleToggleTheme}
      />
    </div>
  );
}
