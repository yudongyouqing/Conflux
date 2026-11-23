import { useState } from "react";
import {
  CheckCircle2,
  GitBranch,
  Loader2,
  Pin,
  Play,
  Plus,
  ShieldCheck,
  Trash2,
  XCircle,
} from "lucide-react";
import type {
  ChatRoom,
  ContextKind,
  GraphNode,
  WorkflowStepDefinition,
  WorkflowStepStatus,
} from "@conflux/shared";
import {
  useApproveWorkflowGate,
  useCancelWorkflowRun,
  useCreateWorkflow,
  usePublishContext,
  useRoomContext,
  useStartWorkflowRun,
  useUpdateContext,
  useWorkflowRuns,
  useWorkflows,
} from "../hooks";

const STEP_STATUS_STYLE: Record<WorkflowStepStatus, string> = {
  pending: "bg-neutral-soft text-neutral",
  ready: "bg-info-soft text-info",
  running: "bg-info-soft text-info",
  waiting_human: "bg-warning-soft text-warning",
  done: "bg-success-soft text-success",
  failed: "bg-danger-soft text-danger",
  skipped: "bg-neutral-soft text-ink-faint",
};

const STEP_STATUS_LABEL: Record<WorkflowStepStatus, string> = {
  pending: "等待上游",
  ready: "就绪",
  running: "运行中",
  waiting_human: "待人工审批",
  done: "已完成",
  failed: "失败",
  skipped: "已跳过",
};

interface WorkflowViewProps {
  room: ChatRoom;
  members: readonly GraphNode[];
  active: boolean;
}

