import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { Folder, Ghost, Archive } from "lucide-react";

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
 * Collapsible container for offline (stale/ended) sessions, in the same
 * visual language as SessionNode: a muted icon block + count pill, dashed
 * everything (archive semantics — "not live"). Collapsed it is a single
 * small card with the count; expanded it becomes a dashed rectangle whose
 * children are laid out on an absolute grid inside it by GraphTab. In
 * "dirs" view mode one cluster is rendered per project directory.
 */
export function StaleCluster({ data }: NodeProps) {
  const d = data as StaleClusterData;
  const title = d.label ?? "已离线";
  const Icon = d.label ? Folder : Ghost;

  if (!d.expanded) {
    return (
      <div
        className="group relative rounded-2xl border border-dashed border-gray-300 bg-white/70 hover:bg-white hover:border-gray-400 cursor-pointer transition-all select-none overflow-hidden"
        style={{ width: 200 }}
      >
        <div className="h-[3px] bg-gray-300 group-hover:bg-gray-400 transition-colors" />
        <Handle type="target" position={Position.Left} className="!w-2 !h-2 !bg-gray-300 !border-2 !border-white opacity-50 group-hover:opacity-100 !transition-all" />
        <div className="px-3 pt-2 pb-2.5">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-gray-100 border border-gray-200 flex items-center justify-center flex-shrink-0">
              <Icon size={14} className="text-gray-400" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-gray-500 text-xs font-semibold truncate" title={d.label ?? undefined}>
                  {title}
                </span>
                <span className="ml-auto flex items-center gap-0.5 text-[10px] font-medium text-gray-400 bg-gray-100 border border-gray-200 rounded-full px-1.5 py-px flex-shrink-0">
                  <Archive size={9} /> {d.count}
                </span>
              </div>
              <div className="text-[9px] text-gray-400 uppercase tracking-wide mt-0.5">点击展开</div>
            </div>
          </div>
        </div>
        <Handle type="source" position={Position.Right} className="!w-2 !h-2 !bg-gray-300 !border-2 !border-white opacity-50 group-hover:opacity-100 !transition-all" />
      </div>
    );
  }

  return (
    <div
      className="group rounded-2xl border-2 border-dashed border-gray-300 bg-gray-50/60 hover:border-gray-400 cursor-pointer select-none overflow-hidden"
      style={{ width: d.width, height: d.height }}
    >
      <Handle type="target" position={Position.Left} className="!w-2 !h-2 !bg-gray-300 !border-2 !border-white opacity-50 group-hover:opacity-100 !transition-all" />
      <Handle type="source" position={Position.Right} className="!w-2 !h-2 !bg-gray-300 !border-2 !border-white opacity-50 group-hover:opacity-100 !transition-all" />
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <div className="w-7 h-7 rounded-lg bg-gray-100 border border-gray-200 flex items-center justify-center flex-shrink-0">
          <Icon size={14} className="text-gray-400" />
        </div>
        <span className="text-gray-500 text-xs font-semibold truncate" title={d.label ?? undefined}>
          {title}
        </span>
        <span className="flex items-center gap-0.5 text-[10px] font-medium text-gray-400 bg-white border border-gray-200 rounded-full px-1.5 py-px flex-shrink-0">
          <Archive size={9} /> {d.count}
        </span>
        <span className="ml-auto text-[9px] text-gray-400 uppercase tracking-wide flex-shrink-0">点击折叠</span>
      </div>
    </div>
  );
}
