import assert from "node:assert/strict";
import { test } from "node:test";
import dagre from "@dagrejs/dagre";
import type { Node, Edge } from "@xyflow/react";
import { layoutGraph } from "../src/layout.ts";

const nodes = Array.from({ length: 25 }, (_, i) => ({
  id: `n${i}`,
  position: { x: 0, y: 0 },
})) as Node[];
const path = nodes
  .slice(1)
  .map((node, i) => ({ id: `e${i}`, source: nodes[i].id, target: node.id })) as Edge[];

test("long directed paths retain snake positions without performing Dagre layouts", (t) => {
  const layout = t.mock.method(dagre, "layout", () => {
    throw new Error("Redundant Dagre layout");
  });
  const result = layoutGraph(nodes, path);
  assert.equal(layout.mock.callCount(), 0);
  assert.equal(result.nodes.length, 25);
  assert.equal(result.edges, path);
  const position = (id: string) => result.nodes.find((node) => node.id === id)!.position;
  assert.deepEqual(position("n1"), { x: 0, y: 0 });
  assert.deepEqual(position("n0"), { x: 232, y: 0 });
  assert.deepEqual(position("n5"), { x: 928, y: 114 });
  assert.deepEqual(position("n24"), { x: 928, y: 456 });
});

test("cycles and branching graphs continue through the general layout", (t) => {
  const original = dagre.layout;
  const layout = t.mock.method(dagre, "layout", (...args: Parameters<typeof original>) =>
    original(...args),
  );
  for (const edges of [
    [...path, { id: "cycle", source: "n24", target: "n0" }] as Edge[],
    path.map((edge, i) => ({ ...edge, source: `n${Math.floor(i / 2)}` })),
    [
      ...path.filter((_, i) => i !== 9),
      { id: "separate-cycle", source: "n24", target: "n10" },
    ] as Edge[],
  ]) {
    const result = layoutGraph(nodes, edges);
    assert.equal(result.nodes.length, 25);
    assert.ok(
      result.nodes.every(
        (node) => Number.isFinite(node.position.x) && Number.isFinite(node.position.y),
      ),
    );
  }
  assert.equal(layout.mock.callCount(), 6);
});
