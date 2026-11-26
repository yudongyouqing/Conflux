import { useEffect, useState } from "react";
import type { AgentThread, WorkspaceTerminalRunResult } from "@conflux/shared";
import {
  Check,
  ChevronLeft,
  ExternalLink,
  FileCode2,
  Folder,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Globe,
  RefreshCw,
  Send,
  Terminal,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import {
  useDetectPreview,
  useThreadGitDiff,
  useThreadGitStatus,
  useThreadPrDetail,
  useWorkspaceFileContent,
  useWorkspaceFiles,
} from "../hooks";

export type PaseoToolTab = "git" | "term" | "files" | "preview";

interface PaseoToolPaneProps {
  thread: AgentThread;
  tool: PaseoToolTab;
  layout: "split" | "full";
  onSendPromptToAgent: (promptText: string) => Promise<void> | void;
}

function formatDiffLineClass(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return "bg-success-soft/80 text-success";
  if (line.startsWith("-") && !line.startsWith("---")) return "bg-danger-soft/80 text-danger";
  if (line.startsWith("@@") || line.startsWith("diff --git")) return "text-info font-medium";
  return "text-ink-muted";
}

function fileStatusLetter(status: string): { letter: string; cls: string } {
  switch (status) {
    case "added":
    case "untracked":
      return { letter: "A", cls: "text-success" };
    case "deleted":
      return { letter: "D", cls: "text-danger" };
    case "renamed":
      return { letter: "R", cls: "text-info" };
    default:
      return { letter: "M", cls: "text-warning" };
  }
}

export function PaseoToolPane({
  thread,
  tool,
  layout,
  onSendPromptToAgent,
}: PaseoToolPaneProps) {
  const qc = useQueryClient();

  // ---- Git & PR State ----
  const [selectedGitFile, setSelectedGitFile] = useState<string | null>(null);
  const [commitMsg, setCommitMsg] = useState("");
  const [gitBusy, setGitBusy] = useState(false);
  const [gitNotice, setGitNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [showCreatePrForm, setShowCreatePrForm] = useState(false);
  const [prTitle, setPrTitle] = useState("");
  const [prDraft, setPrDraft] = useState(false);

  const gitStatus = useThreadGitStatus(tool === "git" ? thread.id : null);
  const gitDiff = useThreadGitDiff(tool === "git" ? thread.id : null, selectedGitFile);
  const prDetail = useThreadPrDetail(tool === "git" ? thread.id : null);

  // ---- Terminal State ----
  const [termInput, setTermInput] = useState("");
  const [termBusy, setTermBusy] = useState(false);
  const [termLogs, setTermLogs] = useState<WorkspaceTerminalRunResult[]>([]);

  // ---- File Explorer State ----
  const [currentDir, setCurrentDir] = useState("");
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const filesTree = useWorkspaceFiles(tool === "files" ? thread.id : null, currentDir);
  const fileContent = useWorkspaceFileContent(tool === "files" ? thread.id : null, selectedFilePath);

  // ---- Live Preview State ----
  const previewDetect = useDetectPreview(tool === "preview" ? thread.id : null);
  const [previewInput, setPreviewInput] = useState(thread.preview_url || "");
  const [previewUrl, setPreviewUrl] = useState(thread.preview_url || "");
  const [previewNonce, setPreviewNonce] = useState(0);

  useEffect(() => {
    setSelectedGitFile(null);
    setGitNotice(null);
    setShowCreatePrForm(false);
    setCurrentDir("");
    setSelectedFilePath(null);
    setTermLogs([]);
    const saved = thread.preview_url || "";
    setPreviewInput(saved);
    setPreviewUrl(saved);
  }, [thread.id, thread.preview_url]);

  useEffect(() => {
    if (tool !== "preview" || previewUrl) return;
    const first = previewDetect.data?.saved_url || previewDetect.data?.detected?.[0]?.url || "";
    if (first) {
      setPreviewInput(first);
      setPreviewUrl(first);
    }
  }, [tool, previewUrl, previewDetect.data]);

  const invalidateGit = () => {
    void qc.invalidateQueries({ queryKey: ["thread-git-status", thread.id] });
    void qc.invalidateQueries({ queryKey: ["thread-git-diff", thread.id] });
    void qc.invalidateQueries({ queryKey: ["thread-pr-detail", thread.id] });
    void qc.invalidateQueries({ queryKey: ["workspace-tree"] });
  };

  // ==================== 1. FULL PASEO GIT & PR ====================
  if (tool === "git") {
    const status = gitStatus.data;
    const files = status?.files ?? [];
    const pr = prDetail.data?.pr ?? null;
    const isSplit = layout === "split";
    const agentShortName = thread.name.split(/\s+/)[0] || thread.name;

    const handleToggleStage = async (path: string, nextStaged: boolean) => {
      setGitBusy(true);
      setGitNotice(null);
      try {
        await api.stageGitFiles(thread.id, { paths: [path], staged: nextStaged });
        invalidateGit();
      } catch (err) {
        setGitNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
      } finally {
        setGitBusy(false);
      }
    };

    const handleCommit = async () => {
      const msg = commitMsg.trim();
      if (!msg) {
        setGitNotice({ ok: false, text: "请输入 Commit 信息" });
        return;
      }
      setGitBusy(true);
      setGitNotice(null);
      try {
        const res = await api.commitGitChanges(thread.id, msg);
        setGitNotice({ ok: res.ok, text: res.message });
        if (res.ok) setCommitMsg("");
        invalidateGit();
      } catch (err) {
        setGitNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
      } finally {
        setGitBusy(false);
      }
    };

    const handlePush = async () => {
      setGitBusy(true);
      setGitNotice(null);
      try {
        const res = await api.pushGitBranch(thread.id);
        setGitNotice({ ok: res.ok, text: res.message });
        invalidateGit();
      } catch (err) {
        setGitNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
      } finally {
        setGitBusy(false);
      }
    };

    const handleCreatePr = async () => {
      setGitBusy(true);
      setGitNotice(null);
      try {
        const res = await api.createWorktreePr(thread.id, {
          title: prTitle.trim() || undefined,
          draft: prDraft,
        });
        setGitNotice({ ok: res.ok, text: res.message });
        if (res.ok) {
          setShowCreatePrForm(false);
          setPrTitle("");
        }
        invalidateGit();
      } catch (err) {
        setGitNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
      } finally {
        setGitBusy(false);
      }
    };

    const handleMergePr = async () => {
      setGitBusy(true);
      setGitNotice(null);
      try {
        const res = await api.mergeGitPr(thread.id, {
          method: "squash",
          cleanup_worktree: Boolean(thread.worktree_path),
        });
        setGitNotice({ ok: res.ok, text: res.message });
        invalidateGit();
      } catch (err) {
        setGitNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
      } finally {
        setGitBusy(false);
      }
    };

    const handleMergeWorktree = async () => {
      setGitBusy(true);
      setGitNotice(null);
      try {
        const res = await api.mergeWorktree(thread.id);
        setGitNotice({ ok: res.ok, text: res.message });
        invalidateGit();
      } catch (err) {
        setGitNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
      } finally {
        setGitBusy(false);
      }
    };

    const handleCleanupWorktree = async () => {
      setGitBusy(true);
      setGitNotice(null);
      try {
        await api.cleanupWorktree(thread.id);
        setGitNotice({ ok: true, text: "已清理 Worktree 目录" });
        invalidateGit();
      } catch (err) {
        setGitNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
      } finally {
        setGitBusy(false);
      }
    };

    return (
      <div
        data-testid="paseo-git-pane"
        className={`flex min-h-0 flex-1 ${
          isSplit
            ? "flex-col overflow-y-auto"
            : "flex-col overflow-y-auto lg:flex-row lg:overflow-hidden"
        } bg-surface`}
      >
        {/* Stage / Commit / Changes column */}
        <div
          className={`flex shrink-0 flex-col gap-2.5 bg-paper ${
            isSplit
              ? "w-full border-b border-line px-3.5 py-2.5"
              : "w-full border-b border-line p-3 lg:w-[280px] lg:overflow-y-auto lg:border-b-0 lg:border-r"
          }`}
        >
          <div className="rounded-lg border border-line bg-elev p-2.5">
            <div className="mb-1.5 flex items-center justify-between text-2xs font-semibold text-ink-faint">
              <span>STAGE &amp; COMMIT</span>
              {status?.branch && (
                <span className="inline-flex items-center gap-1 font-mono text-ink-muted">
                  <GitBranch className="h-3 w-3" />
                  {status.branch}
                </span>
              )}
            </div>

            <div className={`flex gap-1.5 ${isSplit ? "flex-row items-center" : "flex-col"}`}>
              <input
                type="text"
                data-testid="git-commit-input"
                value={commitMsg}
                onChange={(e) => setCommitMsg(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleCommit();
                }}
                placeholder="Commit message (如 feat: fix auth)…"
                className="h-7 min-w-0 flex-1 rounded-[5px] border border-line bg-surface px-2 text-2xs text-ink focus:border-ink-muted focus:outline-none"
              />
              <div className="flex shrink-0 gap-1.5">
                <button
                  type="button"
                  disabled={gitBusy}
                  data-testid="git-commit-btn"
                  onClick={() => void handleCommit()}
                  className="inline-flex h-7 flex-1 items-center justify-center rounded-md bg-accent px-2.5 text-2xs font-semibold text-on-accent hover:bg-accent-deep disabled:opacity-50"
                >
                  Commit
                </button>
                <button
                  type="button"
                  disabled={gitBusy}
                  data-testid="git-push-btn"
                  onClick={() => void handlePush()}
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-line-strong bg-surface px-2 text-2xs font-medium text-ink hover:bg-tile-hover disabled:opacity-50"
                >
                  <Upload className="h-3 w-3" />
                  <span>Push</span>
                </button>
              </div>
            </div>

            {gitNotice && (
              <div
                data-testid="git-notice-banner"
                className={`mt-2 rounded px-2 py-1 text-2xs ${
                  gitNotice.ok ? "bg-success-soft text-success" : "bg-danger-soft text-danger"
                }`}
              >
                {gitNotice.text}
              </div>
            )}
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between text-2xs font-semibold text-ink-faint">
              <span>CHANGES ({files.length})</span>
              {selectedGitFile && (
                <button
                  type="button"
                  onClick={() => setSelectedGitFile(null)}
                  className="font-normal text-ink-muted hover:text-ink"
                >
                  看全部
                </button>
              )}
            </div>

            {files.length === 0 ? (
              <div className="px-1 py-2 text-2xs text-ink-faint">
                {status?.is_git_repo === false ? "当前目录不是 Git 仓库" : "工作区干净，暂无未提交改动"}
              </div>
            ) : (
              <div className="space-y-0.5">
                {files.map((f) => {
                  const badge = fileStatusLetter(f.status);
                  const active = selectedGitFile === f.path;
                  return (
                    <div
                      key={f.path}
                      className={`flex items-center gap-1.5 rounded-md px-1.5 py-1 text-2xs transition-colors ${
                        active ? "bg-tile-active text-ink" : "hover:bg-tile-hover text-ink-muted"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={f.staged}
                        disabled={gitBusy}
                        aria-label={`暂存 ${f.path}`}
                        onChange={(e) => void handleToggleStage(f.path, e.target.checked)}
                        className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-current"
                      />
                      <span className={`w-3 shrink-0 font-mono font-semibold ${badge.cls}`}>
                        {badge.letter}
                      </span>
                      <button
                        type="button"
                        onClick={() => setSelectedGitFile(f.path)}
                        className="min-w-0 flex-1 truncate text-left font-mono text-ink"
                      >
                        {f.path}
                      </button>
                      {typeof f.additions === "number" && (
                        <span className="shrink-0 font-mono text-success">+{f.additions}</span>
                      )}
                      {typeof f.deletions === "number" && f.deletions > 0 && (
                        <span className="shrink-0 font-mono text-danger">-{f.deletions}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* PR Detail Card + Diff Viewer */}
        <div
          className={`flex min-w-0 flex-1 flex-col gap-3 bg-surface ${
            isSplit ? "px-3.5 py-3" : "p-3.5 lg:overflow-y-auto lg:p-4"
          }`}
        >
          {/* Full Paseo PR Card */}
          <div
            data-testid="paseo-pr-card"
            className="flex flex-col gap-2.5 rounded-xl border border-line-strong bg-elev p-3.5"
          >
            {pr ? (
              <>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="inline-flex items-center gap-1 rounded bg-success-soft px-1.5 py-0.5 font-mono text-2xs font-medium text-success">
                        <GitPullRequest className="h-3 w-3" />
                        PR #{pr.number} · {pr.state}
                      </span>
                      <span className="font-mono text-2xs text-ink-faint">
                        {pr.head_branch} → {pr.base_branch}
                      </span>
                      <a
                        href={pr.url}
                        target="_blank"
                        rel="noreferrer"
                        data-testid="pr-external-link"
                        className="inline-flex items-center gap-0.5 text-2xs text-ink-muted hover:text-ink"
                      >
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                    <div className="mt-1.5 text-[13px] font-semibold text-ink">{pr.title}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => void prDetail.refetch()}
                      className="inline-flex h-7 items-center gap-1 rounded-md border border-line-strong bg-surface px-2 text-2xs text-ink hover:bg-tile-hover"
                    >
                      <RefreshCw className="h-3 w-3" />
                      <span>刷新</span>
                    </button>
                    <button
                      type="button"
                      disabled={gitBusy}
                      data-testid="merge-pr-btn"
                      onClick={() => void handleMergePr()}
                      className="inline-flex h-7 items-center gap-1 rounded-md bg-accent px-2.5 text-2xs font-semibold text-on-accent hover:bg-accent-deep disabled:opacity-50"
                    >
                      <GitMerge className="h-3 w-3" />
                      <span>合并 PR</span>
                    </button>
                  </div>
                </div>

                {/* CI Checks */}
                {pr.checks.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-2xs font-medium text-ink-faint">
                      CI CHECKS (gh pr checks)
                    </div>
                    {pr.checks.map((c, idx) => (
                      <div
                        key={`${c.name}-${idx}`}
                        className="flex items-center justify-between gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5 text-2xs"
                      >
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span
                            className={`font-bold ${
                              c.status === "pass"
                                ? "text-success"
                                : c.status === "fail"
                                  ? "text-danger"
                                  : "text-warning"
                            }`}
                          >
                            {c.status === "pass" ? "✓" : c.status === "fail" ? "✗" : "○"}
                          </span>
                          <span className="truncate font-mono text-ink">{c.name}</span>
                        </span>
                        <span className="flex shrink-0 items-center gap-1.5">
                          {c.status === "fail" && (
                            <button
                              type="button"
                              data-testid={`fix-check-btn-${idx}`}
                              onClick={() =>
                                void onSendPromptToAgent(
                                  `请排查并修复 PR #${pr.number} 失败的 CI Check「${c.name}」${
                                    c.description ? `：${c.description}` : ""
                                  }`,
                                )
                              }
                              className="h-5 rounded border border-line-strong bg-elev px-2 text-2xs text-ink hover:bg-tile-hover"
                            >
                              交给 Agent 修
                            </button>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Review Comments -> 1-Click Send to Agent */}
                {pr.comments.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-2xs font-medium text-ink-faint">
                      REVIEW 评论 ({pr.comments.length})
                    </div>
                    {pr.comments.map((cm) => (
                      <div
                        key={cm.id}
                        className="space-y-1.5 rounded-lg border border-line bg-surface p-2.5 text-xs"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-mono text-2xs text-ink-muted">
                            <strong className="text-ink">{cm.author}</strong>
                            {cm.path ? ` · ${cm.path}${cm.line ? `:${cm.line}` : ""}` : ""}
                          </span>
                          <button
                            type="button"
                            data-testid={`send-review-fix-${cm.id}`}
                            onClick={() =>
                              void onSendPromptToAgent(
                                `请处理 PR #${pr.number} Review 评论${
                                  cm.path ? ` (${cm.path}${cm.line ? `:${cm.line}` : ""})` : ""
                                }：\n${cm.body}`,
                              )
                            }
                            className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-accent px-2.5 text-2xs font-semibold text-on-accent hover:bg-accent-deep"
                          >
                            <span>发给 {agentShortName} 修复 →</span>
                          </button>
                        </div>
                        <div className="whitespace-pre-wrap leading-relaxed text-ink">{cm.body}</div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-xs font-semibold text-ink">
                      Pull Request（基于本机 gh）
                    </div>
                    <div className="mt-0.5 text-2xs text-ink-faint">
                      {prDetail.data?.message || `当前分支 ${status?.branch || "—"} 尚未关联 PR`}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {thread.worktree_path && (
                      <>
                        <button
                          type="button"
                          disabled={gitBusy}
                          data-testid="merge-worktree-btn"
                          onClick={() => void handleMergeWorktree()}
                          className="inline-flex h-7 items-center gap-1 rounded-md border border-line-strong bg-surface px-2.5 text-2xs text-ink hover:bg-tile-hover"
                        >
                          <GitMerge className="h-3 w-3" />
                          <span>合并回 {thread.base_branch || "main"}</span>
                        </button>
                        <button
                          type="button"
                          disabled={gitBusy}
                          title="清理 Worktree"
                          onClick={() => void handleCleanupWorktree()}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-line-strong bg-surface text-ink-muted hover:text-danger"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      data-testid="toggle-create-pr-btn"
                      onClick={() => setShowCreatePrForm((v) => !v)}
                      className="inline-flex h-7 items-center gap-1 rounded-md bg-accent px-2.5 text-2xs font-semibold text-on-accent hover:bg-accent-deep"
                    >
                      <GitPullRequest className="h-3 w-3" />
                      <span>推送并创建 PR</span>
                    </button>
                  </div>
                </div>

                {showCreatePrForm && (
                  <div className="space-y-2 rounded-lg border border-line bg-surface p-2.5">
                    <input
                      type="text"
                      value={prTitle}
                      onChange={(e) => setPrTitle(e.target.value)}
                      placeholder="PR 标题（留空按最新 commit 自动填充）"
                      className="h-7 w-full rounded border border-line bg-elev px-2 text-2xs text-ink focus:border-ink-muted focus:outline-none"
                    />
                    <div className="flex items-center justify-between">
                      <label className="inline-flex cursor-pointer items-center gap-1.5 text-2xs text-ink-muted">
                        <input
                          type="checkbox"
                          checked={prDraft}
                          onChange={(e) => setPrDraft(e.target.checked)}
                        />
                        <span>Draft PR</span>
                      </label>
                      <button
                        type="button"
                        disabled={gitBusy}
                        data-testid="submit-create-pr-btn"
                        onClick={() => void handleCreatePr()}
                        className="h-7 rounded-md bg-accent px-3 text-2xs font-semibold text-on-accent hover:bg-accent-deep disabled:opacity-50"
                      >
                        确认创建 PR
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Diff Viewer */}
          <div
            data-testid="git-diff-viewer"
            className="overflow-hidden rounded-lg border border-line bg-rail font-mono text-2xs leading-relaxed"
          >
            <div className="flex items-center justify-between border-b border-line bg-elev px-3 py-1.5 text-ink">
              <span>{selectedGitFile || "全部未提交改动 Diff"}</span>
              <span className="text-ink-faint">{files.length} 个文件</span>
            </div>
            <div className="overflow-x-auto py-1.5">
              {!gitDiff.data?.diff?.trim() ? (
                <div className="px-3 py-4 font-sans text-2xs text-ink-faint">暂无 Diff 内容</div>
              ) : (
                gitDiff.data.diff.split(/\r?\n/).map((line, i) => (
                  <div
                    key={i}
                    className={`min-w-max whitespace-pre px-3 py-[1px] ${formatDiffLineClass(line)}`}
                  >
                    {line || " "}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ==================== 2. PASEO EMBEDDED TERMINAL ====================
  if (tool === "term") {
    const runCommand = async (rawCmd: string) => {
      const cmd = rawCmd.trim();
      if (!cmd || termBusy) return;
      setTermBusy(true);
      setTermInput("");
      try {
        const res = await api.execTerminalCommand(thread.id, cmd);
        setTermLogs((prev) => [...prev, res]);
      } catch (err) {
        setTermLogs((prev) => [
          ...prev,
          {
            ok: false,
            command: cmd,
            cwd: thread.workdir,
            stdout: "",
            stderr: err instanceof Error ? err.message : String(err),
            exit_code: 1,
            duration_ms: 0,
          },
        ]);
      } finally {
        setTermBusy(false);
      }
    };

    return (
      <div
        data-testid="paseo-terminal-pane"
        className="flex min-h-0 flex-1 flex-col overflow-hidden bg-rail font-mono text-xs text-ink"
      >
        <div className="flex items-center gap-1.5 overflow-x-auto border-b border-line bg-paper px-3 py-1.5">
          <Terminal className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
          <span className="truncate text-2xs text-ink-faint">{thread.workdir}</span>
          <div className="ml-auto flex shrink-0 gap-1">
            {["git status -sb", "git log -n 5 --oneline", "gh pr checks"].map((preset) => (
              <button
                key={preset}
                type="button"
                disabled={termBusy}
                onClick={() => void runCommand(preset)}
                className="rounded border border-line bg-elev px-2 py-0.5 text-2xs text-ink-muted hover:text-ink"
              >
                {preset}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-3.5 leading-relaxed">
          {termLogs.length === 0 && (
            <div className="text-2xs text-ink-faint">
              [Paseo Embedded Shell · {thread.workdir}] 输入命令回车执行（例如 git status / npm test）
            </div>
          )}
          {termLogs.map((entry, i) => (
            <div key={i} className="space-y-1">
              <div className="flex items-center justify-between gap-2 text-success">
                <span>$ {entry.command}</span>
                <span className="text-2xs text-ink-faint">
                  exit {entry.exit_code ?? 0} · {entry.duration_ms}ms
                </span>
              </div>
              {entry.stdout && (
                <pre className="whitespace-pre-wrap break-words text-ink">{entry.stdout}</pre>
              )}
              {entry.stderr && (
                <pre className="whitespace-pre-wrap break-words text-danger">{entry.stderr}</pre>
              )}
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2 border-t border-line bg-paper px-3.5 py-2">
          <span className="text-success">❯</span>
          <input
            type="text"
            data-testid="paseo-terminal-input"
            value={termInput}
            disabled={termBusy}
            onChange={(e) => setTermInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void runCommand(termInput);
            }}
            placeholder={termBusy ? "命令执行中…" : "输入命令回车执行…"}
            className="flex-1 bg-transparent font-mono text-xs text-ink placeholder:text-ink-faint focus:outline-none"
          />
          <button
            type="button"
            disabled={termBusy || !termInput.trim()}
            onClick={() => void runCommand(termInput)}
            className="inline-flex h-6 items-center gap-1 rounded bg-accent px-2 text-2xs font-semibold text-on-accent disabled:opacity-40"
          >
            <Send className="h-3 w-3" />
          </button>
        </div>
      </div>
    );
  }

  // ==================== 3. PASEO FILE EXPLORER ====================
  if (tool === "files") {
    const entries = filesTree.data?.entries ?? [];
    const parentDir = currentDir.includes("/")
      ? currentDir.slice(0, currentDir.lastIndexOf("/"))
      : "";

    return (
      <div
        data-testid="paseo-files-pane"
        className="flex min-h-0 flex-1 overflow-hidden bg-surface"
      >
        <div
          className={`shrink-0 overflow-y-auto border-r border-line bg-paper p-2 font-mono text-2xs ${
            layout === "split" ? "w-[180px]" : "w-[236px]"
          }`}
        >
          <div className="mb-1.5 flex items-center justify-between gap-1 px-1 text-ink-faint">
            <span className="truncate">{currentDir || "/"}</span>
            {currentDir && (
              <button
                type="button"
                onClick={() => setCurrentDir(parentDir)}
                className="inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-ink-muted hover:bg-tile-hover hover:text-ink"
              >
                <ChevronLeft className="h-3 w-3" />
                <span>上级</span>
              </button>
            )}
          </div>

          <div className="space-y-0.5">
            {entries.map((ent) => (
              <button
                key={ent.path}
                type="button"
                data-testid={`fs-entry-${ent.name}`}
                onClick={() => {
                  if (ent.kind === "dir") setCurrentDir(ent.path);
                  else setSelectedFilePath(ent.path);
                }}
                className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors ${
                  selectedFilePath === ent.path
                    ? "bg-tile-active text-ink"
                    : "text-ink-muted hover:bg-tile-hover hover:text-ink"
                }`}
              >
                {ent.kind === "dir" ? (
                  <Folder className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                ) : (
                  <FileCode2 className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                )}
                <span className="truncate">{ent.name}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-rail">
          {selectedFilePath ? (
            <>
              <div className="flex items-center justify-between gap-2 border-b border-line bg-paper px-3 py-1.5 font-mono text-2xs">
                <span className="truncate text-ink">{selectedFilePath}</span>
                <button
                  type="button"
                  onClick={() => void onSendPromptToAgent(`请查看并说明 @${selectedFilePath} 的关键实现。`)}
                  className="shrink-0 rounded bg-accent px-2 py-0.5 font-sans text-2xs font-semibold text-on-accent hover:bg-accent-deep"
                >
                  引用到对话
                </button>
              </div>
              <div className="flex-1 overflow-auto p-3.5 font-mono text-2xs leading-relaxed text-ink">
                {fileContent.isLoading ? (
                  <div className="text-ink-faint">读取中…</div>
                ) : fileContent.data?.binary ? (
                  <div className="text-ink-faint">二进制文件，暂不支持文本预览</div>
                ) : (
                  <pre className="whitespace-pre">{fileContent.data?.content ?? ""}</pre>
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-xs text-ink-faint">
              点击左侧文件查看代码内容
            </div>
          )}
        </div>
      </div>
    );
  }

  // ==================== 4. PASEO LIVE WEB PREVIEW ====================
  const detected = previewDetect.data?.detected ?? [];

  const applyPreviewUrl = async (nextUrl: string) => {
    const cleaned = nextUrl.trim();
    setPreviewInput(cleaned);
    setPreviewUrl(cleaned);
    setPreviewNonce((n) => n + 1);
    try {
      await api.savePreviewUrl(thread.id, cleaned || null);
      void qc.invalidateQueries({ queryKey: ["workspace-tree"] });
    } catch {
      // non-fatal
    }
  };

  return (
    <div
      data-testid="paseo-preview-pane"
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-surface"
    >
      <div className="flex items-center gap-1.5 border-b border-line bg-paper px-3 py-1.5">
        <Globe className="h-3.5 w-3.5 shrink-0 text-success" />
        <input
          type="text"
          data-testid="paseo-preview-url-input"
          value={previewInput}
          onChange={(e) => setPreviewInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void applyPreviewUrl(previewInput);
          }}
          placeholder="输入本地服务地址（如 http://localhost:5173）回车加载"
          className="h-7 min-w-0 flex-1 rounded-[5px] border border-line bg-surface px-2.5 font-mono text-2xs text-ink focus:border-ink-muted focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void applyPreviewUrl(previewInput)}
          title="加载 / 刷新"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-line-strong bg-elev text-ink hover:bg-tile-hover"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
        {previewUrl && (
          <>
            <a
              href={previewUrl}
              target="_blank"
              rel="noreferrer"
              title="在新标签页打开"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-line-strong bg-elev text-ink hover:bg-tile-hover"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
            <button
              type="button"
              onClick={() => void applyPreviewUrl("")}
              title="清除预览"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-line bg-elev text-ink-muted hover:text-ink"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>

      {detected.length > 0 && (
        <div className="flex items-center gap-1.5 border-b border-line bg-elev px-3 py-1 text-2xs text-ink-faint">
          <span>探测到本机端口：</span>
          {detected.map((d) => (
            <button
              key={d.port}
              type="button"
              onClick={() => void applyPreviewUrl(d.url)}
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono transition-colors ${
                previewUrl === d.url
                  ? "bg-success-soft text-success"
                  : "bg-surface text-ink-muted hover:text-ink"
              }`}
            >
              {previewUrl === d.url && <Check className="h-3 w-3" />}
              <span>:{d.port}</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-1 flex-col bg-rail">
        {previewUrl ? (
          <iframe
            key={`${previewUrl}-${previewNonce}`}
            src={previewUrl}
            title="Paseo Live Preview"
            className="h-full w-full flex-1 border-0 bg-surface"
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
            <Globe className="h-7 w-7 text-ink-faint" />
            <div className="text-xs font-medium text-ink">实时 Web 预览</div>
            <p className="max-w-sm text-2xs leading-relaxed text-ink-faint">
              在「终端」启动本地开发服务（如 <span className="font-mono text-ink">npm run dev</span>），或在上方输入{" "}
              <span className="font-mono text-ink">http://localhost:5173</span> 即可实时边聊边看页面。
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
