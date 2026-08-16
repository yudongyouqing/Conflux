import { type NodeProps, type Node } from "@xyflow/react";
import { Folder } from "lucide-react";

export interface DirLabelData {
  label: string;
  [key: string]: unknown;
}

export type DirLabelNodeType = Node<DirLabelData>;

/**
 * Plain row caption for the dirs view mode: a folder icon + directory name
 * at the left edge of a row of individually laid-out session nodes.
 */
export function DirLabelNode({ data }: NodeProps) {
  const d = data as DirLabelData;
  return (
    <div className="flex items-center gap-1.5 select-none" style={{ width: 160 }}>
      <Folder size={13} className="text-gray-400 flex-shrink-0" />
      <span className="text-xs font-medium text-gray-500 truncate" title={d.label}>
        {d.label}
      </span>
    </div>
  );
}
