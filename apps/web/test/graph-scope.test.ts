import assert from "node:assert/strict";
import { test } from "node:test";
import type { Graph, GraphEdge, GraphNode } from "@conflux/shared";
import { scopeGraphToRoom } from "../src/graph-scope.ts";

function node(id: string): GraphNode {
  return {
    id,
    name: id,
    status: "active",
    type: "session",
    context_count: 0,
    pending_inbox: 0,
  };
}

function edge(id: number, from: string, to: string): GraphEdge {
  return { id, from, to, weight: 1, last_interact_at: "2026-11-06T00:00:00Z", last_message: null };
}

test("room scope keeps member nodes, internal edges and isolated members; drops everything else", () => {
  const graph: Graph = {
    nodes: [node("A"), node("B"), node("C"), node("D")],
    // A→B internal; B→C crosses out; A→C crosses out; D isolated
    edges: [edge(1, "A", "B"), edge(2, "B", "C"), edge(3, "A", "C")],
  };

  const scoped = scopeGraphToRoom(graph, ["A", "B", "D"]);

  assert.deepEqual(
    scoped.nodes.map((n) => n.id).sort(),
    ["A", "B", "D"],
    "members only — the isolated member D stays visible",
  );
  assert.deepEqual(
    scoped.edges.map((e) => e.id),
    [1],
    "only edges with BOTH ends inside the room survive, with their real channel id",
  );
  assert.equal(scoped.edges[0].from, "A");
  assert.equal(scoped.edges[0].to, "B", "edge direction is preserved");
});

test("room scope never mutates its input graph", () => {
  const graph: Graph = {
    nodes: [node("A"), node("B"), node("C")],
    edges: [edge(7, "A", "B"), edge(8, "B", "C")],
  };
  const before = JSON.stringify(graph);

  scopeGraphToRoom(graph, ["A", "B"]);

  assert.equal(JSON.stringify(graph), before, "the caller's graph object must stay untouched");
});

test("room scope with unknown member ids simply yields no fabricated nodes", () => {
  const graph: Graph = { nodes: [node("A")], edges: [] };
  const scoped = scopeGraphToRoom(graph, ["ghost", "A", ""]);
  assert.deepEqual(scoped.nodes.map((n) => n.id), ["A"]);
  assert.deepEqual(scoped.edges, []);
});

test("empty member list scopes to an empty graph without touching the input", () => {
  const graph: Graph = { nodes: [node("A"), node("B")], edges: [edge(1, "A", "B")] };
  const scoped = scopeGraphToRoom(graph, []);
  assert.deepEqual(scoped, { nodes: [], edges: [] });
});
