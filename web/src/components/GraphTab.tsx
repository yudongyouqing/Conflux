import { useMemo, useCallback } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
  type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useGraph } from "../hooks";
import { layoutGraph } from "../layout";
import { SessionNode, type SessionNodeData } from "./SessionNode";

const nodeTypes = { session: SessionNode };

interface GraphTabProps {
  onSelectSession: (sessionId: string | null) => void;
  selectedSessionId: string | null;
}

export function GraphTab({
  onSelectSession,
  selectedSessionId,
}: GraphTabProps) {
  const { data, isLoading, error } = useGraph();

  const { nodes, edges } = useMemo(() => {
    if (!data) return { nodes: [] as Node[], edges: [] as Edge[] };

    const rawNodes: Node<SessionNodeData>[] = data.nodes.map((n) => ({
      id: n.id,
      type: "session",
      position: { x: 0, y: 0 },
      data: {
        name: n.name,
        status: n.status,
        type: n.type,
        context_count: n.context_count,
        pending_inbox: n.pending_inbox,
        conversation_count: (n as { conversation_count?: number }).conversation_count,
      },
    }));

    const rawEdges: Edge[] = data.edges.map((e, i) => ({
      id: `e-${e.from}-${e.to}-${i}`,
      source: e.from,
      target: e.to,
      animated: true,
      label: e.weight > 1 ? String(e.weight) : "",
      style: { strokeWidth: Math.min(1 + e.weight, 5) },
    }));

    return layoutGraph(rawNodes, rawEdges);
  }, [data]);

  // Apply selection highlight without re-running layout
  const nodesWithSelection = useMemo(
    () =>
      nodes.map((n) => ({
        ...n,
        selected: n.id === selectedSessionId,
      })),
    [nodes, selectedSessionId]
  );

  const onNodeClick: NodeMouseHandler = useCallback(
    (_, node) => {
      onSelectSession(node.id);
    },
    [onSelectSession]
  );

  if (isLoading)
    return (
      <div className="flex items-center justify-center h-full text-slate-500 text-sm">
        加载图中...
      </div>
    );

  if (error)
    return (
      <div className="flex items-center justify-center h-full text-red-400 text-sm">
        连接失败: {(error as Error).message}
      </div>
    );

  if (nodes.length === 0)
    return (
      <div className="flex items-center justify-center h-full text-slate-500 text-sm text-center px-8">
        暂无会话。
        <br />
        用 CLI 注册一个会话:
        <code className="text-slate-400 ml-1">
          muiltchat sessions register --name "test"
        </code>
      </div>
    );

  return (
    <ReactFlow
      nodes={nodesWithSelection}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeClick={onNodeClick}
      fitView
      fitViewOptions={{ padding: 0.2 }}
      proOptions={{ hideAttribution: true }}
      className="bg-slate-900"
    >
      <Background color="#1e293b" gap={20} />
      <Controls className="!bg-slate-800 !border-slate-600 [&_button]:!bg-slate-800 [&_button]:!border-slate-600 [&_svg]:!fill-slate-400" />
    </ReactFlow>
  );
}
