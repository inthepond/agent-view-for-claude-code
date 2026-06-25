import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type * as React from "react";
import type { AgentSummary } from "../protocol";
import type { BoardArrow, BoardCamera, BoardCard } from "./protocol";
import { AgentCardView, SubAgentCardView, DiffCardView, TextCardView } from "./cards";

export interface AgentNode {
  sessionId: string;
  x: number;
  y: number;
  agent: AgentSummary;
  subCount: number;
  expanded?: boolean;
  isSub?: boolean;
}

interface Props {
  agents: AgentNode[];
  cards: BoardCard[];
  arrows: BoardArrow[];
  tethers: { from: string; to: string }[];
  camera: BoardCamera;
  selectedIds: string[];
  editingId: string | null;
  canSend: boolean;
  onCamera(c: BoardCamera): void;
  onViewport(size: { w: number; h: number }): void;
  onMoveCard(id: string, x: number, y: number): void;
  onMoveAgent(id: string, x: number, y: number): void;
  onSelectCard(id: string, additive: boolean): void;
  onClearSelection(): void;
  onFocusAgent(id: string): void;
  onPinDiff(id: string): void;
  onPinOutput(id: string): void;
  onOpenDiff(id: string): void;
  onSendHere(id: string): void;
  onToggleSubs(id: string): void;
  onStartEdit(id: string): void;
  onEditBody(id: string, body: string): void;
  onArrowLabel(id: string, label: string): void;
}

const EST: Record<string, { w: number; h: number }> = {
  agent: { w: 210, h: 150 },
  sub: { w: 184, h: 74 },
  diff: { w: 340, h: 220 },
  text: { w: 260, h: 120 },
};

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;

interface DragState {
  mode: "pan" | "node";
  kind?: "agent" | "card";
  id?: string;
  startClientX: number;
  startClientY: number;
  startCamX: number;
  startCamY: number;
  startNodeX: number;
  startNodeY: number;
  moved: boolean;
  additive: boolean;
}

function curve(from: { x: number; y: number }, to: { x: number; y: number }, bow: number) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const off = Math.min(80, len * bow);
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const nx = (-dy / len) * off;
  const ny = (dx / len) * off;
  return {
    d: `M ${from.x} ${from.y} Q ${mx + nx} ${my + ny} ${to.x} ${to.y}`,
    lx: mx + nx * 0.5,
    ly: my + ny * 0.5,
  };
}

