import { useMemo, useState } from "react";
import type { AgentThread, Message, Project } from "@conflux/shared";
import { ChevronDown, Plus } from "lucide-react";

type SidebarFilter = "all" | "calling" | "approval";

interface WorkspaceSidebarProps {
  collapsed: boolean;
  projects: Project[];
  threads: AgentThread[];
  activeCalls: Message[];
  activeThreadId: string | null;
  localHostname: string;
  onSelectThread: (threadId: string) => void;
  onOpenNewWorkspace: (prefillDir?: string) => void;
}

function dirDisplayName(dirPath: string): string {
  const cleaned = dirPath.replace(/[\\/]+$/, "");
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || cleaned || "workspace";
}

function baseWorkdirKey(thread: AgentThread, projectsById: Map<number, Project>): string {
  if (thread.project_id !== null) {
    const proj = projectsById.get(thread.project_id);
    if (proj?.root_path) return proj.root_path;
  }
  // Collapse .conflux-worktrees/<slug> back under its parent repository directory
  const wtIdx = thread.workdir.indexOf(".conflux-worktrees");
  if (wtIdx > 0) {
    return thread.workdir.slice(0, wtIdx).replace(/[\\/]+$/, "");
  }
  return thread.workdir;
}

function extractPrNumber(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = url.match(/\/pull\/(\d+)/);
  return match ? `#${match[1]}` : null;
}

function extractPreviewPort(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.port ? `:${parsed.port}` : null;
  } catch {
    const m = url.match(/:(\d{2,5})/);
    return m ? `:${m[1]}` : null;
  }
}

