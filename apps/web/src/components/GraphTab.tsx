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
  applyScopePositions,
  buildActiveView,
  buildAllView,
  buildDirsView,
  selectedEdgeEndpoints,
  styleEdges,
  graphBuildMetrics,
  type ScopeSnapshot,
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
  const manualOffsetsRef = useRef<Record<string, number> | null>(null);
  if (manualOffsetsRef.current === null) {
    let loaded: Record<string, number> = {};
    try {
      const parsed: unknown = JSON.parse(
        localStorage.getItem(OFFSETS_KEY) ?? localStorage.getItem(LEGACY_OFFSETS_KEY) ?? "{}",
      );
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        loaded = parsed as Record<string, number>;
      }
    } catch {
      loaded = {};
    }
    manualOffsetsRef.current = loaded;
  }
  const manualOffsets: Record<string, number> = manualOffsetsRef.current;

  const rfInstance = useRef<FlowInstance | null>(null);
  const [flowInstance, setFlowInstance] = useState<FlowInstance | null>(null);
  const viewportRef = useRef<Viewport | null>(null);
  const nodesRef = useRef<Node[]>([]);
  nodesRef.current = nodes;
  const baseEdgesRef = useRef<Edge[]>([]);
  const selectedSessionIdRef = useRef(selectedSessionId);
  selectedSessionIdRef.current = selectedSessionId;
  const selectedEdgeRef = useRef(selectedEdge);
  selectedEdgeRef.current = selectedEdge;
  const scopeKeyRef = useRef(scopeKey);
  // the scope this component last BUILT for: entering a scope restores its
  // snapshot once; same-scope refreshes keep freshly dragged positions
  const lastBuiltScopeRef = useRef<string | null>(null);
  const lastBuiltComposition = useRef("");

  const snapshotCurrent = useCallback((key: string) => {
    // StrictMode replays cleanup before the renderer mounts. Preserve an
    // existing scope snapshot until this instance has a real flow to save.
    if (!key || !rfInstance.current) return;
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
  const flushManualOffsets = useCallback(() => {
    try {
      localStorage.setItem(OFFSETS_KEY, JSON.stringify(manualOffsetsRef.current ?? {}));
    } catch {
      // storage full/blocked — in-memory override still works this session
    }
  }, []);
  useEffect(
    () => () => {
      if (offsetPersistTimer.current) {
        clearTimeout(offsetPersistTimer.current);
        offsetPersistTimer.current = null;
        flushManualOffsets();
      }
    },
    [flushManualOffsets],
  );
  const handleOffsetChange = useCallback(
    (key: string, offset: number | null) => {
      const store = manualOffsetsRef.current ?? (manualOffsetsRef.current = {});
      if (offset === null) delete store[key];
      else store[key] = Math.round(offset);
      if (offsetPersistTimer.current) clearTimeout(offsetPersistTimer.current);
      offsetPersistTimer.current = setTimeout(() => {
        offsetPersistTimer.current = null;
        flushManualOffsets();
      }, 250);
      const applyOffset = (eds: Edge[]) =>
        eds.map((e) => {
          const d = e.data as
            | { offsetKey?: string; offset?: number; autoOffset?: number }
            | undefined;
          if (d?.offsetKey !== key) return e;
          const auto = d.autoOffset ?? 0;
          return { ...e, data: { ...d, offset: offset === null ? auto : Math.round(offset) } };
        });
      baseEdgesRef.current = applyOffset(baseEdgesRef.current);
      setEdges(applyOffset);
    },
    [flushManualOffsets, setEdges],
  );

  // Sync topology data into state via the pure builders in graph-builders.ts.
  // Runs only while active and only when graph data or view composition
  // changes — selection changes are styled in a separate lightweight effect so
  // clicking a node/edge never re-runs Dagre layout.
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
    const offset = applyEdgeOffsets(built.edges, manualOffsets, handleOffsetChange);
    baseEdgesRef.current = offset;
    const selSession = selectedSessionIdRef.current;
    const selEdge = selectedEdgeRef.current;
    const styled = styleEdges(offset, selEdge, selSession);
    const endpoints = selectedEdgeEndpoints(selEdge);
    const scopeEntered = lastBuiltScopeRef.current !== scopeKey;
    const composition = `${scope}:${viewMode}:${expandedKey ?? ""}`;
    const compositionChanged = lastBuiltComposition.current !== composition;
    lastBuiltComposition.current = composition;
    lastBuiltScopeRef.current = scopeKey;

    setNodes((prev) =>
      applyScopePositions(
        compositionChanged || scopeEntered ? [] : prev,
        built.nodes as Node[],
        scopeEntered,
        scopeSnapshots.get(scopeKey),
        selSession,
      ).map((n) => ({
        ...n,
        data: { ...n.data, highlighted: !!endpoints?.has(n.id) },
      })),
    );
    setEdges(styled);
    if (import.meta.env?.DEV) {
      console.debug(
        "[conflux:perf] graph build",
        graphBuildMetrics(built.nodes.length, built.edges.length, startedAt, performance.now()),
      );
    }
  }, [
    active,
    graph,
    scope,
    scopeKey,
    viewMode,
    expandedKey,
    onSelectEdge,
    handleOffsetChange,
    manualOffsets,
    setNodes,
    setEdges,
  ]);

  // Apply selection & highlight styling without re-running layout.
  useEffect(() => {
    if (!active) return;
    const endpoints = selectedEdgeEndpoints(selectedEdge);
    setNodes((prev) =>
      prev.map((n) => {
        const nextSelected = n.id === selectedSessionId;
        const nextHighlighted = !!endpoints?.has(n.id);
        if (n.selected === nextSelected && n.data?.highlighted === nextHighlighted) {
          return n;
        }
        return {
          ...n,
          selected: nextSelected,
          data: { ...n.data, highlighted: nextHighlighted },
        };
      }),
    );
    setEdges(styleEdges(baseEdgesRef.current, selectedEdge, selectedSessionId));
  }, [active, selectedSessionId, selectedEdge, setNodes, setEdges]);

  // Reframe when the composition itself changes — dagre/grid/rows swap
  // positions wholesale and the initial fitView never reruns on its own.
  // Restore once when entering a scope; composition changes frame the new
  // layout. Wait for the actual React Flow mount, including delayed data.
  const lastFramedScope = useRef<string | null>(null);
  useEffect(() => {
    if (!active) {
      lastFramedScope.current = null;
      setFlowInstance(null);
      return;
    }
    if (!flowInstance || nodes.length === 0) return;
    const entering = lastFramedScope.current !== scopeKey;
    const snap = entering ? scopeSnapshots.get(scopeKey) : undefined;
    if (entering && !snap?.viewport) {
      // The new renderer performs its initial fit after measuring nodes.
      lastFramedScope.current = scopeKey;
      return;
    }
    const t = setTimeout(() => {
      if (snap?.viewport) {
        flowInstance.setViewport(snap.viewport, { duration: 0 });
      } else {
        flowInstance.fitView({ padding: 0.3, maxZoom: 1, duration: 400 });
      }
      lastFramedScope.current = scopeKey;
    }, 350);
    return () => clearTimeout(t);
  }, [active, scopeKey, viewMode, expandedKey, scope, flowInstance, nodes.length === 0]);

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
      <div className="flex items-center justify-center h-full text-danger text-sm">
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
      key={scopeKey}
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
        setFlowInstance(instance);
      }}
      minZoom={0.2}
      maxZoom={1.25}
      defaultViewport={scopeSnapshots.get(scopeKey)?.viewport}
      fitView={!scopeSnapshots.get(scopeKey)?.viewport}
      fitViewOptions={{ padding: 0.3, maxZoom: 1, duration: 400 }}
      proOptions={{ hideAttribution: true }}
      className="bg-paper"
    >
      {scope === "global" && (
        <Panel position="top-left" className="!m-3">
          <div className="flex bg-surface/90 backdrop-blur-md border border-line rounded-lg p-0.5 shadow-raised text-xs">
            {(Object.keys(VIEW_LABELS) as ViewMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setViewMode(m)}
                className={`px-2.5 py-1 rounded-md font-medium transition-colors duration-200 ${
                  viewMode === m
                    ? "bg-accent text-on-accent shadow-card"
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
          <div className="text-2xs text-ink-muted bg-surface/90 backdrop-blur-md border border-line rounded-full px-3.5 py-1.5 shadow-raised">
            {viewMode === "dirs" && (graph?.edges.length ?? 0) > 0
              ? "展开目录卡片查看目录内连线，或切换「仅活跃 / 全部」查看跨目录通道"
              : "当前视图暂无会话间消息通道 —— 发起一次对话即可建立连线"}
          </div>
        </Panel>
      )}
      <Background color="rgb(var(--tk-line))" gap={22} size={1.2} />
      <Controls className="!bg-surface/90 !backdrop-blur-md !border !border-line !rounded-lg !shadow-raised !overflow-hidden [&_button]:!bg-transparent [&_button]:!border-line [&_button]:!text-ink-muted [&_button:hover]:!bg-tile-hover [&_button:hover]:!text-ink" />

      <MiniMap
        pannable
        zoomable
        bgColor="rgb(var(--tk-paper))"
        nodeColor="rgb(var(--tk-line-strong))"
        nodeStrokeColor="rgb(var(--tk-ink) / 0.35)"
        maskColor="rgb(var(--tk-paper) / 0.72)"
        className="!border !border-line !rounded-lg !shadow-raised"
      />
    </ReactFlow>
  );
}