export function Canvas(props: Props) {
  const cam = props.camera;
  const vpRef = useRef<HTMLDivElement>(null);
  const camRef = useRef(cam);
  const dragRef = useRef<DragState | null>(null);
  const nodeEls = useRef<Map<string, HTMLDivElement>>(new Map());
  const [sizes, setSizes] = useState<Record<string, { w: number; h: number }>>({});
  const [editingArrow, setEditingArrow] = useState<string | null>(null);

  useEffect(() => {
    camRef.current = cam;
  }, [cam]);

  useEffect(() => {
    const el = vpRef.current;
    if (!el) return;
    const report = () => props.onViewport({ w: el.clientWidth, h: el.clientHeight });
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const next: Record<string, { w: number; h: number }> = {};
    nodeEls.current.forEach((el, id) => {
      next[id] = { w: el.offsetWidth, h: el.offsetHeight };
    });
    let changed = Object.keys(next).length !== Object.keys(sizes).length;
    if (!changed) {
      for (const k of Object.keys(next)) {
        const a = sizes[k];
        if (!a || a.w !== next[k].w || a.h !== next[k].h) {
          changed = true;
          break;
        }
      }
    }
    if (changed) setSizes(next);
  });

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dxS = e.clientX - d.startClientX;
      const dyS = e.clientY - d.startClientY;
      if (!d.moved && Math.hypot(dxS, dyS) > 4) d.moved = true;
      if (d.mode === "pan") {
        props.onCamera({ ...camRef.current, x: d.startCamX + dxS, y: d.startCamY + dyS });
      } else if (d.mode === "node" && d.moved && d.id) {
        const z = camRef.current.zoom;
        const nx = d.startNodeX + dxS / z;
        const ny = d.startNodeY + dyS / z;
        if (d.kind === "card") props.onMoveCard(d.id, nx, ny);
        else props.onMoveAgent(d.id, nx, ny);
      }
    };
    const onUp = () => {
      const d = dragRef.current;
      dragRef.current = null;
      if (!d || d.moved) return;
      if (d.mode === "pan") props.onClearSelection();
      else if (d.kind === "card" && d.id) props.onSelectCard(d.id, d.additive);
      else if (d.kind === "agent" && d.id) props.onFocusAgent(d.id);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onBgPointerDown = (e: { clientX: number; clientY: number }) => {
    dragRef.current = {
      mode: "pan",
      startClientX: e.clientX,
      startClientY: e.clientY,
      startCamX: camRef.current.x,
      startCamY: camRef.current.y,
      startNodeX: 0,
      startNodeY: 0,
      moved: false,
      additive: false,
    };
  };

  const onNodePointerDown = (
    e: { clientX: number; clientY: number; shiftKey: boolean; stopPropagation(): void },
    kind: "agent" | "card",
    id: string,
    nodeX: number,
    nodeY: number,
  ) => {
    e.stopPropagation();
    dragRef.current = {
      mode: "node",
      kind,
      id,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startCamX: camRef.current.x,
      startCamY: camRef.current.y,
      startNodeX: nodeX,
      startNodeY: nodeY,
      moved: false,
      additive: e.shiftKey,
    };
  };

  const onWheel = (e: React.WheelEvent) => {
    const el = vpRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam.zoom * factor));
    const wx = (sx - cam.x) / cam.zoom;
    const wy = (sy - cam.y) / cam.zoom;
    props.onCamera({ x: sx - wx * z, y: sy - wy * z, zoom: z });
  };

  const setEl = (id: string) => (el: HTMLDivElement | null) => {
    if (el) nodeEls.current.set(id, el);
    else nodeEls.current.delete(id);
  };

  // Position lookup for every node (agents, subs, cards) — used to anchor links.
  const posIndex = new Map<string, { x: number; y: number; kind: string }>();
  for (const n of props.agents) posIndex.set(n.sessionId, { x: n.x, y: n.y, kind: n.isSub ? "sub" : "agent" });
  for (const c of props.cards) posIndex.set(c.id, { x: c.x, y: c.y, kind: c.kind === "diff" ? "diff" : "text" });

  const centerOf = (id: string) => {
    const p = posIndex.get(id);
    if (!p) return null;
    const s = sizes[id] || EST[p.kind] || EST.text;
    return { x: p.x + s.w / 2, y: p.y + s.h / 2 };
  };

  const arrowGeo = props.arrows
    .map((a) => {
      if (!a.fromCard || !a.toCard) return null;
      const from = centerOf(a.fromCard);
      const to = centerOf(a.toCard);
      if (!from || !to) return null;
      const g = curve(from, to, 0.25);
      return { a, ...g };
    })
    .filter((g): g is { a: BoardArrow; d: string; lx: number; ly: number } => g !== null);

  const tetherGeo = props.tethers
    .map((t, i) => {
      const from = centerOf(t.from);
      const to = centerOf(t.to);
      if (!from || !to) return null;
      return { key: `${t.from}->${t.to}-${i}`, d: curve(from, to, 0.18).d };
    })
    .filter((g): g is { key: string; d: string } => g !== null);

  return (
    <div className="canvas-viewport" ref={vpRef} onPointerDown={onBgPointerDown} onWheel={onWheel}>
      <div
        className="canvas-world"
        style={{ transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.zoom})` }}
      >
        <svg className="arrow-layer" width={1} height={1} style={{ overflow: "visible" }}>
          <defs>
            <marker id="arrowhead" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
              <path d="M0,0 L7,3 L0,6 Z" className="arrowhead" />
            </marker>
          </defs>
          {tetherGeo.map((t) => (
            <path key={t.key} d={t.d} className="tether-line" fill="none" />
          ))}
          {arrowGeo.map(({ a, d }) => (
            <path key={a.id} d={d} className="arrow-line" fill="none" markerEnd="url(#arrowhead)" />
          ))}
        </svg>

        {arrowGeo.map(({ a, lx, ly }) => {
          const editing = editingArrow === a.id;
          return (
            <div key={a.id} className="arrow-label" style={{ left: lx, top: ly }} onPointerDown={(e) => e.stopPropagation()}>
              {editing ? (
                <input
                  autoFocus
                  defaultValue={a.label || ""}
                  onBlur={(e) => {
                    props.onArrowLabel(a.id, e.target.value);
                    setEditingArrow(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                />
              ) : (
                <span onClick={() => setEditingArrow(a.id)}>{a.label || "+ label"}</span>
              )}
            </div>
          );
        })}

        {props.agents.map((n) => (
          <div
            key={n.sessionId}
            ref={setEl(n.sessionId)}
            className="node-wrap"
            style={{ left: n.x, top: n.y }}
            onPointerDown={(e) => onNodePointerDown(e, "agent", n.sessionId, n.x, n.y)}
          >
            {n.isSub ? (
              <SubAgentCardView agent={n.agent} />
            ) : (
              <AgentCardView
                agent={n.agent}
                subCount={n.subCount}
                expanded={!!n.expanded}
                canSend={props.canSend}
                onPinDiff={() => props.onPinDiff(n.sessionId)}
                onPinOutput={() => props.onPinOutput(n.sessionId)}
                onDiff={() => props.onOpenDiff(n.sessionId)}
                onSendHere={() => props.onSendHere(n.sessionId)}
                onToggleSubs={() => props.onToggleSubs(n.sessionId)}
              />
            )}
          </div>
        ))}

        {props.cards.map((c) => (
          <div
            key={c.id}
            ref={setEl(c.id)}
            className={"node-wrap" + (props.selectedIds.includes(c.id) ? " selected" : "")}
            style={{ left: c.x, top: c.y }}
            onPointerDown={(e) => onNodePointerDown(e, "card", c.id, c.x, c.y)}
          >
            {c.kind === "diff" ? (
              <DiffCardView card={c} />
            ) : (
              <TextCardView
                card={c}
                editing={props.editingId === c.id}
                onStartEdit={() => props.onStartEdit(c.id)}
                onEdit={(body) => props.onEditBody(c.id, body)}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
