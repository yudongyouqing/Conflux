import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { Ghost } from "lucide-react";

export interface StaleClusterData {
  count: number;
  expanded: boolean;
  width: number;
  height: number;
  [key: string]: unknown;
}

export type StaleClusterNodeType = Node<StaleClusterData>;

/**
 * Collapsible container for offline (stale/ended) sessions. Collapsed it is
 * a single small node with the offline count; expanded it becomes a dashed
 * rectangle whose children (the individual stale session nodes) are laid out
 * on an absolute grid inside it by GraphTab.
 */
export function StaleCluster({ data }: NodeProps) {
  const d = data as StaleClusterData;

  if (!d.expanded) {
    return (
      <div
        className="px-3 py-2 rounded-xl border border-dashed border-gray-300 bg-gray-100/80 hover:bg-gray-100 cursor-pointer transition-colors select-none"
        style={{ width: 148 }}
      >
        <Handle type="target" position={Position.Left} className="!w-2 !h-2 !bg-gray-300" />
        <div className="flex items-center gap-2">
          <Ghost size={14} className="text-gray-400 flex-shrink-0" />
          <span className="text-gray-500 text-xs font-medium">已离线 {d.count}</span>
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
        <Ghost size={13} className="text-gray-400" />
        <span className="text-gray-500 text-xs font-medium">已离线 {d.count}</span>
        <span className="text-[10px] text-gray-400">点击折叠</span>
      </div>
    </div>
  );
}
