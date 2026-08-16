import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from "@xyflow/react";

/**
 * Quadratic-arc edge whose bow is a signed perpendicular offset supplied via
 * data.offset. Reciprocal pairs (A→B and B→A) share one offset value; because
 * the direction vector reverses between them, the two arcs bend to opposite
 * sides — a symmetric lens instead of two overlapping lines. Single edges get
 * offset 0 and render as a straight line. Labels ride the arc's midpoint.
 */
export function CurvedPairEdge(props: EdgeProps) {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    data,
    label,
    labelStyle,
    markerEnd,
    style,
  } = props;

  const offset = (data as { offset?: number } | undefined)?.offset ?? 0;
  const mx = (sourceX + targetX) / 2;
  const my = (sourceY + targetY) / 2;
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const len = Math.hypot(dx, dy) || 1;
  const cx = mx + (-dy / len) * offset;
  const cy = my + (dx / len) * offset;
  const path = `M ${sourceX},${sourceY} Q ${cx},${cy} ${targetX},${targetY}`;

  // Point at t = 0.5 of a quadratic bezier — where the label sits.
  const lx = 0.25 * sourceX + 0.5 * cx + 0.25 * targetX;
  const ly = 0.25 * sourceY + 0.5 * cy + 0.25 * targetY;

  const isSelected = (style as { stroke?: string } | undefined)?.stroke === "#2563eb";

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      {label ? (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)`,
            }}
            className={`nodrag nopan pointer-events-none rounded border px-1 text-[9px] max-w-[140px] truncate ${
              isSelected
                ? "bg-blue-100 border-blue-300 text-blue-700 font-semibold"
                : "bg-white border-gray-200 text-gray-500"
            }`}
          >
            <span style={labelStyle}>{label}</span>
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
