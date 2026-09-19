import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { FileText, Inbox, Bot, MessageSquare, Globe, Terminal } from "lucide-react";
import type { ElementType } from "react";
import { ClaudeIcon, OpenAIIcon } from "./brand-icons";
import { PLACEHOLDER_DESCRIPTIONS, WEB_CONSOLE_ID } from "@conflux/shared";

export interface SessionNodeData {
  name: string;
  status: string;
  type: "session" | "agent";
  context_count: number;
  pending_inbox: number;
  conversation_count?: number;
  last_heartbeat_at?: string;
  description?: string | null;
  project_dir?: string | null;
  runtime?: string | null;
  /** Agent Card skills (capability self-description). */
  skills?: string[];
  /** Endpoint of the currently selected edge — amber ring emphasis. */
  highlighted?: boolean;
  [key: string]: unknown;
}

/**
 * Dify-style node identity: every node KIND carries a signature color and
 * icon on a left block, plus a thin top accent strip — the graph reads by
 * shape+color before text.
 */
interface NodeSkin {
  /** lucide icons and brand glyphs share the (size, className) surface */
  icon: ElementType;
  block: string; // icon block bg + icon color
  accent: string; // top strip color
}

function skinFor(d: SessionNodeData, isAgent: boolean, isWeb: boolean): NodeSkin {
  if (isAgent) return { icon: Bot, block: "bg-indigo-600", accent: "bg-indigo-500" };
  if (isWeb) return { icon: Globe, block: "bg-blue-600", accent: "bg-blue-500" };
  if (d.runtime === "claude")
    return { icon: ClaudeIcon, block: "bg-orange-600", accent: "bg-orange-500" };
  if (d.runtime === "codex")
    return { icon: OpenAIIcon, block: "bg-slate-700", accent: "bg-slate-500" };
  return { icon: Terminal, block: "bg-gray-500", accent: "bg-gray-400" };
}

const STATUS_DOT: Record<string, string> = {
  active: "bg-emerald-500",
  stale: "bg-gray-300",
  ended: "bg-red-500",
};

export type SessionNodeType = Node<SessionNodeData>;

export function SessionNode({ id, data, selected, dragging }: NodeProps) {
  const d = data as SessionNodeData;
  const isAgent = d.type === "agent";
  // The server registers the browser identity with the fixed WEB_CONSOLE_ID;
  // name matching would break the moment a user renames the session.
  const isWeb = id === WEB_CONSOLE_ID;
  const skin = skinFor(d, isAgent, isWeb);
  const Icon = skin.icon;

  return (
    <div
      title={
        [
          d.priority === "P0" ? "P0 重点会话" : d.priority === "P2" ? "P2 后台会话" : null,
          d.skills?.length ? `技能: ${d.skills.join(" · ")}` : null,
        ]
          .filter(Boolean)
          .join(" | ") || undefined
      }
      className={`group relative w-[176px] rounded-xl bg-white border border-slate-200/70 overflow-hidden transition-all duration-200 ease-out cursor-grab active:cursor-grabbing ${
        dragging
          ? "shadow-[0_12px_28px_rgba(16,24,40,0.18)] scale-[1.02] ring-2 ring-blue-500/30 border-slate-300"
          : selected
            ? "shadow-[0_4px_16px_rgba(37,99,235,0.16)] ring-2 ring-blue-500"
            : "shadow-[0_1px_2px_rgba(16,24,40,0.05),0_4px_12px_rgba(16,24,40,0.06)] hover:shadow-[0_8px_24px_rgba(16,24,40,0.12)] hover:border-slate-300 hover:-translate-y-0.5"
      } ${d.highlighted ? "ring-2 ring-amber-400/80" : ""}`}
    >
      {/* signature top accent strip */}
      <div className={`h-[2.5px] ${skin.accent}`} />

      <Handle
        type="target"
        position={Position.Left}
        className="!w-1.5 !h-1.5 !bg-gray-300 !border-[1.5px] !border-white opacity-50 group-hover:!bg-gray-400 group-hover:opacity-100 !transition-all"
      />

      <div className="px-2.5 py-2">
        {/* header: icon block + name + status */}
        <div className="flex items-center gap-2">
          <div
            className={`w-6 h-6 rounded-[7px] ${skin.block} flex items-center justify-center flex-shrink-0 shadow-sm`}
          >
            <Icon size={12} className="text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1">
              <span
                className="text-gray-900 text-[12px] font-semibold truncate flex-1"
                title={d.name}
              >
                {d.name}
              </span>
              <span
                className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                  STATUS_DOT[d.status] ?? "bg-gray-300"
                } ${d.status === "active" ? "shadow-[0_0_0_2px_rgba(16,185,129,0.15)] animate-pulse" : ""}`}
                title={`状态: ${d.status}`}
              />
            </div>
            {d.runtime && !isAgent && (
              <div className="font-mono text-[10px] text-slate-400 leading-3">{d.runtime}</div>
            )}
          </div>
        </div>

        {/* body — hide boilerplate descriptions the server writes for unnamed sessions */}
        {d.description && !(PLACEHOLDER_DESCRIPTIONS as readonly string[]).includes(d.description) && (
            <div
              className="text-[11px] text-gray-500 truncate mt-1.5 leading-4"
              title={d.description}
            >
              {d.description}
            </div>
          )}

        {/* footer meta — quiet metric chips */}
        <div className="flex items-center gap-1.5 mt-2 text-[10px]">
          {d.context_count > 0 && (
            <span
              className="inline-flex items-center gap-1 rounded-md bg-slate-50 border border-slate-100 px-1.5 py-[1px] text-gray-500"
              title="已发布上下文"
            >
              <FileText size={10} /> {d.context_count}
            </span>
          )}
          {d.pending_inbox > 0 && (
            <span
              className="inline-flex items-center gap-1 rounded-md bg-amber-50 border border-amber-100 px-1.5 py-[1px] text-amber-600"
              title="待处理收件"
            >
              <Inbox size={10} /> {d.pending_inbox}
            </span>
          )}
          {isAgent && (d.conversation_count ?? 0) > 0 && (
            <span
              className="inline-flex items-center gap-1 rounded-md bg-indigo-50 border border-indigo-100 px-1.5 py-[1px] text-indigo-500"
              title="对话数"
            >
              <MessageSquare size={10} /> {d.conversation_count}
            </span>
          )}
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Right}
        className="!w-1.5 !h-1.5 !bg-gray-300 !border-[1.5px] !border-white opacity-50 group-hover:!bg-gray-400 group-hover:opacity-100 !transition-all"
      />
    </div>
  );
}
