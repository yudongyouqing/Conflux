import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { Folder, Ghost } from "lucide-react";

export interface StaleClusterData {
  count: number;
  expanded: boolean;
  width: number;
  height: number;
  /** Cluster title: project directory name (dirs mode) or null (offline). */
  label?: string | null;
  /** Full directory key used for expand/collapse state (dirs mode). */
  dir?: string | null;
  [key: string]: unknown;
}

export type StaleClusterNodeType = Node<StaleClusterData>;

/**
 * Collapsible container for offline (stale/ended) sessions. Collapsed it is
 * a single small node with the count; expanded it becomes a dashed rectangle
 * whose children (the individual stale session nodes) are laid out on an
 * absolute grid inside it by GraphTab. In "dirs" view mode one cluster is
 * rendered per project directory (label = dir name); otherwise a single
 * cluster holds all offline sessions.
 */
export function StaleCluster({ data }: NodeProps) {
  const d = data as StaleClusterData;
  const title = d.label ?? "已离线";

  if (!d.expanded) {
    return (
      <div
        className="px-3 py-2 rounded-xl border border-dashed border-gray-300 bg-gray-100/80 hover:bg-gray-100 cursor-pointer transition-colors select-none"
        style={{ width: 176 }}
      >
        <Handle type="target" position={Position.Left} className="!w-2 !h-2 !bg-gray-300" />
        <div className="flex items-center gap-2">
          {d.label ? (
            <Folder size={13} className="text-gray-400 flex-shrink-0" />
          ) : (
            <Ghost size={14} className="text-gray-400 flex-shrink-0" />
          )}
          <span className="text-gray-500 text-xs font-medium truncate" title={d.label ?? undefined}>
            {title} {d.count}
          </span>
        </div>
        <div className="text-[10px] text-gray-400 mt-0.5">点击展开</div>
        <Handle type="source" position={Position.Right} className="!w-2 !h-2 !bg-gray-300" />
      </div>
    );
  }

  return (
    <div
      className="rounded-2xl border-2 border-dashed border-gray-300 bg-gray-100/40 cursor-pointer select-none"
      style={{ width: d.width, height: d.height }}
    >
      <Handle type="target" position={Position.Left} className="!w-2 !h-2 !bg-gray-300" />
      <Handle type="source" position={Position.Right} className="!w-2 !h-2 !bg-gray-300" />
      <div className="flex items-center gap-2 px-3 pt-2">
        {d.label ? (
          <Folder size={13} className="text-gray-400" />
        ) : (
          <Ghost size={13} className="text-gray-400" />
        )}
        <span className="text-gray-500 text-xs font-medium truncate" title={d.label ?? undefined}>
          {title} {d.count}
        </span>
        <span className="text-[10px] text-gray-400">点击折叠</span>
      </div>
    </div>
  );
}
