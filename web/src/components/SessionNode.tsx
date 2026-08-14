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
  active: "border-emerald-300",
  stale: "border-gray-300",
  ended: "border-red-300",
};

const STATUS_DOT: Record<string, string> = {
  active: "bg-emerald-500",
  stale: "bg-gray-400",
  ended: "bg-red-500",
};

export type SessionNodeType = Node<SessionNodeData>;

export function SessionNode({ data, selected, dragging }: NodeProps) {
  const d = data as SessionNodeData;
  const isAgent = d.type === "agent";

  return (
    <div
      className={`px-3 py-2 rounded-xl border min-w-[120px] transition-all duration-150 cursor-grab active:cursor-grabbing ${
        dragging
          ? "shadow-xl scale-[1.03] ring-2 ring-blue-500/40"
          : selected
            ? "shadow-md ring-2 ring-blue-500/60 ring-offset-1 ring-offset-gray-50"
            : "shadow-sm hover:shadow-md"
      } ${
        isAgent ? "bg-indigo-50 border-indigo-300" : "bg-white border-gray-200"
      } ${STATUS_BORDER[d.status] ?? "border-gray-200"}`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!w-2 !h-2 !bg-gray-400"
      />
      <div className="flex items-center gap-2">
        {isAgent ? (
          <div className="w-5 h-5 rounded-md bg-indigo-600 flex items-center justify-center flex-shrink-0">
            <Bot size={12} className="text-white" />
          </div>
        ) : (
          <span
            className={`w-2 h-2 rounded-full flex-shrink-0 ${
              STATUS_DOT[d.status] ?? "bg-gray-400"
            }`}
          />
        )}
        <span className="text-gray-900 text-xs font-medium truncate max-w-[100px]">
          {d.name}
        </span>
      </div>
      <div className="flex items-center gap-3 mt-1 text-[10px] text-gray-500">
        {d.context_count > 0 && (
          <span className="flex items-center gap-0.5">
            <FileText size={10} /> {d.context_count}
          </span>
        )}
        {d.pending_inbox > 0 && (
          <span className="flex items-center gap-0.5 text-amber-600">
            <Inbox size={10} /> {d.pending_inbox}
          </span>
        )}
        {isAgent && (d.conversation_count ?? 0) > 0 && (
          <span className="flex items-center gap-0.5 text-indigo-600">
            <MessageSquare size={10} /> {d.conversation_count}
          </span>
        )}
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className="!w-2 !h-2 !bg-gray-400"
      />
    </div>
  );
}
