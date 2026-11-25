import { useState } from "react";
import type {
  AgentThread,
  ContextEntry,
  ContextKind,
  GitCreatePrResult,
  GitMergeResult,
  ThreadCheckpoint,
} from "@conflux/shared";
import {
  AlertTriangle,
  ArrowRightLeft,
  Bookmark,
  CheckCircle2,
  ExternalLink,
  FileDiff,
  GitBranch,
  GitMerge,
  GitPullRequest,
  History,
  Pin,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useContextEntries, useThreadGitDiff, useThreadGitStatus } from "../hooks";

type InspectorTab = "git" | "memory" | "handoff";

interface RightInspectorProps {
  thread: AgentThread;
  checkpoints: ThreadCheckpoint[];
  allThreads: AgentThread[];
  onRollbackCheckpoint: (checkpointId: number) => Promise<void>;
  onOpenForkModal: () => void;
  onSelectThread: (threadId: string) => void;
}

function statusBadge(status: string): { label: string; cls: string } {
  switch (status) {
    case "added":
    case "untracked":
      return { label: status === "untracked" ? "?" : "A", cls: "text-success" };
    case "deleted":
      return { label: "D", cls: "text-danger" };
    case "conflicted":
      return { label: "U", cls: "text-warning" };
    default:
      return { label: "M", cls: "text-info" };
  }
}

function DiffLines({ diff }: { diff: string }) {
  if (!diff.trim()) {
    return (
      <div className="py-6 text-center text-xs text-ink-faint">工作树干净，暂无未提交改动</div>
    );
  }
  const lines = diff.split(/\r?\n/);
  return (
    <div
      data-testid="git-diff-viewer"
      className="max-h-80 overflow-auto rounded-md border border-line bg-paper font-mono text-2xs leading-relaxed"
    >
      {lines.map((line, idx) => {
        let rowCls = "text-ink-muted";
        if (line.startsWith("+") && !line.startsWith("+++")) {
          rowCls = "bg-success-soft/75 text-success";
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          rowCls = "bg-danger-soft/75 text-danger";
        } else if (line.startsWith("@@")) {
          rowCls = "bg-info-soft/75 text-info font-medium";
        } else if (line.startsWith("diff --git")) {
          rowCls = "bg-tile text-ink font-medium border-t border-line";
        }
        return (
          <div key={idx} className={`whitespace-pre px-2 py-0.2 ${rowCls}`}>
            {line || " "}
          </div>
        );
      })}
    </div>
  );
}

