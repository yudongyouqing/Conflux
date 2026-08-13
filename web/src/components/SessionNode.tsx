import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { FileText, Inbox, Bot, MessageSquare } from "lucide-react";

export interface SessionNodeData {
  name: string;
  status: string;
  type: "session" | "agent";
  context_count: number;
  pending_inbox: number;
  conversation_count?: number;
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
  const isAgent = d.type === "agent";

  return (
    <div
      className={`px-3 py-2 rounded-lg border-2 shadow-lg min-w-[120px] transition-shadow ${
        isAgent ? "bg-indigo-950/60 border-indigo-500" : "bg-slate-800"
      } ${STATUS_BORDER[d.status] ?? "border-slate-600"} ${
        selected ? "ring-2 ring-blue-500 ring-offset-0" : ""
      }`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!w-2 !h-2 !bg-slate-500 !border-none"
      />
      <div className="flex items-center gap-2">
        {isAgent ? (
          <Bot size={14} className="text-indigo-400 flex-shrink-0" />
        ) : (
          <span
            className={`w-2 h-2 rounded-full flex-shrink-0 ${
              STATUS_DOT[d.status] ?? "bg-gray-500"
            }`}
          />
        )}
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
        {isAgent && (d.conversation_count ?? 0) > 0 && (
          <span className="flex items-center gap-0.5 text-indigo-400">
            <MessageSquare size={10} /> {d.conversation_count}
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
