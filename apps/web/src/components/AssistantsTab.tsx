import { useMemo, useState } from "react";
import {
  Bot,
  ChevronDown,
  ChevronUp,
  Clock,
  Cpu,
  FolderOpen,
  Loader2,
  MessageSquare,
  Plus,
  Terminal,
  Trash2,
} from "lucide-react";
import type { Agent } from "@conflux/shared";
import {
  useAgents,
  useDeleteAgent,
  useDeleteRuntimeAgent,
  useGraph,
  useRuntimes,
  useRuntimeInstances,
  useStartRuntimeAgent,
} from "../hooks";
import { buildAssistantCatalog, type CodingAssistantItem } from "../assistant-catalog";
import { CreateAgentWizard, type CreatedAssistant } from "./CreateAgentWizard";
import { PtyPanel } from "./PtyPanel";
import { RuntimeInstanceRow, RuntimeInstancesPanel } from "./RuntimeInstancesPanel";
import { ChatPanel } from "./ChatPanel";

type Category = "coding" | "model";

const CATEGORY_LABELS: Record<Category, string> = { coding: "编码助手", model: "模型助手" };

export interface AssistantsTabProps {
  /** polling/PTY subscriptions pause while another view is showing */
  active: boolean;
  /** Open a conversation with a preset's real session (workspace target). */
  onOpenSession?: (sessionId: string) => void;
}

/**
 * Unified assistants page: one entry, two categories (编码 = CLI presets,
 * 模型 = API personas). Every association shown here comes from the
 * identity-based catalog projection; navigation and category switches never
 * start or stop CLI processes, and the PTY only streams while visible.
 */