export function RightInspector({
  thread,
  checkpoints,
  allThreads,
  onRollbackCheckpoint,
  onOpenForkModal,
  onSelectThread,
}: RightInspectorProps) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<InspectorTab>("git");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [mergeResult, setMergeResult] = useState<GitMergeResult | null>(null);
  const [prFormOpen, setPrFormOpen] = useState(false);
  const [prTitle, setPrTitle] = useState("");
  const [prDraft, setPrDraft] = useState(false);
  const [prResult, setPrResult] = useState<GitCreatePrResult | null>(null);
  const [gitBusy, setGitBusy] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);

  // Memory composer
  const [memTitle, setMemTitle] = useState("");
  const [memContent, setMemContent] = useState("");
  const [memKind, setMemKind] = useState<ContextKind>("decision");
  const [memPinned, setMemPinned] = useState(true);
  const [memBusy, setMemBusy] = useState(false);

  // Cross-thread handoff form
  const otherThreads = allThreads.filter((t) => t.id !== thread.id);
  const [targetThreadId, setTargetThreadId] = useState(otherThreads[0]?.id ?? "");
  const [handoffTitle, setHandoffTitle] = useState("");
  const [handoffNote, setHandoffNote] = useState("");
  const [handoffPrompt, setHandoffPrompt] = useState("");
  const [handoffStatus, setHandoffStatus] = useState<string | null>(null);

  const gitStatusQuery = useThreadGitStatus(thread.id);
  const gitDiffQuery = useThreadGitDiff(thread.id, selectedFile);
  const contextQuery = useContextEntries(
    thread.project_id !== null ? { project_id: thread.project_id } : {},
  );

  const gitStatus = gitStatusQuery.data;
  const gitDiff = gitDiffQuery.data;
  const entries: ContextEntry[] = contextQuery.data?.entries ?? [];

  const refreshGit = () => {
    void qc.invalidateQueries({ queryKey: ["thread-git-status", thread.id] });
    void qc.invalidateQueries({ queryKey: ["thread-git-diff", thread.id] });
  };

  const handleMergeWorktree = async () => {
    setGitBusy(true);
    setGitError(null);
    setMergeResult(null);
    try {
      const res = await api.mergeWorktree(thread.id);
      setMergeResult(res);
      refreshGit();
    } catch (err) {
      setGitError(err instanceof Error ? err.message : String(err));
    } finally {
      setGitBusy(false);
    }
  };

  const handleCreatePr = async (e: React.FormEvent) => {
    e.preventDefault();
    setGitBusy(true);
    setGitError(null);
    setPrResult(null);
    try {
      const res = await api.createWorktreePr(thread.id, {
        title: prTitle.trim() || undefined,
        draft: prDraft,
      });
      setPrResult(res);
      if (res.ok) {
        setPrFormOpen(false);
        setPrTitle("");
        void qc.invalidateQueries({ queryKey: ["workspace-tree"] });
        void qc.invalidateQueries({ queryKey: ["thread-detail", thread.id] });
        refreshGit();
      }
    } catch (err) {
      setGitError(err instanceof Error ? err.message : String(err));
    } finally {
      setGitBusy(false);
    }
  };

  const handleCleanupWorktree = async () => {
    setGitBusy(true);
    setGitError(null);
    try {
      await api.cleanupWorktree(thread.id);
      void qc.invalidateQueries({ queryKey: ["workspace-tree"] });
      void qc.invalidateQueries({ queryKey: ["thread-detail", thread.id] });
      refreshGit();
    } catch (err) {
      setGitError(err instanceof Error ? err.message : String(err));
    } finally {
      setGitBusy(false);
    }
  };

  const handlePublishMemory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!memTitle.trim() || !memContent.trim()) return;
    setMemBusy(true);
    try {
      await api.publishContext({
        title: memTitle.trim(),
        content: memContent.trim(),
        project_id: thread.project_id,
        kind: memKind,
        pinned: memPinned,
      });
      setMemTitle("");
      setMemContent("");
      void qc.invalidateQueries({ queryKey: ["context"] });
    } finally {
      setMemBusy(false);
    }
  };

  const handleTogglePin = async (entry: ContextEntry) => {
    await api.updateContext(entry.id, {
      pinned: !entry.pinned,
      expected_version: entry.version,
    });
    void qc.invalidateQueries({ queryKey: ["context"] });
  };

  const handleCrossHandoff = async (e: React.FormEvent) => {
    e.preventDefault();
    const target = targetThreadId || otherThreads[0]?.id;
    if (!target) return;
    setHandoffStatus("正在打包交接...");
    try {
      const res = await api.handoffContext({
        from_thread: thread.id,
        to_thread: target,
        project_id: thread.project_id,
        title: handoffTitle.trim() || undefined,
        note: handoffNote.trim() || undefined,
        prompt: handoffPrompt.trim() || undefined,
      });
      setHandoffStatus(`已交接 ${res.summary_chars} 字符（${res.delivery_method}）`);
      setHandoffTitle("");
      setHandoffNote("");
      setHandoffPrompt("");
      void qc.invalidateQueries({ queryKey: ["context"] });
    } catch (err) {
      setHandoffStatus(`交接失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <aside
      data-testid="right-inspector"
      className="workspace-details border-l border-line bg-surface"
    >
      {/* Razor-thin Linear underline tabs */}
      <div className="flex h-10 shrink-0 items-end border-b border-line px-2">
        {(
          [
            { id: "git", label: "Git Diff", icon: FileDiff },
            { id: "memory", label: "共享记忆", icon: Bookmark },
            { id: "handoff", label: "交接", icon: ArrowRightLeft },
          ] as const
        ).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            data-testid={`inspector-tab-${id}`}
            onClick={() => setTab(id)}
            className={`flex flex-1 items-center justify-center gap-1.5 border-b-2 pb-2 text-xs transition-colors ${
              tab === id
                ? "border-accent font-medium text-ink"
                : "border-transparent text-ink-faint hover:text-ink"
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-3.5 space-y-4">
        {tab === "git" && (
          <>
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-xs font-medium text-ink">
                  <GitBranch className="h-3.5 w-3.5 text-ink-muted" />
                  <span className="truncate font-mono">
                    {gitStatus?.branch ?? (gitStatus?.is_git_repo ? "HEAD" : "非 Git 仓库")}
                  </span>
                </div>
                {thread.worktree_branch && (
                  <div className="mt-0.5 text-2xs text-ink-faint">
                    Worktree 基线 {thread.base_branch ?? "HEAD"}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={refreshGit}
                title="刷新 Git 状态"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-muted hover:bg-tile-hover hover:text-ink"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            </div>

            {thread.worktree_path && (
              <div className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={gitBusy}
                    data-testid="merge-worktree-btn"
                    onClick={() => void handleMergeWorktree()}
                    className="inline-flex h-7 flex-1 items-center justify-center gap-1 rounded-md bg-accent px-2 text-xs font-medium text-on-accent hover:bg-accent-deep disabled:opacity-50"
                  >
                    <GitMerge className="h-3.5 w-3.5" />
                    合并
                  </button>
                  <button
                    type="button"
                    disabled={gitBusy}
                    data-testid="toggle-pr-form-btn"
                    onClick={() => setPrFormOpen((v) => !v)}
                    title={
                      gitStatus?.gh_available === false
                        ? "未检测到本机 gh CLI"
                        : "推送当前 Worktree 分支并调用本机 gh 创建/更新 PR"
                    }
                    className="inline-flex h-7 items-center gap-1 rounded-md bg-tile px-2.5 text-xs font-medium text-ink hover:bg-tile-hover disabled:opacity-50"
                  >
                    <GitPullRequest className="h-3.5 w-3.5" />
                    {thread.pr_url || prResult?.pr_url ? "更新 PR" : "建 PR"}
                  </button>
                  <button
                    type="button"
                    disabled={gitBusy}
                    data-testid="cleanup-worktree-btn"
                    onClick={() => void handleCleanupWorktree()}
                    className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-danger hover:bg-danger-soft disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    清理
                  </button>
                </div>

                {(thread.pr_url || prResult?.pr_url) && (
                  <a
                    href={thread.pr_url ?? prResult?.pr_url ?? "#"}
                    target="_blank"
                    rel="noreferrer"
                    data-testid="inspector-pr-link"
                    className="flex items-center justify-between gap-2 rounded-md bg-accent-soft px-2.5 py-1.5 text-xs font-medium text-accent hover:underline"
                  >
                    <span className="inline-flex min-w-0 items-center gap-1.5 truncate">
                      <GitPullRequest className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate font-mono text-2xs">
                        {thread.pr_url ?? prResult?.pr_url}
                      </span>
                    </span>
                    <ExternalLink className="h-3 w-3 shrink-0" />
                  </a>
                )}

                {prFormOpen && (
                  <form
                    data-testid="pr-create-form"
                    onSubmit={(e) => void handleCreatePr(e)}
                    className="space-y-2 rounded-lg bg-tile p-2.5"
                  >
                    <input
                      type="text"
                      value={prTitle}
                      onChange={(e) => setPrTitle(e.target.value)}
                      placeholder="PR 标题（留空按提交自动生成）"
                      className="w-full rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink focus:border-accent focus:outline-none"
                    />
                    <div className="flex items-center justify-between gap-2">
                      <label className="inline-flex items-center gap-1.5 text-2xs text-ink-muted">
                        <input
                          type="checkbox"
                          checked={prDraft}
                          onChange={(e) => setPrDraft(e.target.checked)}
                        />
                        Draft PR
                      </label>
                      <button
                        type="submit"
                        disabled={gitBusy}
                        data-testid="submit-create-pr-btn"
                        className="inline-flex h-6 items-center gap-1 rounded-md bg-accent px-2.5 text-2xs font-medium text-on-accent hover:bg-accent-deep disabled:opacity-50"
                      >
                        {gitBusy ? "推送中..." : "推送并创建 PR"}
                      </button>
                    </div>
                  </form>
                )}

                {prResult && (
                  <div
                    data-testid="pr-result-banner"
                    className={`rounded-lg px-2.5 py-2 text-2xs ${
                      prResult.ok ? "bg-success-soft text-success" : "bg-danger-soft text-danger"
                    }`}
                  >
                    {prResult.message}
                  </div>
                )}
              </div>
            )}

            {mergeResult && (
              <div
                data-testid="merge-result-banner"
                className={`rounded-lg p-2.5 text-xs ${
                  mergeResult.ok
                    ? "bg-success-soft text-success"
                    : "bg-danger-soft text-danger"
                }`}
              >
                <div className="flex items-center gap-1.5 font-medium">
                  {mergeResult.ok ? (
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  )}
                  <span>{mergeResult.message}</span>
                </div>
                {mergeResult.conflicts && mergeResult.conflicts.length > 0 && (
                  <ul className="mt-1.5 list-disc pl-4 font-mono text-2xs">
                    {mergeResult.conflicts.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {gitError && (
              <div className="rounded-lg bg-danger-soft px-2.5 py-2 text-2xs text-danger">
                {gitError}
              </div>
            )}

            {gitStatus?.is_git_repo && (
              <div>
                <div className="mb-1 flex items-center justify-between text-2xs text-ink-faint">
                  <span>变更文件 ({gitStatus.files.length})</span>
                  {selectedFile && (
                    <button
                      type="button"
                      onClick={() => setSelectedFile(null)}
                      className="text-accent hover:underline"
                    >
                      全部
                    </button>
                  )}
                </div>
                {gitStatus.files.length === 0 ? (
                  <div className="text-2xs text-ink-faint">无未提交文件</div>
                ) : (
                  <div className="max-h-36 space-y-0.5 overflow-y-auto">
                    {gitStatus.files.map((f) => {
                      const badge = statusBadge(f.status);
                      const active = selectedFile === f.path;
                      return (
                        <button
                          key={f.path}
                          type="button"
                          onClick={() => setSelectedFile(active ? null : f.path)}
                          className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors ${
                            active ? "bg-tile-active text-ink" : "hover:bg-tile-hover text-ink-muted"
                          }`}
                        >
                          <span className={`w-3 shrink-0 font-mono text-2xs font-semibold ${badge.cls}`}>
                            {badge.label}
                          </span>
                          <span className="min-w-0 flex-1 truncate font-mono text-2xs">
                            {f.path}
                          </span>
                          {f.additions !== undefined && (
                            <span className="shrink-0 font-mono text-2xs text-success tabular-nums">
                              +{f.additions}
                            </span>
                          )}
                          {f.deletions !== undefined && (
                            <span className="shrink-0 font-mono text-2xs text-danger tabular-nums">
                              -{f.deletions}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            <DiffLines diff={gitDiff?.diff ?? ""} />

            {checkpoints.length > 0 && (
              <div className="border-t border-line pt-3">
                <div className="mb-1.5 flex items-center gap-1.5 text-2xs text-ink-faint">
                  <History className="h-3 w-3" />
                  轮前快照 ({checkpoints.length})
                </div>
                <div className="divide-y divide-line">
                  {checkpoints.slice(0, 8).map((cp) => (
                    <div key={cp.id} className="flex items-center justify-between gap-2 py-1.5">
                      <div className="min-w-0">
                        <div className="truncate text-xs text-ink">
                          {cp.summary ?? `快照 #${cp.id}`}
                        </div>
                        <div className="font-mono text-2xs text-ink-faint">
                          {cp.commit_sha.slice(0, 8)}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void onRollbackCheckpoint(cp.id)}
                        className="inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-2xs text-ink-muted hover:bg-tile-hover hover:text-warning transition-colors"
                      >
                        <RotateCcw className="h-3 w-3" />
                        回滚
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {tab === "memory" && (
          <>
            <form onSubmit={(e) => void handlePublishMemory(e)} className="space-y-2 border-b border-line pb-3">
              <div className="flex items-center gap-1.5">
                <select
                  value={memKind}
                  onChange={(e) => setMemKind(e.target.value as ContextKind)}
                  className="rounded-md border border-line bg-paper/60 px-2 py-1 text-2xs text-ink"
                >
                  <option value="decision">决策</option>
                  <option value="note">笔记</option>
                  <option value="artifact">产物</option>
                  <option value="summary">摘要</option>
                </select>
                <input
                  type="text"
                  value={memTitle}
                  onChange={(e) => setMemTitle(e.target.value)}
                  placeholder="记忆标题..."
                  className="min-w-0 flex-1 rounded-md border border-line bg-paper/60 px-2 py-1 text-xs text-ink focus:border-accent focus:outline-none"
                />
              </div>
              <textarea
                rows={2}
                value={memContent}
                onChange={(e) => setMemContent(e.target.value)}
                placeholder="记录约束或结论（置顶项会增量同步到新轮次）"
                className="w-full rounded-md border border-line bg-paper/60 px-2 py-1.5 text-xs text-ink focus:border-accent focus:outline-none"
              />
              <div className="flex items-center justify-between">
                <label className="inline-flex items-center gap-1.5 text-2xs text-ink-muted">
                  <input
                    type="checkbox"
                    checked={memPinned}
                    onChange={(e) => setMemPinned(e.target.checked)}
                  />
                  置顶自动注入
                </label>
                <button
                  type="submit"
                  disabled={memBusy || !memTitle.trim() || !memContent.trim()}
                  className="inline-flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-2xs font-medium text-on-accent hover:bg-accent-deep disabled:opacity-50"
                >
                  <Plus className="h-3 w-3" />
                  写入
                </button>
              </div>
            </form>

            <div className="divide-y divide-line">
              {entries.length === 0 ? (
                <div className="py-6 text-center text-xs text-ink-faint">暂无共享记忆</div>
              ) : (
                entries.map((entry) => (
                  <div key={entry.id} className="space-y-1 py-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <span className="mr-1.5 font-mono text-2xs text-ink-faint">
                          {entry.kind}
                        </span>
                        <span className="text-xs font-medium text-ink">{entry.title}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleTogglePin(entry)}
                        title={entry.pinned ? "取消置顶" : "置顶"}
                        className={`rounded p-1 transition-colors ${
                          entry.pinned
                            ? "text-accent"
                            : "text-ink-faint hover:bg-tile-hover hover:text-ink"
                        }`}
                      >
                        <Pin className="h-3 w-3" />
                      </button>
                    </div>
                    <p className="whitespace-pre-wrap text-2xs text-ink-muted">{entry.content}</p>
                    <div className="font-mono text-2xs text-ink-faint">
                      #{entry.id} v{entry.version}
                    </div>
                  </div>
                ))
              )}
            </div>
          </>
        )}

        {tab === "handoff" && (
          <div className="space-y-4">
            <div className="border-b border-line pb-4">
              <div className="text-xs font-medium text-ink">原地换引擎接力</div>
              <p className="mt-1 text-2xs text-ink-faint">
                停止当前线程并打包摘要，在相同目录 / Worktree 上启动目标引擎继续。
              </p>
              <button
                type="button"
                data-testid="inspector-fork-handoff-btn"
                onClick={onOpenForkModal}
                className="mt-2.5 inline-flex h-7 w-full items-center justify-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-on-accent hover:bg-accent-deep"
              >
                <ArrowRightLeft className="h-3.5 w-3.5" />
                发起原地接力
              </button>
            </div>

            <form onSubmit={(e) => void handleCrossHandoff(e)} className="space-y-2">
              <div className="text-xs font-medium text-ink">交接给已有线程</div>
              {otherThreads.length === 0 ? (
                <p className="text-2xs text-ink-faint">暂无其他线程</p>
              ) : (
                <>
                  <select
                    value={targetThreadId || otherThreads[0]?.id || ""}
                    onChange={(e) => setTargetThreadId(e.target.value)}
                    className="w-full rounded-md border border-line bg-paper/60 px-2.5 py-1.5 text-xs text-ink"
                  >
                    {otherThreads.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({t.runtime})
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={handoffTitle}
                    onChange={(e) => setHandoffTitle(e.target.value)}
                    placeholder="标题（可选）"
                    className="w-full rounded-md border border-line bg-paper/60 px-2.5 py-1.5 text-xs text-ink"
                  />
                  <textarea
                    rows={2}
                    value={handoffNote}
                    onChange={(e) => setHandoffNote(e.target.value)}
                    placeholder="补充说明（可选）"
                    className="w-full rounded-md border border-line bg-paper/60 px-2.5 py-1.5 text-xs text-ink"
                  />
                  <textarea
                    rows={2}
                    value={handoffPrompt}
                    onChange={(e) => setHandoffPrompt(e.target.value)}
                    placeholder="下一步指令..."
                    className="w-full rounded-md border border-line bg-paper/60 px-2.5 py-1.5 text-xs text-ink"
                  />
                  <button
                    type="submit"
                    className="inline-flex h-7 w-full items-center justify-center rounded-md bg-tile text-xs font-medium text-ink hover:bg-tile-hover"
                  >
                    发送交接包
                  </button>
                </>
              )}
              {handoffStatus && (
                <div className="flex items-center justify-between text-2xs text-info">
                  <span>{handoffStatus}</span>
                  {targetThreadId && (
                    <button
                      type="button"
                      onClick={() => onSelectThread(targetThreadId)}
                      className="text-accent underline"
                    >
                      查看
                    </button>
                  )}
                </div>
              )}
            </form>
          </div>
        )}
      </div>
    </aside>
  );
}
