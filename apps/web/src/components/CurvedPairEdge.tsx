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
 * follows the cursor; double-click resets to the automatic offset (null
 * clears the manual override in GraphTab's persisted map).
 */
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
  const mx = (sourceX + targetX) / 2;
  const my = (sourceY + targetY) / 2;
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const cx = mx + nx * offset;
  const cy = my + ny * offset;
  const path = `M ${sourceX},${sourceY} Q ${cx},${cy} ${targetX},${targetY}`;

  // Point at t = 0.5 of a quadratic bezier — where the label sits.
  const lx = 0.25 * sourceX + 0.5 * cx + 0.25 * targetX;
  const ly = 0.25 * sourceY + 0.5 * cy + 0.25 * targetY;

  const stroke = (style as { stroke?: string } | undefined)?.stroke;
  const isSelected = stroke === "#2563eb";
  const manual = d.offsetKey !== undefined && d.onOffsetChange !== undefined;

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
      {/* animated dot-flow riding the rail — decorative only */}
      <path
        d={path}
        fill="none"
        className="react-flow__edge-path rf-flow-dots"
        style={{
          stroke: isSelected ? "#60a5fa" : "#94a3b8",
          strokeWidth: 2.5,
          pointerEvents: "none",
        }}
      />
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
              ? `px-2 py-0.5 rounded-full text-[10px] font-medium max-w-[140px] truncate border shadow-sm ${
                  isSelected
                    ? "bg-blue-50 border-blue-300 text-blue-700"
                    : "bg-white border-gray-200 text-gray-500"
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
            d.onOffsetChange!(d.offsetKey!, pointerToOffset(ev));
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
