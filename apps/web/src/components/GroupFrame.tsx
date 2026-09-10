import type { NodeProps, Node } from "@xyflow/react";
import { Folder, Ghost, ChevronDown, ChevronRight } from "lucide-react";

export interface GroupFrameData {
  /** stable key; the ONE frame whose key matches GraphTab's expandedKey opens */
  key: string;
  variant: "dir" | "archive";
  /** frame title: project directory basename, or null for the offline archive */
  label?: string | null;
  count: number;
  activeCount?: number;
  /** sessions beyond the display cap inside an expanded frame */
  hiddenCount?: number;
  /** tailwind bg classes for active sessions' runtime dots (max 4) */
  runtimeDots?: string[];
  expanded: boolean;
  width: number;
  height: number;
  [key: string]: unknown;
}

export type GroupFrameNodeType = Node<GroupFrameData>;

/**
 * Progressive-disclosure group tile (Google-Maps-cluster / Linear-drill-in
 * pattern) for scale: at overview EVERY directory is one compact tile —
 * name, count, live pill, runtime dots — so the canvas stays constant
 * density no matter how many sessions exist (13 dirs / 57 sessions render
 * as 13 tidy tiles). Clicking a tile drills in (accordion: one frame open
 * at a time); the opened frame shows at most six cards plus a "+N" chip —
 * a 32-session directory can never become a wall of cards again.
 *
 * Chrome stays whisper-quiet (hairline border, near-transparent bg): the
 * cards inside carry the weight, the frame only groups.
 */
export function GroupFrame({ data }: NodeProps) {
  const d = data as GroupFrameData;
  const isDir = d.variant === "dir";
  const title = d.label ?? "已离线";
  const Icon = isDir ? Folder : Ghost;
  const active = d.activeCount ?? 0;

  const shell = isDir
    ? "bg-slate-50/70 border-slate-200/90 hover:border-blue-300/70 hover:bg-blue-50/40"
    : "border-dashed border-slate-300/80 bg-slate-50/40 hover:border-slate-400";

  return (
    <div
      className={`group relative rounded-2xl border ${shell} cursor-pointer select-none overflow-hidden transition-colors ${
        d.expanded ? "bg-blue-50/30 border-blue-200" : ""
      }`}
      style={{ width: d.width, height: d.height }}
    >
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1">
        <div
          className={`w-6 h-6 rounded-md border flex items-center justify-center flex-shrink-0 ${
            isDir
              ? "bg-blue-50 border-blue-100 text-blue-500"
              : "bg-slate-100 border-slate-200 text-slate-400"
          }`}
        >
          <Icon size={12} />
        </div>
        <span
          className={`text-xs font-semibold truncate ${isDir ? "text-slate-600" : "text-slate-400"}`}
          title={d.label ?? undefined}
        >
          {title}
        </span>
        <span className="text-[10px] text-slate-400 tabular-nums flex-shrink-0">{d.count}</span>
        {isDir && (
          <span
            className={`flex items-center gap-1 text-[10px] font-medium flex-shrink-0 ${
              active > 0 ? "text-emerald-600" : "text-slate-400"
            }`}
            title={active > 0 ? `${active} 个会话在线` : "该目录暂无在线会话"}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${active > 0 ? "bg-emerald-500" : "bg-slate-300"}`} />
            {active > 0 ? `${active} 在线` : "离线"}
          </span>
        )}
        {/* runtime identity dots: which CLIs are alive here, at a glance */}
        {!d.expanded && (d.runtimeDots?.length ?? 0) > 0 && (
          <span className="flex items-center -space-x-1 flex-shrink-0" title="在线会话的运行时">
            {d.runtimeDots!.map((c, i) => (
              <span
                key={i}
                className={`w-2 h-2 rounded-full border border-white shadow-sm ${c}`}
              />
            ))}
          </span>
        )}
        <span className="ml-auto text-slate-300 group-hover:text-slate-500 flex-shrink-0 transition-colors">
          {d.expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
      </div>

      {!d.expanded ? (
        <div className="px-3 pb-2 text-[10px] text-slate-400">
          {d.count} 个会话 · 点击展开
        </div>
      ) : (d.hiddenCount ?? 0) > 0 ? (
        <div className="absolute bottom-1.5 right-3 text-[10px] font-medium text-slate-400 bg-white/80 border border-slate-200 rounded-full px-1.5">
          还有 {d.hiddenCount} 个未显示
        </div>
      ) : null}
    </div>
  );
}
