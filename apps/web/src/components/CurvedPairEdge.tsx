import { useRef } from "react";
import { BaseEdge, EdgeLabelRenderer, useReactFlow, type EdgeProps } from "@xyflow/react";

/**
 * Quadratic-arc edge whose bow is a signed perpendicular offset supplied via
 * data.offset. Reciprocal pairs (A→B and B→A) share one offset value; because
 * the direction vector reverses between them, the two arcs bend to opposite
 * sides — a symmetric lens instead of two overlapping lines. Single edges get
 * offset 0 and render as a straight line.
 *
 * Visual language (Dify/n8n-style connection): a solid neutral rail plus an
 * animated dot-flow riding on top (see .rf-flow-dots in index.css), an
 * arrowhead at the target, and a message-count pill at the apex. The pill
 * doubles as a curvature handle: drag it and the arc bends so its apex
 * follows the cursor; double-click resets to the automatic offset.
 *
 * The dot-flow GAPS around the pill (subway-map style): de Casteljau
 * subdivision splits the quadratic at the pill's t-extents, so beads flow
 * up to the label and continue on the far side without crossing the text.
 */

interface Pt {
  x: number;
  y: number;
}
const lerp = (a: Pt, b: Pt, t: number): Pt => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

/** de Casteljau split of B(t), t∈[0,1], into [0,t] and [t,1] quadratics. */
function splitQ(p0: Pt, p1: Pt, p2: Pt, t: number) {
  const l1 = lerp(p0, p1, t);
  const l2 = lerp(p1, p2, t);
  const m = lerp(l1, l2, t);
  return {
    left: [p0, l1, m] as const,
    right: [m, l2, p2] as const,
  };
}

function pathOf([a, c, b]: readonly [Pt, Pt, Pt]) {
  return `M ${a.x},${a.y} Q ${c.x},${c.y} ${b.x},${b.y}`;
}

