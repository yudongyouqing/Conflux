import dagre from "@dagrejs/dagre";
import type { Node, Edge } from "@xyflow/react";

const NODE_WIDTH = 160;
const NODE_HEIGHT = 56;

export function layoutGraph(
  nodes: Node[],
  edges: Edge[],
  direction: "LR" | "TB" = "LR"
): { nodes: Node[]; edges: Edge[] } {
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