export function WorkspaceSidebar({
  collapsed,
  projects,
  threads,
  activeCalls,
  activeThreadId,
  localHostname,
  onSelectThread,
  onOpenNewWorkspace,
}: WorkspaceSidebarProps) {
  const [filter, setFilter] = useState<SidebarFilter>("all");
  const [closedGroups, setClosedGroups] = useState<Record<string, boolean>>({});

  const projectsById = useMemo(() => {
    const m = new Map<number, Project>();
    for (const p of projects) m.set(p.id, p);
    return m;
  }, [projects]);

  const callPartnerByThread = useMemo(() => {
    const map = new Map<string, { partnerName: string; status: Message["status"]; hop: number }>();
    for (const c of activeCalls) {
      if (!map.has(c.from_session)) {
        map.set(c.from_session, {
          partnerName: c.to_name || c.to_session.slice(0, 8),
          status: c.status,
          hop: c.hop_count,
        });
      }
      if (!map.has(c.to_session)) {
        map.set(c.to_session, {
          partnerName: c.from_name || c.from_session.slice(0, 8),
          status: c.status,
          hop: c.hop_count,
        });
      }
    }
    return map;
  }, [activeCalls]);

  const pendingCallThreadIds = useMemo(() => {
    const set = new Set<string>();
    for (const c of activeCalls) {
      if (c.status === "awaiting_approval") set.add(c.to_session);
    }
    return set;
  }, [activeCalls]);

  // Only keep online/live workspaces plus active selected thread so closed sessions never clutter
  const visibleThreads = useMemo(() => {
    const online = threads.filter((t) => t.live !== false || t.id === activeThreadId || t.kind === "managed");
    if (filter === "calling") {
      return online.filter((t) => callPartnerByThread.has(t.id));
    }
    if (filter === "approval") {
      return online.filter(
        (t) => (t.pending_approvals ?? 0) > 0 || pendingCallThreadIds.has(t.id),
      );
    }
    return online;
  }, [threads, activeThreadId, filter, callPartnerByThread, pendingCallThreadIds]);

  const totalOnlineCount = useMemo(
    () => threads.filter((t) => t.live !== false || t.kind === "managed").length,
    [threads],
  );
  const totalCallingCount = useMemo(
    () => threads.filter((t) => callPartnerByThread.has(t.id)).length,
    [threads, callPartnerByThread],
  );
  const totalApprovalCount = useMemo(
    () =>
      threads.filter((t) => (t.pending_approvals ?? 0) > 0 || pendingCallThreadIds.has(t.id))
        .length,
    [threads, pendingCallThreadIds],
  );

  // Strict Host -> Directory -> Session hierarchy
  const hostTree = useMemo(() => {
    const hosts = new Map<
      string,
      {
        host: string;
        isRemote: boolean;
        dirs: Map<string, { dirPath: string; dirName: string; threads: AgentThread[] }>;
      }
    >();

    // Ensure registered local projects show up even before their first workspace is created
    if (filter === "all") {
      for (const proj of projects) {
        const h = localHostname || "localhost";
        let hostEntry = hosts.get(h);
        if (!hostEntry) {
          hostEntry = { host: h, isRemote: false, dirs: new Map() };
          hosts.set(h, hostEntry);
        }
        if (!hostEntry.dirs.has(proj.root_path)) {
          hostEntry.dirs.set(proj.root_path, {
            dirPath: proj.root_path,
            dirName: proj.name || dirDisplayName(proj.root_path),
            threads: [],
          });
        }
      }
    }

    for (const thread of visibleThreads) {
      const h = thread.host?.trim() || localHostname || "localhost";
      const isRemote = h.toLowerCase() !== (localHostname || "localhost").toLowerCase();
      let hostEntry = hosts.get(h);
      if (!hostEntry) {
        hostEntry = { host: h, isRemote, dirs: new Map() };
        hosts.set(h, hostEntry);
      }
      const dirPath = baseWorkdirKey(thread, projectsById);
      let dirEntry = hostEntry.dirs.get(dirPath);
      if (!dirEntry) {
        const matchedProj = thread.project_id ? projectsById.get(thread.project_id) : null;
        dirEntry = {
          dirPath,
          dirName: matchedProj?.name || dirDisplayName(dirPath),
          threads: [],
        };
        hostEntry.dirs.set(dirPath, dirEntry);
      }
      dirEntry.threads.push(thread);
    }

    return Array.from(hosts.values()).sort((a, b) => Number(a.isRemote) - Number(b.isRemote));
  }, [visibleThreads, projects, projectsById, localHostname, filter]);

  const toggleGroup = (key: string) => {
    setClosedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <aside
      data-testid="workspace-sidebar"
      className={`cfx-sidebar select-none border-r border-line bg-paper ${
        collapsed ? "is-collapsed" : ""
      }`}
    >
      <div className="cfx-sidebar-inner flex flex-col">
        {/* Top Header */}
        <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-line px-3">
          <span className="text-xs font-semibold text-ink-muted">工作区</span>
          <button
            type="button"
            data-testid="sidebar-new-workspace-btn"
            onClick={() => onOpenNewWorkspace()}
            className="inline-flex h-6 items-center gap-1 rounded-md bg-accent px-2 text-2xs font-semibold text-on-accent hover:bg-accent-deep transition-colors"
          >
            <Plus className="h-3 w-3" />
            <span>新建</span>
          </button>
        </div>

        {/* 3-Way Compact Filter */}
        <div className="grid grid-cols-3 gap-1 border-b border-line px-2 py-1.5">
          {(
            [
              { id: "all", label: `在线 ${totalOnlineCount}`, accent: false },
              { id: "calling", label: `通话 ${totalCallingCount}`, accent: false },
              { id: "approval", label: `待批 ${totalApprovalCount}`, accent: totalApprovalCount > 0 },
            ] as const
          ).map((item) => {
            const active = filter === item.id;
            return (
              <button
                key={item.id}
                type="button"
                data-testid={`sidebar-filter-${item.id}`}
                onClick={() => setFilter(item.id)}
                className={`h-6 rounded-[5px] border text-2xs transition-colors ${
                  active
                    ? "border-line-strong bg-elev font-semibold text-ink"
                    : item.accent
                      ? "border-transparent text-warning hover:bg-tile-hover"
                      : "border-transparent text-ink-faint hover:bg-tile-hover hover:text-ink"
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </div>

        {/* Host -> Directory -> Session Tree */}
        <div className="flex-1 space-y-1.5 overflow-y-auto px-1.5 py-2">
          {hostTree.length === 0 && (
            <div className="px-3 py-8 text-center text-xs text-ink-faint">
              暂无匹配的工作区，点击右上角「+ 新建」开始。
            </div>
          )}

          {hostTree.map((hostGroup) => {
            const hostKey = `host:${hostGroup.host}`;
            const hostOpen = !closedGroups[hostKey];
            const hostCount = Array.from(hostGroup.dirs.values()).reduce(
              (sum, d) => sum + d.threads.length,
              0,
            );
            return (
              <div
                key={hostKey}
                data-testid={`sidebar-host-${hostGroup.host}`}
                data-open={hostOpen ? "true" : "false"}
                className="cfx-acc-group"
              >
                <div className="cfx-acc-head">
                  <button
                    type="button"
                    onClick={() => toggleGroup(hostKey)}
                    className="flex w-full items-center justify-between gap-1.5 rounded-[5px] px-1.5 py-1 text-left text-xs hover:bg-tile-hover transition-colors"
                  >
                    <span
                      className={`inline-flex min-w-0 items-center gap-1.5 font-semibold ${
                        hostGroup.isRemote ? "text-info" : "text-ink"
                      }`}
                    >
                      <ChevronDown className="cfx-acc-chevron h-3 w-3 shrink-0 text-ink-faint" />
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                          hostGroup.isRemote ? "bg-info" : "bg-success"
                        }`}
                      />
                      <span className="truncate">
                        {hostGroup.host} · {hostGroup.isRemote ? "远程" : "本机"}
                      </span>
                    </span>
                    <span className="font-mono text-2xs text-ink-faint tabular-nums">
                      {hostCount}
                    </span>
                  </button>
                </div>

                <div className="cfx-acc-body">
                  <div className="cfx-acc-inner">
                    <div className="space-y-1 pt-0.5">
                      {Array.from(hostGroup.dirs.values()).map((dirGroup) => {
                        const dirKey = `dir:${hostGroup.host}:${dirGroup.dirPath}`;
                        const dirOpen = !closedGroups[dirKey];
                        return (
                          <div
                            key={dirKey}
                            data-open={dirOpen ? "true" : "false"}
                            className="cfx-acc-group ml-2 border-l border-line pl-2"
                          >
                            <div
                              className="cfx-acc-head flex items-center gap-0.5"
                              title={dirGroup.dirPath}
                            >
                              <button
                                type="button"
                                onClick={() => toggleGroup(dirKey)}
                                className="flex min-w-0 flex-1 items-center justify-between gap-1 rounded-[5px] px-1.5 py-1 text-left text-2xs text-ink-muted hover:bg-tile-hover hover:text-ink transition-colors"
                              >
                                <span className="inline-flex min-w-0 items-center gap-1.5">
                                  <ChevronDown className="cfx-acc-chevron h-3 w-3 shrink-0 text-ink-faint" />
                                  <span className="truncate font-mono">{dirGroup.dirName}</span>
                                </span>
                                <span className="font-mono text-2xs text-ink-faint tabular-nums">
                                  {dirGroup.threads.length}
                                </span>
                              </button>
                              {!hostGroup.isRemote && (
                                <button
                                  type="button"
                                  title={`在 ${dirGroup.dirName} 新建工作区`}
                                  onClick={() => onOpenNewWorkspace(dirGroup.dirPath)}
                                  className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-faint hover:bg-tile-hover hover:text-ink transition-colors"
                                >
                                  <Plus className="h-3 w-3" />
                                </button>
                              )}
                            </div>

                            <div className="cfx-acc-body">
                              <div className="cfx-acc-inner">
                                <div className="space-y-0.5 pt-0.5">
                                  {dirGroup.threads.length === 0 && (
                                    <div className="px-2 py-1 text-2xs text-ink-faint">
                                      暂无工作区
                                    </div>
                                  )}

                                  {dirGroup.threads.map((thread) => {
                                    const active = thread.id === activeThreadId;
                                    const callInfo = callPartnerByThread.get(thread.id);
                                    const hasPendingCall = pendingCallThreadIds.has(thread.id);
                                    const pendingTotal =
                                      (thread.pending_approvals ?? 0) + (hasPendingCall ? 1 : 0);
                                    const prNum = extractPrNumber(thread.pr_url);
                                    const previewPort = extractPreviewPort(thread.preview_url);
                                    const dotCls =
                                      pendingTotal > 0 || thread.state === "waiting_approval"
                                        ? "bg-warning animate-pulse"
                                        : callInfo
                                          ? "bg-info animate-pulse"
                                          : thread.state === "stopped"
                                            ? "bg-neutral"
                                            : thread.state === "error"
                                              ? "bg-danger"
                                              : "bg-success";

                                    return (
                                      <button
                                        key={thread.id}
                                        type="button"
                                        data-testid={`sidebar-thread-${thread.id}`}
                                        onClick={() => onSelectThread(thread.id)}
                                        className={`flex w-full flex-col gap-0.5 rounded-md border px-2 py-1.5 text-left transition-colors ${
                                          active
                                            ? "border-line-strong bg-tile-active text-ink"
                                            : "border-transparent bg-transparent text-ink-muted hover:bg-tile-hover hover:text-ink"
                                        }`}
                                      >
                                        <div className="flex items-center justify-between gap-1.5">
                                          <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium">
                                            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotCls}`} />
                                            <span
                                              className={`truncate ${
                                                active ? "font-semibold text-ink" : ""
                                              }`}
                                            >
                                              {thread.name}
                                            </span>
                                          </span>

                                          {pendingTotal > 0 ? (
                                            <span
                                              data-testid={`sidebar-approval-badge-${thread.id}`}
                                              className="shrink-0 rounded bg-warning-soft px-1.5 py-0.5 font-mono text-2xs font-medium text-warning"
                                            >
                                              待批 {pendingTotal}
                                            </span>
                                          ) : hostGroup.isRemote ? (
                                            <span className="shrink-0 rounded bg-info-soft px-1.5 py-0.5 font-mono text-2xs text-info">
                                              远程
                                            </span>
                                          ) : thread.kind === "external" ? (
                                            <span
                                              data-testid={`external-badge-${thread.id}`}
                                              className="shrink-0 rounded bg-elev px-1.5 py-0.5 font-mono text-2xs text-ink-faint"
                                            >
                                              Hook
                                            </span>
                                          ) : null}
                                        </div>

                                        <div className="flex items-center gap-1.5 pl-3 font-mono text-2xs text-ink-faint">
                                          <span className="truncate">
                                            {thread.worktree_branch || thread.base_branch || thread.runtime}
                                          </span>
                                          {prNum && (
                                            <>
                                              <span>·</span>
                                              <span className="text-warning">PR {prNum}</span>
                                            </>
                                          )}
                                          {previewPort && (
                                            <>
                                              <span>·</span>
                                              <span>{previewPort}</span>
                                            </>
                                          )}
                                        </div>

                                        {callInfo && (
                                          <div className="flex items-center justify-between gap-1 pl-3 text-2xs text-info">
                                            <span className="truncate">⇄ {callInfo.partnerName}</span>
                                            <span className="shrink-0 font-mono">
                                              hop {callInfo.hop}/5
                                            </span>
                                          </div>
                                        )}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
