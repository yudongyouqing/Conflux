import type { NodeProps, Node } from "@xyflow/react";
import { Folder, Ghost, Archive } from "lucide-react";

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
 * OWNS its child session nodes (React Flow parentId + extent), making the
 * grouping visually explicit instead of implied by a row caption.
 *
 *  - variant "dir": solid tinted card, folder icon, live-count pill — the
 *    primary grouping in the dirs view mode.
 *  - variant "archive": dashed gray frame for offline orphans — archive
 *    semantics, "not live".
 *
 * Collapsed it is a header-only bar; expanded GraphTab lays children out on
 * an absolute grid below the header. Clicking the header toggles collapse
 * (handled in GraphTab via data.key).
 */
export function GroupFrame({ data }: NodeProps) {
  const d = data as GroupFrameData;
  const isDir = d.variant === "dir";
  const title = d.label ?? "已离线";
  const Icon = isDir ? Folder : Ghost;
  const active = d.activeCount ?? 0;

  const shell = isDir
    ? "bg-blue-50/60 border-blue-200/80 hover:border-blue-300"
    : "border-dashed border-gray-300 bg-gray-50/50 hover:border-gray-400";
  const accent = isDir ? "bg-blue-400/70" : "bg-gray-300";
  const iconBlock = isDir
    ? "bg-blue-100 border-blue-200 text-blue-600"
    : "bg-gray-100 border-gray-200 text-gray-400";

  return (
    <div
      className={`group relative rounded-2xl border ${shell} cursor-pointer select-none overflow-hidden transition-colors`}
      style={{ width: d.width, height: d.height }}
    >
      <div className={`h-[3px] ${accent}`} />
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-2">
        <div
          className={`w-7 h-7 rounded-lg border flex items-center justify-center flex-shrink-0 ${iconBlock}`}
        >
          <Icon size={14} />
        </div>
        <span
          className={`text-xs font-semibold truncate ${isDir ? "text-gray-700" : "text-gray-500"}`}
          title={d.label ?? undefined}
        >
          {title}
        </span>
        <span
          className={`flex items-center gap-0.5 text-[10px] font-medium rounded-full px-1.5 py-px border flex-shrink-0 ${
            isDir
              ? "bg-white border-blue-200 text-blue-600"
              : "bg-white border-gray-200 text-gray-400"
          }`}
        >
          <Archive size={9} /> {d.count}
        </span>
        {isDir && (
          <span
            className={`flex items-center gap-1 text-[10px] font-medium rounded-full px-1.5 py-px border flex-shrink-0 ${
              active > 0
                ? "bg-emerald-50 border-emerald-200 text-emerald-600"
                : "bg-gray-50 border-gray-200 text-gray-400"
            }`}
            title={active > 0 ? `${active} 个会话在线` : "该目录暂无在线会话"}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${active > 0 ? "bg-emerald-500" : "bg-gray-300"}`}
            />
            {active > 0 ? `${active} 在线` : "全离线"}
          </span>
        )}
        <span className="ml-auto text-[9px] text-gray-400 uppercase tracking-wide flex-shrink-0">
          {d.expanded ? "点击折叠" : "点击展开"}
        </span>
      </div>
      {!d.expanded && (
        <div className="px-3 pb-2.5 text-[10px] text-gray-400">
          {isDir ? "目录会话已折叠" : `${d.count} 个离线会话`}
        </div>
      )}
    </div>
  );
}
