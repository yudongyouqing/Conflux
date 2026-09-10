import { useEffect, useCallback, useRef, useState } from "react";
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
import { SessionNode } from "./SessionNode";
import { GroupFrame, type GroupFrameData } from "./GroupFrame";
import { CurvedPairEdge } from "./CurvedPairEdge";
import {
  applyEdgeOffsets,
  buildActiveView,
  buildAllView,
  buildDirsView,
  mergeNodePositions,
  selectedEdgeEndpoints,
  styleEdges,
} from "../graph-builders";

const nodeTypes = { session: SessionNode, cluster: GroupFrame };
const edgeTypes = { curved: CurvedPairEdge };

type ViewMode = "active" | "dirs" | "all";

const VIEW_LABELS: Record<ViewMode, string> = {
  active: "仅活跃",
  dirs: "目录分层",
  all: "全部",
};

interface GraphTabProps {
  onSelectSession: (sessionId: string | null) => void;
  selectedSessionId: string | null;
  onSelectEdge: (edge: { id: number; from: string; to: string } | null) => void;
  selectedEdge: { from: string; to: string } | null;
}

export function GraphTab({
  onSelectSession,
  selectedSessionId,
  onSelectEdge,
  selectedEdge,
}: GraphTabProps) {
  const { data, isLoading, error } = useGraph();
  const [viewMode, setViewMode] = useState<ViewMode>("active");
  // ACCORDION: at most one frame open at a time. The overview stays
  // constant-density (every directory is one compact tile) no matter how
  // many sessions exist; clicking a tile drills into that directory.
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  // Interactive state — required for node dragging in React Flow v12.
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // Manual edge curvature overrides, keyed `${from}->${to}`. Survives the 5s
  // poll rebuilds (read when edges are rebuilt) and page reloads (localStorage).
  const OFFSETS_KEY = "muiltchat:edge-offsets:v1";
  const manualOffsets = useRef<Record<string, number>>(
    (() => {
      try {
        return JSON.parse(localStorage.getItem(OFFSETS_KEY) ?? "{}");
      } catch {
        return {};
      }
    })(),
  );

  // Reframe when the composition itself changes — dagre/grid/rows swap
  // positions wholesale and the initial fitView never reruns on its own.
  const rfInstance = useRef<{
    fitView: (opts?: { padding?: number; duration?: number; maxZoom?: number }) => void;
  } | null>(null);
  useEffect(() => {
    const t = setTimeout(
      () => rfInstance.current?.fitView({ padding: 0.3, maxZoom: 1, duration: 400 }),
      350,
    );
    return () => clearTimeout(t);
  }, [viewMode, expandedKey]);

  // localStorage writes are DEBOUNCED: pointermove fires ~60x/s during an
  // edge-curvature drag, and a synchronous disk write per event janks the
  // drag on Windows. The in-memory ref is authoritative immediately; the
  // disk copy trails by the debounce window.
  const offsetPersistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleOffsetChange = useCallback(
    (key: string, offset: number | null) => {
      if (offset === null) delete manualOffsets.current[key];
      else manualOffsets.current[key] = Math.round(offset);
      if (offsetPersistTimer.current) clearTimeout(offsetPersistTimer.current);
      offsetPersistTimer.current = setTimeout(() => {
        try {
          localStorage.setItem(OFFSETS_KEY, JSON.stringify(manualOffsets.current));
        } catch {
          // storage full/blocked — in-memory override still works this session
        }
      }, 250);
      setEdges((eds) =>
        eds.map((e) => {
          const d = e.data as
            { offsetKey?: string; offset?: number; autoOffset?: number } | undefined;
          if (d?.offsetKey !== key) return e;
          const auto = d.autoOffset ?? 0;
          return { ...e, data: { ...d, offset: offset === null ? auto : Math.round(offset) } };
        }),
      );
    },
    [setEdges],
  );

  // Sync polled data into state via the pure builders in graph-builders.ts.
  // Node positions the user dragged to are preserved across polls; only
  // data (name/status/counts) refreshes.
  useEffect(() => {
    if (!data) return;
    const built =
      viewMode === "dirs"
        ? buildDirsView({ data, onSelectEdge, expandedKey })
        : viewMode === "all"
          ? buildAllView({ data, onSelectEdge })
          : buildActiveView({ data, onSelectEdge });
    const offset = applyEdgeOffsets(built.edges, manualOffsets.current, handleOffsetChange);
    const styled = styleEdges(offset, selectedEdge, selectedSessionId);
    const endpoints = selectedEdgeEndpoints(selectedEdge);

    setNodes((prev) =>
      mergeNodePositions(prev, built.nodes as Node[], selectedSessionId).map((n) => ({
        ...n,
        data: { ...n.data, highlighted: !!endpoints?.has(n.id) },
      })),
    );
    setEdges(styled);
  }, [
    data,
    selectedSessionId,
    selectedEdge,
    viewMode,
    expandedKey,
    onSelectEdge,
    handleOffsetChange,
    setNodes,
    setEdges,
  ]);

  const onNodeClick: NodeMouseHandler = useCallback(
    (_, node) => {
      if (node.type === "cluster") {
        const key = (node.data as GroupFrameData).key ?? "";
        setExpandedKey((prev) => (prev === key ? null : key));
        return;
      }
      onSelectSession(node.id);
    },
    [onSelectSession],
  );

  const onEdgeClick: EdgeMouseHandler = useCallback(
    (_, edge) => {
      const d = edge.data as { id: number; from: string; to: string } | undefined;
      if (d && typeof d.id === "number" && !d.from.startsWith("__") && !d.to.startsWith("__")) {
        onSelectEdge(d);
      }
    },
    [onSelectEdge],
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
        <br />用 CLI 注册一个会话:
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
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={onNodeClick}
      onEdgeClick={onEdgeClick}
      nodesConnectable={false}
      onInit={(instance) => {
        rfInstance.current = instance;
      }}
      minZoom={0.2}
      maxZoom={1.25}
      fitView
      fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
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
                viewMode === m ? "bg-blue-600 text-white" : "text-gray-600 hover:bg-gray-50"
              }`}
            >
              {VIEW_LABELS[m]}
            </button>
          ))}
        </div>
      </Panel>
      {/* no edges in view: say WHY instead of looking like a broken graph */}
      {edges.length === 0 && nodes.length > 0 && (
        <Panel position="bottom-center" className="!mb-4">
          <div className="text-[11px] text-gray-400 bg-white/85 border border-gray-100 rounded-full px-3 py-1 shadow-sm">
            当前视图暂无会话间消息通道 —— 发起一次对话即可建立连线
          </div>
        </Panel>
      )}
      <Background color="#cbd5e1" gap={24} />
      <Controls className="!bg-white !border !border-gray-200 !rounded-lg !shadow-sm [&_button]:!bg-white [&_button]:!border-gray-200 [&_button]:!text-gray-600 [&_button:hover]:!bg-gray-50" />
    </ReactFlow>
  );
}