export function AssistantsTab({ active, onOpenSession }: AssistantsTabProps) {
  // the page's own queries pause while another view is showing; the shared
  // graph query stays with the App (single poll, identity for the sidebar)
  const agentsQuery = useAgents(active);
  const runtimesQuery = useRuntimes(active);
  const instancesQuery = useRuntimeInstances(active);
  const graph = useGraph();

  const start = useStartRuntimeAgent();
  const delPreset = useDeleteRuntimeAgent();
  const delAgent = useDeleteAgent();

  const [category, setCategory] = useState<Category>("coding");
  const [wizardOpen, setWizardOpen] = useState(false);
  const [expandedPreset, setExpandedPreset] = useState<number | null>(null);
  const [ptyAgentId, setPtyAgentId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [chatAgentId, setChatAgentId] = useState<number | null>(null);

  const catalog = useMemo(
    () =>
      buildAssistantCatalog(
        agentsQuery.data?.agents ?? [],
        runtimesQuery.data?.agents ?? [],
        instancesQuery.data?.instances ?? [],
        graph.data?.nodes ?? [],
      ),
    [agentsQuery.data, runtimesQuery.data, instancesQuery.data, graph.data],
  );

  const runtimeLabel = (id: string) => runtimesQuery.data?.runtimes[id]?.label ?? id;
  const chatAgent: Agent | null =
    chatAgentId != null
      ? (catalog.models.find((m) => m.agent.id === chatAgentId)?.agent ?? null)
      : null;

  // creation lands on the caller's category and locates the new object by
  // its typed identity — a coding preset id never selects a model assistant
  const handleCreated = (created: CreatedAssistant) => {
    if (created.kind === "model") {
      setCategory("model");
      setChatAgentId(created.id);
    } else {
      setCategory("coding");
      setExpandedPreset(created.id);
    }
  };

  const launch = (id: number, name: string) => {
    setNotice(null);
    start.mutate(id, {
      onError: (e) => setNotice(`启动 ${name} 失败: ${(e as Error).message}`),
      onSuccess: () => setNotice(`已请求在新的终端窗口启动 ${name}，实例状态见下方。`),
    });
  };

  if (chatAgent) {
    return <ChatPanel agent={chatAgent} onBack={() => setChatAgentId(null)} />;
  }

  const isLoading = runtimesQuery.isLoading || agentsQuery.isLoading;

  return (
    <div className="h-full overflow-y-auto p-3 sm:p-6">
      <div className="max-w-2xl mx-auto space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-ink font-semibold text-base flex items-center gap-2">
              <Bot size={16} className="text-ink-muted" /> 助手
            </h2>
            <p className="text-xs text-ink-muted mt-0.5">
              编码助手 = CLI 启动配置与运行实例；模型助手 = 独立 API 对话。名称相同仍是不同对象。
            </p>
          </div>
          <button
            onClick={() => setWizardOpen(true)}
            className="flex shrink-0 items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-on-accent text-xs hover:bg-accent-deep transition-colors"
          >
            <Plus size={13} /> 创建{CATEGORY_LABELS[category]}
          </button>
        </div>

        <div className="flex bg-surface border border-line rounded-lg overflow-hidden text-xs w-fit">
          {(Object.keys(CATEGORY_LABELS) as Category[]).map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              aria-pressed={category === c}
              className={`px-3.5 py-1.5 transition-colors ${
                category === c
                  ? "bg-accent text-on-accent"
                  : "text-ink-muted hover:bg-tile-hover hover:text-ink"
              }`}
            >
              {CATEGORY_LABELS[c]}
            </button>
          ))}
        </div>

        {notice && (
          <div
            role="status"
            className={`text-xs px-3 py-2 rounded-lg border ${
              start.isError
                ? "bg-danger-soft border-danger/30 text-danger"
                : "bg-info-soft border-info/30 text-info"
            }`}
          >
            {notice}
          </div>
        )}

        {isLoading ? (
          <div className="text-center text-ink-faint text-sm py-10">
            <Loader2 size={16} className="inline-block animate-spin mr-1.5" />
            加载助手…
          </div>
        ) : category === "coding" ? (
          <>
            {catalog.coding.length === 0 && (
              <div className="text-center text-ink-faint text-sm py-10 border border-dashed border-line-strong rounded-xl">
                还没有编码助手预设。点「创建编码助手」新建一个 CLI 启动配置。
              </div>
            )}
            <div className="space-y-3">
              {catalog.coding.map((item) => (
                <CodingCard
                  key={item.key}
                  item={item}
                  expanded={expandedPreset === item.preset.id}
                  onToggle={() =>
                    setExpandedPreset(expandedPreset === item.preset.id ? null : item.preset.id)
                  }
                  runtimeLabel={runtimeLabel}
                  start={start}
                  launch={launch}
                  del={delPreset}
                  onOpenSession={onOpenSession}
                  onOpenPty={(id) => setPtyAgentId((prev) => (prev === id ? null : id))}
                  ptyOpen={ptyAgentId === item.preset.id}
                />
              ))}
            </div>
            {catalog.orphanInstances.length > 0 && (
              <RuntimeInstancesPanel
                instances={catalog.orphanInstances}
                title="无关联配置的运行记录"
                active={active}
              />
            )}
          </>
        ) : (
          <>
            {catalog.models.length === 0 && (
              <div className="text-center text-ink-faint text-sm py-10 border border-dashed border-line-strong rounded-xl">
                还没有模型助手。点「创建模型助手」配置一个 API 对话人格。
              </div>
            )}
            <div className="space-y-2">
              {catalog.models.map(({ key, agent }) => (
                <ModelCard
                  key={key}
                  agent={agent}
                  onChat={() => setChatAgentId(agent.id)}
                  onDelete={() => delAgent.mutate(agent.id)}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {ptyAgentId !== null && category === "coding" && (
        <div className="mt-4 border border-line rounded-xl overflow-hidden bg-surface h-[300px] flex-shrink-0 max-w-2xl mx-auto">
          <PtyPanel
            agentId={ptyAgentId}
            agentName={
              catalog.coding.find((c) => c.preset.id === ptyAgentId)?.preset.name ??
              `助手 #${ptyAgentId}`
            }
            active={active}
          />
        </div>
      )}

      <CreateAgentWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        initialKind={category}
        onCreated={handleCreated}
      />
    </div>
  );
}

function CodingCard({
  item,
  expanded,
  onToggle,
  runtimeLabel,
  start,
  launch,
  del,
  onOpenSession,
  onOpenPty,
  ptyOpen,
}: {
  item: CodingAssistantItem;
  expanded: boolean;
  onToggle: () => void;
  runtimeLabel: (id: string) => string;
  start: ReturnType<typeof useStartRuntimeAgent>;
  launch: (id: number, name: string) => void;
  del: ReturnType<typeof useDeleteRuntimeAgent>;
  onOpenSession?: (sessionId: string) => void;
  onOpenPty: (id: number) => void;
  ptyOpen: boolean;
}) {
  const { preset, instances, sessions } = item;
  // stats derive from the real instances — the preset's live flag never
  // decides what the user is told here
  const running = instances.filter((i) => i.state === "running" || i.state === "starting").length;
  return (
    <div className="rounded-xl bg-surface border border-line overflow-hidden">
      <div
        className="flex flex-wrap items-center gap-3 p-3 cursor-pointer"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <div className="w-8 h-8 rounded-lg bg-tile flex items-center justify-center flex-shrink-0">
          <Cpu size={15} className="text-ink-muted" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-ink truncate">{preset.name}</span>
            <span className="text-2xs px-1.5 py-px rounded bg-tile text-ink-muted font-mono">
              {runtimeLabel(preset.runtime)}
            </span>
            {preset.model && (
              <span className="text-2xs text-ink-faint font-mono truncate">{preset.model}</span>
            )}
            {(preset.interval_min ?? 0) > 0 && (
              <span
                className="text-2xs px-1.5 py-px rounded bg-info-soft text-info border border-info/30 font-medium flex items-center gap-0.5 flex-shrink-0"
                title={
                  preset.last_scheduled_run
                    ? `上次自动运行 ${new Date(preset.last_scheduled_run).toLocaleString()}`
                    : "尚未自动运行"
                }
              >
                <Clock size={9} />每 {preset.interval_min} 分钟
              </span>
            )}
          </div>
          <div className="text-2xs text-ink-muted flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5 min-w-0">
            <span className="flex items-center gap-1 min-w-0">
              <FolderOpen size={10} className="flex-shrink-0" />
              <span className="truncate" title={preset.workdir ?? ""}>
                {preset.workdir || "(未设置目录)"}
              </span>
            </span>
            {/* object-sourced stats: instance/session counts by identity */}
            <span className="text-ink-faint">· 运行中 {running} 个实例</span>
            <span className="text-ink-faint">· 关联 {sessions.length} 个会话</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => launch(preset.id, preset.name)}
            disabled={start.isPending && start.variables === preset.id}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-accent text-on-accent text-xs hover:bg-accent-deep disabled:opacity-50"
            title="在新终端窗口启动"
          >
            {start.isPending && start.variables === preset.id ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Terminal size={12} />
            )}
            启动
          </button>
          <button
            onClick={() => onOpenPty(preset.id)}
            aria-pressed={ptyOpen}
            title="查看终端输出（桌面端）"
            className={`p-1.5 rounded-lg transition-colors ${
              ptyOpen ? "bg-accent-soft text-accent" : "text-ink-faint hover:bg-tile-hover"
            }`}
          >
            <Terminal size={13} />
          </button>
          <button
            onClick={() => del.mutate(preset.id)}
            className="p-1.5 rounded-lg text-ink-faint hover:text-danger hover:bg-danger-soft"
            title="删除预设"
          >
            <Trash2 size={13} />
          </button>
          {expanded ? (
            <ChevronUp size={14} className="text-ink-faint" />
          ) : (
            <ChevronDown size={14} className="text-ink-faint" />
          )}
        </div>
      </div>

      {expanded && (
        <div className="px-3 pb-3 space-y-3 border-t border-line pt-3">
          {/* only REAL session bindings appear here — a starting instance
              without a session id offers no conversation entry */}
          {sessions.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {sessions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onOpenSession?.(s.id)}
                  title={`打开会话 ${s.id}`}
                  className="text-2xs px-2 py-1 rounded-md bg-tile border border-line text-ink-muted hover:border-accent/60 hover:text-accent"
                >
                  <MessageSquare size={10} className="inline mr-1" />
                  {s.name}
                </button>
              ))}
            </div>
          )}
          <div className="space-y-2">
            {instances.length === 0 && (
              <div className="text-2xs text-ink-faint px-1">
                还没有运行实例。启动后 starting 实例先出现在这里，取得会话后才能打开会话。
              </div>
            )}
            {instances.map((inst) => (
              <RuntimeInstanceRow key={inst.id} instance={inst} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ModelCard({
  agent,
  onChat,
  onDelete,
}: {
  agent: Agent;
  onChat: () => void;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-xl border border-line bg-surface overflow-hidden">
      <div className="flex items-center gap-3 p-4 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <div className="w-9 h-9 rounded-lg bg-indigo-600 flex items-center justify-center flex-shrink-0">
          <Bot size={17} className="text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm text-ink font-medium truncate">{agent.name}</div>
          <div className="flex items-center gap-2 text-2xs text-ink-muted mt-0.5">
            <span className="px-1.5 py-0.5 rounded-md bg-paper text-ink-muted border border-line">
              {agent.model_config.provider}
            </span>
            <span>{agent.model_config.model}</span>
            {/* this conversation stays separate from rooms — no join entry */}
            <span className="px-1.5 py-0.5 rounded-md bg-paper text-ink-faint border border-line">
              独立对话
            </span>
          </div>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onChat();
          }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-accent hover:bg-accent-deep text-on-accent transition-colors shadow-sm"
        >
          <MessageSquare size={12} /> 对话
        </button>
        {expanded ? (
          <ChevronUp size={14} className="text-ink-faint" />
        ) : (
          <ChevronDown size={14} className="text-ink-faint" />
        )}
      </div>
      {expanded && (
        <div className="px-4 pb-4 space-y-3">
          {agent.description && <div className="text-xs text-ink-muted">{agent.description}</div>}
          <div>
            <div className="text-2xs text-ink-faint mb-1.5">System Prompt</div>
            <pre className="text-2xs text-ink-muted font-mono whitespace-pre-wrap bg-paper p-3 rounded-lg border border-line max-h-40 overflow-y-auto">
              {agent.system_prompt}
            </pre>
          </div>
          <div className="flex items-center justify-between text-2xs text-ink-faint">
            <span>
              ID: {agent.id} · 更新于 {new Date(agent.updated_at).toLocaleString()}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="flex items-center gap-1 text-red-500/70 hover:text-red-500"
            >
              <Trash2 size={11} /> 删除
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
