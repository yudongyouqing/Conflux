import { test } from "node:test";
import assert from "node:assert/strict";
import type { GraphEdge, GraphNode } from "@muiltchat/shared";
import {
  ARCHIVE_KEY,
  applyEdgeOffsets,
  buildActiveView,
  buildDirsView,
  mergeNodePositions,
  previewOf,
  selectedEdgeEndpoints,
  styleEdges,
} from "../src/graph-builders.ts";
import type { Edge, Node } from "@xyflow/react";

const noop = () => {};

const node = (over: Partial<GraphNode>): GraphNode => ({
  id: "n",
  name: "n",
  status: "active",
  type: "session",
  context_count: 0,
  pending_inbox: 0,
  ...(over as GraphNode),
});

const edge = (from: string, to: string, weight = 1): GraphEdge =>
  ({ from, to, weight, last_message: null }) as GraphEdge;

const frameNodes = (nodes: Node[]) => nodes.filter((n) => n.type === "cluster");
const sessionNodes = (nodes: Node[]) => nodes.filter((n) => n.type === "session");

test("previewOf truncates to 16 chars with ellipsis", () => {
  assert.equal(previewOf(null), "");
  assert.equal(previewOf("short"), "short");
  assert.equal(previewOf("a".repeat(20)), "a".repeat(16) + "…");
});

test("buildActiveView drops offline nodes and dangling edges", () => {
  const data = {
    nodes: [
      node({ id: "live-1", project_dir: "C:\\a" }),
      node({ id: "live-2", project_dir: "C:\\a" }),
      node({ id: "dead-1", status: "stale", project_dir: "C:\\a" }),
    ],
    edges: [edge("live-1", "live-2"), edge("live-1", "dead-1")],
  };
  const { nodes, edges } = buildActiveView({ data, onSelectEdge: noop });
  assert.ok(
    sessionNodes(nodes).every((n) => n.id !== "dead-1"),
    "offline node hidden",
  );
  assert.equal(edges.length, 1, "dangling edge dropped");
  assert.equal(edges[0].target, "live-2");
});

test("buildDirsView: one frame per dir, collapsed by default, masonry columns", () => {
  const data = {
    nodes: [
      node({ id: "a1", project_dir: "C:\\projA", last_heartbeat_at: "2026-01-02" }),
      node({ id: "a2", project_dir: "C:\\projA", last_heartbeat_at: "2026-01-01" }),
      node({ id: "b1", project_dir: "C:\\projB", last_heartbeat_at: "2025-12-31" }),
    ],
    edges: [],
  };
  const { nodes } = buildDirsView({ data, onSelectEdge: noop, expandedKey: null });
  const frames = frameNodes(nodes);
  assert.equal(frames.length, 2, "one frame per directory");
  assert.equal(sessionNodes(nodes).length, 0, "all collapsed by default");
  // masonry: two frames land in different columns (different x)
  const xs = new Set(frames.map((f) => f.position.x));
  assert.equal(xs.size, 2, "two-column masonry");

  // opening one dir shows its (capped) children inside its frame
  const open = buildDirsView({ data, onSelectEdge: noop, expandedKey: "dir:C:\\projA" });
  const openFrames = frameNodes(open.nodes);
  const projA = openFrames.find((f) => (f.data as { label?: string }).label === "projA");
  assert.ok(projA, "frame labeled by dir basename");
  const kids = sessionNodes(open.nodes).filter((n) => n.parentId === projA!.id);
  assert.equal(kids.length, 2, "children parented to the frame");
  const projB = openFrames.find((f) => (f.data as { label?: string }).label === "projB");
  assert.equal((projB!.data as { expanded: boolean }).expanded, false, "accordion: sibling closed");
});

