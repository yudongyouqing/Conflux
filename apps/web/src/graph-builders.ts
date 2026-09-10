import { MarkerType, type Edge, type Node } from "@xyflow/react";
import type { GraphEdge, GraphNode } from "@muiltchat/shared";
import { layoutGraph } from "./layout";
import type { SessionNodeData } from "./components/SessionNode";
import type { GroupFrameData } from "./components/GroupFrame";

/**
 * Pure view builders for the graph tab. Everything here is a data-in →
 * data-out transformation with NO React, DOM, or localStorage access —
 * which is exactly what makes the three view modes testable without a
 * browser. GraphTab keeps only hooks, effects that call these, and JSX.
 */

// ---- geometry ---------------------------------------------------------------

export const CLUSTER_ID = "__orphan_cluster__";
export const ARCHIVE_KEY = "__archive__";
const START_X = 40;
const START_Y = 24;
const FRAME_W = 420; // uniform dir-frame width (2 cards per row)
const FRAME_GAP_X = 56;
const FRAME_GAP_Y = 56;
const FRAME_HEADER_H = 56; // collapsed frame height
const CELL_W = 192;
const CELL_H = 98;
const GRID_PAD_X = 16;
const GRID_PAD_TOP = 52; // room below the frame header
const DIR_COLS = 2;
const FRAME_CHILD_CAP = 6; // max visible cards per expanded frame
const FAN_STEP = 34; // per-sibling edge fan spacing
const LENS_OFFSET = 34; // reciprocal A↔B lens bow

const groupId = (dir: string) => `__group:${dir}`;
const dirBasename = (dir: string) => dir.split(/[\\/]/).pop() || dir;

// ---- node / edge construction ------------------------------------------------

export function toSessionNode(n: GraphNode): Node<SessionNodeData> {
  return {
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
  };
}

export const previewOf = (m: string | null | undefined) =>
  !m ? "" : m.length > 16 ? m.slice(0, 16) + "…" : m;

export interface EdgeSelectHandler {
  (edge: { id: number; from: string; to: string }): void;
}

// Canvas shows STRUCTURE (who talks to whom, how much); the message preview
// is detail — it appears only while the edge is selected. The default label
// is a compact xN count badge.
export function mkEdge(e: GraphEdge, i: number, onSelect: EdgeSelectHandler): Edge {
  return {
    id: `e-${e.from}-${e.to}-${i}`,
    source: e.from,
    target: e.to,
    animated: true,
    label: e.weight > 1 ? `x${e.weight}` : "",
    style: { strokeWidth: Math.min(1 + e.weight, 5), stroke: "#94a3b8" },
    markerEnd: { type: MarkerType.ArrowClosed, color: "#94a3b8", width: 18, height: 18 },
    data: {
      id: e.id,
      from: e.from,
      to: e.to,
      lastMessage: e.last_message ?? null,
      onSelect: () => onSelect({ id: e.id, from: e.from, to: e.to }),
    },
  };
}

// ---- view builders -------------------------------------------------------------

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ViewBuilderInput {
  data: GraphData;
  onSelectEdge: EdgeSelectHandler;
}

/** active: live nodes only; edges never dangle onto offline/placeholder nodes. */
export function buildActiveView({ data, onSelectEdge }: ViewBuilderInput) {
  const live = data.nodes.filter((n) => n.status === "active" || n.type === "agent");
  const visible = new Set(live.map((n) => n.id));
  const edges = data.edges
    .filter((e) => visible.has(e.from) && visible.has(e.to))
    .map((e, i) => mkEdge(e, i, onSelectEdge));
  const { nodes } = layoutGraph(live.map(toSessionNode) as never, edges as never);
  return { nodes, edges };
}

/** all: every node through dagre with its real edges. */
export function buildAllView({ data, onSelectEdge }: ViewBuilderInput) {
  const edges = data.edges.map((e, i) => mkEdge(e, i, onSelectEdge));
  const { nodes } = layoutGraph(data.nodes.map(toSessionNode) as never, edges as never);
  return { nodes, edges };
}

export interface DirsViewInput extends ViewBuilderInput {
  /** the ONE open frame (accordion); null = all collapsed */
  expandedKey: string | null;
}

