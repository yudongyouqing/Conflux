import type { RuntimeInstance } from "@conflux/shared";
import { Loader2, RotateCw, Square } from "lucide-react";
import { useRuntimeInstances, useStopRuntimeInstance, useResumeRuntimeInstance } from "../hooks";

const STATE_STYLE: Record<RuntimeInstance["state"], string> = {
  starting: "text-info bg-info-soft",
  running: "text-success bg-success-soft",
  stale: "text-warning bg-warning-soft",
  ended: "text-neutral bg-neutral-soft",
  failed: "text-danger bg-danger-soft",
};
const STATE_LABEL = {
  starting: "启动中",
  running: "运行中",
  stale: "失联",
  ended: "已结束",
  failed: "启动失败",
};
const timeOf = (value: string | null) => (value ? new Date(value).toLocaleString() : "暂无");

export function RuntimeInstancesPanel() {
  const instances = useRuntimeInstances();
  return (
    <section className="border-t border-line pt-5" aria-labelledby="runtime-instances-title">
      <div className="flex items-center justify-between gap-3">
        <h3 id="runtime-instances-title" className="text-sm font-semibold text-ink">
          运行实例
        </h3>
        <span className="text-2xs text-ink-faint">每 5 秒刷新</span>
      </div>
      <p className="text-xs text-ink-muted mt-1 mb-3">
        每次启动独立记录；恢复会创建新实例，保留原实例历史。
      </p>
      {instances.isLoading && <p className="text-xs text-ink-faint py-3">加载实例…</p>}
      {instances.error && (
        <p role="alert" className="text-xs text-danger py-3">
          实例加载失败：{instances.error.message}
        </p>
      )}
      {!instances.isLoading && !instances.error && instances.data?.instances.length === 0 && (
        <p className="text-xs text-ink-faint py-4">暂无运行实例，启动上方预设后会显示在这里。</p>
      )}
      <div className="space-y-3">
        {instances.data?.instances.map((instance) => (
          <RuntimeInstanceRow key={instance.id} instance={instance} />
        ))}
      </div>
    </section>
  );
}

function RuntimeInstanceRow({ instance }: { instance: RuntimeInstance }) {
  const stop = useStopRuntimeInstance();
  const resume = useResumeRuntimeInstance();
  const busy = stop.isPending || resume.isPending;
  const stopped =
    instance.state === "ended" || instance.state === "stale" || instance.state === "failed";
  return (
    <article className="rounded-xl bg-surface border border-line p-3 min-w-0">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="text-sm font-medium text-ink break-words">{instance.preset_name}</h4>
          <p className="text-2xs text-ink-muted font-mono break-all mt-0.5">
            {instance.runtime} / {instance.id}
          </p>
        </div>
        <span className={`shrink-0 rounded-md px-2 py-0.5 text-2xs ${STATE_STYLE[instance.state]}`}>
          {STATE_LABEL[instance.state]}
        </span>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 mt-3 text-xs">
        <dt className="text-ink-faint">项目</dt>
        <dd className="text-ink-muted font-mono break-all">{instance.workdir || "未设置目录"}</dd>
        <dt className="text-ink-faint">会话</dt>
        <dd className="text-ink-muted font-mono break-all">
          {instance.session_id || "等待会话绑定"}
        </dd>
        <dt className="text-ink-faint">运行时 PID</dt>
        <dd className="text-ink-muted font-mono">{instance.runtime_pid ?? "未绑定"}</dd>
        <dt className="text-ink-faint">启动时间</dt>
        <dd className="text-ink-muted">{timeOf(instance.created_at)}</dd>
        <dt className="text-ink-faint">最近心跳</dt>
        <dd className="text-ink-muted">{timeOf(instance.last_seen)}</dd>
        {instance.ended_at && (
          <>
            <dt className="text-ink-faint">结束时间</dt>
            <dd className="text-ink-muted">{timeOf(instance.ended_at)}</dd>
          </>
        )}
        {instance.resumed_from && (
          <>
            <dt className="text-ink-faint">恢复来源</dt>
            <dd className="text-ink-muted font-mono break-all">{instance.resumed_from}</dd>
          </>
        )}
      </dl>
      {instance.error && <p className="mt-2 text-xs text-danger break-words">{instance.error}</p>}
      {instance.limitation && (
        <p className="mt-2 text-xs text-ink-muted break-words">{instance.limitation}</p>
      )}
      <div className="flex flex-wrap items-center gap-2 mt-3">
        <button
          type="button"
          disabled={!instance.can_stop || busy}
          title={
            !instance.can_stop
              ? (instance.limitation ?? "无法验证该实例的运行时进程，暂不可停止")
              : "停止已验证的运行时进程"
          }
          onClick={() => stop.mutate(instance.id)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-danger/30 text-danger bg-danger-soft disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {stop.isPending ? <Loader2 size={12} className="animate-spin" /> : <Square size={12} />}
          {stop.isPending ? "正在停止…" : "停止实例"}
        </button>
        {stopped && (
          <button
            type="button"
            disabled={!instance.can_resume || busy}
            title={
              !instance.can_resume
                ? (instance.limitation ?? "缺少可恢复的会话或原进程尚未退出")
                : "从原会话恢复并创建新实例"
            }
            onClick={() => resume.mutate(instance.id)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg bg-accent text-on-accent hover:bg-accent-deep disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {resume.isPending ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <RotateCw size={12} />
            )}
            {resume.isPending ? "正在恢复…" : "恢复为新实例"}
          </button>
        )}
      </div>
      {(stop.error || resume.error) && (
        <p role="alert" className="mt-2 text-xs text-danger break-words">
          操作失败：{(stop.error || resume.error)?.message}
        </p>
      )}
      {resume.isSuccess && (
        <p role="status" className="mt-2 text-xs text-info">
          已请求恢复，新实例启动中。
        </p>
      )}
    </article>
  );
}
