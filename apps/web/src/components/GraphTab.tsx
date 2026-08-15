import { useEffect, useCallback, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Panel,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeMouseHandler,
  type EdgeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useGraph } from "../hooks";
import { layoutGraph } from "../layout";
import { SessionNode, type SessionNodeData } from "./SessionNode";
import { StaleCluster, type StaleClusterData } from "./StaleCluster";

const nodeTypes = { session: SessionNode, cluster: StaleCluster };

// Grid geometry for offline children inside an expanded cluster container.
const CELL_W = 176;
const CELL_H = 64;
const GRID_COLS = 3;
const GRID_PAD_X = 16;
const GRID_PAD_TOP = 34; // room for the container title bar

type ViewMode = "active" | "dirs" | "all";

const VIEW_LABELS: Record<ViewMode, string> = {
  active: "仅活跃",
  dirs: "目录分层",
  all: "全部",
};

/** Cluster node id for one project directory in dirs mode. */
const dirClusterId = (dir: string) => `__dir:${dir}`;

interface GraphTabProps {
  onSelectSession: (sessionId: string | null) => void;
  selectedSessionId: string | null;
  onSelectEdge: (edge: { from: string; to: string } | null) => void;
}

export function GraphTab({
  onSelectSession,
  selectedSessionId,
  onSelectEdge,
}: GraphTabProps) {
  const { data, isLoading, error } = useGraph();
  const [viewMode, setViewMode] = useState<ViewMode>("active");
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());

  // Interactive state — required for node dragging in React Flow v12.
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesStateChange] = useEdgesState<Edge>([]);

  // Sync polled data into state. Node positions the user dragged to are
  // preserved across polls; only data (name/status/counts) refreshes.
  //
  // View modes:
  //   active — live nodes only; edges never dangle onto offline/placeholder nodes
  //   dirs   — live nodes + one collapsible cluster per project directory
  //   all    — every node laid out flat with its real edges
  useEffect(() => {
    if (!data) return;

    const live = data.nodes.filter(
      (n) => n.status === "active" || n.type === "agent"
    );
    const offline = data.nodes.filter(
      (n) => n.status !== "active" && n.type === "session"
    );

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
        description: n.description,
        project_dir: n.project_dir,
        runtime: n.runtime ?? null,
      },
    });

    // An edge carries its channel's latest question as the label; clicking it
    // (when both endpoints are real sessions) opens the two-way message flow.
    const mkEdge = (
      from: string,
      to: string,
      weight: number,
      lastMessage: string | null | undefined,
      i: number
    ): Edge => {
      const preview =
        lastMessage && lastMessage.length > 0
          ? lastMessage.length > 28
            ? lastMessage.slice(0, 28) + "…"
            : lastMessage
          : "";
      return {
        id: `e-${from}-${to}-${i}`,
        source: from,
        target: to,
        animated: true,
        label: preview || (weight > 1 ? String(weight) : ""),
        style: { strokeWidth: Math.min(1 + weight, 5), stroke: "#94a3b8" },
        data: { from, to },
      };
    };

    // Node id → the node that represents it on screen (itself or its cluster).
    const foldMap = new Map<string, string>();
    if (viewMode === "dirs") {
      for (const n of offline) {
        const dir = n.project_dir || "(无目录)";
        if (!expandedDirs.has(dir)) foldMap.set(n.id, dirClusterId(dir));
      }
    }

    let rawEdges: Edge[];
    if (viewMode === "active") {
      // Only edges between visible (live) nodes — no dangling connections.
      const visible = new Set(live.map((n) => n.id));
      rawEdges = data.edges
        .filter((e) => visible.has(e.from) && visible.has(e.to))
        .map((e, i) => mkEdge(e.from, e.to, e.weight, e.last_message, i));
    } else if (viewMode === "dirs" && foldMap.size > 0) {
      // Fold offline endpoints onto their (collapsed) directory cluster and
      // aggregate weights per folded pair.
      const agg = new Map<string, { edge: Edge; weight: number }>();
      let i = 0;
      for (const e of data.edges) {
        const from = foldMap.get(e.from) ?? e.from;
        const to = foldMap.get(e.to) ?? e.to;
        if (from === to) continue; // internal to one cluster
        const key = `${from}->${to}`;
        const prev = agg.get(key);
        if (prev) {
          prev.weight += e.weight;
          if (!prev.edge.label) {
            prev.edge.label =
              e.last_message && e.last_message.length > 0
                ? e.last_message.length > 28
                  ? e.last_message.slice(0, 28) + "…"
                  : e.last_message
                : "";
          }
          prev.edge.style = {
            ...prev.edge.style,
            strokeWidth: Math.min(1 + prev.weight, 5),
          };
          if (prev.weight > 1) prev.edge.label ||= String(prev.weight);
        } else {
          agg.set(key, { edge: mkEdge(from, to, e.weight, e.last_message, i++), weight: e.weight });
        }
      }
      rawEdges = [...agg.values()].map((v) => v.edge);
    } else {
      rawEdges = data.edges.map((e, i) => mkEdge(e.from, e.to, e.weight, e.last_message, i));
    }

    // ---- layout ----
    // Clusters (one per dir in dirs mode) participate in the dagre layout as
    // single placeholder nodes; children are placed on a grid inside the
    // expanded container afterwards.
    const dirsShown =
      viewMode === "dirs"
        ? [...new Set(offline.map((n) => n.project_dir || "(无目录)"))]
        : [];
    const collapsedDirs = dirsShown.filter((d) => !expandedDirs.has(d));

    const layoutInputs: Node[] = live.map((n) => toSessionNode(n) as unknown as Node);
    for (const dir of collapsedDirs) {
      layoutInputs.push({
        id: dirClusterId(dir),
        type: "cluster",
        position: { x: 0, y: 0 },
        data: { label: dir.split(/[\\/]/).pop(), dir, count: 0, expanded: false, width: 0, height: 0 },
      });
    }
    const layoutNodeIds = new Set(layoutInputs.map((n) => n.id));
    const layoutEdges = rawEdges.filter(
      (e) => layoutNodeIds.has(e.source) && layoutNodeIds.has(e.target)
    );
    const { nodes: layouted } = layoutGraph(layoutInputs, layoutEdges as never);

    let outNodes: Node[];
    if (viewMode === "dirs") {
      outNodes = [...layouted];
      // Children of expanded dir clusters are real React Flow children
      // (parentId + extent: "parent"): dragging the container carries them.
      for (const dir of dirsShown) {
        if (!expandedDirs.has(dir)) continue;
        const members = offline.filter((n) => (n.project_dir || "(无目录)") === dir);
        const cols = Math.min(GRID_COLS, members.length);
        const rows = Math.ceil(members.length / cols);
        const width = cols * CELL_W + GRID_PAD_X * 2;
        const height = rows * CELL_H + GRID_PAD_TOP + 12;
        const clusterPos =
          layouted.find((n) => n.id === dirClusterId(dir))?.position ?? { x: 0, y: 0 };
        outNodes.push({
          id: dirClusterId(dir),
          type: "cluster",
          position: clusterPos,
          data: { label: dir.split(/[\\/]/).pop(), dir, count: members.length, expanded: true, width, height },
          style: { width, height },
          zIndex: -1,
        } as Node<StaleClusterData>);
        members.forEach((n, i) => {
          const node = toSessionNode(n);
          node.parentId = dirClusterId(dir);
          node.extent = "parent";
          node.position = {
            x: GRID_PAD_X + (i % cols) * CELL_W,
            y: GRID_PAD_TOP + Math.floor(i / cols) * CELL_H,
          };
          node.zIndex = 0;
          outNodes.push(node);
        });
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
  }, [data, selectedSessionId, viewMode, expandedDirs, setNodes, setEdges]);

  const onNodeClick: NodeMouseHandler = useCallback(
    (_, node) => {
      if (node.type === "cluster") {
        const d = node.data as StaleClusterData;
        if (viewMode === "dirs" && d.dir) {
          setExpandedDirs((prev) => {
            const next = new Set(prev);
            next.has(d.dir!) ? next.delete(d.dir!) : next.add(d.dir!);
            return next;
          });
        }
        return;
      }
      onSelectSession(node.id);
    },
    [onSelectSession, viewMode]
  );

  const onEdgeClick: EdgeMouseHandler = useCallback(
    (_, edge) => {
      const d = edge.data as { from: string; to: string } | undefined;
      if (d && d.from && d.to && !d.from.startsWith("__dir:") && !d.to.startsWith("__dir:")) {
        onSelectEdge(d);
      }
    },
    [onSelectEdge]
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
      onEdgesChange={onEdgesStateChange}
      onNodeClick={onNodeClick}
      onEdgeClick={onEdgeClick}
      nodesConnectable={false}
      minZoom={0.2}
      maxZoom={2}
      fitView
      fitViewOptions={{ padding: 0.2 }}
      proOptions={{ hideAttribution: true }}
      className="bg-gray-50"
    >
      <Panel position="top-left" className="!m-2">
        <div className="flex bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden text-xs">
          {(Object.keys(VIEW_LABELS) as ViewMode[]).map((m) => (
            <button
              key={m}
              onClick={() => setViewMode(m)}
              className={`px-3 py-1.5 transition-colors ${
                viewMode === m
                  ? "bg-gray-800 text-white"
                  : "text-gray-600 hover:bg-gray-50"
              }`}
            >
              {VIEW_LABELS[m]}
            </button>
          ))}
        </div>
      </Panel>
      <Background color="#d0d5dd" gap={20} />
      <Controls className="!bg-white !border !border-gray-200 !rounded-lg !shadow-sm [&_button]:!bg-white [&_button]:!border-gray-200 [&_button]:!text-gray-600 [&_button:hover]:!bg-gray-50" />
    </ReactFlow>
  );
}