/**
 * dirs: one owning group FRAME per project directory (Dify/Figma section
 * style) in a two-column masonry, plus an archive frame for offline
 * orphans. Frames OWN their session nodes as React Flow children
 * (parentId + extent) so a frame drags as one unit.
 */
export function buildDirsView({ data, onSelectEdge, expandedKey }: DirsViewInput) {
  const live = data.nodes.filter((n) => n.status === "active" || n.type === "agent");
  const offline = data.nodes.filter((n) => n.status !== "active" && n.type === "session");

  // Endpoints of any edge = sessions that still carry communication history.
  // Offline sessions without links are orphans → archive frame.
  const linked = new Set<string>();
  for (const e of data.edges) {
    linked.add(e.from);
    linked.add(e.to);
  }
  const individuals = [...live, ...offline.filter((n) => linked.has(n.id))];
  const orphans = offline.filter((n) => !linked.has(n.id));

  const hb = (n: GraphNode) => n.last_heartbeat_at ?? "";
  const groups = new Map<string, GraphNode[]>();
  for (const n of individuals) {
    const dir = n.project_dir || "(no dir)";
    const g = groups.get(dir) ?? [];
    g.push(n);
    groups.set(dir, g);
  }
  const rows = [...groups.entries()]
    .map(([dir, ns]) => ({ dir, nodes: [...ns].sort((a, b) => hb(b).localeCompare(hb(a))) }))
    .sort((a, b) => hb(b.nodes[0]).localeCompare(hb(a.nodes[0])));

  const outNodes: Node[] = [];
  // two-column masonry: each frame drops into the SHORTER column — avoids
  // the single tall tower of stacked slabs
  const colH = [START_Y, START_Y];
  const place = (height: number): { x: number; y: number } => {
    const c = colH[0] <= colH[1] ? 0 : 1;
    const pos = { x: START_X + c * (FRAME_W + FRAME_GAP_X), y: colH[c] };
    colH[c] = pos.y + height + FRAME_GAP_Y;
    return pos;
  };

  const frameGeometry = (count: number, expanded: boolean) => {
    const gridRows = Math.max(Math.ceil(count / DIR_COLS), 1);
    return {
      width: FRAME_W,
      height: expanded ? gridRows * CELL_H + GRID_PAD_TOP + 14 : FRAME_HEADER_H,
    };
  };
  const placeChildren = (nodes: GraphNode[], parentId: string) => {
    nodes.forEach((n, i) => {
      const node = toSessionNode(n);
      node.parentId = parentId;
      node.extent = "parent";
      node.position = {
        x: GRID_PAD_X + (i % DIR_COLS) * CELL_W,
        y: GRID_PAD_TOP + Math.floor(i / DIR_COLS) * CELL_H,
      };
      node.zIndex = 0;
      outNodes.push(node);
    });
  };

  for (const row of rows) {
    const active = row.nodes.filter((n) => n.status === "active" || n.type === "agent").length;
    const key = "dir:" + row.dir;
    const collapsed = expandedKey !== key;
    const shown = collapsed ? [] : row.nodes.slice(0, FRAME_CHILD_CAP);
    const hidden = row.nodes.length - shown.length;
    const { width, height } = frameGeometry(shown.length, !collapsed);
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
    if (!collapsed) placeChildren(shown, id);
  }

  // Orphan archive frame below the directory frames (accordion member too).
  if (orphans.length > 0) {
    const expanded = expandedKey === ARCHIVE_KEY;
    const shown = expanded ? orphans.slice(0, FRAME_CHILD_CAP) : [];
    const hidden = orphans.length - shown.length;
    const { width, height } = frameGeometry(shown.length, expanded);
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
        hiddenCount: hidden,
        expanded,
        width,
        height,
      },
      style: { width, height },
      zIndex: -1,
    } as Node<GroupFrameData>);
    if (expanded) placeChildren(shown, CLUSTER_ID);
  }

  // Orphans have no edges by definition, so every real edge already runs
  // between visible individuals — no folding or aggregation needed.
  return { nodes: outNodes, edges: data.edges.map((e, i) => mkEdge(e, i, onSelectEdge)) };
}

// ---- edge offsets (fan + reciprocal lens) ---------------------------------------

