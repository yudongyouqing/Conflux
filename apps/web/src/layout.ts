import dagre from "@dagrejs/dagre";
import type { Node, Edge } from "@xyflow/react";

const NODE_WIDTH = 200;
const NODE_HEIGHT = 88;

export function layoutGraph(
  nodes: Node[],
  edges: Edge[],
  direction: "LR" | "TB" = "LR"
): { nodes: Node[]; edges: Edge[] } {
  // No relations to draw: dagre would stack every node into one rank (a
  // single vertical column) — a "graph" that reads as a broken list. Fall
  // back to a tidy left-aligned grid instead.
  if (edges.length === 0 && nodes.length > 1) {
    const COLS = 3;
    const GAP_X = 56;
    const GAP_Y = 48;
    const layoutedNodes = nodes.map((node, i) => ({
      ...node,
      position: {
        x: (i % COLS) * (NODE_WIDTH + GAP_X),
        y: Math.floor(i / COLS) * (NODE_HEIGHT + GAP_Y),
      },
    }));
    return { nodes: layoutedNodes, edges };
  }

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: direction, ranksep: 100, nodesep: 50, marginx: 40, marginy: 40 });
  g.setDefaultEdgeLabel(() => ({}));

  nodes.forEach((node) => {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  });
  edges.forEach((edge) => {
    if (g.hasNode(edge.source) && g.hasNode(edge.target)) {
      g.setEdge(edge.source, edge.target);
    }
  });

  dagre.layout(g);

  const layoutedNodes = nodes.map((node) => {
    const pos = g.node(node.id);
    return {
      ...node,
      position: pos
        ? { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 }
        : node.position,
    };
  });

  return { nodes: layoutedNodes, edges };
}
