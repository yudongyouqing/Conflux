import { useState } from "react";
import { useRuntimes, useDeleteRuntimeAgent, useStartRuntimeAgent } from "../hooks";
import { Terminal, FolderOpen, Cpu, Trash2, Plus, Loader2, Clock } from "lucide-react";
import { CreateAgentWizard } from "./CreateAgentWizard";

export function RuntimesTab() {
  const { data, isLoading, error } = useRuntimes();
  const del = useDeleteRuntimeAgent();
  const start = useStartRuntimeAgent();

  const [wizardOpen, setWizardOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const agents = data?.agents ?? [];
  const runtimeLabel = (id: string) => data?.runtimes[id]?.label ?? id;

  const launch = (id: number, name: string) => {
    setNotice(null);
    start.mutate(id, {
      onError: (e) => setNotice(`启动 ${name} 失败: ${(e as Error).message}`),
      onSuccess: () => setNotice(`已在新的终端窗口启动 ${name}`),
    });
  };

  if (isLoading)
    return (
      <div className="flex items-center justify-center h-full text-ink-faint text-sm">
        加载运行时...
      </div>
    );

  if (error)
    return (
      <div className="flex items-center justify-center h-full text-red-500 text-sm">
        连接失败: {(error as Error).message}
      </div>
    );

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-2xl mx-auto space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-ink font-semibold text-base flex items-center gap-2">
              <Terminal size={16} className="text-cyan-600" /> 运行时 Agents
            </h2>
            <p className="text-xs text-ink-muted mt-0.5">
              预设 CLI agent(Claude Code / Codex):固定目录 + API 渠道,一键在
              新终端窗口拉起并接入图。
            </p>
          </div>
          <button
            onClick={() => setWizardOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-800 text-white text-xs hover:bg-gray-700 transition-colors"
          >
            <Plus size={13} />
            新建
          </button>
        </div>

        {notice && (
          <div className="text-xs px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-800">
            {notice}
          </div>
        )}

        {agents.length === 0 ? (
          <div className="text-center text-ink-faint text-sm py-10 border border-dashed border-line-strong rounded-xl">
            还没有运行时 agent 预设。点「新建」创建一个。
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            <KanbanColumn
              title="运行中"
              accent="border-emerald-300 bg-emerald-50/60"
              countAccent="text-emerald-700"
              agents={agents.filter((a) => a.live)}
              runtimeLabel={runtimeLabel}
              launch={launch}
              del={del}
              start={start}
              emptyHint="没有存活的实例 — 启动一个预设或等心跳超时后回这里。"
            />
            <KanbanColumn
              title="离线"
              accent="border-line-strong bg-paper/60"
              countAccent="text-ink-muted"
              agents={agents.filter((a) => !a.live)}
              runtimeLabel={runtimeLabel}
              launch={launch}
              del={del}
              start={start}
              emptyHint="全部在跑,没有离线预设。"
            />
          </div>
        )}
      </div>

      <CreateAgentWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />
    </div>
  );
}

function KanbanColumn({
  title,
  accent,
  countAccent,
  agents,
  runtimeLabel,
  launch,
  del,
  start,
  emptyHint,
}: {
  title: string;
  accent: string;
  countAccent: string;
  agents: import("@conflux/shared").RuntimeAgent[];
  runtimeLabel: (id: string) => string;
  launch: (id: number, name: string) => void;
  del: ReturnType<typeof useDeleteRuntimeAgent>;
  start: ReturnType<typeof useStartRuntimeAgent>;
  emptyHint: string;
}) {
  return (
    <div className={`rounded-xl border ${accent} p-3 min-h-[120px]`}>
      <div className="flex items-center justify-between mb-2.5 px-1">
        <span className={`text-xs font-semibold ${countAccent}`}>{title}</span>
        <span className={`text-[10px] ${countAccent}`}>{agents.length}</span>
      </div>
      {agents.length === 0 ? (
        <div className="text-[11px] text-ink-faint text-center py-6">{emptyHint}</div>
      ) : (
        <div className="space-y-2">
          {agents.map((a) => (
            <div
              key={a.id}
              className="bg-white border border-line rounded-xl p-3 shadow-sm flex items-center gap-3"
            >
              <div className="w-8 h-8 rounded-lg bg-cyan-50 border border-cyan-200 flex items-center justify-center flex-shrink-0">
                <Cpu size={15} className="text-cyan-600" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-ink truncate">{a.name}</span>
                  <span className="text-[10px] px-1.5 py-px rounded bg-cyan-50 text-cyan-700 border border-cyan-200 font-medium">
                    {runtimeLabel(a.runtime)}
                  </span>
                  {a.model && (
                    <span className="text-[10px] text-ink-faint font-mono truncate">{a.model}</span>
                  )}
                  {(a.interval_min ?? 0) > 0 && (
                    <span
                      className="text-[10px] px-1.5 py-px rounded bg-violet-50 text-violet-700 border border-violet-200 font-medium flex items-center gap-0.5 flex-shrink-0"
                      title={
                        a.last_scheduled_run
                          ? `上次自动运行 ${new Date(a.last_scheduled_run).toLocaleString()}`
                          : "尚未自动运行"
                      }
                    >
                      <Clock size={9} />每 {a.interval_min} 分钟
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-ink-muted flex items-center gap-1 mt-0.5 min-w-0">
                  <FolderOpen size={10} className="flex-shrink-0" />
                  <span className="truncate" title={a.workdir ?? ""}>
                    {a.workdir || "(未设置目录)"}
                  </span>
                  {a.last_seen && (
                    <span
                      className="text-ink-faint truncate"
                      title={`最近心跳 ${new Date(a.last_seen).toLocaleString()}`}
                    >
                      · {new Date(a.last_seen).toLocaleTimeString()}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <button
                  onClick={() => launch(a.id, a.name)}
                  disabled={start.isPending && start.variables === a.id}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-emerald-600 text-white text-xs hover:bg-emerald-500 disabled:opacity-50"
                  title="在新终端窗口启动"
                >
                  {start.isPending && start.variables === a.id ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Terminal size={12} />
                  )}
                  启动
                </button>
                <button
                  onClick={() => del.mutate(a.id)}
                  className="p-1.5 rounded-lg text-ink-faint hover:text-red-500 hover:bg-red-50"
                  title="删除预设"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
