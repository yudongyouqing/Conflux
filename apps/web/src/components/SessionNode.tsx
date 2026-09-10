import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import {
  FileText,
  Inbox,
  Bot,
  MessageSquare,
  Globe,
  Terminal,
  Code2,
  type LucideIcon,
} from "lucide-react";

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
  icon: LucideIcon;
  block: string; // icon block bg + icon color
  accent: string; // top strip color
}

function skinFor(d: SessionNodeData, isAgent: boolean, isWeb: boolean): NodeSkin {
  if (isAgent) return { icon: Bot, block: "bg-indigo-600", accent: "bg-indigo-500" };
  if (isWeb) return { icon: Globe, block: "bg-blue-600", accent: "bg-blue-500" };
  if (d.runtime === "claude")
    return { icon: Terminal, block: "bg-orange-600", accent: "bg-orange-500" };
  if (d.runtime === "codex") return { icon: Code2, block: "bg-slate-700", accent: "bg-slate-500" };
  return { icon: Terminal, block: "bg-gray-500", accent: "bg-gray-400" };
}

const STATUS_DOT: Record<string, string> = {
  active: "bg-emerald-500",
  stale: "bg-gray-300",
  ended: "bg-red-500",
};

export type SessionNodeType = Node<SessionNodeData>;

export function SessionNode({ data, selected, dragging }: NodeProps) {
  const d = data as SessionNodeData;
  const isAgent = d.type === "agent";
  const isWeb = (d as { id?: string }).id === "web-console" || d.name === "Web 控制台";
  const skin = skinFor(d, isAgent, isWeb);
  const Icon = skin.icon;

  // Seconds since the last heartbeat — drives the "live" feel on the graph.
  const ageSec = d.last_heartbeat_at
    ? Math.max(0, Math.round((Date.now() - new Date(d.last_heartbeat_at).getTime()) / 1000))
    : null;
  const ageLabel =
    ageSec === null
      ? null
      : ageSec < 60
        ? `${ageSec}s`
        : ageSec < 3600
          ? `${Math.floor(ageSec / 60)}m`
          : `${Math.floor(ageSec / 3600)}h`;

  return (
    <div
      title={d.skills?.length ? `技能: ${d.skills.join(" · ")}` : undefined}
      className={`group relative w-[176px] rounded-xl bg-white border border-gray-200 overflow-hidden transition-all duration-150 cursor-grab active:cursor-grabbing ${
        dragging
          ? "shadow-xl scale-[1.02] ring-2 ring-blue-500/40"
          : selected
            ? "shadow-lg ring-2 ring-blue-500/50"
            : "shadow-sm hover:shadow-lg hover:border-gray-300 hover:-translate-y-px"
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
            className={`w-5 h-5 rounded-md ${skin.block} flex items-center justify-center flex-shrink-0 shadow-sm`}
          >
            <Icon size={11} className="text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1">
              <span
                className="text-gray-900 text-[11px] font-semibold truncate flex-1"
                title={d.name}
              >
                {d.name}
              </span>
              <span
                className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                  STATUS_DOT[d.status] ?? "bg-gray-300"
                } ${d.status === "active" ? "shadow-[0_0_0_2px_rgba(16,185,129,0.15)]" : ""}`}
                title={`状态: ${d.status}`}
              />
            </div>
            {d.runtime && !isAgent && (
              <div className="text-[8px] text-gray-400 uppercase tracking-wide">{d.runtime}</div>
            )}
          </div>
        </div>

        {/* body */}
        {d.description &&
          d.description !== "Claude Code session (hook)" &&
          d.description !== "浏览器界面身份(从会话详情抽屉发起的对话)" && (
            <div
              className="text-[10px] text-gray-500 truncate mt-1 leading-3"
              title={d.description}
            >
              {d.description}
            </div>
          )}

        {/* footer meta */}
        <div className="flex items-center gap-2.5 mt-1.5 text-[9px] text-gray-400">
          {d.context_count > 0 && (
            <span className="flex items-center gap-1" title="已发布上下文">
              <FileText size={10} /> {d.context_count}
            </span>
          )}
          {d.status === "active" && ageLabel && (
            // neutral metadata: elapsed time is NOT a health signal — color
            // stays reserved for the status dot
            <span title={`最后心跳 ${ageLabel} 前`}>{ageLabel}</span>
          )}
          {d.pending_inbox > 0 && (
            <span className="flex items-center gap-1 text-amber-600" title="待处理收件">
              <Inbox size={10} /> {d.pending_inbox}
            </span>
          )}
          {isAgent && (d.conversation_count ?? 0) > 0 && (
            <span className="flex items-center gap-1 text-indigo-500">
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
