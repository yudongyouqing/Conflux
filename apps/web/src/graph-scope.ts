import type { Graph } from "@conflux/shared";

/**
 * Project the shared graph down to one room's member set: member nodes
 * (isolated members included), and only edges whose BOTH ends are members —
 * channel ids and direction stay exactly as the server reported them. Pure:
 * the input graph is never mutated, and members without graph nodes are
 * simply absent rather than fabricated.
 */
export function scopeGraphToRoom(graph: Graph, members: readonly string[]): Graph {
  const ids = new Set(members);
  return {
    nodes: graph.nodes.filter((node) => ids.has(node.id)),
    edges: graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
  };
}