type EdgeData = { from: string; to: string };

/**
 * Fan-out: parallel edges leaving the SAME source would stack into one
 * bundle (the web-console spoke mess) — spread them by per-source index.
 * Reciprocal separation: both directions of a two-way pair bend by the same
 * perpendicular offset; the reversed direction vector flips the bow to the
 * opposite side — a symmetric lens instead of overlapping lines. Single
 * edges stay straight (offset 0). Manual overrides win over the automatic
 * value; null clears back to automatic.
 */
export function applyEdgeOffsets(
  edges: Edge[],
  manualOffsets: Record<string, number>,
  onOffsetChange: (key: string, offset: number | null) => void,
): Edge[] {
  const srcTotal = new Map<string, number>();
  const srcIndex = new Map<string, number>();
  const pairKey = (d: EdgeData) => (d.from < d.to ? `${d.from}|${d.to}` : `${d.to}|${d.from}`);
  const pairCount = new Map<string, number>();
  for (const e of edges) {
    const d = e.data as EdgeData;
    srcIndex.set(d.from + ">" + d.to, srcTotal.get(d.from) ?? 0);
    srcTotal.set(d.from, (srcTotal.get(d.from) ?? 0) + 1);
    const k = pairKey(d);
    pairCount.set(k, (pairCount.get(k) ?? 0) + 1);
  }
  return edges.map((e) => {
    const d = e.data as EdgeData;
    const twoWay = (pairCount.get(pairKey(d)) ?? 0) > 1;
    const dirKey = `${d.from}->${d.to}`;
    const n = srcTotal.get(d.from) ?? 1;
    const idx = srcIndex.get(d.from + ">" + d.to) ?? 0;
    const fan = n > 1 ? (idx - (n - 1) / 2) * FAN_STEP : 0;
    const auto = (twoWay ? LENS_OFFSET : 0) + fan;
    return {
      ...e,
      type: "curved" as const,
      data: {
        ...d,
        offset: manualOffsets[dirKey] ?? auto,
        autoOffset: auto,
        offsetKey: dirKey,
        onOffsetChange,
      },
    };
  });
}

// ---- selection emphasis ----------------------------------------------------------

export type SelectedEdge = { from: string; to: string } | null;

/**
 * Edge selected: that edge goes strong blue with a bigger arrow and its
 * message preview, its endpoints get an amber ring (via caller), all other
 * edges dim. Node selected instead: its incident edges go blue.
 */
export function styleEdges(
  edges: Edge[],
  selectedEdge: SelectedEdge,
  selectedSessionId: string | null,
): Edge[] {
  const selKey = selectedEdge ? `${selectedEdge.from}->${selectedEdge.to}` : null;
  return edges.map((e) => {
    const d = e.data as EdgeData & { lastMessage?: string | null };
    const w = (e.style?.strokeWidth as number) ?? 2;
    if (selKey && `${d.from}->${d.to}` === selKey) {
      return {
        ...e,
        zIndex: 5,
        label: previewOf(d.lastMessage) || e.label,
        style: { ...e.style, stroke: "#2563eb", strokeWidth: Math.min(w + 1, 6) },
        labelStyle: { fill: "#1d4ed8", fontWeight: 600 },
        labelBgStyle: { fill: "#dbeafe" },
        markerEnd: { type: MarkerType.ArrowClosed, color: "#2563eb", width: 22, height: 22 },
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
}

/** Endpoint ids of the selected edge — for amber-ring highlighting. */
export function selectedEdgeEndpoints(selectedEdge: SelectedEdge): Set<string> | null {
  return selectedEdge ? new Set([selectedEdge.from, selectedEdge.to]) : null;
}

// ---- poll merge -------------------------------------------------------------------

/**
 * Rebuilt nodes keep user-dragged positions and selection/highlight state;
 * brand-new nodes take their builder-assigned position.
 */
export function mergeNodePositions(
  prev: Node[],
  next: Node[],
  selectedSessionId: string | null,
): Node[] {
  const prevPos = new Map(prev.map((n) => [n.id, n.position]));
  return next.map((n) => ({
    ...n,
    position: prevPos.get(n.id) ?? n.position,
    selected: n.id === selectedSessionId,
  }));
}
