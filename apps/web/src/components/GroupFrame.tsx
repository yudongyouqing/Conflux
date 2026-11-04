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
    ? "bg-paper/70 border-line/90 hover:border-accent/70 hover:bg-accent-soft/40"
    : "border-dashed border-line-strong/80 bg-paper/40 hover:border-neutral";

  return (
    <div
      className={`group relative rounded-2xl border ${shell} cursor-pointer select-none overflow-hidden transition-colors ${
        d.expanded ? "bg-accent-soft/30 border-accent/30" : ""
      }`}
      style={{ width: d.width, height: d.height }}
    >
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1">
        <div
          className={`w-6 h-6 rounded-md border flex items-center justify-center flex-shrink-0 ${
            isDir
              ? "bg-accent-soft border-accent/20 text-accent"
              : "bg-neutral-soft border-line text-neutral"
          }`}
        >
          <Icon size={12} />
        </div>
        <span
          className={`text-xs font-semibold truncate ${isDir ? "text-ink-muted" : "text-neutral"}`}
          title={d.label ?? undefined}
        >
          {title}
        </span>
        <span className="text-2xs text-ink-faint tabular-nums flex-shrink-0">{d.count}</span>
        {isDir && (
          <span
            className={`flex items-center gap-1 text-2xs font-medium flex-shrink-0 ${
              active > 0 ? "text-success" : "text-neutral"
            }`}
            title={active > 0 ? `${active} 个会话在线` : "该目录暂无在线会话"}
          >
            <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full ${active > 0 ? "bg-success" : "bg-neutral"}`} />
            {active > 0 ? `${active} 在线` : "离线"}
          </span>
        )}
        {/* runtime identity dots: which CLIs are alive here, at a glance */}
        {!d.expanded && (d.runtimeDots?.length ?? 0) > 0 && (
          <span className="flex items-center -space-x-1 flex-shrink-0" title="在线会话的运行时">
            {d.runtimeDots!.map((c, i) => (
              <span
                key={i}
                className={`w-2 h-2 rounded-full border border-surface shadow-sm ${c}`}
              />
            ))}
          </span>
        )}
        <span className="ml-auto text-ink-faint group-hover:text-ink-muted flex-shrink-0 transition-colors">
          {d.expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
      </div>

      {!d.expanded ? (
        <div className="px-3 pb-2 text-2xs text-ink-faint">
          {d.count} 个会话 · 点击展开
        </div>
      ) : (d.hiddenCount ?? 0) > 0 ? (
        <div className="absolute bottom-1.5 right-3 text-2xs font-medium text-ink-faint bg-surface/80 border border-line rounded-full px-1.5">
          还有 {d.hiddenCount} 个未显示
        </div>
      ) : null}
    </div>
  );
}
