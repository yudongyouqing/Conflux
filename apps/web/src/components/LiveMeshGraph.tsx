import { useMemo, useState } from "react";
import type { Graph, GraphNode, IncomingCallMode, Message } from "@conflux/shared";
import { Check, ChevronDown, Folder, PhoneOff, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api";

interface LiveMeshGraphProps {
  graph: Graph;
  activeCalls: Message[];
  allCalls: Message[];
  localHostname: string;
  onEnterWorkspace: (threadId: string) => void;
}

const NODE_W = 240;
const NODE_H = 112;
const HOST_PAD_X = 16;
const DIR_PAD_X = 12;
const DIR_HEADER_H = 26;
const HOST_HEADER_H = 34;

function nextIncomingMode(current: IncomingCallMode): IncomingCallMode {
  if (current === "auto") return "ask";
  if (current === "ask") return "dnd";
  return "auto";
}

export function incomingModeLabel(mode: IncomingCallMode, withPrefix = false): string {
  const base = mode === "auto" ? "自动接听" : mode === "ask" ? "需我放行" : "免打扰";
  return withPrefix ? `来电：${base}` : base;
}

export function incomingModeClass(mode: IncomingCallMode): string {
  if (mode === "auto") return "border-success/35 bg-success-soft text-success";
  if (mode === "ask") return "border-warning/35 bg-warning-soft text-warning";
  return "border-danger/35 bg-danger-soft text-danger";
}

interface PositionedHost {
  host: string;
  isRemote: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  dirs: Array<{
    dirPath: string;
    x: number;
    y: number;
    w: number;
    h: number;
    nodes: Array<{ node: GraphNode; x: number; y: number }>;
  }>;
}

export function LiveMeshGraph({
  graph,
  activeCalls,
  allCalls,
  localHostname,
  onEnterWorkspace,
}: LiveMeshGraphProps) {
  const qc = useQueryClient();
  const [selectedCallId, setSelectedCallId] = useState<number | null>(null);
  const [ctxOpen, setCtxOpen] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);

  const liveNodes = useMemo(
    () => graph.nodes.filter((n) => n.kind !== "console"),
    [graph.nodes],
  );

  // Organize live nodes strictly as Host -> Directory -> Session with deterministic coordinates
  const layout = useMemo(() => {
    const byHost = new Map<string, Map<string, GraphNode[]>>();
    for (const node of liveNodes) {
      const h = node.host || localHostname || "localhost";
      let dirs = byHost.get(h);
      if (!dirs) {
        dirs = new Map();
        byHost.set(h, dirs);
      }
      const dir = node.workdir || "workspace";
      const list = dirs.get(dir) ?? [];
      list.push(node);
      dirs.set(dir, list);
    }

    const hostKeys = Array.from(byHost.keys()).sort((a, b) => {
      const aRemote = a.toLowerCase() !== (localHostname || "localhost").toLowerCase();
      const bRemote = b.toLowerCase() !== (localHostname || "localhost").toLowerCase();
      return Number(aRemote) - Number(bRemote);
    });

    const hosts: PositionedHost[] = [];
    const nodePos = new Map<string, { x: number; y: number }>();

    const hostColW = NODE_W + HOST_PAD_X * 2 + DIR_PAD_X * 2;
    const hostGapX = 148;
    let cursorX = 24;
    let maxCanvasH = 560;

    for (const h of hostKeys) {
      const isRemote = h.toLowerCase() !== (localHostname || "localhost").toLowerCase();
      const dirsMap = byHost.get(h)!;
      const dirsOut: PositionedHost["dirs"] = [];
      let cursorY = 24 + HOST_HEADER_H;

      for (const [dirPath, nodesInDir] of dirsMap.entries()) {
        const dirX = cursorX + HOST_PAD_X;
        const dirY = cursorY;
        const dirW = hostColW - HOST_PAD_X * 2;
        const placedNodes: Array<{ node: GraphNode; x: number; y: number }> = [];
        let nodeY = dirY + DIR_HEADER_H + 8;

        for (const node of nodesInDir) {
          const nx = dirX + DIR_PAD_X;
          placedNodes.push({ node, x: nx, y: nodeY });
          nodePos.set(node.id, { x: nx, y: nodeY });
          nodeY += NODE_H + 14;
        }

        const dirH = Math.max(nodeY - dirY + 2, 146);
        dirsOut.push({ dirPath, x: dirX, y: dirY, w: dirW, h: dirH, nodes: placedNodes });
        cursorY += dirH + 14;
      }

      const hostH = Math.max(cursorY - 24 + 8, 220);
      hosts.push({ host: h, isRemote, x: cursorX, y: 24, w: hostColW, h: hostH, dirs: dirsOut });
      maxCanvasH = Math.max(maxCanvasH, hostH + 48);
      cursorX += hostColW + hostGapX;
    }

    const canvasW = Math.max(cursorX + 40, 760);
    return { hosts, nodePos, canvasW, canvasH: maxCanvasH };
  }, [liveNodes, localHostname]);

  // Visible live calls connecting live nodes on the graph
  const visibleCalls = useMemo(() => {
    const candidates = activeCalls.length > 0 ? activeCalls : allCalls.slice(0, 6);
    return candidates.filter(
      (c) => layout.nodePos.has(c.from_session) && layout.nodePos.has(c.to_session),
    );
  }, [activeCalls, allCalls, layout.nodePos]);

  const selectedCall = useMemo(() => {
    if (selectedCallId === null) return null;
    return allCalls.find((c) => c.id === selectedCallId) ?? null;
  }, [allCalls, selectedCallId]);

  const handleCycleCallMode = async (node: GraphNode) => {
    const next = nextIncomingMode(node.incoming_call_mode ?? "auto");
    await api.setIncomingCallMode(node.id, next);
    void qc.invalidateQueries({ queryKey: ["graph"] });
    void qc.invalidateQueries({ queryKey: ["workspace-tree"] });
  };

  const handleApproveCall = async (callId: number) => {
    setBusyId(callId);
    try {
      await api.approveMeshCall(callId);
      void qc.invalidateQueries({ queryKey: ["mesh-calls"] });
      void qc.invalidateQueries({ queryKey: ["graph"] });
    } finally {
      setBusyId(null);
    }
  };

  const handleHangupCall = async (callId: number) => {
    setBusyId(callId);
    try {
      await api.hangupMeshCall(callId);
      void qc.invalidateQueries({ queryKey: ["mesh-calls"] });
      void qc.invalidateQueries({ queryKey: ["graph"] });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section
      data-testid="live-mesh-graph"
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-surface"
    >
      {/* Top Bar */}
      <header className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-line bg-paper px-3.5">
        <div className="flex items-center gap-2 overflow-x-auto">
          <strong className="whitespace-nowrap text-[13px] font-semibold text-ink">
            实时通话关系图谱
          </strong>
          <span className="rounded bg-success-soft px-1.5 py-0.5 font-mono text-2xs text-success">
            {liveNodes.length} 在线
          </span>
          <span className="rounded bg-info-soft px-1.5 py-0.5 font-mono text-2xs text-info">
            {activeCalls.length} 条活跃通话
          </span>
          <span className="hidden whitespace-nowrap text-2xs text-ink-faint md:inline">
            按 session_id 1:1 实时映射 · 仅显示存活会话
          </span>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Scrollable Topology Canvas */}
        <div className="paseo-dot-grid relative flex-1 overflow-auto">
          {liveNodes.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
              <div className="text-sm font-semibold text-ink">当前暂无在线会话节点</div>
              <p className="max-w-md text-xs text-ink-faint">
                点击左侧「+ 新建」创建工作区，或点击左下角「接入远程 Agent」把本机 / Tailscale 终端接入 Conflux MCP 总线后，节点将按 设备 → 目录 自动出现在此处。
              </p>
            </div>
          ) : (
            <div
              className="relative"
              style={{ width: layout.canvasW, height: layout.canvasH }}
            >
              {/* Host & Directory Zones */}
              {layout.hosts.map((h) => (
                <div key={h.host}>
                  <div
                    className={`pointer-events-none absolute rounded-xl border border-dashed p-2.5 ${
                      h.isRemote
                        ? "border-info/40 bg-surface/45"
                        : "border-line-strong bg-surface/45"
                    }`}
                    style={{ left: h.x, top: h.y, width: h.w, height: h.h }}
                  >
                    <div
                      className={`flex items-center gap-1.5 text-2xs font-semibold ${
                        h.isRemote ? "text-info" : "text-ink-muted"
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          h.isRemote ? "bg-info" : "bg-success"
                        }`}
                      />
                      <span>
                        {h.host} · {h.isRemote ? "远程 Tailscale/LAN" : "本机"}
                      </span>
                    </div>
                  </div>

                  {h.dirs.map((d) => (
                    <div
                      key={`${h.host}:${d.dirPath}`}
                      className="pointer-events-none absolute rounded-lg border border-line bg-rail/45 px-2.5 py-1.5"
                      style={{ left: d.x, top: d.y, width: d.w, height: d.h }}
                    >
                      <div className="flex items-center gap-1.5 truncate font-mono text-2xs text-ink-faint">
                        <Folder className="h-3 w-3 shrink-0" />
                        <span className="truncate">{d.dirPath}</span>
                      </div>
                    </div>
                  ))}
                </div>
              ))}

              {/* Flowing Call Edges SVG */}
              <svg
                className="pointer-events-none absolute inset-0 z-[4]"
                width={layout.canvasW}
                height={layout.canvasH}
              >
                <defs>
                  <marker id="mesh-arr-green" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                    <path d="M0,0 L7,3.5 L0,7 Z" fill="rgb(var(--tk-success))" />
                  </marker>
                  <marker id="mesh-arr-amber" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                    <path d="M0,0 L7,3.5 L0,7 Z" fill="rgb(var(--tk-warning))" />
                  </marker>
                </defs>

                {visibleCalls.map((call, idx) => {
                  const pFrom = layout.nodePos.get(call.from_session)!;
                  const pTo = layout.nodePos.get(call.to_session)!;
                  const goingRight = pTo.x >= pFrom.x;
                  const x1 = goingRight ? pFrom.x + NODE_W : pFrom.x;
                  const y1 = pFrom.y + NODE_H * 0.45 + (idx % 3) * 8;
                  const x2 = goingRight ? pTo.x : pTo.x + NODE_W;
                  const y2 = pTo.y + NODE_H * 0.55 + (idx % 3) * 8;
                  const dx = Math.max(Math.abs(x2 - x1) * 0.45, 56);
                  const d = `M ${x1} ${y1} C ${x1 + (goingRight ? dx : -dx)} ${y1}, ${
                    x2 + (goingRight ? -dx : dx)
                  } ${y2}, ${x2} ${y2}`;
                  const isWaiting = call.status === "awaiting_approval";
                  const isActive =
                    call.status === "pending" ||
                    call.status === "seen" ||
                    call.status === "awaiting_approval";
                  const strokeVar = isWaiting ? "rgb(var(--tk-warning))" : "rgb(var(--tk-success))";
                  return (
                    <g key={call.id}>
                      <path d={d} fill="none" stroke={strokeVar} strokeOpacity={0.18} strokeWidth={5} />
                      <path
                        d={d}
                        fill="none"
                        stroke={strokeVar}
                        strokeWidth={2}
                        className={isActive ? "paseo-edge-flow" : ""}
                        markerEnd={isWaiting ? "url(#mesh-arr-amber)" : "url(#mesh-arr-green)"}
                      />
                    </g>
                  );
                })}
              </svg>

              {/* Edge Midpoint Pills */}
              {visibleCalls.map((call, idx) => {
                const pFrom = layout.nodePos.get(call.from_session)!;
                const pTo = layout.nodePos.get(call.to_session)!;
                const goingRight = pTo.x >= pFrom.x;
                const x1 = goingRight ? pFrom.x + NODE_W : pFrom.x;
                const x2 = goingRight ? pTo.x : pTo.x + NODE_W;
                const mx = (x1 + x2) / 2;
                const my = (pFrom.y + pTo.y) / 2 + NODE_H * 0.5 + (idx % 3) * 24 - 16;
                const isWaiting = call.status === "awaiting_approval";
                return (
                  <div
                    key={`pill-${call.id}`}
                    data-testid={`mesh-edge-pill-${call.id}`}
                    onClick={() => setSelectedCallId(call.id)}
                    style={{ left: mx, top: my }}
                    className={`absolute z-10 inline-flex -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border bg-surface px-2.5 py-1 text-2xs shadow-raised transition-colors hover:border-ink ${
                      isWaiting ? "border-warning" : "border-success"
                    }`}
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        isWaiting ? "bg-warning animate-pulse" : "bg-success"
                      }`}
                    />
                    <span className="max-w-[140px] truncate text-ink">
                      {call.question.slice(0, 18)}
                    </span>
                    {isWaiting && (
                      <button
                        type="button"
                        disabled={busyId === call.id}
                        data-testid={`edge-approve-call-${call.id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleApproveCall(call.id);
                        }}
                        className="rounded-full bg-accent px-2 py-0.5 text-2xs font-semibold text-on-accent hover:bg-accent-deep"
                      >
                        放行
                      </button>
                    )}
                  </div>
                );
              })}

              {/* Live Session Nodes */}
              {layout.hosts.flatMap((h) =>
                h.dirs.flatMap((d) =>
                  d.nodes.map(({ node, x, y }) => {
                    const isRemote =
                      (node.host || localHostname).toLowerCase() !==
                      (localHostname || "localhost").toLowerCase();
                    const mode = node.incoming_call_mode ?? "auto";
                    return (
                      <div
                        key={node.id}
                        data-testid={`mesh-node-${node.id}`}
                        onDoubleClick={() => onEnterWorkspace(node.id)}
                        style={{ left: x, top: y, width: NODE_W }}
                        className="absolute z-[8] cursor-pointer rounded-[9px] border border-line-strong bg-surface p-2.5 shadow-raised transition-all hover:-translate-y-0.5 hover:border-ink"
                      >
                        <div className="flex items-center justify-between gap-1.5">
                          <strong className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-ink">
                            <span
                              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                                node.state === "waiting_approval"
                                  ? "bg-warning animate-pulse"
                                  : "bg-success"
                              }`}
                            />
                            <span className="truncate">{node.name}</span>
                          </strong>
                          <span
                            className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-2xs ${
                              isRemote
                                ? "bg-info-soft text-info"
                                : node.kind === "external"
                                  ? "bg-elev text-ink-muted"
                                  : "bg-elev text-ink-faint"
                            }`}
                          >
                            {isRemote ? "远程 Hook" : node.kind === "external" ? "外部 Hook" : "本机托管"}
                          </span>
                        </div>

                        <div className="mt-1 truncate font-mono text-2xs text-ink-faint">
                          {(node.external_session_id || node.id).slice(0, 14)} ·{" "}
                          {node.worktree_branch || node.runtime}
                        </div>

                        <div className="mt-2 flex items-center justify-between gap-2 border-t border-line pt-2">
                          <button
                            type="button"
                            data-testid={`node-call-mode-${node.id}`}
                            title="点击切换来电策略（仅控制他人来电，不影响外呼）"
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleCycleCallMode(node);
                            }}
                            className={`h-6 rounded-full border px-2 text-2xs font-medium transition-colors ${incomingModeClass(mode)}`}
                          >
                            {incomingModeLabel(mode)}
                          </button>

                          <button
                            type="button"
                            data-testid={`node-enter-${node.id}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              onEnterWorkspace(node.id);
                            }}
                            className="h-6 rounded-md bg-accent px-2.5 text-2xs font-semibold text-on-accent hover:bg-accent-deep"
                          >
                            进入 →
                          </button>
                        </div>
                      </div>
                    );
                  }),
                ),
              )}
            </div>
          )}
        </div>

        {/* Smooth Sliding Right Audit Drawer */}
        <aside
          data-testid="mesh-audit-drawer"
          data-open={selectedCall ? "true" : "false"}
          className="paseo-audit-drawer border-l border-line bg-paper"
        >
          {selectedCall && (
            <div className="paseo-audit-drawer-inner flex flex-col">
              <div className="flex items-center justify-between gap-2 border-b border-line px-3.5 py-2.5">
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-semibold text-ink">
                    {selectedCall.from_name || selectedCall.from_session} →{" "}
                    {selectedCall.to_name || selectedCall.to_session}
                  </div>
                  <div className="mt-0.5 font-mono text-2xs text-ink-faint">
                    {selectedCall.trace_id || `call_${selectedCall.id}`} · hop{" "}
                    {selectedCall.hop_count}/5 · {selectedCall.status}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  {selectedCall.status !== "replied" && selectedCall.status !== "cancelled" && (
                    <button
                      type="button"
                      disabled={busyId === selectedCall.id}
                      data-testid="audit-hangup-btn"
                      onClick={() => void handleHangupCall(selectedCall.id)}
                      className="inline-flex h-6 items-center gap-1 rounded-md border border-danger/40 bg-danger-soft px-2 text-2xs font-semibold text-danger"
                    >
                      <PhoneOff className="h-3 w-3" />
                      <span>挂断</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setSelectedCallId(null)}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-md text-ink-muted hover:bg-tile-hover hover:text-ink"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              <div className="flex-1 space-y-3 overflow-y-auto p-3.5 text-xs leading-relaxed">
                {selectedCall.status === "awaiting_approval" && (
                  <div className="flex items-center justify-between gap-2 rounded-lg border border-warning/35 bg-warning-soft p-2.5 text-warning">
                    <span className="text-2xs font-medium">目标节点策略为「需我放行」</span>
                    <button
                      type="button"
                      disabled={busyId === selectedCall.id}
                      data-testid="audit-approve-btn"
                      onClick={() => void handleApproveCall(selectedCall.id)}
                      className="inline-flex h-6 items-center gap-1 rounded-md bg-accent px-2.5 text-2xs font-semibold text-on-accent"
                    >
                      <Check className="h-3 w-3" />
                      <span>放行来电</span>
                    </button>
                  </div>
                )}

                <div className="rounded-lg border border-line bg-elev p-3">
                  <div className="mb-1 flex items-center justify-between text-2xs text-ink-faint">
                    <strong className="text-ink">
                      {selectedCall.from_name || selectedCall.from_session}
                    </strong>
                    <span className="font-mono">ask_peer</span>
                  </div>
                  <div className="whitespace-pre-wrap text-ink">{selectedCall.question}</div>

                  {selectedCall.context && (
                    <div
                      data-open={ctxOpen ? "true" : "false"}
                      className="paseo-acc-group mt-2.5 overflow-hidden rounded-md border border-line"
                    >
                      <div className="paseo-acc-head">
                        <button
                          type="button"
                          onClick={() => setCtxOpen((v) => !v)}
                          className="flex w-full items-center justify-between bg-surface px-2.5 py-1.5 font-mono text-2xs text-ink-muted hover:text-ink"
                        >
                          <span>附带上下文 / Diff</span>
                          <ChevronDown className="paseo-acc-chevron h-3 w-3" />
                        </button>
                      </div>
                      <div className="paseo-acc-body">
                        <div className="paseo-acc-inner">
                          <pre className="overflow-x-auto bg-rail p-2 font-mono text-2xs text-ink-muted">
                            {selectedCall.context}
                          </pre>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {selectedCall.reply && (
                  <div className="rounded-lg border border-line border-l-2 border-l-success bg-surface p-3">
                    <div className="mb-1 flex items-center justify-between text-2xs text-ink-faint">
                      <strong className="text-success">
                        {selectedCall.to_name || selectedCall.to_session}
                      </strong>
                      <span className="font-mono">reply_peer</span>
                    </div>
                    <div className="whitespace-pre-wrap text-ink">{selectedCall.reply}</div>
                  </div>
                )}
              </div>

              <div className="flex gap-2 border-t border-line p-3">
                <button
                  type="button"
                  onClick={() => onEnterWorkspace(selectedCall.from_session)}
                  className="h-7 flex-1 truncate rounded-md border border-line-strong bg-elev px-2 text-2xs font-medium text-ink hover:bg-tile-hover"
                >
                  进入 {selectedCall.from_name || "发起方"} →
                </button>
                <button
                  type="button"
                  onClick={() => onEnterWorkspace(selectedCall.to_session)}
                  className="h-7 flex-1 truncate rounded-md bg-accent px-2 text-2xs font-semibold text-on-accent hover:bg-accent-deep"
                >
                  进入 {selectedCall.to_name || "接收方"} →
                </button>
              </div>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
