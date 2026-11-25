import { useMemo } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { GraphNode } from "@conflux/shared";
import { GitBranch, Network, Plus, Terminal } from "lucide-react";
import { useGraph } from "../hooks";
import { RuntimeGlyph } from "./brand-icons";

interface GraphOverviewProps {
  onSelectThread: (threadId: string) => void;
  onNewAgentClick: () => void;
}

type ThreadNodeData = {
  node: GraphNode;
  onOpen: (id: string) => void;
};

function ThreadGraphNode({ data }: NodeProps<Node<ThreadNodeData>>) {
  const { node, onOpen } = data;
  const clickable = node.kind !== "console";

  return (
    <div
      data-testid={`graph-node-${node.id}`}
      onClick={() => clickable && onOpen(node.id)}
      className={`w-56 rounded-lg border bg-surface p-3 shadow-card transition-colors ${
        clickable ? "cursor-pointer hover:border-accent hover:shadow-raised" : "border-line"
      } ${node.pending_approvals > 0 ? "border-warning/60" : "border-line-strong"}`}
    >
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !bg-accent" />
      <div className="flex items-center gap-2">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-tile text-ink">
          <RuntimeGlyph runtime={node.runtime} size={13} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <span className="truncate text-xs font-medium text-ink">{node.name}</span>
            {node.kind === "external" && <Terminal className="h-3 w-3 shrink-0 text-info" />}
          </div>
          <div className="truncate text-2xs text-ink-faint">
            {node.project_name ?? (node.kind === "console" ? "控制台" : "独立线程")}
          </div>
        </div>
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${
            node.state === "running"
              ? "bg-accent animate-pulse"
              : node.state === "waiting_approval"
                ? "bg-warning animate-pulse"
                : node.state === "idle"
                  ? "bg-success"
                  : node.state === "error"
                    ? "bg-danger"
                    : "bg-neutral"
          }`}
        />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-2xs">
        <span className="rounded bg-tile px-1.5 py-0.2 font-mono text-ink-muted">
          {node.runtime}
        </span>
        {node.worktree_branch && (
          <span className="inline-flex max-w-[130px] items-center gap-0.5 truncate rounded bg-tile px-1.5 py-0.2 font-mono text-ink-faint">
            <GitBranch className="h-2.5 w-2.5 shrink-0" />
            {node.worktree_branch}
          </span>
        )}
        {node.pending_approvals > 0 && (
          <span className="ml-auto rounded-full bg-warning-soft px-1.5 py-0.2 font-mono font-medium text-warning">
            待批 {node.pending_approvals}
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !bg-accent" />
    </div>
  );
}

const NODE_TYPES = { agentThread: ThreadGraphNode };

export function GraphOverview({ onSelectThread, onNewAgentClick }: GraphOverviewProps) {
  const graphQuery = useGraph();
  const graph = graphQuery.data;

  const { nodes, edges } = useMemo(() => {
    const rawNodes = graph?.nodes ?? [];
    const rawEdges = graph?.edges ?? [];
    const cols = Math.max(1, Math.ceil(Math.sqrt(rawNodes.length)));
    const rfNodes: Node<ThreadNodeData>[] = rawNodes.map((n, i) => ({
      id: n.id,
      type: "agentThread",
      position: {
        x: 60 + (i % cols) * 280,
        y: 60 + Math.floor(i / cols) * 140,
      },
      data: { node: n, onOpen: onSelectThread },
    }));

    const rfEdges: Edge[] = rawEdges.map((e) => ({
      id: `edge-${e.id}`,
      source: e.from,
      target: e.to,
      label: e.weight > 1 ? `×${e.weight}` : undefined,
      animated: true,
    }));
    return { nodes: rfNodes, edges: rfEdges };
  }, [graph, onSelectThread]);

  return (
    <div data-testid="graph-overview" className="relative flex min-w-0 flex-1 flex-col bg-paper">
      {nodes.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center bg-surface p-8 text-center">
          <Network className="h-8 w-8 text-ink-faint" />
          <p className="mt-3 text-sm font-medium text-ink">尚未启动任何 Agent</p>
          <p className="mt-1 text-xs text-ink-faint">
            创建托管 Agent 或从外部终端接入 MCP 后，协作拓扑将自动呈现。
          </p>
          <button
            type="button"
            onClick={onNewAgentClick}
            className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3.5 text-xs font-medium text-on-accent hover:bg-accent-deep"
          >
            <Plus className="h-3.5 w-3.5" />
            新建 Agent
          </button>
        </div>
      ) : (
        <div className="relative flex-1">
          <div className="pointer-events-none absolute left-3 top-3 z-10 inline-flex items-center gap-2 rounded-md border border-line bg-surface/90 px-2.5 py-1 text-2xs text-ink-muted shadow-card">
            <span className="font-mono tabular-nums">
              {nodes.length} 节点 / {edges.length} 连线
            </span>
            <span className="text-ink-faint">点击节点进入工作台</span>
          </div>
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} fitView>
            <Background gap={20} size={1} />
            <Controls />
          </ReactFlow>
        </div>
      )}
    </div>
  );
}
