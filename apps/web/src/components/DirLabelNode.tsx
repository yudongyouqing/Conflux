import { type NodeProps, type Node } from "@xyflow/react";
import { Folder } from "lucide-react";

export interface DirLabelData {
  label: string;
  [key: string]: unknown;
}

export type DirLabelNodeType = Node<DirLabelData>;

/**
 * Plain row caption for the dirs view mode: a folder icon block + directory
 * name at the left edge of a row of individually laid-out session nodes —
 * same icon-block language as SessionNode, muted to stay a caption.
 */
export function DirLabelNode({ data }: NodeProps) {
  const d = data as DirLabelData;
  return (
    <div className="flex items-center gap-2 select-none" style={{ width: 176 }}>
      <div className="w-6 h-6 rounded-lg bg-gray-100 border border-gray-200 flex items-center justify-center flex-shrink-0">
        <Folder size={12} className="text-gray-400" />
      </div>
      <span
        className="text-[11px] font-semibold text-gray-500 truncate"
        style={{ maxWidth: 176 - 32 }}
        title={d.label}
      >
        {d.label}
      </span>
    </div>
  );
}