export function CurvedPairEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, data, label, labelStyle, markerEnd, style } =
    props;
  const { screenToFlowPosition } = useReactFlow();

  const d = (data ?? {}) as {
    offset?: number;
    offsetKey?: string;
    onOffsetChange?: (key: string, offset: number | null) => void;
  };
  const offset = d.offset ?? 0;
  const p0 = { x: sourceX, y: sourceY };
  const p2 = { x: targetX, y: targetY };
  const mx = (sourceX + targetX) / 2;
  const my = (sourceY + targetY) / 2;
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const c = { x: mx + nx * offset, y: my + ny * offset };
  const path = `M ${p0.x},${p0.y} Q ${c.x},${c.y} ${p2.x},${p2.y}`;

  // Point at t = 0.5 of a quadratic bezier — where the label sits.
  const lx = 0.25 * p0.x + 0.5 * c.x + 0.25 * p2.x;
  const ly = 0.25 * p0.y + 0.5 * c.y + 0.25 * p2.y;

  const stroke = (style as { stroke?: string } | undefined)?.stroke;
  const isSelected = stroke === "#2563eb";
  const manual = d.offsetKey !== undefined && d.onOffsetChange !== undefined;

  // ---- dot-flow gap around the label --------------------------------------
  // Estimate the arc length (8 samples) and convert the pill's pixel width
  // to a t-interval centered at 0.5; beads render as two sub-paths skipping
  // it so nothing crosses the text.
  const hasLabel = !!label;
  let beadPaths: string[] = [path];
  if (hasLabel) {
    const samples = 8;
    let arcLen = 0;
    let prev = p0;
    for (let i = 1; i <= samples; i++) {
      const t = i / samples;
      const pt = {
        x: (1 - t) * (1 - t) * p0.x + 2 * (1 - t) * t * c.x + t * t * p2.x,
        y: (1 - t) * (1 - t) * p0.y + 2 * (1 - t) * t * c.y + t * t * p2.y,
      };
      arcLen += Math.hypot(pt.x - prev.x, pt.y - prev.y);
      prev = pt;
    }
    const textPx = Math.min(String(label).length * 5.6 + 22, 140);
    const halfT = Math.min(0.42, Math.max(0.06, textPx / 2 / arcLen));
    const t0 = 0.5 - halfT;
    const t1 = 0.5 + halfT;
    const left = splitQ(p0, c, p2, t0).left;
    const right = splitQ(p0, c, p2, t1).right;
    beadPaths = [pathOf(left), pathOf(right)];
  }

  // ---- drag: rAF-coalesced curvature updates ------------------------------
  // Coalesce pointermove-driven updates to one per animation frame —
  // pointer events can outpace the display, and each update re-renders
  // every edge on the canvas.
  const pendingOffset = useRef<{ key: string; offset: number } | null>(null);
  const rafId = useRef<number | null>(null);
  const flushOffset = () => {
    rafId.current = null;
    const pending = pendingOffset.current;
    if (!pending || !d.onOffsetChange || d.offsetKey === undefined) return;
    d.onOffsetChange(pending.key, pending.offset);
  };
  const scheduleOffset = (key: string, offsetNum: number) => {
    pendingOffset.current = { key, offset: offsetNum };
    if (rafId.current === null) rafId.current = requestAnimationFrame(flushOffset);
  };

  const pointerToOffset = (ev: React.PointerEvent) => {
    const p = screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
    // The apex sits at mid + n * offset/2, so the cursor position maps to
    // offset = 2 * perp(cursor - mid). Clamped to keep arcs on the canvas.
    return Math.max(-240, Math.min(240, 2 * ((p.x - mx) * nx + (p.y - my) * ny)));
  };

  return (
    <>
      {/* solid rail (also carries interaction hit-testing) */}
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          ...style,
          strokeWidth: 2,
          stroke: isSelected ? "#3b82f6" : "#9ca8b6",
        }}
      />
      {/* animated dot-flow riding the rail — gapped around the label pill */}
      {beadPaths.map((p, i) => (
        <path
          key={i}
          d={p}
          fill="none"
          className="react-flow__edge-path rf-flow-dots"
          style={{
            stroke: isSelected ? "#60a5fa" : "#94a3b8",
            strokeWidth: 2.5,
            pointerEvents: "none",
          }}
        />
      ))}
      <EdgeLabelRenderer>
        <div
          style={{
            position: "absolute",
            transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)`,
            // EdgeLabelRenderer's container is pointer-events:none — children
            // must opt back in or drags never reach them.
            pointerEvents: "all",
          }}
          title={manual ? "拖动调整弧度 · 双击复位" : undefined}
          className={`nodrag nopan touch-none select-none ${
            label
              ? `px-2 py-0.5 rounded-full text-[10px] font-medium max-w-[140px] truncate border shadow-sm bg-white ${
                  isSelected ? "border-blue-300 text-blue-700" : "border-gray-200 text-gray-600"
                }${manual ? " cursor-grab active:cursor-grabbing hover:border-blue-300" : ""}`
              : `w-2.5 h-2.5 rounded-full border ${
                  manual
                    ? "border-gray-300 bg-gray-100 opacity-0 hover:opacity-100 cursor-grab active:cursor-grabbing"
                    : "hidden"
                } transition-opacity`
          }`}
          onPointerDown={(ev) => {
            if (!manual) return;
            ev.preventDefault();
            ev.stopPropagation();
            (ev.target as HTMLElement).setPointerCapture(ev.pointerId);
          }}
          onPointerMove={(ev) => {
            if (!manual || !(ev.buttons & 1)) return;
            ev.stopPropagation();
            scheduleOffset(d.offsetKey!, pointerToOffset(ev));
          }}
          onPointerUp={() => {
            if (rafId.current !== null) cancelAnimationFrame(rafId.current);
            flushOffset();
          }}
          onDoubleClick={(ev) => {
            if (!manual) return;
            ev.stopPropagation();
            d.onOffsetChange!(d.offsetKey!, null);
          }}
        >
          {label ? <span style={labelStyle}>{label}</span> : null}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
