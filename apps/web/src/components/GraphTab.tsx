import { useEffect, useCallback, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Panel,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeMouseHandler,
  type EdgeMouseHandler,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Graph } from "@conflux/shared";
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
  graphBuildMetrics,
} from "../graph-builders";

const nodeTypes = { session: SessionNode, cluster: GroupFrame };
const edgeTypes = { curved: CurvedPairEdge };

type ViewMode = "active" | "dirs" | "all";

const VIEW_LABELS: Record<ViewMode, string> = {
  active: "仅活跃",
  dirs: "目录分层",
  all: "全部",
};

interface FlowInstance {
  fitView: (opts?: { padding?: number; duration?: number; maxZoom?: number }) => void;
  setViewport: (viewport: Viewport, opts?: { duration?: number }) => void;
}

/**
 * Interactive state per graph scope (zoom/pan + dragged node positions).
 * Module-level so switching scopes — or leaving the graph view entirely —
 * preserves every room's layout without keeping a hidden React Flow tree
 * alive per room.
 */
interface ScopeSnapshot {
  positions: Record<string, { x: number; y: number }>;
  viewport?: Viewport;
}
const scopeSnapshots = new Map<string, ScopeSnapshot>();

export interface GraphTabProps {
  /** the shared graph data — one query upstream, never a second one here */
  graph: Graph | undefined;
  loading?: boolean;
  error?: string | null;
  /**
   * "room" shows the caller-scoped graph with ALL its members (no global
   * filters — a room must never look empty because someone is offline);
   * "global" keeps the mode switcher.
   */
  scope: "global" | "room";
  /** snapshot identity: "global" | `room:<id>` */
  scopeKey: string;
  /** false = hidden: no rebuilds, no fitView timers, no React Flow tree */
  active: boolean;
  onSelectSession: (sessionId: string | null) => void;
  selectedSessionId: string | null;
  onSelectEdge: (edge: { id: number; from: string; to: string } | null) => void;
  selectedEdge: { from: string; to: string } | null;
}

