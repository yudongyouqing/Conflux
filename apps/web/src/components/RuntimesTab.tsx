import { useState } from "react";
import {
  useRuntimes,
  useCreateRuntimeAgent,
  useDeleteRuntimeAgent,
  useStartRuntimeAgent,
} from "../hooks";
import type { RuntimeId } from "@muiltchat/shared";
import { Terminal, FolderOpen, Cpu, Trash2, Plus, Loader2, Clock } from "lucide-react";

const EMPTY_FORM = {
  interval_min: "",
  name: "",
  runtime: "claude" as RuntimeId,
  workdir: "",
  model: "",
  base_url: "",
  api_key: "",
  extra_env: "",
  instructions: "",
};

export function RuntimesTab() {
  const { data, isLoading, error } = useRuntimes();
  const create = useCreateRuntimeAgent();
  const del = useDeleteRuntimeAgent();
  const start = useStartRuntimeAgent();

  const [form, setForm] = useState(EMPTY_FORM);
  const [showForm, setShowForm] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const agents = data?.agents ?? [];
  const runtimeLabel = (id: string) => data?.runtimes[id]?.label ?? id;

  const set = <K extends keyof typeof EMPTY_FORM>(k: K, v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  const submit = () => {
    if (!form.name.trim() || create.isPending) return;
    create.mutate(
      {
        name: form.name,
        runtime: form.runtime,
        workdir: form.workdir || undefined,
        model: form.model || undefined,
        base_url: form.base_url || undefined,
        api_key: form.api_key || undefined,
        extra_env: form.extra_env || undefined,
        instructions: form.instructions || undefined,
        interval_min: form.interval_min.trim() ? Number(form.interval_min) : undefined,
      },
      {
        onSuccess: () => {
          setForm(EMPTY_FORM);
          setShowForm(false);
          setNotice(null);
        },
        onError: (e) => setNotice(`创建失败: ${(e as Error).message}`),
      }
    );
  };

  const launch = (id: number, name: string) => {
    setNotice(null);
    start.mutate(id, {
      onError: (e) => setNotice(`启动 ${name} 失败: ${(e as Error).message}`),
      onSuccess: () => setNotice(`已在新的终端窗口启动 ${name}`),
    });
  };

  if (isLoading)
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-sm">
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
            <h2 className="text-gray-900 font-semibold text-base flex items-center gap-2">
              <Terminal size={16} className="text-cyan-600" /> 运行时 Agents
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              预设 CLI agent(Claude Code / Codex):固定目录 + API 渠道,一键在
              新终端窗口拉起并接入图。
            </p>
          </div>
          <button
            onClick={() => setShowForm((v) => !v)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-800 text-white text-xs hover:bg-gray-700 transition-colors"
          >
            <Plus size={13} />
            {showForm ? "收起" : "新建"}
          </button>
        </div>

        {notice && (
          <div className="text-xs px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-800">
            {notice}
          </div>
        )}

        {showForm && (
          <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3 shadow-sm">
            <div className="grid grid-cols-2 gap-3">
              <Field label="名称 *">
                <input
                  value={form.name}
                  onChange={(e) => set("name", e.target.value)}
                  placeholder="e.g. api-worker"
                  className={inputCls}
                />
              </Field>
              <Field label="运行时 *">
                <select
                  value={form.runtime}
                  onChange={(e) => set("runtime", e.target.value as RuntimeId)}
                  className={inputCls}
                >
                  <option value="claude">Claude Code</option>
                  <option value="codex">Codex</option>
                </select>
              </Field>
            </div>
            <Field label="工作目录(启动后 cd 到这里)">
              <input
                value={form.workdir}
                onChange={(e) => set("workdir", e.target.value)}
                placeholder="C:\Project folder\项目\xxx"
                className={inputCls}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="模型(可选)">
                <input
                  value={form.model}
                  onChange={(e) => set("model", e.target.value)}
                  placeholder="claude-sonnet-4 / gpt-5-codex"
                  className={inputCls}
                />
              </Field>
              <Field label="API Base URL(可选,中转/代理)">
                <input
                  value={form.base_url}
                  onChange={(e) => set("base_url", e.target.value)}
                  placeholder="https://relay.example.com"
                  className={inputCls}
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="定时间隔(分钟,可选)">
                <input
                  value={form.interval_min}
                  onChange={(e) => set("interval_min", e.target.value.replace(/[^0-9]/g, ""))}
                  placeholder="留空 = 仅手动启动;如 30 = 每半小时自动巡检"
                  className={inputCls}
                />
              </Field>
              <Field label="定时说明">
                <div className="text-[11px] text-gray-400 px-1 py-1.5">
                  到点后 headless 唤醒(无窗口):查收件箱、处理待办、简报后退出。
                </div>
              </Field>
            </div>
            <Field label="API Key(可选,启动时注入环境变量,本地存储)">
              <input
                type="password"
                value={form.api_key}
                onChange={(e) => set("api_key", e.target.value)}
                placeholder="sk-..."
                className={inputCls}
              />
            </Field>
            <Field label="额外环境变量(JSON,可选)">
              <textarea
                value={form.extra_env}
                onChange={(e) => set("extra_env", e.target.value)}
                placeholder='{"HTTP_PROXY":"http://127.0.0.1:7890"}'
                rows={2}
                className={`${inputCls} font-mono text-[11px]`}
              />
            </Field>
            <Field label="系统指令(可选,--append-system-prompt)">
              <textarea
                value={form.instructions}
                onChange={(e) => set("instructions", e.target.value)}
                placeholder="你是一个只做 API 对接的后台 worker…"
                rows={3}
                className={inputCls}
              />
            </Field>
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => {
                  setForm(EMPTY_FORM);
                  setShowForm(false);
                }}
                className="px-3 py-1.5 rounded-lg text-xs text-gray-600 hover:bg-gray-100"
              >
                取消
              </button>
              <button
                onClick={submit}
                disabled={!form.name.trim() || create.isPending}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs hover:bg-blue-500 disabled:opacity-50"
              >
                {create.isPending && <Loader2 size={12} className="animate-spin" />}
                创建
              </button>
            </div>
            {create.isError && (
              <div className="text-xs text-red-600">
                {(create.error as Error)?.message}
              </div>
            )}
          </div>
        )}

        {agents.length === 0 && !showForm ? (
          <div className="text-center text-gray-400 text-sm py-10 border border-dashed border-gray-300 rounded-xl">
            还没有运行时 agent 预设。点「新建」创建一个。
          </div>
        ) : (
          <div className="space-y-2">
            {agents.map((a) => (
              <div
                key={a.id}
                className="bg-white border border-gray-200 rounded-xl p-3.5 shadow-sm flex items-center gap-3"
              >
                <div className="w-8 h-8 rounded-lg bg-cyan-50 border border-cyan-200 flex items-center justify-center flex-shrink-0">
                  <Cpu size={15} className="text-cyan-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-900 truncate">
                      {a.name}
                    </span>
                    <span className="text-[10px] px-1.5 py-px rounded bg-cyan-50 text-cyan-700 border border-cyan-200 font-medium">
                      {runtimeLabel(a.runtime)}
                    </span>
                    {a.model && (
                      <span className="text-[10px] text-gray-400 font-mono truncate">
                        {a.model}
                      </span>
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
                        <Clock size={9} />
                        每 {a.interval_min} 分钟
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-gray-500 flex items-center gap-1 mt-0.5 min-w-0">
                    <FolderOpen size={10} className="flex-shrink-0" />
                    <span className="truncate" title={a.workdir ?? ""}>
                      {a.workdir || "(未设置目录)"}
                    </span>
                    {a.base_url && (
                      <span className="text-gray-400 truncate">· {a.base_url}</span>
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
                    className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50"
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
    </div>
  );
}

const inputCls =
  "w-full px-2.5 py-1.5 rounded-lg border border-gray-200 text-xs text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 bg-white";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] text-gray-500 mb-1">{label}</span>
      {children}
    </label>
  );
}