export function WorkflowView({ room, members, active }: WorkflowViewProps) {
  const workflowsQuery = useWorkflows(room.id, active);
  const runsQuery = useWorkflowRuns(room.id, active);
  const roomCtxQuery = useRoomContext(room.id, active);

  const createWf = useCreateWorkflow();
  const startRun = useStartWorkflowRun();
  const approveGate = useApproveWorkflowGate();
  const cancelRun = useCancelWorkflowRun();
  const publishMem = usePublishContext();
  const updateMem = useUpdateContext();

  const [creating, setCreating] = useState(false);
  const [wfName, setWfName] = useState("");
  const [runInput, setRunInput] = useState("");
  const [steps, setSteps] = useState<WorkflowStepDefinition[]>(() => [
    {
      key: "plan",
      title: "方案规划",
      kind: "agent",
      depends_on: [],
      target_session_id: members[0]?.id ?? "",
      prompt_template: "请为以下需求给出实施计划：{{input}}",
      include_handoff: false,
    },
    {
      key: "gate",
      title: "人工评审门禁",
      kind: "human_gate",
      depends_on: ["plan"],
      prompt_template: "核对方案后放行执行",
      include_handoff: false,
    },
    {
      key: "implement",
      title: "执行实现",
      kind: "agent",
      depends_on: ["gate"],
      target_session_id: members[1]?.id ?? members[0]?.id ?? "",
      prompt_template: "请按上游方案与审批意见落地实现",
      include_handoff: true,
    },
  ]);

  const [gateComments, setGateComments] = useState<Record<number, string>>({});
  const [memTitle, setMemTitle] = useState("");
  const [memContent, setMemContent] = useState("");
  const [memKind, setMemKind] = useState<ContextKind>("decision");

  const workflows = workflowsQuery.data?.workflows ?? [];
  const runs = runsQuery.data?.runs ?? [];
  const memories = roomCtxQuery.data?.entries ?? [];

  const handleCreateAndRun = async () => {
    if (!wfName.trim() || steps.length === 0) return;
    const created = await createWf.mutateAsync({
      name: wfName.trim(),
      room_id: room.id,
      steps,
    });
    setCreating(false);
    setWfName("");
    await startRun.mutateAsync({
      workflowId: created.workflow.id,
      input: runInput.trim() || undefined,
      room_id: room.id,
    });
    setRunInput("");
  };

  const handlePublishMemory = async () => {
    if (!memTitle.trim() || !memContent.trim()) return;
    await publishMem.mutateAsync({
      title: memTitle.trim(),
      content: memContent.trim(),
      room_id: room.id,
      kind: memKind,
      pinned: memKind === "decision",
    });
    setMemTitle("");
    setMemContent("");
  };

  const nameOf = (sid: string | null) =>
    sid ? (members.find((m) => m.id === sid)?.name ?? sid.slice(0, 8)) : "人工";

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-5 space-y-5 bg-paper">
      {/* Header + quick actions */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <GitBranch size={15} className="text-accent" />
          <h3 className="text-sm font-semibold text-ink">多 Agent 协同工作流 (DAG) & 共享记忆</h3>
        </div>
        <button
          type="button"
          onClick={() => setCreating((v) => !v)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-on-accent text-xs font-medium hover:bg-accent-deep"
        >
          <Plus size={13} />
          {creating ? "收起编排器" : "新建工作流"}
        </button>
      </div>

      {/* DAG Workflow builder */}
      {creating && (
        <section className="rounded-xl bg-surface border border-line p-4 space-y-3 shadow-card">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <input
              value={wfName}
              onChange={(e) => setWfName(e.target.value)}
              placeholder="工作流名称（如：Claude 规划 → 人工审批 → Codex/Agy 实现）"
              className="px-2.5 py-1.5 text-xs rounded-lg bg-paper border border-line text-ink"
            />
            <input
              value={runInput}
              onChange={(e) => setRunInput(e.target.value)}
              placeholder="本次运行的初始需求 {{input}}（可选）"
              className="px-2.5 py-1.5 text-xs rounded-lg bg-paper border border-line text-ink"
            />
          </div>

          <div className="space-y-2">
            {steps.map((s, idx) => (
              <div
                key={`${s.key}-${idx}`}
                className="rounded-lg border border-line bg-paper p-2.5 space-y-2"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    value={s.key}
                    onChange={(e) =>
                      setSteps((prev) =>
                        prev.map((item, i) => (i === idx ? { ...item, key: e.target.value } : item)),
                      )
                    }
                    className="w-24 px-2 py-1 text-2xs font-mono rounded border border-line bg-surface text-ink"
                    placeholder="step_key"
                  />
                  <input
                    value={s.title}
                    onChange={(e) =>
                      setSteps((prev) =>
                        prev.map((item, i) => (i === idx ? { ...item, title: e.target.value } : item)),
                      )
                    }
                    className="flex-1 min-w-[120px] px-2 py-1 text-xs rounded border border-line bg-surface text-ink"
                    placeholder="步骤标题"
                  />
                  <select
                    value={s.kind}
                    onChange={(e) =>
                      setSteps((prev) =>
                        prev.map((item, i) =>
                          i === idx
                            ? { ...item, kind: e.target.value as "agent" | "human_gate" }
                            : item,
                        ),
                      )
                    }
                    className="px-2 py-1 text-2xs rounded border border-line bg-surface text-ink"
                  >
                    <option value="agent">Agent 节点</option>
                    <option value="human_gate">人工门禁</option>
                  </select>
                  {s.kind === "agent" && (
                    <select
                      value={s.target_session_id ?? ""}
                      onChange={(e) =>
                        setSteps((prev) =>
                          prev.map((item, i) =>
                            i === idx ? { ...item, target_session_id: e.target.value } : item,
                          ),
                        )
                      }
                      className="px-2 py-1 text-2xs rounded border border-line bg-surface text-ink"
                    >
                      <option value="">选择执行会话…</option>
                      {members.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name} ({m.runtime ?? "session"})
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    type="button"
                    onClick={() => setSteps((prev) => prev.filter((_, i) => i !== idx))}
                    className="p-1 text-ink-faint hover:text-danger"
                    title="删除步骤"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-2 text-2xs">
                  <span className="text-ink-faint">依赖前置：</span>
                  <input
                    value={s.depends_on.join(",")}
                    onChange={(e) =>
                      setSteps((prev) =>
                        prev.map((item, i) =>
                          i === idx
                            ? {
                                ...item,
                                depends_on: e.target.value
                                  .split(",")
                                  .map((v) => v.trim())
                                  .filter(Boolean),
                              }
                            : item,
                        ),
                      )
                    }
                    placeholder="逗号分隔 step_key（留空为根节点）"
                    className="flex-1 min-w-[140px] px-2 py-1 rounded border border-line bg-surface text-ink font-mono"
                  />
                  {s.kind === "agent" && (
                    <label className="inline-flex items-center gap-1 text-ink-muted cursor-pointer">
                      <input
                        type="checkbox"
                        checked={Boolean(s.include_handoff)}
                        onChange={(e) =>
                          setSteps((prev) =>
                            prev.map((item, i) =>
                              i === idx ? { ...item, include_handoff: e.target.checked } : item,
                            ),
                          )
                        }
                        className="accent-accent"
                      />
                      自动注入交接记忆
                    </label>
                  )}
                </div>

                <input
                  value={s.prompt_template}
                  onChange={(e) =>
                    setSteps((prev) =>
                      prev.map((item, i) =>
                        i === idx ? { ...item, prompt_template: e.target.value } : item,
                      ),
                    )
                  }
                  placeholder="指令模板（支持 {{input}} 与 {{step.<key>}}）"
                  className="w-full px-2 py-1 text-2xs rounded border border-line bg-surface text-ink"
                />
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              onClick={() =>
                setSteps((prev) => [
                  ...prev,
                  {
                    key: `step_${prev.length + 1}`,
                    title: `步骤 ${prev.length + 1}`,
                    kind: "agent",
                    depends_on: prev.length > 0 ? [prev[prev.length - 1].key] : [],
                    target_session_id: members[0]?.id ?? "",
                    prompt_template: "继续处理上游结论",
                    include_handoff: true,
                  },
                ])
              }
              className="px-2.5 py-1.5 rounded-lg border border-line text-xs text-ink-muted hover:bg-tile-hover"
            >
              + 添加步骤
            </button>
            <button
              type="button"
              disabled={!wfName.trim() || createWf.isPending || startRun.isPending}
              onClick={() => void handleCreateAndRun()}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-accent text-on-accent text-xs font-medium hover:bg-accent-deep disabled:opacity-50"
            >
              {createWf.isPending || startRun.isPending ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Play size={12} />
              )}
              创建并立即运行
            </button>
          </div>
          {(createWf.error || startRun.error) && (
            <p role="alert" className="text-2xs text-danger">
              {((createWf.error ?? startRun.error) as Error).message}
            </p>
          )}
        </section>
      )}

      {/* Saved templates */}
      {workflows.length > 0 && (
        <section className="space-y-2">
          <div className="text-2xs font-medium text-ink-faint">已保存工作流模板</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
            {workflows.map((wf) => (
              <div
                key={wf.id}
                className="rounded-xl bg-surface border border-line p-3 flex items-center justify-between gap-2 shadow-card"
              >
                <div className="min-w-0">
                  <div className="text-xs font-medium text-ink truncate">{wf.name}</div>
                  <div className="text-2xs text-ink-faint mt-0.5">
                    {wf.steps.length} 个步骤 · {wf.steps.map((s) => s.title).join(" → ")}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={startRun.isPending}
                  onClick={() =>
                    startRun.mutate({ workflowId: wf.id, room_id: room.id })
                  }
                  className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-accent-soft text-accent text-2xs font-medium hover:bg-accent hover:text-on-accent"
                >
                  <Play size={11} /> 运行
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Active & historical runs */}
      <section className="space-y-3">
        <div className="text-2xs font-medium text-ink-faint">工作流运行记录</div>
        {runs.length === 0 ? (
          <div className="rounded-xl bg-surface border border-line p-5 text-center text-xs text-ink-faint">
            暂无运行记录。点击右上角「新建工作流」，把房间里的 Claude / Codex / Antigravity 编排成协同流水线。
          </div>
        ) : (
          runs.map((run) => (
            <div
              key={run.id}
              className="rounded-xl bg-surface border border-line p-3.5 space-y-3 shadow-card"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs font-semibold text-ink truncate">
                    #{run.id} {run.workflow_name ?? `工作流 ${run.workflow_id}`}
                  </span>
                  <span className="px-2 py-0.5 rounded-md text-2xs bg-tile text-ink-muted">
                    {run.status}
                  </span>
                </div>
                {(run.status === "running" || run.status === "waiting_human") && (
                  <button
                    type="button"
                    onClick={() => cancelRun.mutate(run.id)}
                    className="text-2xs text-danger hover:underline"
                  >
                    取消运行
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5">
                {run.steps.map((step) => (
                  <div
                    key={step.id}
                    className="rounded-lg border border-line bg-paper p-2.5 space-y-1.5"
                  >
                    <div className="flex items-center justify-between gap-1.5">
                      <span className="text-xs font-medium text-ink truncate">
                        {step.kind === "human_gate" ? "🛡 " : ""}
                        {step.title}
                      </span>
                      <span
                        className={`shrink-0 px-1.5 py-0.5 rounded text-2xs ${
                          STEP_STATUS_STYLE[step.status]
                        }`}
                      >
                        {STEP_STATUS_LABEL[step.status]}
                      </span>
                    </div>
                    <div className="text-2xs text-ink-faint flex flex-wrap gap-1.5">
                      <span>执行：{nameOf(step.target_session_id)}</span>
                      {step.depends_on.length > 0 && (
                        <span className="font-mono">← {step.depends_on.join(", ")}</span>
                      )}
                    </div>
                    {step.output && (
                      <div className="text-2xs text-ink-muted bg-surface border border-line/60 rounded p-2 max-h-24 overflow-y-auto whitespace-pre-wrap break-words">
                        {step.output}
                      </div>
                    )}
                    {step.error && (
                      <div className="text-2xs text-danger break-words">{step.error}</div>
                    )}
                    {step.status === "waiting_human" && (
                      <div className="pt-1 space-y-1.5">
                        <input
                          value={gateComments[step.id] ?? ""}
                          onChange={(e) =>
                            setGateComments((prev) => ({ ...prev, [step.id]: e.target.value }))
                          }
                          placeholder="审批意见（会传递给下游步骤）…"
                          className="w-full px-2 py-1 text-2xs rounded border border-line bg-surface text-ink"
                        />
                        <div className="flex gap-1.5">
                          <button
                            type="button"
                            disabled={approveGate.isPending}
                            onClick={() =>
                              approveGate.mutate({
                                stepId: step.id,
                                approved: true,
                                comment: gateComments[step.id],
                              })
                            }
                            className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 rounded-md bg-success text-on-accent text-2xs font-medium"
                          >
                            <CheckCircle2 size={11} /> 批准放行
                          </button>
                          <button
                            type="button"
                            disabled={approveGate.isPending}
                            onClick={() =>
                              approveGate.mutate({
                                stepId: step.id,
                                approved: false,
                                comment: gateComments[step.id],
                              })
                            }
                            className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 rounded-md bg-danger text-on-accent text-2xs font-medium"
                          >
                            <XCircle size={11} /> 驳回
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </section>

      {/* Room persistent shared memory */}
      <section className="rounded-xl bg-surface border border-line p-4 space-y-3 shadow-card">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-ink">
          <ShieldCheck size={14} className="text-accent" />
          房间持久共享记忆（决策 / 产物 / 交接）
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-[140px_1fr] gap-2">
          <select
            value={memKind}
            onChange={(e) => setMemKind(e.target.value as ContextKind)}
            className="px-2 py-1.5 text-xs rounded-lg bg-paper border border-line text-ink"
          >
            <option value="decision">架构决策 (decision)</option>
            <option value="artifact">产物记录 (artifact)</option>
            <option value="note">笔记 (note)</option>
          </select>
          <input
            value={memTitle}
            onChange={(e) => setMemTitle(e.target.value)}
            placeholder="记忆标题…"
            className="px-2.5 py-1.5 text-xs rounded-lg bg-paper border border-line text-ink"
          />
        </div>
        <div className="flex gap-2">
          <input
            value={memContent}
            onChange={(e) => setMemContent(e.target.value)}
            placeholder="写下值得长期沉淀并跨 Agent 交接的关键结论…"
            className="flex-1 min-w-0 px-2.5 py-1.5 text-xs rounded-lg bg-paper border border-line text-ink"
          />
          <button
            type="button"
            disabled={!memTitle.trim() || !memContent.trim() || publishMem.isPending}
            onClick={() => void handlePublishMemory()}
            className="px-3 py-1.5 rounded-lg bg-accent text-on-accent text-xs font-medium hover:bg-accent-deep disabled:opacity-50"
          >
            沉淀记忆
          </button>
        </div>

        {memories.length === 0 ? (
          <p className="text-2xs text-ink-faint">该房间还没有共享记忆。</p>
        ) : (
          <div className="space-y-2">
            {memories.map((m) => (
              <div
                key={m.id}
                className="rounded-lg bg-paper border border-line p-2.5 flex items-start justify-between gap-2"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-2xs px-1.5 py-0.5 rounded bg-accent-soft text-accent">
                      {m.kind ?? "note"}
                    </span>
                    <span className="text-xs font-medium text-ink">{m.title}</span>
                  </div>
                  <p className="text-2xs text-ink-muted whitespace-pre-wrap break-words line-clamp-3">
                    {m.content}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => updateMem.mutate({ id: m.id, patch: { pinned: !m.pinned } })}
                  title={m.pinned ? "取消置顶" : "置顶记忆（交接时优先携带）"}
                  className={`p-1 rounded-md shrink-0 ${
                    m.pinned
                      ? "bg-warning-soft text-warning"
                      : "text-ink-faint hover:bg-tile-hover hover:text-ink"
                  }`}
                >
                  <Pin size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
