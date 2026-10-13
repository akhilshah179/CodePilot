import { select } from 'd3-selection';
import 'd3-transition';
import { zoom as d3zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from 'd3-zoom';
import { ArrowLeftRight, Box, Boxes, Cog, Container, FileCode2, Filter, Globe, HelpCircle, ListOrdered, Monitor, Radio, Route, Shield, ShieldCheck, Workflow, type LucideIcon } from 'lucide-react';
import { motion } from 'motion/react';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { prefersReducedMotion } from '../../lib/hooks.ts';
import type { SystemLink, SystemMap as SystemMapData, SystemNode } from '../../lib/api.ts';
import { CategoryIcon } from './CategoryIcon.tsx';
import { edgeStyle } from './style.ts';
import { layoutSystem, NODE_H, NODE_W } from './systemLayout.ts';
import type { ArchEdge, ArchNode } from '../../lib/api.ts';

export interface SystemMapHandle {
  fit(ids?: string[]): void;
  zoomBy(f: number): void;
}

interface Props {
  map: SystemMapData;
  archById: Map<string, ArchNode>;
  selected: string | null;
  /** Externally emphasised components (technology focus, a flow's path). */
  focus: Set<string> | null;
  playIntro: boolean;
  onIntroDone(): void;
  onSelect(id: string | null): void;
}

const KIND_LABEL: Record<SystemNode['kind'], string> = {
  client: 'Client',
  transport: 'Transport',
  api: 'API',
  proxy: 'Gateway',
  middleware: 'Middleware',
  handler: 'Route handler',
  service: 'Service',
  tool: 'Data',
  queue: 'Queue',
  worker: 'Worker',
  external: 'External',
  infra: 'Infrastructure',
};

function kindIcon(n: SystemNode): LucideIcon {
  switch (n.kind) {
    case 'client':
      return Monitor;
    case 'transport':
      return n.name.includes('Event') || n.name.includes('Socket') ? Radio : ArrowLeftRight;
    case 'api':
      return Route;
    case 'proxy':
      return Shield;
    case 'middleware':
      return /security|auth/.test(n.detail) ? ShieldCheck : Filter;
    case 'handler':
      return FileCode2;
    case 'service':
      return Cog;
    case 'queue':
      return ListOrdered;
    case 'worker':
      return Workflow;
    case 'external':
      return n.confidence === 'possible' ? HelpCircle : Globe;
    case 'infra':
      return Container;
    default:
      return Box;
  }
}

/** Colour and dash for a system link: transports cyan, data by operation, async dashed, unknown targets dotted red. */
export function linkStyle(l: SystemLink): { color: string; dash: string; width: number } {
  if (l.target.startsWith('unknown:')) return { color: '#ef4444', dash: '1.5 4', width: 1.4 };
  if (l.kind === 'transport') return { color: '#00d2ff', dash: '', width: 1.8 };
  if (l.kind === 'route') return { color: 'rgba(255,255,255,0.3)', dash: '', width: 1 };
  if (l.kind === 'call') return { color: 'rgba(214,220,207,0.75)', dash: l.confidence === 'confirmed' ? '' : '6 4', width: 1.3 };
  const s = edgeStyle({ labels: l.label.split(' · ') as ArchEdge['labels'], confidence: l.confidence });
  return { color: s.color, dash: l.async ? '6 4' : s.dash, width: s.width };
}

export const SystemMap = forwardRef<SystemMapHandle, Props>(function SystemMap(p, ref) {
  const layout = useMemo(() => layoutSystem(p.map), [p.map]);
  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<ZoomBehavior<HTMLDivElement, unknown> | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [intro, setIntro] = useState(p.playIntro && !prefersReducedMotion());
  const pos = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout]);

  const fitTo = (ids?: string[], animate = true) => {
    const vp = viewportRef.current;
    const z = zoomRef.current;
    if (!vp || !z) return;
    const w = vp.clientWidth;
    const h = vp.clientHeight;
    const members = ids?.length ? layout.nodes.filter((n) => ids.includes(n.id)) : null;
    const x0 = members ? Math.min(...members.map((n) => n.x)) - 80 : 0;
    const y0 = members ? Math.min(...members.map((n) => n.y)) - 80 : 0;
    const x1 = members ? Math.max(...members.map((n) => n.x + NODE_W)) + 80 : layout.width;
    const y1 = members ? Math.max(...members.map((n) => n.y + NODE_H)) + 80 : layout.height;
    // Clear of the floating toolbar at the top and the legend at the bottom.
    const top = 64;
    const bottom = members ? 12 : 96;
    const k = Math.min(1.25, Math.max(0.2, Math.min(w / (x1 - x0), (h - top - bottom) / (y1 - y0))));
    const t = zoomIdentity.translate(w / 2 - ((x0 + x1) / 2) * k, top + (h - top - bottom) / 2 - ((y0 + y1) / 2) * k).scale(k);
    const sel = select(vp);
    if (animate && !prefersReducedMotion()) sel.transition().duration(550).call(z.transform, t);
    else sel.call(z.transform, t);
  };

  useImperativeHandle(ref, () => ({
    fit: (ids) => fitTo(ids),
    zoomBy: (f) => {
      const vp = viewportRef.current;
      if (!vp || !zoomRef.current) return;
      select(vp).transition().duration(prefersReducedMotion() ? 0 : 240).call(zoomRef.current.scaleBy, f);
    },
  }));

  useEffect(() => {
    const vp = viewportRef.current!;
    const z = d3zoom<HTMLDivElement, unknown>()
      .scaleExtent([0.15, 2.5])
      .filter((e: Event) => !(e.type === 'mousedown' && (e as MouseEvent).button !== 0) && e.type !== 'dblclick')
      .on('zoom', (e: { transform: ZoomTransform }) => {
        const { x, y, k } = e.transform;
        if (stageRef.current) stageRef.current.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
      });
    zoomRef.current = z;
    select(vp).call(z);
    fitTo(undefined, false);
    const ro = new ResizeObserver(() => fitTo(undefined, false));
    ro.observe(vp);
    return () => {
      ro.disconnect();
      select(vp).on('.zoom', null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  useEffect(() => {
    if (!intro) return;
    const t = setTimeout(() => {
      setIntro(false);
      p.onIntroDone();
    }, layout.lanes.length * 110 + 1400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Emphasis: the hovered/selected component and its direct links, or an external focus set.
  const active = hovered ?? p.selected;
  const emphasis = useMemo(() => {
    if (active) {
      const nodes = new Set([active]);
      const links = new Set<string>();
      for (const l of p.map.links) {
        if (l.source === active || l.target === active) {
          links.add(l.id);
          nodes.add(l.source);
          nodes.add(l.target);
        }
      }
      return { nodes, links };
    }
    if (p.focus?.size) {
      const links = new Set(p.map.links.filter((l) => p.focus!.has(l.source) && p.focus!.has(l.target)).map((l) => l.id));
      return { nodes: p.focus, links };
    }
    return null;
  }, [active, p.focus, p.map.links]);

  const laneIndex = new Map(layout.lanes.map((l, i) => [l.layer, i]));
  const colors = [...new Set(layout.links.map((l) => linkStyle(l.link).color))];
  const marker = (c: string) => `sm-${colors.indexOf(c)}`;

  return (
    <div
      ref={viewportRef}
      className={`sys-viewport${intro ? ' is-intro' : ''}`}
      onClick={(e) => e.target === e.currentTarget && p.onSelect(null)}
      role="application"
      aria-roledescription="system map"
      aria-label={`System map: ${p.map.nodes.length} components in ${layout.lanes.length} layers and ${p.map.links.length} connections. Use Tab to move between components.`}
    >
      <div ref={stageRef} className="sys-stage" style={{ width: layout.width, height: layout.height }}>
        {layout.lanes.map((lane, i) => (
          <motion.div
            key={lane.layer}
            className={`sys-lane lane-${lane.layer}`}
            style={{ top: lane.y, height: lane.h - 8, width: layout.width }}
            initial={intro ? { opacity: 0, x: -24 } : false}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.45, delay: i * 0.11, ease: [0.22, 1, 0.36, 1] }}
          >
            <span className="sys-lane-label">{lane.label}</span>
          </motion.div>
        ))}
        {layout.groups.map((g) => (
          <motion.div
            key={g.app}
            className="sys-group"
            style={{ left: g.x, top: g.y, width: g.w, height: g.h }}
            initial={intro ? { opacity: 0 } : false}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, delay: 0.35 }}
          >
            <span className="sys-group-label">
              <strong>{g.name}</strong>
              {g.frameworks.length > 0 && <span className="mono">{g.frameworks.slice(0, 4).join(' · ')}</span>}
            </span>
          </motion.div>
        ))}
        <svg className="sys-links" width={layout.width} height={layout.height} aria-hidden="true">
          <defs>
            {colors.map((c) => (
              <marker key={c} id={marker(c)} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
                <path d="M0 0L10 5L0 10z" fill={c} />
              </marker>
            ))}
          </defs>
          {layout.links.map((ml, i) => {
            const s = linkStyle(ml.link);
            const on = !emphasis || emphasis.links.has(ml.link.id);
            const srcLane = laneIndex.get(pos.get(ml.link.source)?.node.layer ?? 'client') ?? 0;
            return (
              <motion.path
                key={ml.link.id}
                d={ml.d}
                fill="none"
                stroke={s.color}
                strokeWidth={on && emphasis ? s.width + 0.8 : s.width}
                strokeDasharray={s.dash || undefined}
                markerEnd={`url(#${marker(s.color)})`}
                initial={intro ? { pathLength: 0, opacity: 0 } : false}
                animate={{ pathLength: 1, opacity: on ? 0.9 : 0.07 }}
                transition={{ pathLength: { duration: 0.6, delay: 0.55 + srcLane * 0.11 + (i % 12) * 0.02 }, opacity: { duration: 0.18 } }}
              />
            );
          })}
        </svg>
        {/* Labels: the client's transport library always; everything else when its component is in focus. */}
        {layout.links.map((ml) => {
          const on = emphasis ? emphasis.links.has(ml.link.id) : ml.link.kind === 'transport' && pos.get(ml.link.source)?.node.kind === 'client';
          if (!on || !ml.link.label) return null;
          const s = linkStyle(ml.link);
          return (
            <span key={`l-${ml.link.id}`} className="sys-link-label mono" style={{ left: ml.lx, top: ml.ly, color: s.color }}>
              {ml.link.label}
              {ml.link.count > 1 ? ` ×${ml.link.count}` : ''}
              {ml.link.async ? ' · async' : ''}
            </span>
          );
        })}
        {layout.nodes.map((mn, i) => {
          const n = mn.node;
          const Icon = kindIcon(n);
          const arch = n.arch ? p.archById.get(n.arch) : undefined;
          const dim = emphasis && !emphasis.nodes.has(n.id);
          return (
            <motion.button
              key={n.id}
              type="button"
              className={`sys-node kind-${n.kind} conf-${n.confidence}${p.selected === n.id ? ' is-selected' : ''}`}
              style={{ left: mn.x, top: mn.y, width: NODE_W, height: NODE_H }}
              initial={intro ? { opacity: 0, y: 6 } : false}
              animate={{ opacity: dim ? 0.22 : 1, y: 0 }}
              transition={{ opacity: { duration: 0.18 }, y: { duration: 0.4, delay: 0.3 + (laneIndex.get(n.layer) ?? 0) * 0.11 + (i % 8) * 0.02 } }}
              onClick={(e) => {
                e.stopPropagation();
                p.onSelect(p.selected === n.id ? null : n.id);
              }}
              onMouseEnter={() => setHovered(n.id)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(n.id)}
              onBlur={() => setHovered(null)}
              aria-pressed={p.selected === n.id}
              aria-label={`${KIND_LABEL[n.kind]} ${n.name}. ${n.detail}. ${n.confidence === 'confirmed' ? 'Confirmed' : n.confidence === 'strong' ? 'Strong inference' : 'Possible'}.`}
            >
              <span className="sn-head">
                <span className="sn-icon">{arch && n.kind !== 'client' ? <CategoryIcon category={arch.category} size={14} /> : <Icon size={14} strokeWidth={1.8} />}</span>
                <span className="sn-kind">{KIND_LABEL[n.kind]}</span>
                {n.routes && <span className="sn-count mono">{n.routes.length}</span>}
              </span>
              <span className="sn-name">{n.name}</span>
              <span className="sn-detail mono">{n.detail}</span>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
});