export function GraphTab({
  graph,
  loading,
  error,
  scope,
  scopeKey,
  active,
  onSelectSession,
  selectedSessionId,
  onSelectEdge,
  selectedEdge,
}: GraphTabProps) {
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
  const OFFSETS_KEY = "conflux:edge-offsets:v1";
  const LEGACY_OFFSETS_KEY = "muiltchat:edge-offsets:v1"; // pre-rename key, read-only
  const manualOffsets = useRef<Record<string, number>>(
    (() => {
      try {
        return JSON.parse(
          localStorage.getItem(OFFSETS_KEY) ?? localStorage.getItem(LEGACY_OFFSETS_KEY) ?? "{}",
        );
      } catch {
        return {};
      }
    })(),
  );

  const rfInstance = useRef<FlowInstance | null>(null);
  const viewportRef = useRef<Viewport | null>(null);
  const nodesRef = useRef<Node[]>([]);
  nodesRef.current = nodes;
  const scopeKeyRef = useRef(scopeKey);

  const snapshotCurrent = useCallback((key: string) => {
    if (!key) return;
    scopeSnapshots.set(key, {
      positions: Object.fromEntries(nodesRef.current.map((n) => [n.id, n.position])),
      viewport: viewportRef.current ?? undefined,
    });
  }, []);

  // Leaving a scope (or hiding the graph) stores its interactive state; the
  // component may unmount at any moment, so the cleanup path snapshots too.
  useEffect(() => {
    if (scopeKeyRef.current !== scopeKey) {
      snapshotCurrent(scopeKeyRef.current);
      scopeKeyRef.current = scopeKey;
    }
  }, [scopeKey, snapshotCurrent]);
  useEffect(() => {
    if (!active) snapshotCurrent(scopeKeyRef.current);
  }, [active, snapshotCurrent]);
  useEffect(() => () => snapshotCurrent(scopeKeyRef.current), [snapshotCurrent]);

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
            | { offsetKey?: string; offset?: number; autoOffset?: number }
            | undefined;
          if (d?.offsetKey !== key) return e;
          const auto = d.autoOffset ?? 0;
          return { ...e, data: { ...d, offset: offset === null ? auto : Math.round(offset) } };
        }),
      );
    },
    [setEdges],
  );

  // Sync data into state via the pure builders in graph-builders.ts. Runs
  // only while active — a hidden graph does no layout work; re-activating
  // rebuilds once from the freshest data. Dragged positions survive polls;
  // on a scope switch the target scope's snapshot positions are restored.
  useEffect(() => {
    if (!active || !graph) return;
    const startedAt = performance.now();
    const built =
      scope === "room"
        ? buildAllView({ data: graph, onSelectEdge })
        : viewMode === "dirs"
          ? buildDirsView({ data: graph, onSelectEdge, expandedKey })
          : viewMode === "all"
            ? buildAllView({ data: graph, onSelectEdge })
            : buildActiveView({ data: graph, onSelectEdge });
    const offset = applyEdgeOffsets(built.edges, manualOffsets.current, handleOffsetChange);
    const styled = styleEdges(offset, selectedEdge, selectedSessionId);
    const endpoints = selectedEdgeEndpoints(selectedEdge);
    const snap = scopeSnapshots.get(scopeKey);

    setNodes((prev) => {
      const merged = mergeNodePositions(prev, built.nodes as Node[], selectedSessionId).map(
        (n) => {
          const saved = snap?.positions[n.id];
          return saved ? { ...n, position: saved } : n;
        },
      );
      return merged.map((n) => ({
        ...n,
        data: { ...n.data, highlighted: !!endpoints?.has(n.id) },
      }));
    });
    setEdges(styled);
    console.debug(
      "[conflux:perf] graph build",
      graphBuildMetrics(built.nodes.length, built.edges.length, startedAt, performance.now()),
    );
  }, [
    active,
    graph,
    scope,
    scopeKey,
    selectedSessionId,
    selectedEdge,
    viewMode,
    expandedKey,
    onSelectEdge,
    handleOffsetChange,
    setNodes,
    setEdges,
  ]);

  // Reframe when the composition itself changes — dagre/grid/rows swap
  // positions wholesale and the initial fitView never reruns on its own.
  // A scope with a saved viewport restores it instead of reframing.
  useEffect(() => {
    if (!active) return;
    const snap = scopeSnapshots.get(scopeKey);
    const t = setTimeout(() => {
      if (snap?.viewport && rfInstance.current) {
        rfInstance.current.setViewport(snap.viewport, { duration: 0 });
      } else {
        rfInstance.current?.fitView({ padding: 0.3, maxZoom: 1, duration: 400 });
      }
    }, 350);
    return () => clearTimeout(t);
  }, [active, scopeKey, viewMode, expandedKey, scope]);

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

  if (loading && !graph)
    return (
      <div className="flex items-center justify-center h-full text-ink-faint text-sm">
        加载图中...
      </div>
    );

  if (error && !graph)
    return (
      <div className="flex items-center justify-center h-full text-red-500 text-sm">
        连接失败: {error}
      </div>
    );

  if (nodes.length === 0)
    return (
      <div className="flex items-center justify-center h-full text-ink-faint text-sm text-center px-8">
        {scope === "room" ? (
          <>房间成员还没有出现在图谱中（装 hooks 或挂 MCP 后自动出现）</>
        ) : (
          <>
            暂无会话。
            <br />用 CLI 注册一个会话:
            <code className="text-ink-muted ml-1 bg-paper px-1 rounded">
              conflux sessions register --name "test"
            </code>
          </>
        )}
      </div>
    );

  // Hidden = no React Flow tree at all: no layout, no window listeners, no
  // timers. Interactive state lives in the snapshot map until re-activation.
  if (!active) return null;

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
      onMove={(_, viewport) => {
        viewportRef.current = viewport;
      }}
      nodesConnectable={false}
      onInit={(instance) => {
        rfInstance.current = instance;
      }}
      minZoom={0.2}
      maxZoom={1.25}
      fitView
      fitViewOptions={{ padding: 0.3, maxZoom: 1, duration: 400 }}
      proOptions={{ hideAttribution: true }}
      className="bg-paper"
    >
      {scope === "global" && (
        <Panel position="top-left" className="!m-2">
          <div className="flex bg-surface border border-line rounded-lg shadow-[0_2px_10px_rgba(16,24,40,0.08)] overflow-hidden text-xs">
            {(Object.keys(VIEW_LABELS) as ViewMode[]).map((m) => (
              <button
                key={m}
                onClick={() => setViewMode(m)}
                className={`px-3 py-1.5 transition-colors duration-200 ${
                  viewMode === m
                    ? "bg-accent text-on-accent"
                    : "text-ink-muted hover:bg-tile-hover hover:text-ink"
                }`}
              >
                {VIEW_LABELS[m]}
              </button>
            ))}
          </div>
        </Panel>
      )}
      {/* no edges in view: say WHY instead of looking like a broken graph */}
      {edges.length === 0 && nodes.length > 0 && (
        <Panel position="bottom-center" className="!mb-4">
          <div className="text-2xs text-ink-faint bg-surface/90 backdrop-blur-sm border border-slate-100 rounded-full px-3 py-1 shadow-[0_2px_10px_rgba(16,24,40,0.08)]">
            当前视图暂无会话间消息通道 —— 发起一次对话即可建立连线
          </div>
        </Panel>
      )}
      <Background color="rgb(var(--tk-line))" gap={22} size={1.2} />
      <Controls className="!bg-surface !border !border-line !rounded-lg !shadow-[0_2px_10px_rgba(16,24,40,0.1)] !overflow-hidden [&_button]:!bg-surface [&_button]:!border-line [&_button]:!text-ink-muted [&_button:hover]:!bg-paper [&_button:hover]:!text-ink" />

      <MiniMap
        pannable
        zoomable
        bgColor="rgb(var(--tk-paper))"
        nodeColor="#CBD5E1"
        nodeStrokeColor="#94A3B8"
        maskColor="rgb(var(--tk-paper) / 0.7)"
        className="!border !border-line !rounded-lg !shadow-[0_2px_10px_rgba(16,24,40,0.1)]"
      />
    </ReactFlow>
  );
}
