import type { NodeProps, Node } from "@xyflow/react";
import { Folder, Ghost, ChevronDown, ChevronRight } from "lucide-react";

export interface GroupFrameData {
  /** stable key driving per-frame collapse state (GraphTab keeps the map) */
  key: string;
  variant: "dir" | "archive";
  /** frame title: project directory basename, or null for the offline archive */
  label?: string | null;
  count: number;
  activeCount?: number;
  expanded: boolean;
  width: number;
  height: number;
  [key: string]: unknown;
}

export type GroupFrameNodeType = Node<GroupFrameData>;

/**
 * Canvas group frame (Dify/Figma-section style): a titled container that
 * OWNS its child session nodes (React Flow parentId + extent).
 *
 * The frame is deliberately QUIET chrome — no accent strip, no shadow, hairline
 * border, near-transparent tint. The session cards inside carry the visual
 * weight; the frame only whispers the grouping (a loud container would turn
 * the canvas into stacked slabs).
 *
 *  - variant "dir": cool tint, folder icon, live-count summary.
 *  - variant "archive": dashed outline for offline orphans.
 *
 * Collapsed it is a header-only bar; expanded GraphTab lays children out on
 * an absolute grid below the header. Clicking toggles collapse (GraphTab,
 * via data.key). The chevron indicates the state wordlessly.
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
      className={`group relative rounded-2xl border ${shell} cursor-pointer select-none overflow-hidden transition-colors`}
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
            <span
              className={`w-1.5 h-1.5 rounded-full ${active > 0 ? "bg-emerald-500" : "bg-slate-300"}`}
            />
            {active > 0 ? `${active} 在线` : "离线"}
          </span>
        )}
        <span className="ml-auto text-slate-300 group-hover:text-slate-500 flex-shrink-0 transition-colors">
          {d.expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
      </div>
      {!d.expanded && (
        <div className="px-3 pb-2 text-[10px] text-slate-400">{d.count} 个会话 · 点击展开</div>
      )}
    </div>
  );
}
