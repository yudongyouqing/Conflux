import { useEffect, useState } from "react";
import type {
  AgentTemplate,
  AgentThread,
  ApprovalMode,
  CliProbeEntry,
  Project,
  RuntimeId,
} from "@conflux/shared";
import { AlertTriangle, GitBranch, Shield, X, Zap } from "lucide-react";
import { api } from "../api";
import { RuntimeGlyph } from "./brand-icons";

interface NewAgentModalProps {
  open: boolean;
  onClose: () => void;
  projects: Project[];
  defaultProjectId: number | null;
  cliProbes: CliProbeEntry[];
  templates: AgentTemplate[];
  onCreated: (thread: AgentThread) => void;
}

const PRIMARY_RUNTIMES: RuntimeId[] = ["antigravity", "claude", "codex"];

export function NewAgentModal({
  open,
  onClose,
  projects,
  defaultProjectId,
  cliProbes,
  templates,
  onCreated,
}: NewAgentModalProps) {
  const firstAvailable =
    cliProbes.find((p) => PRIMARY_RUNTIMES.includes(p.runtime) && p.available)?.runtime ?? "claude";
  const [runtime, setRuntime] = useState<RuntimeId>(firstAvailable);
  const [projectId, setProjectId] = useState<number | "">(defaultProjectId ?? projects[0]?.id ?? "");
  const [customWorkdir, setCustomWorkdir] = useState("");
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [instructions, setInstructions] = useState("");
  const [useWorktree, setUseWorktree] = useState(false);
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>("ask");
  const [initialPrompt, setInitialPrompt] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [showCustomAcp, setShowCustomAcp] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const acpProbe = cliProbes.find((p) => p.runtime === "acp");
  const visibleRuntimes: RuntimeId[] =
    acpProbe?.available || showCustomAcp ? [...PRIMARY_RUNTIMES, "acp"] : PRIMARY_RUNTIMES;

  useEffect(() => {
    if (!open) return;
    setProjectId(defaultProjectId ?? projects[0]?.id ?? "");
    const avail =
      cliProbes.find((p) => PRIMARY_RUNTIMES.includes(p.runtime) && p.available)?.runtime ??
      "claude";
    setRuntime(avail);
    setShowCustomAcp(false);
    setError(null);
  }, [open, defaultProjectId, projects, cliProbes]);

  if (!open) return null;

  const activeProbe = cliProbes.find((p) => p.runtime === runtime);
  const availableModels = activeProbe?.models ?? [];

  const applyTemplate = (templateIdStr: string) => {
    setSelectedTemplateId(templateIdStr);
    const tpl = templates.find((t) => String(t.id) === templateIdStr);
    if (!tpl) return;
    if (tpl.runtime === "acp") setShowCustomAcp(true);
    setRuntime(tpl.runtime);
    setModel(tpl.model ?? "");
    setInstructions(tpl.instructions ?? "");
    setApprovalMode(tpl.approval_mode);
    setUseWorktree(tpl.use_worktree);
    if (!name.trim()) setName(tpl.name);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const payload = {
        project_id: projectId === "" ? null : Number(projectId),
        workdir: projectId === "" && customWorkdir.trim() ? customWorkdir.trim() : undefined,
        name: name.trim() || undefined,
        runtime,
        model: model.trim() || null,
        instructions: instructions.trim() || null,
        approval_mode: approvalMode,
        use_worktree: useWorktree,
        initial_prompt: initialPrompt.trim() || null,
      };
      const res = await api.createThread(payload);
      setName("");
      setInstructions("");
      setInitialPrompt("");
      setSelectedTemplateId("");
      onCreated(res.thread);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      data-testid="new-agent-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4"
    >
      <div className="flex max-h-[88vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-line-strong bg-surface shadow-overlay">
        <div className="flex h-11 items-center justify-between border-b border-line px-4">
          <h2 className="text-[13.5px] font-semibold text-ink">新建 Agent 线程</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭弹窗"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-muted hover:bg-tile-hover hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="flex-1 space-y-3.5 overflow-y-auto px-4 py-4">
          {/* Primary 3 CLI engines (custom ACP only when configured or explicitly expanded) */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-xs font-medium text-ink-muted">引擎</label>
              {!acpProbe?.available && !showCustomAcp && (
                <button
                  type="button"
                  onClick={() => {
                    setShowCustomAcp(true);
                    setRuntime("acp");
                  }}
                  className="text-2xs text-ink-faint hover:text-ink transition-colors"
                >
                  自定义 ACP CLI
                </button>
              )}
            </div>
            <div className={`grid gap-2 ${visibleRuntimes.length === 4 ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-3"}`}>
              {visibleRuntimes.map((rid) => {
                const probe = cliProbes.find((p) => p.runtime === rid);
                const selected = runtime === rid;
                return (
                  <button
                    key={rid}
                    type="button"
                    data-testid={`engine-card-${rid}`}
                    onClick={() => {
                      setRuntime(rid);
                      setModel("");
                    }}
                    className={`flex flex-col items-start gap-1 rounded-lg border px-2.5 py-2 text-left transition-colors ${
                      selected
                        ? "border-accent bg-accent-soft"
                        : "border-line bg-paper/60 hover:bg-tile-hover"
                    }`}
                  >
                    <div className="flex w-full items-center justify-between">
                      <RuntimeGlyph
                        runtime={rid}
                        size={15}
                        className={selected ? "text-accent" : "text-ink-muted"}
                      />
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          probe?.available ? "bg-success" : "bg-neutral"
                        }`}
                        title={probe?.available ? "本机可用" : "未配置"}
                      />
                    </div>
                    <div className="text-xs font-medium text-ink">{probe?.label ?? rid}</div>
                    <div className="w-full truncate font-mono text-2xs text-ink-faint">
                      {probe?.available ? (probe.version ?? probe.executable) : "未配置"}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {templates.length > 0 && (
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-muted">预设模板</label>
              <select
                value={selectedTemplateId}
                onChange={(e) => applyTemplate(e.target.value)}
                className="w-full rounded-md border border-line bg-paper/60 px-2.5 py-1.5 text-xs text-ink focus:border-accent focus:outline-none"
              >
                <option value="">不使用模板</option>
                {templates.map((tpl) => (
                  <option key={tpl.id} value={String(tpl.id)}>
                    {tpl.name} ({tpl.runtime}{tpl.model ? ` / ${tpl.model}` : ""})
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Project + Name */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-muted">所属项目</label>
              <select
                data-testid="new-agent-project-select"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value === "" ? "" : Number(e.target.value))}
                className="w-full rounded-md border border-line bg-paper/60 px-2.5 py-1.5 text-xs text-ink focus:border-accent focus:outline-none"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
                <option value="">自定义目录路径...</option>
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-ink-muted">名称（可选）</label>
              <input
                type="text"
                data-testid="new-agent-name-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="留空自动命名"
                className="w-full rounded-md border border-line bg-paper/60 px-2.5 py-1.5 text-xs text-ink focus:border-accent focus:outline-none"
              />
            </div>
          </div>

          {projectId === "" && (
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-muted">工作目录</label>
              <input
                type="text"
                value={customWorkdir}
                onChange={(e) => setCustomWorkdir(e.target.value)}
                placeholder="C:\Project folder\my-repo"
                required={projectId === ""}
                className="w-full rounded-md border border-line bg-paper/60 px-2.5 py-1.5 font-mono text-xs text-ink focus:border-accent focus:outline-none"
              />
            </div>
          )}

          {/* Model + Approval mode */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-muted">模型</label>
              <select
                data-testid="new-agent-model-select"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full rounded-md border border-line bg-paper/60 px-2.5 py-1.5 font-mono text-xs text-ink focus:border-accent focus:outline-none"
              >
                <option value="">默认模型</option>
                {availableModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-ink-muted">审批模式</label>
              <div className="grid grid-cols-2 rounded-md border border-line bg-paper/60 p-0.5">
                <button
                  type="button"
                  onClick={() => setApprovalMode("ask")}
                  className={`inline-flex items-center justify-center gap-1 rounded py-1 text-xs transition-colors ${
                    approvalMode === "ask"
                      ? "bg-surface font-medium text-ink shadow-card"
                      : "text-ink-faint hover:text-ink"
                  }`}
                >
                  <Shield className="h-3 w-3" />
                  Ask
                </button>
                <button
                  type="button"
                  onClick={() => setApprovalMode("auto")}
                  className={`inline-flex items-center justify-center gap-1 rounded py-1 text-xs transition-colors ${
                    approvalMode === "auto"
                      ? "bg-warning-soft font-medium text-warning"
                      : "text-ink-faint hover:text-ink"
                  }`}
                >
                  <Zap className="h-3 w-3" />
                  Auto
                </button>
              </div>
            </div>
          </div>

          {/* Worktree toggle */}
          <label className="flex cursor-pointer items-center gap-2.5 rounded-lg bg-tile px-3 py-2 hover:bg-tile-hover transition-colors">
            <input
              type="checkbox"
              data-testid="new-agent-worktree-checkbox"
              checked={useWorktree}
              onChange={(e) => setUseWorktree(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-line-strong text-accent"
            />
            <GitBranch className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
            <span className="text-xs text-ink">使用独立 Git Worktree 隔离工作区</span>
          </label>

          {/* Instructions & initial prompt */}
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-muted">静态角色指令（可选）</label>
            <textarea
              rows={2}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="例如：负责后端重构与回归测试..."
              className="w-full rounded-md border border-line bg-paper/60 px-2.5 py-1.5 text-xs text-ink focus:border-accent focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-ink-muted">首轮提示词（可选）</label>
            <textarea
              rows={2}
              value={initialPrompt}
              onChange={(e) => setInitialPrompt(e.target.value)}
              placeholder="留空则先就绪待命"
              className="w-full rounded-md border border-line bg-paper/60 px-2.5 py-1.5 text-xs text-ink focus:border-accent focus:outline-none"
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-line pt-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-xs text-ink-muted hover:bg-tile-hover hover:text-ink"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={submitting}
              data-testid="new-agent-submit-btn"
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3.5 py-1.5 text-xs font-medium text-on-accent hover:bg-accent-deep disabled:opacity-50 transition-colors"
            >
              {submitting ? "启动中..." : "创建并启动"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
