import { select } from 'd3-selection';
import 'd3-transition';
import { zoom as d3zoom, zoomIdentity, zoomTransform, type ZoomBehavior, type ZoomTransform } from 'd3-zoom';
import { ArrowLeftRight, Box, CircleDot, Cog, Database, FileCode2, Filter, Globe, HelpCircle, ListOrdered, MousePointerClick, Reply, Route, Workflow, Zap, type LucideIcon } from 'lucide-react';
import { motion } from 'motion/react';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import type { Flow, FlowStep } from '../../lib/api.ts';
import { prefersReducedMotion } from '../../lib/hooks.ts';
import { CARD_H, CARD_W, edgeGeometry, STAGE_LABELS, type FlowGraph } from './flowGraph.ts';

export interface FlowCanvasHandle {
  fit(keys?: string[]): void;
  zoomBy(f: number): void;
}

interface Props {
  graph: FlowGraph;
  /** The flow in focus (its path is highlighted; everything else dims). */
  flow: Flow | null;
  step: number;
  playing: boolean;
  speed: number;
  /** Highlight entities whose label or file matches. */
  find: string;
  onStep(i: number): void;
  /** An entity outside the focused flow was clicked. */
  onEntity(key: string): void;
}

const ICON: Record<NonNullable<FlowStep['kind']>, LucideIcon> = {
  action: MousePointerClick,
  handler: FileCode2,
  client: ArrowLeftRight,
  route: Route,
  middleware: Filter,
  service: Cog,
  data: Database,
  cache: Zap,
  queue: ListOrdered,
  external: Globe,
  worker: Workflow,
  response: Reply,
  resolve: CircleDot,
  state: Box,
  unknown: HelpCircle,
};

