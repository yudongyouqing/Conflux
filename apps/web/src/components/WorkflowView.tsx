import { useState } from "react";
import type {
  AgentThread,
  WorkflowDefinition,
  WorkflowStepDefinition,
  WorkflowStepKind,
} from "@conflux/shared";
import { Check, Play, Plus, Trash2, UserCheck, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useWorkflowRuns } from "../hooks";

interface WorkflowViewProps {
  projectId: number | null;
  workflows: WorkflowDefinition[];
  allThreads: AgentThread[];
  onSelectThread: (threadId: string) => void;
}

export function WorkflowView({
  projectId,
  workflows,
  allThreads,
  onSelectThread,
}: WorkflowViewProps) {
  const qc = useQueryClient();
  const filtered =
    projectId === null ? workflows : workflows.filter((w) => w.project_id === projectId);
  const [selectedId, setSelectedId] = useState<number | null>(filtered[0]?.id ?? null);
  const runsQuery = useWorkflowRuns(selectedId ?? undefined);

  const [creating, setCreating] = useState(false);
  const [wfName, setWfName] = useState("");
  const [wfDesc, setWfDesc] = useState("");
  const [steps, setSteps] = useState<WorkflowStepDefinition[]>([
    {
      key: "plan",
      title: "方案设计",
      kind: "agent",
      depends_on: [],
      target_thread_id: allThreads[0]?.id ?? null,
      prompt_template: "根据需求 {{input}} 给出实现方案。",
      include_handoff: false,
    },
    {
      key: "review_gate",
      title: "人工确认门控",
      kind: "human_gate",
      depends_on: ["plan"],
      target_thread_id: null,
      prompt_template: "确认方案后放行执行。",
      include_handoff: false,
    },
  ]);

  const [runInput, setRunInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedWorkflow = filtered.find((w) => w.id === selectedId) ?? filtered[0] ?? null;
  const runs = runsQuery.data?.runs ?? [];

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["workspace-tree"] });
    void qc.invalidateQueries({ queryKey: ["workflow-runs"] });
  };

  const handleCreateWorkflow = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!wfName.trim() || steps.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.createWorkflow({
        name: wfName.trim(),
        description: wfDesc.trim() || null,
        project_id: projectId,
        steps,
      });
      setSelectedId(res.workflow.id);
      setCreating(false);
      setWfName("");
      setWfDesc("");
      invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleStartRun = async () => {
    if (!selectedWorkflow) return;
    setBusy(true);
    setError(null);
    try {
      await api.startWorkflowRun(selectedWorkflow.id, {
        input: runInput.trim() || undefined,
        project_id: projectId,
      });
      setRunInput("");
      invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleGateDecision = async (stepId: number, approved: boolean) => {
    await api.approveWorkflowStep(stepId, { approved });
    invalidate();
  };

  const addStep = () => {
    const idx = steps.length + 1;
    const prevKey = steps[steps.length - 1]?.key;
    setSteps((prev) => [
      ...prev,
      {
        key: `step_${idx}`,
        title: `步骤 ${idx}`,
        kind: "agent",
        depends_on: prevKey ? [prevKey] : [],
        target_thread_id: allThreads[0]?.id ?? null,
        prompt_template: "承接上游输出继续执行：{{input}}",
        include_handoff: true,
      },
    ]);
  };

  return (
    <div data-testid="workflow-view" className="flex-1 overflow-y-auto bg-surface px-6 py-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-4">
          <div>
            <h1 className="text-[15px] font-semibold text-ink">DAG 工作流</h1>
            <p className="mt-0.5 text-xs text-ink-faint">
              按依赖拓扑串联多 Agent 线程与人工门控（human_gate）。
            </p>
          </div>
          <button
            type="button"
            data-testid="new-workflow-btn"
            onClick={() => setCreating((v) => !v)}
            className="inline-flex h-7 items-center gap-1 rounded-md bg-accent px-3 text-xs font-medium text-on-accent hover:bg-accent-deep"
          >
            <Plus className="h-3.5 w-3.5" />
            {creating ? "取消" : "新建工作流"}
          </button>
        </div>

        {error && (
          <div className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</div>
        )}

        {creating && (
          <form
            data-testid="workflow-builder-form"
            onSubmit={(e) => void handleCreateWorkflow(e)}
            className="space-y-3 border-b border-line pb-6"
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <input
                type="text"
                required
                value={wfName}
                onChange={(e) => setWfName(e.target.value)}
                placeholder="工作流名称"
                className="rounded-md border border-line bg-paper/60 px-2.5 py-1.5 text-xs text-ink focus:border-accent focus:outline-none"
              />
              <input
                type="text"
                value={wfDesc}
                onChange={(e) => setWfDesc(e.target.value)}
                placeholder="描述（可选）"
                className="rounded-md border border-line bg-paper/60 px-2.5 py-1.5 text-xs text-ink focus:border-accent focus:outline-none"
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-ink-muted">步骤 ({steps.length})</span>
                <button
                  type="button"
                  onClick={addStep}
                  className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-2xs text-accent hover:bg-accent-soft"
                >
                  <Plus className="h-3 w-3" />
                  添加步骤
                </button>
              </div>
              {steps.map((step, idx) => (
                <div key={idx} className="space-y-1.5 rounded-lg bg-tile p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      value={step.key}
                      onChange={(e) =>
                        setSteps((prev) =>
                          prev.map((s, i) => (i === idx ? { ...s, key: e.target.value } : s)),
                        )
                      }
                      className="w-24 rounded-md border border-line bg-surface px-2 py-1 font-mono text-2xs text-ink"
                    />
                    <input
                      type="text"
                      value={step.title}
                      onChange={(e) =>
                        setSteps((prev) =>
                          prev.map((s, i) => (i === idx ? { ...s, title: e.target.value } : s)),
                        )
                      }
                      className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink"
                    />
                    <select
                      value={step.kind}
                      onChange={(e) =>
                        setSteps((prev) =>
                          prev.map((s, i) =>
                            i === idx ? { ...s, kind: e.target.value as WorkflowStepKind } : s,
                          ),
                        )
                      }
                      className="rounded-md border border-line bg-surface px-2 py-1 text-2xs text-ink"
                    >
                      <option value="agent">Agent</option>
                      <option value="human_gate">人工门控</option>
                    </select>
                    {step.kind === "agent" && (
                      <select
                        value={step.target_thread_id ?? ""}
                        onChange={(e) =>
                          setSteps((prev) =>
                            prev.map((s, i) =>
                              i === idx ? { ...s, target_thread_id: e.target.value || null } : s,
                            ),
                          )
                        }
                        className="rounded-md border border-line bg-surface px-2 py-1 text-2xs text-ink"
                      >
                        <option value="">选择执行线程</option>
                        {allThreads.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name} ({t.runtime})
                          </option>
                        ))}
                      </select>
                    )}
                    <button
                      type="button"
                      onClick={() => setSteps((prev) => prev.filter((_, i) => i !== idx))}
                      className="rounded p-1 text-ink-faint hover:text-danger"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <input
                    type="text"
                    value={step.prompt_template}
                    onChange={(e) =>
                      setSteps((prev) =>
                        prev.map((s, i) =>
                          i === idx ? { ...s, prompt_template: e.target.value } : s,
                        ),
                      )
                    }
                    placeholder="提示词模板，支持 {{input}} 与 {{steps.<key>.output}}"
                    className="w-full rounded-md border border-line bg-surface px-2.5 py-1 text-xs text-ink"
                  />
                </div>
              ))}
            </div>

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={busy}
                className="rounded-md bg-accent px-3.5 py-1.5 text-xs font-medium text-on-accent hover:bg-accent-deep disabled:opacity-50"
              >
                保存工作流
              </button>
            </div>
          </form>
        )}

        {filtered.length === 0 ? (
          <div className="py-12 text-center text-xs text-ink-faint">
            尚未创建任何 DAG 工作流。
          </div>
        ) : (
          <div className="space-y-6">
            <div className="flex flex-wrap gap-1.5">
              {filtered.map((wf) => (
                <button
                  key={wf.id}
                  type="button"
                  onClick={() => setSelectedId(wf.id)}
                  className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                    selectedWorkflow?.id === wf.id
                      ? "bg-tile-active font-medium text-ink"
                      : "text-ink-muted hover:bg-tile-hover hover:text-ink"
                  }`}
                >
                  {wf.name} ({wf.steps.length})
                </button>
              ))}
            </div>

            {selectedWorkflow && (
              <div className="space-y-3 border-b border-line pb-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="text-sm font-medium text-ink">{selectedWorkflow.name}</h2>
                    {selectedWorkflow.description && (
                      <p className="text-2xs text-ink-faint">{selectedWorkflow.description}</p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedWorkflow.steps.map((st) => (
                      <span
                        key={st.key}
                        className="rounded bg-tile px-2 py-0.5 font-mono text-2xs text-ink-muted"
                      >
                        {st.key}: {st.title}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    type="text"
                    value={runInput}
                    onChange={(e) => setRunInput(e.target.value)}
                    placeholder="输入本次运行任务目标 ({{input}})..."
                    className="flex-1 rounded-md border border-line bg-paper/60 px-3 py-1.5 text-xs text-ink focus:border-accent focus:outline-none"
                  />
                  <button
                    type="button"
                    disabled={busy}
                    data-testid="start-workflow-run-btn"
                    onClick={() => void handleStartRun()}
                    className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-accent px-3.5 text-xs font-medium text-on-accent hover:bg-accent-deep disabled:opacity-50"
                  >
                    <Play className="h-3.5 w-3.5" />
                    启动运行
                  </button>
                </div>
              </div>
            )}

            <div className="divide-y divide-line">
              {runs.map((run) => (
                <div key={run.id} data-testid={`workflow-run-${run.id}`} className="space-y-3 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs font-medium text-ink">
                      运行 #{run.id} {run.input ? `— ${run.input}` : ""}
                    </div>
                    <span
                      className={`rounded px-2 py-0.5 font-mono text-2xs ${
                        run.status === "completed"
                          ? "bg-success-soft text-success"
                          : run.status === "waiting_human"
                            ? "bg-warning-soft text-warning"
                            : run.status === "failed" || run.status === "cancelled"
                              ? "bg-danger-soft text-danger"
                              : "bg-accent-soft text-accent"
                      }`}
                    >
                      {run.status}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                    {run.steps.map((st) => (
                      <div key={st.id} className="space-y-1.5 rounded-lg bg-tile p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-1.5">
                            {st.kind === "human_gate" && (
                              <UserCheck className="h-3.5 w-3.5 shrink-0 text-warning" />
                            )}
                            <span className="truncate text-xs font-medium text-ink">
                              {st.title}
                            </span>
                            <span className="font-mono text-2xs text-ink-faint">({st.step_key})</span>
                          </div>
                          <span className="font-mono text-2xs text-ink-muted">{st.status}</span>
                        </div>
                        {st.target_thread_id && (
                          <button
                            type="button"
                            onClick={() => onSelectThread(st.target_thread_id!)}
                            className="font-mono text-2xs text-accent hover:underline"
                          >
                            {st.target_thread_id}
                          </button>
                        )}
                        {st.output && (
                          <p className="line-clamp-3 whitespace-pre-wrap text-2xs text-ink-muted">
                            {st.output}
                          </p>
                        )}
                        {st.status === "waiting_human" && (
                          <div className="flex items-center gap-1.5 pt-1">
                            <button
                              type="button"
                              data-testid={`workflow-gate-approve-${st.id}`}
                              onClick={() => void handleGateDecision(st.id, true)}
                              className="inline-flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-2xs font-medium text-on-accent hover:bg-accent-deep"
                            >
                              <Check className="h-3 w-3" />
                              批准继续
                            </button>
                            <button
                              type="button"
                              data-testid={`workflow-gate-reject-${st.id}`}
                              onClick={() => void handleGateDecision(st.id, false)}
                              className="inline-flex items-center gap-1 rounded-md bg-surface px-2.5 py-1 text-2xs font-medium text-danger hover:bg-danger-soft"
                            >
                              <X className="h-3 w-3" />
                              驳回
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
