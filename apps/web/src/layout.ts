import dagre from "@dagrejs/dagre";
import type { Node, Edge } from "@xyflow/react";

const NODE_WIDTH = 176;
const NODE_HEIGHT = 66;
const GAP_X = 56;
const GAP_Y = 48;

interface BBox {
  width: number;
  height: number;
}

function bboxOf(nodes: Node[]): BBox {
  const xs = nodes.map((n) => n.position.x);
  const ys = nodes.map((n) => n.position.y);
  return {
    width: xs.length ? Math.max(...xs) - Math.min(...xs) + NODE_WIDTH : 0,
    height: ys.length ? Math.max(...ys) - Math.min(...ys) + NODE_HEIGHT : 0,
  };
}

function layoutOnce(nodes: Node[], edges: Edge[], direction: "LR" | "TB"): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: direction, ranksep: 90, nodesep: 80, marginx: 40, marginy: 40 });
  g.setDefaultEdgeLabel(() => ({}));
  nodes.forEach((node) => g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT }));
  edges.forEach((edge) => {
    if (g.hasNode(edge.source) && g.hasNode(edge.target)) g.setEdge(edge.source, edge.target);
  });
  dagre.layout(g);
  return nodes.map((node) => {
    const pos = g.node(node.id);
    return {
      ...node,
      position: pos ? { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 } : node.position,
    };
  });
}

// Layouts closer to this aspect ratio use the canvas better (typical React
// Flow viewport is landscape).
const TARGET_ASPECT = 16 / 9;

function aspectScore(bbox: BBox): number {
  if (bbox.width <= 0 || bbox.height <= 0) return Infinity;
  // LOG space: linear difference is asymmetric — a 40:1 landscape strip and
  // a 1:8 portrait column must score comparably bad.
  return Math.abs(Math.log(bbox.width / bbox.height) - Math.log(TARGET_ASPECT));
}

/**
 * Serpentine wrap for path-like graphs: a pure chain has NO good straight
 * layout (a 10-node chain is either a 2400px strip or a 1400px column);
 * folding it into ~√n rows keeps consecutive nodes adjacent and makes the
 * overall footprint roughly square. Order follows the path itself
 * (BFS from an endpoint), and alternating rows reverse direction so the
 * fold never puts the chain's continuation far away.
 */
function wrapSnake(nodes: Node[], edges: Edge[]): Node[] {
  // adjacency
  const adj = new Map<string, string[]>();
  const add = (a: string, b: string) => adj.set(a, [...(adj.get(a) ?? []), b]);
  edges.forEach((e) => {
    add(e.source, e.target);
    add(e.target, e.source);
  });
  // traversal order: BFS from the HIGHEST-degree node — paths walk end to
  // end, stars radiate from the hub, trees stay locally grouped.
  const ids = nodes.map((n) => n.id);
  const start = ids.reduce(
    (a, b) => ((adj.get(a)?.length ?? 0) >= (adj.get(b)?.length ?? 0) ? a : b),
    ids[0],
  );
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = [start];
  seen.add(start);
  while (queue.length) {
    const cur = queue.shift()!;
    order.push(cur);
    for (const nb of adj.get(cur) ?? []) {
      if (!seen.has(nb)) {
        seen.add(nb);
        queue.push(nb);
      }
    }
  }
  // disconnected stragglers append in original order so no node drops
  for (const id of ids) if (!seen.has(id)) order.push(id);

  const n = order.length;
  const rows = Math.max(1, Math.round(Math.sqrt(n)));
  const cols = Math.ceil(n / rows);
  const byId = new Map(nodes.map((nd) => [nd.id, nd]));
  return order.map((id, i) => {
    const row = Math.floor(i / cols);
    const inRow = i % cols;
    const serpentine = row % 2 === 1;
    const col = serpentine ? cols - 1 - inRow : inRow;
    const node = byId.get(id)!;
    return {
      ...node,
      position: { x: col * (NODE_WIDTH + GAP_X), y: row * (NODE_HEIGHT + GAP_Y) },
    };
  });
}

export function layoutGraph(
  nodes: Node[],
  edges: Edge[],
  direction: "LR" | "TB" = "LR",
): { nodes: Node[]; edges: Edge[] } {
  // No relations to draw: dagre would stack every node into one rank (a
  // single vertical column) — a "graph" that reads as a broken list. Fall
  // back to a tidy left-aligned grid instead.
  if (edges.length === 0 && nodes.length > 1) {
    const layoutedNodes = nodes.map((node, i) => ({
      ...node,
      position: {
        x: (i % 3) * (NODE_WIDTH + GAP_X),
        y: Math.floor(i / 3) * (NODE_HEIGHT + GAP_Y),
      },
    }));
    return { nodes: layoutedNodes, edges };
  }

  // Run BOTH directions and keep the one whose aspect ratio is closer to
  // the canvas. Cheap enough to double-run for <100 nodes.
  const primary = layoutOnce(nodes, edges, direction);
  const other: "LR" | "TB" = direction === "LR" ? "TB" : "LR";
  const alt = layoutOnce(nodes, edges, other);
  // slight bias toward the requested direction so near-ties don't flip
  const best = aspectScore(bboxOf(alt)) + 0.15 < aspectScore(bboxOf(primary)) ? alt : primary;

  // Snake fallback: a hub-and-spoke or long-chain graph is extreme in
  // BOTH directions (one giant column or one giant row) — no straight
  // dagre direction can save it. When the winner is still a sliver
  // (long/short side > 6), fold BFS order into serpentine rows.
  const bb = bboxOf(best);
  const slim = Math.min(bb.width, bb.height) || 1;
  if (Math.max(bb.width, bb.height) / slim > 6 && nodes.length > 4) {
    return { nodes: wrapSnake(nodes, edges), edges };
  }
  return { nodes: best, edges };
}
