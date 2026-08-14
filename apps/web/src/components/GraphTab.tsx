import { useEffect, useCallback, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useGraph } from "../hooks";
import { layoutGraph } from "../layout";
import { SessionNode, type SessionNodeData } from "./SessionNode";
import { StaleCluster, type StaleClusterData } from "./StaleCluster";

const nodeTypes = { session: SessionNode, cluster: StaleCluster };
const CLUSTER_ID = "__offline_cluster__";

// Grid geometry for stale children inside the expanded cluster container.
const CELL_W = 176;
const CELL_H = 64;
const GRID_COLS = 3;
const GRID_PAD_X = 16;
const GRID_PAD_TOP = 34; // room for the container title bar

interface GraphTabProps {
  onSelectSession: (sessionId: string | null) => void;
  selectedSessionId: string | null;
}

export function GraphTab({
  onSelectSession,
  selectedSessionId,
}: GraphTabProps) {
  const { data, isLoading, error } = useGraph();
  const [clusterExpanded, setClusterExpanded] = useState(false);

  // Interactive state — required for node dragging in React Flow v12.
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges] = useEdgesState<Edge>([]);

  // Sync polled data into state. Node positions the user dragged to are
  // preserved across polls; only data (name/status/counts) refreshes.
  // Offline (stale/ended) sessions are aggregated into one collapsible
  // cluster node; edges to them are folded onto the cluster with summed
  // weights while it is collapsed.
  useEffect(() => {
    if (!data) return;

    const live = data.nodes.filter(
      (n) => n.status === "active" || n.type === "agent"
    );
    const offline = data.nodes.filter(
      (n) => n.status !== "active" && n.type === "session"
    );
    const offlineIds = new Set(offline.map((n) => n.id));

    const toSessionNode = (n: (typeof data.nodes)[number]): Node<SessionNodeData> => ({
      id: n.id,
      type: "session",
      position: { x: 0, y: 0 },
      data: {
        name: n.name,
        status: n.status,
        type: n.type,
        context_count: n.context_count,
        pending_inbox: n.pending_inbox,
        conversation_count: n.conversation_count,
        last_heartbeat_at: n.last_heartbeat_at,
      },
    });

    // ---- edges (aggregation depends on cluster state) ----
    const mkEdge = (from: string, to: string, weight: number, i: number): Edge => ({
      id: `e-${from}-${to}-${i}`,
      source: from,
      target: to,
      animated: true,
      label: weight > 1 ? String(weight) : "",
      style: { strokeWidth: Math.min(1 + weight, 5), stroke: "#94a3b8" },
    });

    let rawEdges: Edge[];
    if (!clusterExpanded) {
      const agg = new Map<string, { edge: Edge; weight: number }>();
      let i = 0;
      for (const e of data.edges) {
        const from = offlineIds.has(e.from) ? CLUSTER_ID : e.from;
        const to = offlineIds.has(e.to) ? CLUSTER_ID : e.to;
        if (from === CLUSTER_ID && to === CLUSTER_ID) continue; // internal to the cluster
        const key = `${from}->${to}`;
        const prev = agg.get(key);
        if (prev) {
          prev.weight += e.weight;
          prev.edge.label = prev.weight > 1 ? String(prev.weight) : "";
          prev.edge.style = {
            ...prev.edge.style,
            strokeWidth: Math.min(1 + prev.weight, 5),
          };
        } else {
          agg.set(key, { edge: mkEdge(from, to, e.weight, i++), weight: e.weight });
        }
      }
      rawEdges = [...agg.values()].map((v) => v.edge);
    } else {
      // Expanded: draw real edges, but skip edges fully inside the cluster
      // (they would clutter the container interior).
      rawEdges = data.edges
        .filter((e) => !(offlineIds.has(e.from) && offlineIds.has(e.to)))
        .map((e, i) => mkEdge(e.from, e.to, e.weight, i));
    }

    // ---- layout ----
    // Only live nodes (+ the collapsed cluster placeholder) go through dagre.
    const layoutInputs: Node[] = live.map((n) => toSessionNode(n) as unknown as Node);
    if (offline.length > 0) {
      layoutInputs.push({
        id: CLUSTER_ID,
        type: "cluster",
        position: { x: 0, y: 0 },
        data: { count: offline.length, expanded: false, width: 0, height: 0 },
      });
    }
    // Edges fed to dagre must reference laid-out nodes only.
    const layoutNodeIds = new Set(layoutInputs.map((n) => n.id));
    const layoutEdges =
      offline.length > 0
        ? rawEdges.filter((e) => layoutNodeIds.has(e.source) && layoutNodeIds.has(e.target))
        : rawEdges;
    const { nodes: layouted } = layoutGraph(layoutInputs, layoutEdges as never);

    const clusterPos =
      layouted.find((n) => n.id === CLUSTER_ID)?.position ?? { x: 0, y: 0 };

    let outNodes: Node[];
    if (offline.length > 0) {
      const cols = Math.min(GRID_COLS, offline.length);
      const rows = Math.ceil(offline.length / cols);
      const width = cols * CELL_W + GRID_PAD_X * 2;
      const height = rows * CELL_H + GRID_PAD_TOP + 12;

      const clusterNode: Node<StaleClusterData> = {
        id: CLUSTER_ID,
        type: "cluster",
        position: clusterPos,
        data: { count: offline.length, expanded: clusterExpanded, width, height },
        style: clusterExpanded ? { width, height } : undefined,
        zIndex: -1,
      };

      if (clusterExpanded) {
        const children = offline.map((n, i) => {
          const node = toSessionNode(n);
          node.position = {
            x: clusterPos.x + GRID_PAD_X + (i % cols) * CELL_W,
            y: clusterPos.y + GRID_PAD_TOP + Math.floor(i / cols) * CELL_H,
          };
          node.zIndex = 0;
          return node;
        });
        outNodes = [
          ...layouted.filter((n) => n.id !== CLUSTER_ID),
          clusterNode,
          ...children,
        ];
      } else {
        outNodes = [...layouted.filter((n) => n.id !== CLUSTER_ID), clusterNode];
      }
    } else {
      outNodes = layouted;
    }

    setNodes((prev) => {
      const prevPos = new Map(prev.map((n) => [n.id, n.position]));
      return outNodes.map((n) => ({
        ...n,
        position: prevPos.get(n.id) ?? n.position,
        selected: n.id === selectedSessionId,
      }));
    });
    setEdges(rawEdges);
  }, [data, selectedSessionId, clusterExpanded, setNodes, setEdges]);

  const onNodeClick: NodeMouseHandler = useCallback(
    (_, node) => {
      if (node.id === CLUSTER_ID) {
        setClusterExpanded((v) => !v);
        return;
      }
      onSelectSession(node.id);
    },
    [onSelectSession]
  );

  if (isLoading)
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-sm">
        加载图中...
      </div>
    );

  if (error)
    return (
      <div className="flex items-center justify-center h-full text-red-500 text-sm">
        连接失败: {(error as Error).message}
      </div>
    );

  if (nodes.length === 0)
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-sm text-center px-8">
        暂无会话。
        <br />
        用 CLI 注册一个会话:
        <code className="text-gray-500 ml-1 bg-gray-100 px-1 rounded">
          muiltchat sessions register --name "test"
        </code>
      </div>
    );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onNodeClick={onNodeClick}
      nodesConnectable={false}
      minZoom={0.2}
      maxZoom={2}
      fitView
      fitViewOptions={{ padding: 0.2 }}
      proOptions={{ hideAttribution: true }}
      className="bg-gray-50"
    >
      <Background color="#d0d5dd" gap={20} />
      <Controls className="!bg-white !border !border-gray-200 !rounded-lg !shadow-sm [&_button]:!bg-white [&_button]:!border-gray-200 [&_button]:!text-gray-600 [&_button:hover]:!bg-gray-50" />
    </ReactFlow>
  );
}