test("buildDirsView: 6-card cap + hiddenCount, orphan archive frame", () => {
  const many = Array.from({ length: 9 }, (_, i) =>
    node({ id: `m${i}`, project_dir: "C:\\big", last_heartbeat_at: `2026-01-0${i + 1}` }),
  );
  const orphan = node({ id: "ghost", status: "stale", project_dir: "C:\\gone" });
  const data = { nodes: [...many, orphan], edges: [] };
  const { nodes } = buildDirsView({ data, onSelectEdge: noop, expandedKey: "dir:C:\\big" });

  const big = frameNodes(nodes).find((f) => (f.data as { label?: string }).label === "big")!;
  assert.equal(sessionNodes(nodes).filter((n) => n.parentId === big.id).length, 6, "cap at 6");
  assert.equal((big.data as { hiddenCount: number }).hiddenCount, 3, "hidden count reported");

  const archive = frameNodes(nodes).find((f) => f.id === "__orphan_cluster__");
  assert.ok(archive, "archive frame exists for orphans");
  assert.equal((archive!.data as { key: string }).key, ARCHIVE_KEY);
});

test("applyEdgeOffsets: lens for reciprocal pairs, fan for parallel siblings", () => {
  const mk = (from: string, to: string): Edge =>
    ({ id: `${from}>${to}`, source: from, target: to, data: { from, to } }) as Edge;
  const lens = applyEdgeOffsets([mk("a", "b"), mk("b", "a")], {}, noop);
  const ab = lens[0].data as { offset: number; autoOffset: number };
  const ba = lens[1].data as { offset: number; autoOffset: number };
  assert.equal(ab.autoOffset, 34, "two-way pair bows");
  assert.equal(ba.autoOffset, 34, "both directions bow (opposite sign at render)");

  const fan = applyEdgeOffsets([mk("hub", "s1"), mk("hub", "s2"), mk("hub", "s3")], {}, noop);
  const offs = fan.map((e) => (e.data as { offset: number }).offset);
  assert.deepEqual(offs, [-34, 0, 34], "parallel siblings fan symmetrically");

  const manual = applyEdgeOffsets([mk("a", "b"), mk("b", "a")], { "a->b": -100 }, noop);
  assert.equal((manual[0].data as { offset: number }).offset, -100, "manual wins");
  assert.equal((manual[0].data as { autoOffset: number }).autoOffset, 34, "auto kept for reset");
});

test("styleEdges: selection emphasis dims siblings, session focus blues incident edges", () => {
  const base = (from: string, to: string): Edge =>
    ({
      id: `${from}-${to}`,
      source: from,
      target: to,
      label: "",
      style: { strokeWidth: 2 },
      data: { from, to, lastMessage: "最近的一条消息内容" },
    }) as Edge;
  const edges = [base("a", "b"), base("c", "d")];

  const sel = styleEdges(edges, { from: "a", to: "b" }, null) as never as Array<{
    label: string;
    style: { stroke: string };
    animated: boolean;
    data: { from: string };
  }>;
  assert.ok(sel[0].label.includes("最近的一条"), "selected edge expands preview");
  assert.equal(sel[0].style.stroke, "#2563eb", "selected blue");
  assert.equal(sel[1].animated, false, "sibling dimmed");

  const focus = styleEdges(edges, null, "c") as never as Array<{
    style: { stroke: string };
  }>;
  assert.equal(focus[1].style.stroke, "#3b82f6", "incident edge highlighted");
  assert.notEqual(focus[0].style.stroke, "#3b82f6", "unrelated edge untouched");
});

test("mergeNodePositions keeps dragged positions, new nodes keep builder position", () => {
  const prev = [{ id: "kept", position: { x: 99, y: 99 } }] as Node[];
  const next = [
    { id: "kept", position: { x: 0, y: 0 } },
    { id: "fresh", position: { x: 5, y: 5 } },
  ] as Node[];
  const merged = mergeNodePositions(prev, next, "fresh");
  assert.deepEqual(merged[0].position, { x: 99, y: 99 }, "dragged position preserved");
  assert.deepEqual(merged[1].position, { x: 5, y: 5 }, "new node keeps position");
  assert.equal((merged[1] as { selected?: boolean }).selected, true, "selection applied");
});

test("selectedEdgeEndpoints returns both endpoints or null", () => {
  assert.deepEqual(selectedEdgeEndpoints({ from: "a", to: "b" }), new Set(["a", "b"]));
  assert.equal(selectedEdgeEndpoints(null), null);
});