export const FlowCanvas = forwardRef<FlowCanvasHandle, Props>(function FlowCanvas(p, ref) {
  const { graph } = p;
  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<ZoomBehavior<HTMLDivElement, unknown> | null>(null);
  const byKey = useMemo(() => new Map(graph.nodes.map((n) => [n.key, n])), [graph]);

  const fitTo = (keys?: string[], animate = true) => {
    const vp = viewportRef.current;
    const z = zoomRef.current;
    if (!vp || !z) return;
    const members = keys?.length ? graph.nodes.filter((n) => keys.includes(n.key)) : null;
    const x0 = members ? Math.min(...members.map((n) => n.x)) - 60 : 0;
    const y0 = members ? Math.min(...members.map((n) => n.y)) - 60 : 0;
    const x1 = members ? Math.max(...members.map((n) => n.x + CARD_W)) + 60 : graph.width;
    const y1 = members ? Math.max(...members.map((n) => n.y + CARD_H)) + 60 : graph.height;
    const w = vp.clientWidth;
    const h = vp.clientHeight;
    const k = Math.min(1.2, Math.max(0.25, Math.min(w / (x1 - x0), (h - 20) / (y1 - y0))));
    const t = zoomIdentity.translate(w / 2 - ((x0 + x1) / 2) * k, 10 + (h - 20) / 2 - ((y0 + y1) / 2) * k).scale(k);
    const sel = select(vp);
    if (animate && !prefersReducedMotion()) sel.transition().duration(450).call(z.transform, t);
    else sel.call(z.transform, t);
  };

  useImperativeHandle(ref, () => ({
    fit: (keys) => fitTo(keys),
    zoomBy: (f) => {
      const vp = viewportRef.current;
      if (!vp || !zoomRef.current) return;
      select(vp).transition().duration(prefersReducedMotion() ? 0 : 220).call(zoomRef.current.scaleBy, f);
    },
  }));

  useEffect(() => {
    const vp = viewportRef.current!;
    const z = d3zoom<HTMLDivElement, unknown>()
      .scaleExtent([0.2, 2.5])
      .filter((e: Event) => !(e.type === 'mousedown' && (e as MouseEvent).button !== 0) && e.type !== 'dblclick')
      .on('zoom', (e: { transform: ZoomTransform }) => {
        const { x, y, k } = e.transform;
        if (stageRef.current) stageRef.current.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
      });
    zoomRef.current = z;
    select(vp).call(z);
    fitTo(p.flow ? graph.path.get(p.flow.id) : undefined, false);
    return () => {
      select(vp).on('.zoom', null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  // Keep the focused flow in view when it changes.
  useEffect(() => {
    if (p.flow) fitTo(graph.path.get(p.flow.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.flow?.id]);

  // Follow the current step: pan (without zooming) when it is outside the visible area.
  const followKey = p.flow ? graph.path.get(p.flow.id)?.[p.step] : undefined;
  const followedFlow = useRef(p.flow?.id);
  useEffect(() => {
    // A newly selected flow is fitted as a whole instead.
    if (followedFlow.current !== p.flow?.id) {
      followedFlow.current = p.flow?.id;
      return;
    }
    const vp = viewportRef.current;
    const n = followKey ? byKey.get(followKey) : undefined;
    if (!vp || !n || !zoomRef.current) return;
    const t = zoomTransform(vp);
    const x0 = t.applyX(n.x);
    const y0 = t.applyY(n.y);
    const x1 = t.applyX(n.x + CARD_W);
    const y1 = t.applyY(n.y + CARD_H);
    const pad = 48;
    if (x0 >= pad && y0 >= pad && x1 <= vp.clientWidth - pad && y1 <= vp.clientHeight - pad) return;
    const sel = select(vp);
    const to: [number, number] = [n.x + CARD_W / 2, n.y + CARD_H / 2];
    if (prefersReducedMotion()) sel.call(zoomRef.current.translateTo, ...to);
    else sel.transition().duration(350).call(zoomRef.current.translateTo, ...to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followKey, byKey]);

  const flowKeys = p.flow ? graph.path.get(p.flow.id) ?? [] : [];
  const flowEdges = p.flow ? graph.pathEdges.get(p.flow.id) ?? [] : [];
  const inFlow = new Set(flowKeys);
  const inFlowEdges = new Set(flowEdges.filter(Boolean) as string[]);
  const doneKeys = new Set(flowKeys.slice(0, p.step + 1));
  const doneEdges = new Set(flowEdges.slice(0, p.step + 1).filter(Boolean) as string[]);
  const currentKey = flowKeys[p.step];
  const q = p.find.trim().toLowerCase();
  const found = (label: string, file: string) => !!q && `${label} ${file}`.toLowerCase().includes(q);

  // Packet: travels the edge into the current step while playing.
  const packetEdge = p.flow && p.step > 0 ? flowEdges[p.step] : null;
  const packet = packetEdge ? (() => {
    const e = graph.edges.find((x) => x.key === packetEdge);
    const a = e && byKey.get(e.from);
    const b = e && byKey.get(e.to);
    return a && b && e ? { ...edgeGeometry(a, b), async: e.async, back: e.back } : null;
  })() : null;

  return (
    <div
      ref={viewportRef}
      className="fc-viewport"
      role="application"
      aria-roledescription="flow canvas"
      aria-label={`Flow canvas: ${graph.nodes.length} repository entities across ${graph.columns.length} stages. ${p.flow ? `Showing ${p.flow.name ?? p.flow.title}.` : ''}`}
    >
      <div ref={stageRef} className="fc-stage" style={{ width: graph.width, height: graph.height }}>
        {graph.columns.map((c) => (
          <div key={c.stage} className={`fc-col stage-${c.stage}`} style={{ left: c.x - 12, width: CARD_W + 24, height: graph.height }}>
            <span>{STAGE_LABELS[c.stage]}</span>
          </div>
        ))}
        <svg className="fc-edges" width={graph.width} height={graph.height} aria-hidden="true">
          <defs>
            {['plain', 'on', 'async', 'back', 'unknown'].map((t) => (
              <marker key={t} id={`fc-ah-${t}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M0 0L10 5L0 10z" className={`fc-ah t-${t}`} />
              </marker>
            ))}
          </defs>
          {graph.edges.map((e) => {
            const a = byKey.get(e.from);
            const b = byKey.get(e.to);
            if (!a || !b) return null;
            const g = edgeGeometry(a, b);
            const on = !p.flow || inFlowEdges.has(e.key);
            const done = doneEdges.has(e.key);
            const tone = b.kind === 'unknown' ? 'unknown' : e.async ? 'async' : e.back ? 'back' : on && p.flow ? 'on' : 'plain';
            return (
              <g key={e.key} className={`fc-edge t-${tone}${on ? '' : ' is-dim'}${done ? ' is-done' : ''}`}>
                <path d={g.d} markerEnd={`url(#fc-ah-${tone})`} />
              </g>
            );
          })}
          {packet && !prefersReducedMotion() && (
            <motion.circle
              key={`${p.flow?.id}-${p.step}`}
              r={6}
              className={`fc-packet${packet.async ? ' t-async' : packet.back ? ' t-back' : ''}`}
              initial={{ cx: packet.pts[0][0], cy: packet.pts[0][1], opacity: 0 }}
              animate={{ cx: packet.pts.map((pt) => pt[0]), cy: packet.pts.map((pt) => pt[1]), opacity: [0, 1, 1, 0.85] }}
              transition={{ duration: 0.7 / p.speed, ease: 'easeInOut' }}
            />
          )}
        </svg>
        {graph.nodes.map((n) => {
          const Icon = ICON[n.kind ?? 'service'];
          const on = !p.flow || inFlow.has(n.key);
          const current = n.key === currentKey;
          const done = doneKeys.has(n.key);
          return (
            <button
              key={n.key}
              type="button"
              className={`fc-node k-${n.kind}${on ? '' : ' is-dim'}${current ? ' is-current' : ''}${done && !current ? ' is-done' : ''}${found(n.label, n.file) ? ' is-found' : ''}`}
              style={{ left: n.x, top: n.y, width: CARD_W, height: CARD_H }}
              onClick={(ev) => {
                ev.stopPropagation();
                const i = flowKeys.indexOf(n.key);
                if (p.flow && i >= 0) p.onStep(i);
                else p.onEntity(n.key);
              }}
              aria-label={`${STAGE_LABELS[n.stage]}: ${n.label}, ${n.file}${n.line ? ` line ${n.line}` : ''}. Used by ${n.flows.size} flow${n.flows.size === 1 ? '' : 's'}.`}
            >
              <span className="fc-kind">
                <Icon size={12} /> {n.kind}
                {n.flows.size > 1 && <span className="fc-count">{n.flows.size}</span>}
              </span>
              <span className="fc-label">{n.label}</span>
              <span className="fc-file mono">
                {n.file.slice(n.file.lastIndexOf('/') + 1)}
                {n.line ? `:${n.line}` : ''}
              </span>
            </button>
          );
        })}
        <svg className="fc-edges fc-labels" width={graph.width} height={graph.height} aria-hidden="true">
          {p.flow &&
            graph.edges.map((e) => {
              const into = e.key === flowEdges[p.step];
              if (!inFlowEdges.has(e.key) || !(into ? e.label || e.async : e.async)) return null;
              const a = byKey.get(e.from);
              const b = byKey.get(e.to);
              if (!a || !b) return null;
              const g = edgeGeometry(a, b);
              return (
                <text key={e.key} x={g.mid[0]} y={g.mid[1] - 8} className={`fc-edge-label${e.async ? ' t-async' : ''}`}>
                  {e.async ? 'ASYNC · does not block the response' : e.label}
                </text>
              );
            })}
        </svg>
      </div>
    </div>
  );
});
