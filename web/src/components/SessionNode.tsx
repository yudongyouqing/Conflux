import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { FileText, Inbox } from "lucide-react";

export interface SessionNodeData {
  name: string;
  status: string;
  context_count: number;
  pending_inbox: number;
  [key: string]: unknown;
}

const STATUS_BORDER: Record<string, string> = {
  active: "border-green-500",
  stale: "border-gray-500",
  ended: "border-red-500",
};

const STATUS_DOT: Record<string, string> = {
  active: "bg-green-500",
  stale: "bg-gray-400",
  ended: "bg-red-500",
};

export type SessionNodeType = Node<SessionNodeData>;

export function SessionNode({ data, selected }: NodeProps) {
  const d = data as SessionNodeData;
  return (
    <div
      className={`px-3 py-2 rounded-lg bg-slate-800 border-2 shadow-lg min-w-[120px] transition-shadow ${
        STATUS_BORDER[d.status] ?? "border-slate-600"
      } ${selected ? "ring-2 ring-blue-500 ring-offset-0" : ""}`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!w-2 !h-2 !bg-slate-500 !border-none"
      />
      <div className="flex items-center gap-2">
        <span
          className={`w-2 h-2 rounded-full ${
            STATUS_DOT[d.status] ?? "bg-gray-500"
          }`}
        />
        <span className="text-white text-xs font-medium truncate max-w-[100px]">
          {d.name}
        </span>
      </div>
      <div className="flex items-center gap-3 mt-1 text-[10px] text-slate-400">
        {d.context_count > 0 && (
          <span className="flex items-center gap-0.5">
            <FileText size={10} /> {d.context_count}
          </span>
        )}
        {d.pending_inbox > 0 && (
          <span className="flex items-center gap-0.5 text-amber-400">
            <Inbox size={10} /> {d.pending_inbox}
          </span>
        )}
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className="!w-2 !h-2 !bg-slate-500 !border-none"
      />
    </div>
  );
}
