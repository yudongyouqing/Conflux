import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentThread,
  ApprovalMode,
  CliProbeEntry,
  Project,
  RuntimeId,
  WorkspaceCreateMode,
} from "@conflux/shared";
import { ChevronRight, FolderOpen, GitBranch, GitPullRequest, X } from "lucide-react";
import { api } from "../api";
import { RuntimeGlyph } from "./brand-icons";
import { isMacPlatform } from "./CommandPalette";

interface NewWorkspaceModalProps {
  open: boolean;
  onClose: () => void;
  projects: Project[];
  defaultDir?: string | null;
  cliProbes: CliProbeEntry[];
  onCreated: (thread: AgentThread) => void;
}

const PRIMARY_RUNTIMES: Array<{ id: RuntimeId; title: string }> = [
  { id: "claude", title: "Claude Code" },
  { id: "codex", title: "Codex" },
  { id: "antigravity", title: "Antigravity" },
];

export function NewWorkspaceModal({
  open,
  onClose,
  projects,
  defaultDir,
  cliProbes,
  onCreated,
}: NewWorkspaceModalProps) {
  const [runtime, setRuntime] = useState<RuntimeId>("claude");
  const [workdir, setWorkdir] = useState("");
  const [name, setName] = useState("");
  const [mode, setMode] = useState<WorkspaceCreateMode>("direct");
  const [branchName, setBranchName] = useState("");
  const [prNumber, setPrNumber] = useState("");
  const [model, setModel] = useState("");
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>("ask");
  const [initialPrompt, setInitialPrompt] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const mac = useMemo(() => isMacPlatform(), []);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setName("");
    setBranchName("");
    setPrNumber("");
    setInitialPrompt("");
    setMode("direct");
    setShowAdvanced(false);
    const firstDir = defaultDir?.trim() || projects[0]?.root_path || "";
    setWorkdir(firstDir);
    const available = PRIMARY_RUNTIMES.find((r) =>
      cliProbes.some((p) => p.runtime === r.id && p.available),
    );
    const pickedRuntime = available?.id ?? "claude";
    setRuntime(pickedRuntime);
    const probe = cliProbes.find((p) => p.runtime === pickedRuntime);
    setModel(probe?.models[0] ?? "");
  }, [open, defaultDir, projects, cliProbes]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !submitting) {
        e.preventDefault();
        formRef.current?.requestSubmit();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose, submitting]);

  if (!open) return null;

  const activeProbe = cliProbes.find((p) => p.runtime === runtime);

  const handlePickNativeDir = async () => {
    const picker =
      window.confluxDesktop?.pickProjectDirectory ?? window.confluxDesktop?.pickDirectory;
    if (!picker) return;
    const picked = await picker();
    if (picked) setWorkdir(picked);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workdir.trim()) {
      setError("请输入或选择一个本地项目目录");
      return;
    }
    if (mode === "pr" && !prNumber.trim()) {
      setError("检出 PR 模式请输入 PR 编号（例如 42）");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const matchedProject = projects.find(
        (p) => p.root_path.toLowerCase() === workdir.trim().toLowerCase(),
      );
      const res = await api.createThread({
        project_id: matchedProject?.id ?? null,
        workdir: workdir.trim(),
        name: name.trim() || undefined,
        runtime,
        model: model.trim() || null,
        approval_mode: approvalMode,
        workspace_mode: mode,
        use_worktree: mode === "worktree",
        branch_name: mode === "worktree" && branchName.trim() ? branchName.trim() : null,
        pr_number: mode === "pr" ? prNumber.trim() : null,
        initial_prompt: initialPrompt.trim() || null,
      });
      onCreated(res.thread);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const hasNativePicker = Boolean(
    typeof window !== "undefined" &&
      (window.confluxDesktop?.pickProjectDirectory || window.confluxDesktop?.pickDirectory),
  );

  return (
    <div
      data-testid="new-workspace-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-[2px]"
    >
      <div className="flex max-h-[88vh] w-full max-w-[540px] flex-col overflow-hidden rounded-xl border border-line-strong bg-surface shadow-overlay">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            <h2 className="text-[13.5px] font-semibold text-ink">新建工作区</h2>
            <p className="mt-0.5 text-2xs text-ink-faint">
              支持直连目录、Worktree 新分支，或直接检出已有 PR 开独立工作区
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-ink-muted hover:bg-tile-hover hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form ref={formRef} onSubmit={(e) => void handleSubmit(e)} className="space-y-3.5 overflow-y-auto p-4">
          {/* Engine Picker */}
          <div>
            <label className="mb-1.5 block text-2xs font-medium text-ink-muted">引擎</label>
            <div className="grid grid-cols-3 gap-1.5">
              {PRIMARY_RUNTIMES.map((item) => {
                const probe = cliProbes.find((p) => p.runtime === item.id);
                const selected = runtime === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-testid={`engine-card-${item.id}`}
                    onClick={() => {
                      setRuntime(item.id);
                      setModel(probe?.models[0] ?? "");
                    }}
                    className={`flex flex-col items-center justify-center gap-0.5 rounded-lg border py-2 text-xs transition-colors ${
                      selected
                        ? "border-line-strong bg-tile-active font-semibold text-ink"
                        : "border-line bg-elev text-ink-muted hover:border-line-strong hover:text-ink"
                    }`}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <RuntimeGlyph runtime={item.id} size={13} />
                      <span>{item.title}</span>
                    </span>
                    <span className="font-mono text-2xs text-ink-faint">
                      {probe?.available ? probe.version || "已就绪" : "未检测到"}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Local Directory Picker */}
          <div>
            <label className="mb-1.5 block text-2xs font-medium text-ink-muted">本地项目目录</label>
            <div className="flex gap-1.5">
              <input
                type="text"
                required
                data-testid="new-workspace-dir-input"
                value={workdir}
                onChange={(e) => setWorkdir(e.target.value)}
                placeholder="例如 C:\Projects\my-app 或 /Users/you/dev/repo"
                className="h-8 flex-1 rounded-md border border-line-strong bg-elev px-2.5 font-mono text-xs text-ink focus:border-ink focus:outline-none"
              />
              {hasNativePicker && (
                <button
                  type="button"
                  onClick={() => void handlePickNativeDir()}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong bg-elev px-2.5 text-xs text-ink hover:bg-tile-hover"
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  <span>选择目录</span>
                </button>
              )}
            </div>
            {projects.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {projects.slice(0, 6).map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setWorkdir(p.root_path)}
                    className={`rounded border px-2 py-0.5 font-mono text-2xs transition-colors ${
                      workdir === p.root_path
                        ? "border-line-strong bg-tile-active text-ink"
                        : "border-line bg-paper text-ink-faint hover:text-ink"
                    }`}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Paseo 3-Mode Selector */}
          <div>
            <label className="mb-1.5 block text-2xs font-medium text-ink-muted">
              隔离与 PR 模式（Paseo）
            </label>
            <div className="grid grid-cols-3 gap-1 rounded-lg border border-line bg-rail p-1">
              {(
                [
                  { id: "direct", label: "直连目录", icon: null },
                  { id: "worktree", label: "Worktree 新分支", icon: GitBranch },
                  { id: "pr", label: "检出 PR #", icon: GitPullRequest },
                ] as const
              ).map((opt) => {
                const active = mode === opt.id;
                const Icon = opt.icon;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    data-testid={`ws-mode-${opt.id}`}
                    onClick={() => setMode(opt.id)}
                    className={`inline-flex h-7 items-center justify-center gap-1 rounded-md text-xs transition-colors ${
                      active
                        ? "bg-elev font-semibold text-ink shadow-card"
                        : "text-ink-faint hover:text-ink"
                    }`}
                  >
                    {Icon && <Icon className="h-3 w-3" />}
                    <span>{opt.label}</span>
                  </button>
                );
              })}
            </div>

            {mode === "worktree" && (
              <input
                type="text"
                data-testid="new-workspace-branch-input"
                value={branchName}
                onChange={(e) => setBranchName(e.target.value)}
                placeholder="新分支名（留空自动生成，如 feat/login）"
                className="mt-2 h-8 w-full rounded-md border border-line-strong bg-elev px-2.5 font-mono text-xs text-ink focus:border-ink focus:outline-none"
              />
            )}

            {mode === "pr" && (
              <input
                type="text"
                data-testid="new-workspace-pr-input"
                value={prNumber}
                onChange={(e) => setPrNumber(e.target.value)}
                placeholder="输入已有 PR 编号（如 42），通过 gh 检出到独立 Worktree"
                className="mt-2 h-8 w-full rounded-md border border-line-strong bg-elev px-2.5 font-mono text-xs text-ink focus:border-ink focus:outline-none"
              />
            )}
          </div>

          {/* Orca-style Progressive Disclosure: Advanced Options */}
          <div className="rounded-lg border border-line bg-paper/60">
            <button
              type="button"
              data-testid="new-workspace-advanced-toggle"
              aria-expanded={showAdvanced}
              onClick={() => setShowAdvanced((v) => !v)}
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-2xs font-medium text-ink-muted transition-colors hover:text-ink"
            >
              <span className="inline-flex items-center gap-1.5">
                <ChevronRight
                  className={`h-3.5 w-3.5 transition-transform duration-150 ${
                    showAdvanced ? "rotate-90" : ""
                  }`}
                />
                <span>高级选项</span>
              </span>
              <span className="truncate font-mono text-2xs text-ink-faint">
                {[
                  name.trim() || "自动命名",
                  model || "默认模型",
                  approvalMode === "auto" ? "Auto" : "Ask",
                  initialPrompt.trim() ? "含首条指令" : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </button>

            <div className="paseo-acc-group" data-open={showAdvanced ? "true" : "false"}>
              <div className="paseo-acc-inner">
                <div className="space-y-3 border-t border-line px-3 pb-3 pt-2.5">
                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <label className="mb-1 block text-2xs font-medium text-ink-muted">
                        名称（可选）
                      </label>
                      <input
                        type="text"
                        data-testid="new-agent-name-input"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="留空按引擎与目录命名"
                        className="h-8 w-full rounded-md border border-line-strong bg-elev px-2.5 text-xs text-ink focus:border-ink focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-2xs font-medium text-ink-muted">
                        模型 / 权限
                      </label>
                      <div className="flex gap-1.5">
                        <select
                          value={model}
                          onChange={(e) => setModel(e.target.value)}
                          className="h-8 min-w-0 flex-1 rounded-md border border-line-strong bg-elev px-2 font-mono text-2xs text-ink focus:outline-none"
                        >
                          <option value="">默认模型</option>
                          {(activeProbe?.models ?? []).map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => setApprovalMode((m) => (m === "ask" ? "auto" : "ask"))}
                          className="h-8 shrink-0 rounded-md border border-line-strong bg-elev px-2 font-mono text-2xs text-ink-muted hover:text-ink"
                          title="切换命令/写文件审批模式"
                        >
                          {approvalMode === "auto" ? "Auto" : "Ask"}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="mb-1 block text-2xs font-medium text-ink-muted">
                      首条指令（可选）
                    </label>
                    <textarea
                      rows={2}
                      data-testid="new-workspace-initial-prompt"
                      value={initialPrompt}
                      onChange={(e) => setInitialPrompt(e.target.value)}
                      placeholder="创建后立即发送给该 Agent 的任务…"
                      className="w-full resize-none rounded-md border border-line-strong bg-elev px-2.5 py-1.5 text-xs text-ink focus:border-ink focus:outline-none"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {error && (
            <div className="rounded-md bg-danger-soft px-3 py-2 text-xs text-danger">{error}</div>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-line pt-3">
            <button
              type="button"
              data-testid="new-workspace-cancel-btn"
              onClick={onClose}
              className="h-7 rounded-md px-3 text-xs text-ink-muted transition-colors hover:bg-tile-hover hover:text-ink"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={submitting}
              data-testid="new-agent-submit-btn"
              className="inline-flex h-7 items-center gap-1.5 rounded-md bg-accent px-3.5 text-xs font-semibold text-on-accent hover:bg-accent-deep disabled:opacity-50"
            >
              <span>{submitting ? "创建中…" : "创建并进入"}</span>
              <span className="font-mono text-2xs opacity-80">{mac ? "⌘↵" : "Ctrl+↵"}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
