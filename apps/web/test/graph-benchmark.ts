import { performance } from "node:perf_hooks";
import type { GraphEdge, GraphNode } from "@muiltchat/shared";
import { buildActiveView } from "../src/graph-builders.ts";

for (const topology of ["chain", "tree", "disconnected"] as const) {
  for (const count of [25, 100, 300]) {
    const nodes = Array.from({ length: count }, (_, i) => ({
      id: `n${i}`,
      name: `session ${i}`,
      status: "active",
      type: "session",
      context_count: 0,
      pending_inbox: 0,
    })) as GraphNode[];
    const edges = Array.from({ length: topology === "disconnected" ? 0 : count - 1 }, (_, i) => ({
      from: `n${topology === "tree" ? Math.floor(i / 2) : i}`,
      to: `n${i + 1}`,
      weight: 1,
      last_message: null,
    })) as GraphEdge[];
    const input = { data: { nodes, edges }, onSelectEdge: () => {} };
    for (let i = 0; i < 3; i++) buildActiveView(input);
    const samples = Array.from({ length: 10 }, () => {
      const start = performance.now();
      const result = buildActiveView(input);
      if (result.nodes.length !== count || result.edges.length !== edges.length)
        throw new Error("Unexpected graph size");
      return performance.now() - start;
    }).sort((a, b) => a - b);
    console.log(
      `${topology}: ${count} nodes / ${edges.length} edges: median ${((samples[4] + samples[5]) / 2).toFixed(2)} ms, max ${samples[9].toFixed(2)} ms`,
    );
  }
}
