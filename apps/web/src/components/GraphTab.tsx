import { useEffect, useCallback, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Panel,
  useNodesState,
  useEdgesState,
  MarkerType,
  type Node,
  type Edge,
  type NodeMouseHandler,
  type EdgeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useGraph } from "../hooks";
import { layoutGraph } from "../layout";
import { SessionNode, type SessionNodeData } from "./SessionNode";
import { GroupFrame, type GroupFrameData } from "./GroupFrame";
import { CurvedPairEdge } from "./CurvedPairEdge";

const nodeTypes = { session: SessionNode, cluster: GroupFrame };
const edgeTypes = { curved: CurvedPairEdge };

const CLUSTER_ID = "__orphan_cluster__";

// Grid geometry for orphan children inside the expanded cluster container.
const CELL_W = 192;
const CELL_H = 98;
const GRID_PAD_X = 16;
const GRID_PAD_TOP = 52; // room below the frame header (accent + title bar)

// Dirs-mode geometry: one group FRAME per project directory (Dify/Figma
// section style) — the frame OWNS its session nodes as React Flow children.
// Frames stack vertically newest-first; idle dirs default to collapsed.
const START_X = 40;
const START_Y = 24;
const FRAME_W = 420; // uniform dir-frame width (2 cards per row) — masonry needs aligned columns
const FRAME_GAP_X = 56;
const FRAME_GAP_Y = 56;
const FRAME_HEADER_H = 56; // collapsed frame height
const groupId = (dir: string) => `__group:${dir}`;
const ARCHIVE_KEY = "__archive__";
const dirBasename = (dir: string) => dir.split(/[\\/]/).pop() || dir;

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

  // Sync polled data into state. Node positions the user dragged to are
  // preserved across polls; only data (name/status/counts) refreshes.
  //
  // View modes:
  //   active — live nodes only; edges never dangle onto offline/placeholder nodes
  //   dirs   — live + still-linked offline sessions laid out ONE BY ONE, one
  //            row per project directory (newest directory first); orphan
  //            offline sessions (no communication links) collapse into a
  //            single archive cluster below the rows
  //   all    — every node through dagre with its real edges
  useEffect(() => {
    if (!data) return;

    const live = data.nodes.filter((n) => n.status === "active" || n.type === "agent");
    const offline = data.nodes.filter((n) => n.status !== "active" && n.type === "session");

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
        skills: n.skills,
      },
    });

    // An edge carries its channel's latest question as the label; clicking it
    // opens the two-way message flow in the detail panel. The closed marker
    // makes the direction (who asked whom) readable at a glance.
    const previewOf = (m: string | null | undefined) =>
      !m ? "" : m.length > 28 ? m.slice(0, 28) + "…" : m;
    const mkEdge = (e: (typeof data.edges)[number], i: number): Edge => ({
      id: `e-${e.from}-${e.to}-${i}`,
      source: e.from,
      target: e.to,
      animated: true,
      label: previewOf(e.last_message) || (e.weight > 1 ? String(e.weight) : ""),
      style: { strokeWidth: Math.min(1 + e.weight, 5), stroke: "#94a3b8" },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: "#94a3b8",
        width: 18,
        height: 18,
      },
      data: { id: e.id, from: e.from, to: e.to },
    });

    let rawEdges: Edge[];
    let outNodes: Node[];

    if (viewMode === "dirs") {
      // Endpoints of any edge = sessions that still carry communication
      // history. Offline sessions without links are orphans -> archive frame.
      const linked = new Set<string>();
      for (const e of data.edges) {
        linked.add(e.from);
        linked.add(e.to);
      }
      const individuals = [...live, ...offline.filter((n) => linked.has(n.id))];
      const orphans = offline.filter((n) => !linked.has(n.id));

      const groups = new Map<string, (typeof data.nodes)[number][]>();
      for (const n of individuals) {
        const dir = n.project_dir || "(no dir)";
        const g = groups.get(dir) ?? [];
        g.push(n);
        groups.set(dir, g);
      }
      const hb = (n: (typeof data.nodes)[number]) => n.last_heartbeat_at ?? "";
      const rows = [...groups.entries()]
        .map(([dir, ns]) => ({ dir, nodes: [...ns].sort((a, b) => hb(b).localeCompare(hb(a))) }))
        .sort((a, b) => hb(b.nodes[0]).localeCompare(hb(a.nodes[0])));

      // One owning frame per directory, stacked vertically. Children are
      // real React Flow children (parentId + extent) so a frame drags as
      // one unit; edges still connect children across frames.
      outNodes = [];
      // two-column masonry: each frame drops into the SHORTER column —
      // avoids the single tall tower of stacked slabs
      const colH = [START_Y, START_Y];
      const place = (height: number): { x: number; y: number } => {
        const c = colH[0] <= colH[1] ? 0 : 1;
        const pos = { x: START_X + c * (FRAME_W + FRAME_GAP_X), y: colH[c] };
        colH[c] = pos.y + height + FRAME_GAP_Y;
        return pos;
      };
      for (const row of rows) {
        const active = row.nodes.filter((n) => n.status === "active" || n.type === "agent").length;
        const key = "dir:" + row.dir;
        const collapsed = expandedKey !== key;
        const shown = collapsed ? [] : row.nodes.slice(0, 6); // cap: 3 rows x 2
        const hidden = row.nodes.length - shown.length;
        const cols = 2;
        const gridRows = Math.max(Math.ceil(shown.length / cols), 1);
        const width = FRAME_W;
        const height = collapsed ? FRAME_HEADER_H : gridRows * CELL_H + GRID_PAD_TOP + 14;
        const runtimeDots = row.nodes
          .filter((n) => n.status === "active" && n.type !== "agent")
          .map((n) =>
            n.runtime === "codex"
              ? "bg-slate-600"
              : n.runtime === "claude"
                ? "bg-orange-500"
                : "bg-blue-500",
          )
          .slice(0, 4);
        const id = groupId(row.dir);
        outNodes.push({
          id,
          type: "cluster",
          position: place(height),
          data: {
            key,
            variant: "dir",
            label: dirBasename(row.dir),
            count: row.nodes.length,
            activeCount: active,
            hiddenCount: hidden,
            runtimeDots,
            expanded: !collapsed,
            width,
            height,
          },
          style: { width, height },
          zIndex: -1,
        } as Node<GroupFrameData>);
        if (!collapsed) {
          shown.forEach((n, i) => {
            const node = toSessionNode(n);
            node.parentId = id;
            node.extent = "parent";
            node.position = {
              x: GRID_PAD_X + (i % cols) * CELL_W,
              y: GRID_PAD_TOP + Math.floor(i / cols) * CELL_H,
            };
            node.zIndex = 0;
            outNodes.push(node);
          });
        }
      }

      // Orphan archive frame below the directory frames.
      if (orphans.length > 0) {
        const expanded = expandedKey === ARCHIVE_KEY;
        const shownOrphans = expanded ? orphans.slice(0, 6) : [];
        const hiddenOrphans = orphans.length - shownOrphans.length;
        const cols = 2;
        const gridRows = Math.max(Math.ceil(shownOrphans.length / cols), 1);
        const width = FRAME_W;
        const height = expanded ? gridRows * CELL_H + GRID_PAD_TOP + 14 : FRAME_HEADER_H;
        outNodes.push({
          id: CLUSTER_ID,
          type: "cluster",
          position: place(height),
          data: {
            key: ARCHIVE_KEY,
            variant: "archive",
            label: null,
            count: orphans.length,
            activeCount: 0,
            hiddenCount: hiddenOrphans,
            expanded,
            width,
            height,
          },
          style: { width, height },
          zIndex: -1,
        });
        if (expanded) {
          shownOrphans.forEach((n, i) => {
            const node = toSessionNode(n);
            node.parentId = CLUSTER_ID;
            node.extent = "parent";
            node.position = {
              x: GRID_PAD_X + (i % cols) * CELL_W,
              y: GRID_PAD_TOP + Math.floor(i / cols) * CELL_H,
            };
            node.zIndex = 0;
            outNodes.push(node);
          });
        }
      }

      // Orphans have no edges by definition, so every real edge already runs
      // between visible individuals — no folding or aggregation needed.
      rawEdges = data.edges.map((e, i) => mkEdge(e, i));
    } else if (viewMode === "all") {
      rawEdges = data.edges.map((e, i) => mkEdge(e, i));
      const allNodes = [...live, ...offline];
      const { nodes: layouted } = layoutGraph(
        allNodes.map((n) => toSessionNode(n) as unknown as Node),
        rawEdges as never,
      );
      outNodes = layouted;
    } else {
      // active: only edges between visible (live) nodes — no dangling links.
      const visible = new Set(live.map((n) => n.id));
      rawEdges = data.edges
        .filter((e) => visible.has(e.from) && visible.has(e.to))
        .map((e, i) => mkEdge(e, i));
      const { nodes: layouted } = layoutGraph(
        live.map((n) => toSessionNode(n) as unknown as Node),
        rawEdges as never,
      );
      outNodes = layouted;
    }

    // Fan-out: parallel edges leaving the SAME source would stack into one
    // bundle (the web-console spoke mess). Spread them by per-source index.
    const srcTotal = new Map<string, number>();
    const srcIndex = new Map<string, number>();
    for (const e of rawEdges) {
      const d0 = e.data as { from: string; to: string };
      srcIndex.set(d0.from + ">" + d0.to, srcTotal.get(d0.from) ?? 0);
      srcTotal.set(d0.from, (srcTotal.get(d0.from) ?? 0) + 1);
    }
    // Reciprocal separation: count edges per unordered node pair, then bend
    // both directions of a two-way pair by the same perpendicular offset —
    // the reversed direction vector flips the bow to the opposite side, so
    // A→B and B→A render as a symmetric lens instead of overlapping lines.
    // Single edges stay straight (offset 0).
    const pairCount = new Map<string, number>();
    for (const e of rawEdges) {
      const d = e.data as { from: string; to: string };
      const key = d.from < d.to ? `${d.from}|${d.to}` : `${d.to}|${d.from}`;
      pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
    }
    rawEdges = rawEdges.map((e) => {
      const d = e.data as { from: string; to: string };
      const pairKey = d.from < d.to ? `${d.from}|${d.to}` : `${d.to}|${d.from}`;
      const twoWay = (pairCount.get(pairKey) ?? 0) > 1;
      const dirKey = `${d.from}->${d.to}`;
      const n = srcTotal.get(d.from) ?? 1;
      const idx = srcIndex.get(d.from + ">" + d.to) ?? 0;
      const fan = n > 1 ? (idx - (n - 1) / 2) * 48 : 0;
      const auto = (twoWay ? 34 : 0) + fan;
      return {
        ...e,
        type: "curved" as const,
        data: {
          ...d,
          offset: manualOffsets.current[dirKey] ?? auto,
          autoOffset: auto,
          offsetKey: dirKey,
          onOffsetChange: handleOffsetChange,
        },
      };
    });

    // Selection emphasis. Edge selected: that edge goes strong blue with a
    // bigger arrow, its two endpoint nodes get an amber ring, all other
    // edges dim. Node selected instead: its incident edges go blue.
    const selKey = selectedEdge ? `${selectedEdge.from}->${selectedEdge.to}` : null;
    const endpoints = selectedEdge ? new Set([selectedEdge.from, selectedEdge.to]) : null;
    const styledEdges = rawEdges.map((e) => {
      const d = e.data as { from: string; to: string };
      const w = (e.style?.strokeWidth as number) ?? 2;
      if (selKey && `${d.from}->${d.to}` === selKey) {
        return {
          ...e,
          zIndex: 5,
          style: { ...e.style, stroke: "#2563eb", strokeWidth: Math.min(w + 1, 6) },
          labelStyle: { fill: "#1d4ed8", fontWeight: 600 },
          labelBgStyle: { fill: "#dbeafe" },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: "#2563eb",
            width: 22,
            height: 22,
          },
        };
      }
      if (
        !selKey &&
        selectedSessionId &&
        (d.from === selectedSessionId || d.to === selectedSessionId)
      ) {
        return {
          ...e,
          style: { ...e.style, stroke: "#3b82f6" },
          markerEnd: { type: MarkerType.ArrowClosed, color: "#3b82f6", width: 18, height: 18 },
        };
      }
      if (selKey) {
        // another edge is in focus — fade this one out
        return {
          ...e,
          animated: false,
          style: { ...e.style, stroke: "#d1d5db" },
          markerEnd: { type: MarkerType.ArrowClosed, color: "#d1d5db", width: 16, height: 16 },
        };
      }
      return e;
    });

    setNodes((prev) => {
      const prevPos = new Map(prev.map((n) => [n.id, n.position]));
      return outNodes.map((n) => ({
        ...n,
        position: prevPos.get(n.id) ?? n.position,
        selected: n.id === selectedSessionId,
        data: { ...n.data, highlighted: !!endpoints?.has(n.id) },
      }));
    });
    setEdges(styledEdges);
  }, [
    data,
    selectedSessionId,
    selectedEdge,
    viewMode,
    expandedKey,
    handleOffsetChange,
    setNodes,
    setEdges,
  ]);

  const onNodeClick: NodeMouseHandler = useCallback(
    (_, node) => {
      if (node.type === "cluster") {
        const key = (node.data as { key?: string }).key ?? "";
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
