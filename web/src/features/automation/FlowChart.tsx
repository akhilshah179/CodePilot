import { layoutFlow, NODE_H, NODE_W, type LayoutOptions } from '@codepilot/analyzer/automation/layout';
import {
  ArrowLeftRight,
  Box,
  ChevronDown,
  ChevronRight,
  Cog,
  Crosshair,
  Database,
  Expand,
  Flag,
  Globe,
  HelpCircle,
  Layers,
  LayoutList,
  ListTree,
  Map as MapIcon,
  Minimize2,
  MousePointerClick,
  Pause,
  Play,
  Rows3,
  Share2,
  SkipForward,
  Split,
  Undo2,
  Workflow,
  ZoomIn,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AutoEdge, AutoNode, AutoNodeType, AutomationFlow } from '../../lib/api.ts';
import {
  anchorView,
  anyVisible,
  boundsOf,
  clampView,
  fitView,
  hiddenByCollapse,
  layoutOk,
  pathThrough,
  pointAlong,
  roundedPath,
  startPlayback,
  stepPlayback,
  zoomAt,
  zoomLevel,
  descendants,
  type Playback,
  type View,
} from './chartModel.ts';

export const NODE_META: Record<AutoNodeType, { label: string; icon: LucideIcon }> = {
  trigger: { label: 'Trigger', icon: MousePointerClick },
  ui: { label: 'UI step', icon: Box },
  request: { label: 'HTTP request', icon: ArrowLeftRight },
  server: { label: 'Server step', icon: Cog },
  decision: { label: 'Decision', icon: Split },
  store: { label: 'Data store', icon: Database },
  external: { label: 'External service', icon: Globe },
  job: { label: 'Background job', icon: Workflow },
  end: { label: 'Outcome', icon: Flag },
  jump: { label: 'Jump to flow', icon: Share2 },
  unknown: { label: 'Unknown', icon: HelpCircle },
  group: { label: 'Group', icon: ListTree },
};

const EDGE_TEXT: Record<AutoEdge['kind'], string> = { sequence: 'Sequence', true: 'True / yes', false: 'False / no', error: 'Error', async: 'Async, does not block', jump: 'Continues in another flow', unknown: 'Unknown', group: 'Folded endpoints' };
const LANE_TEXT: Record<string, string> = { frontend: 'Frontend', backend: 'Backend', data: 'Data', external: 'External', background: 'Background', all: '' };

interface Props {
  flow: AutomationFlow;
  /** Changes when the snapshot changes, so a stale layout is never reused. */
  snapshotKey: string;
  selected: string | null;
  onSelect(id: string | null): void;
  reduced: boolean;
  /** Rendered inside the canvas over its right edge when a node is selected. */
  inspector?: React.ReactNode;
  /** Incremented to frame the selected node and everything after it ("Focus branch"). */
  focusRequest?: number;
}

const ss = {
  get(k: string) {
    try {
      return sessionStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      sessionStorage.setItem(k, v);
    } catch {
      /* storage unavailable */
    }
  },
};

export function FlowChart({ flow, snapshotKey, selected, onSelect, reduced, inspector, focusRequest = 0 }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setViewState] = useState<View | null>(null);
  const viewRef = useRef<View | null>(null);
  const [swimlanes, setSwimlanes] = useState(true);
  const [spacing, setSpacing] = useState<LayoutOptions['spacing']>('spacious');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState(false);
  const [minimap, setMinimap] = useState(true);
  const [legend, setLegend] = useState(false);
  const [zoomMenu, setZoomMenu] = useState(false);
  const [hint, setHint] = useState(false);
  const [retry, setRetry] = useState(0);
  const [entering, setEntering] = useState(false);

  // Playback
  const [pb, setPb] = useState<Playback | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [allPaths, setAllPaths] = useState(false);
  const [follow, setFollow] = useState(!reduced);
  const [anim, setAnim] = useState<{ edges: AutoEdge[]; t: number } | null>(null);

  useEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const direction: LayoutOptions['direction'] = size.w && size.h > size.w * 1.15 ? 'TB' : 'LR';
  const hidden = useMemo(() => hiddenByCollapse(flow.nodes, flow.edges, collapsed), [flow, collapsed]);
  const nodes = useMemo(() => flow.nodes.filter((n) => !hidden.has(n.id)), [flow, hidden]);
  const edges = useMemo(() => flow.edges.filter((e) => !hidden.has(e.source) && !hidden.has(e.target)), [flow, hidden]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const layout = useMemo(() => layoutFlow(nodes, edges, { swimlanes, spacing, direction }), [nodes, edges, swimlanes, spacing, direction, retry]);
  const ok = layoutOk(layout);
  const boxes = useMemo(() => Object.values(layout.nodes), [layout]);
  const content = useMemo(() => boundsOf(boxes), [boxes]);
  const triggerBox = layout.nodes[nodes.find((n) => n.type === 'trigger')?.id ?? ''] ?? boxes[0];
  const byId = useMemo(() => new Map(flow.nodes.map((n) => [n.id, n])), [flow]);
  const viewKey = `cp.auto.view.${snapshotKey}.${flow.id}`;

  /* ------------------------------------------------------------ view */
  const setView = useCallback(
    (v: View) => {
      const c = size.w ? clampView(v, content, size.w, size.h) : v;
      viewRef.current = c;
      setViewState(c);
    },
    [content, size],
  );
  const animRef = useRef(0);
  const animateTo = useCallback(
    (target: View) => {
      cancelAnimationFrame(animRef.current);
      const from = viewRef.current;
      if (reduced || !from) return setView(target);
      const t0 = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - t0) / 260);
        const e = 1 - (1 - t) ** 3;
        setView({ x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, k: from.k + (target.k - from.k) * e });
        if (t < 1) animRef.current = requestAnimationFrame(step);
      };
      animRef.current = requestAnimationFrame(step);
    },
    [reduced, setView],
  );
  const fit = useCallback((widthOnly = false) => size.w && animateTo(fitView(content, size.w, size.h, 48, 1.2, widthOnly)), [animateTo, content, size]);
  const toTrigger = useCallback(() => triggerBox && size.w && animateTo(anchorView(triggerBox, size.w, size.h, 0.85, direction === 'TB', content)), [animateTo, triggerBox, size, direction, content]);
  const zoomBy = (f: number) => size.w && viewRef.current && animateTo(zoomAt(viewRef.current, f, size.w / 2, size.h / 2));
  const setZoom = (k: number) => size.w && viewRef.current && animateTo(zoomAt(viewRef.current, k / viewRef.current.k, size.w / 2, size.h / 2));
  const frame = useCallback((ids: string[], maxK = 1.2) => {
    const bs = ids.map((id) => layout.nodes[id]).filter(Boolean);
    if (bs.length && size.w) animateTo(fitView(boundsOf(bs), size.w, size.h, 80, maxK));
  }, [layout, size, animateTo]);

  useEffect(() => {
    if (focusRequest && selected) frame([selected, ...descendants(selected, edges)]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);

  // Initial view per flow: remembered for the session, else 0.85× anchored on the trigger.
  useEffect(() => {
    if (!size.w || !triggerBox) return;
    const saved = ss.get(viewKey);
    const v = saved ? (JSON.parse(saved) as View) : anchorView(triggerBox, size.w, size.h, 0.85, direction === 'TB', content);
    viewRef.current = null;
    setView(v);
    if (!reduced && !ss.get(`${viewKey}.entered`)) {
      setEntering(true);
      ss.set(`${viewKey}.entered`, '1');
      const t = setTimeout(() => setEntering(false), 1100);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey, size.w > 0, direction]);
  useEffect(() => {
    if (!view) return;
    const t = setTimeout(() => ss.set(viewKey, JSON.stringify(view)), 300);
    return () => clearTimeout(t);
  }, [view, viewKey]);
  // A new flow starts clean.
  useEffect(() => {
    setCollapsed(new Set());
    setPb(null);
    setPlaying(false);
    setAnim(null);
  }, [flow.id, snapshotKey]);

  /* ------------------------------------------------------------ input */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ x: number; y: number; v: View; moved: boolean } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('.fc2-node, .fc2-overlay, button, a, input, select')) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (viewRef.current) drag.current = { x: e.clientX, y: e.clientY, v: viewRef.current, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    const prev = pointers.current.get(e.pointerId)!;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const v = viewRef.current;
    if (!v) return;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const other = [...pointers.current.entries()].find(([id]) => id !== e.pointerId)![1];
      const before = Math.hypot(prev.x - other.x, prev.y - other.y) || 1;
      const after = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const rect = wrapRef.current!.getBoundingClientRect();
      setView(zoomAt(v, after / before, (a.x + b.x) / 2 - rect.left, (a.y + b.y) / 2 - rect.top));
      return;
    }
    const d = drag.current;
    if (!d) return;
    if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) {
      d.moved = true;
      setFollow(false);
    }
    setView({ ...d.v, x: d.v.x + e.clientX - d.x, y: d.v.y + e.clientY - d.y });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (drag.current && !drag.current.moved && !(e.target as HTMLElement).closest('.fc2-node, .fc2-overlay')) onSelect(null);
    drag.current = null;
  };

  // Wheel: ctrl/cmd zooms to the cursor; plain scroll pans when expanded, scrolls the page when embedded.
  useEffect(() => {
    const el = wrapRef.current!;
    const onWheel = (e: WheelEvent) => {
      const v = viewRef.current;
      if (!v) return;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        setView(zoomAt(v, Math.exp(-e.deltaY * 0.0022), e.clientX - rect.left, e.clientY - rect.top));
      } else if (expanded) {
        e.preventDefault();
        setView({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY });
      } else if (!ss.get('cp.auto.hint')) {
        ss.set('cp.auto.hint', '1');
        setHint(true);
        setTimeout(() => setHint(false), 2600);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [expanded, setView]);

  useEffect(() => {
    if (!expanded) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setExpanded(false);
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [expanded]);

  const onKey = (e: React.KeyboardEvent) => {
    const v = viewRef.current;
    if (!v || (e.target as HTMLElement).closest('.fc2-overlay, input, select, textarea')) return;
    const onNode = (e.target as HTMLElement).closest('.fc2-node') as HTMLElement | null;
    if (onNode && ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) {
      // Arrows on a node follow the edges.
      const id = onNode.dataset.id!;
      const fwd = e.key === 'ArrowRight' || e.key === 'ArrowDown';
      const nextId = fwd ? edges.find((x) => x.source === id && x.kind !== 'group')?.target : edges.find((x) => x.target === id)?.source;
      if (nextId) {
        e.preventDefault();
        wrapRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(nextId)}"]`)?.focus();
      }
      return;
    }
    const pan = 60;
    const map: Record<string, () => void> = {
      ArrowLeft: () => setView({ ...v, x: v.x + pan }),
      ArrowRight: () => setView({ ...v, x: v.x - pan }),
      ArrowUp: () => setView({ ...v, y: v.y + pan }),
      ArrowDown: () => setView({ ...v, y: v.y - pan }),
      '+': () => zoomBy(1.25),
      '=': () => zoomBy(1.25),
      '-': () => zoomBy(0.8),
      '0': () => fit(),
      '1': () => setZoom(1),
      f: () => selected && frame([selected, ...descendants(selected, edges)]),
      F: () => selected && frame([selected, ...descendants(selected, edges)]),
      Home: () => toTrigger(),
      Escape: () => (expanded ? setExpanded(false) : onSelect(null)),
    };
    const fn = map[e.key];
    if (fn) {
      e.preventDefault();
      fn();
    }
  };

  /* ------------------------------------------------------------ playback */
  const runStep = useCallback(
    (choice?: string) => {
      setPb((cur) => {
        const p0 = cur ?? startPlayback(nodes);
        const next = stepPlayback(p0, nodes, edges, { allPaths, choice });
        const moved = edges.filter((e) => next.visitedEdges.has(e.id) && !p0.visitedEdges.has(e.id));
        if (moved.length && !reduced) setAnim({ edges: moved, t: 0 });
        if (follow && !reduced) {
          if (next.waiting) {
            const outs = edges.filter((e) => e.source === next.waiting).map((e) => e.target);
            setTimeout(() => frame([next.waiting!, ...outs], 1), 0);
          } else if (next.tokens[0] && layout.nodes[next.tokens[0]] && size.w && viewRef.current) {
            const b = layout.nodes[next.tokens[0]];
            const v = viewRef.current;
            setTimeout(() => animateTo({ ...v, x: size.w / 2 - (b.x + b.w / 2) * v.k, y: size.h / 2 - (b.y + b.h / 2) * v.k }), 0);
          }
        }
        if (next.done) setPlaying(false);
        return next;
      });
    },
    [nodes, edges, allPaths, reduced, follow, frame, layout, size, animateTo],
  );
  // Token animation along the edges just taken.
  useEffect(() => {
    if (!anim || anim.t >= 1) return;
    const t0 = performance.now() - anim.t * (600 / speed);
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / (600 / speed));
      setAnim((a) => (a ? { ...a, t } : a));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anim?.edges]);
  useEffect(() => {
    if (!playing || !pb || pb.waiting || pb.done || (anim && anim.t < 1)) return;
    const t = setTimeout(() => runStep(), 260 / speed);
    return () => clearTimeout(t);
  }, [playing, pb, anim, speed, runStep]);

  const resetPlayback = () => {
    setPlaying(false);
    setPb(null);
    setAnim(null);
  };

  /* ------------------------------------------------------------ render */
  const v = view ?? { x: 0, y: 0, k: 0.85 };
  const level = zoomLevel(v.k);
  const highlight = selected ? pathThrough(selected, edges) : null;
  const lost = view && size.w ? !anyVisible(view, boxes, size.w, size.h) : false;
  const visitedN = pb?.visitedNodes;
  const visitedE = pb?.visitedEdges;
  const waitingEdges = pb?.waiting ? edges.filter((e) => e.source === pb.waiting) : [];
  const waitingBox = pb?.waiting ? layout.nodes[pb.waiting] : undefined;

  return (
    <div className={`fc2-region${expanded ? ' is-expanded' : ''}`}>
      <div className="fc2-toolbar" role="toolbar" aria-label="Flowchart controls">
        <div className="fc2-group" aria-label="Playback">
          <button type="button" className="icon-btn" onClick={() => (playing ? setPlaying(false) : reduced ? runStep() : (pb?.done && resetPlayback(), setPlaying(true)))} aria-label={playing ? 'Pause' : reduced ? 'Play one step (reduced motion)' : 'Play'} title={reduced ? 'Step through (reduced motion)' : playing ? 'Pause' : 'Play'}>
            {playing ? <Pause size={15} /> : <Play size={15} />}
          </button>
          <button type="button" className="icon-btn" onClick={() => runStep()} disabled={!!pb?.done} aria-label="Step" title="Step">
            <SkipForward size={15} />
          </button>
          <button type="button" className="icon-btn" onClick={resetPlayback} aria-label="Reset playback" title="Reset">
            <Undo2 size={15} />
          </button>
          <div className="segmented fc2-speed" role="group" aria-label="Speed">
            {[0.5, 1, 2].map((s) => (
              <button key={s} type="button" aria-pressed={speed === s} onClick={() => setSpeed(s)}>
                {s}×
              </button>
            ))}
          </div>
          <label className="fc2-check small">
            <input type="checkbox" checked={allPaths} onChange={(e) => setAllPaths(e.target.checked)} /> Run all paths
          </label>
          <label className="fc2-check small" title={reduced ? 'Off with reduced motion' : undefined}>
            <input type="checkbox" checked={follow && !reduced} disabled={reduced} onChange={(e) => setFollow(e.target.checked)} /> Follow
          </label>
        </div>
        <div className="fc2-group" aria-label="View">
          <button type="button" className={`btn btn-sm${swimlanes ? ' is-on' : ''}`} aria-pressed={swimlanes} onClick={() => setSwimlanes(!swimlanes)} title="Swimlanes">
            <Rows3 size={14} /> Lanes
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setSpacing(spacing === 'spacious' ? 'compact' : 'spacious')} title="Spacing">
            <LayoutList size={14} /> {spacing === 'spacious' ? 'Spacious' : 'Compact'}
          </button>
          <div className="fc2-menu-wrap">
            <button type="button" className="btn btn-sm" aria-expanded={zoomMenu} onClick={() => setZoomMenu(!zoomMenu)}>
              <ZoomIn size={14} /> {Math.round(v.k * 100)}% <ChevronDown size={12} />
            </button>
            {zoomMenu && (
              <div className="fc2-menu" role="menu" onClick={() => setZoomMenu(false)}>
                <button role="menuitem" onClick={() => fit()}>Fit</button>
                <button role="menuitem" onClick={() => fit(true)}>Fit width</button>
                {[0.5, 0.75, 1, 1.5].map((k) => (
                  <button key={k} role="menuitem" onClick={() => setZoom(k)}>
                    {k * 100}%
                  </button>
                ))}
              </div>
            )}
          </div>
          <button type="button" className="btn btn-sm" onClick={() => (ss.set(viewKey, ''), toTrigger())} title="Reset view (Home)">
            <Crosshair size={14} /> Reset view
          </button>
          <button type="button" className="icon-btn" onClick={() => setExpanded(!expanded)} aria-label={expanded ? 'Exit expanded view' : 'Expand'} title={expanded ? 'Exit (Esc)' : 'Expand'}>
            {expanded ? <Minimize2 size={15} /> : <Expand size={15} />}
          </button>
        </div>
      </div>

      <div
        ref={wrapRef}
        className={`fc2-canvas${entering ? ' is-entering' : ''} lvl-${level}`}
        tabIndex={0}
        role="group"
        aria-label={`Flowchart: ${flow.name}. ${nodes.length} steps. Drag to pan, Ctrl or Cmd + scroll to zoom, arrow keys pan, 0 fits, Home goes to the trigger.`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKey}
        onDoubleClick={(e) => {
          const node = (e.target as HTMLElement).closest('.fc2-node') as HTMLElement | null;
          if (node) frame([node.dataset.id!], 1.2);
          else if (!(e.target as HTMLElement).closest('.fc2-overlay')) fit();
        }}
      >
        {!ok ? (
          <div className="fc2-overlay fc2-error" role="alert">
            <p>Couldn’t lay out this flow.</p>
            <button type="button" className="btn btn-sm" onClick={() => setRetry((r) => r + 1)}>
              Retry
            </button>
          </div>
        ) : (
          <div className="fc2-world" style={{ transform: `translate(${v.x}px, ${v.y}px) scale(${v.k})`, width: layout.width, height: layout.height }}>
            {swimlanes &&
              layout.lanes.map((l, i) => (
                <div key={l.lane} className={`fc2-lane lane-${l.lane}${i % 2 ? ' is-alt' : ''}`} style={direction === 'LR' ? { top: l.start, height: l.size, left: 0, width: layout.width } : { left: l.start, width: l.size, top: 0, height: layout.height }} />
              ))}
            <svg className="fc2-edges" width={layout.width} height={layout.height} aria-hidden="true">
              <defs>
                {(['sequence', 'true', 'false', 'error', 'async', 'jump', 'unknown', 'group'] as const).map((k) => (
                  <marker key={k} id={`fc2-ah-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M0 0L10 5L0 10z" className={`fc2-ah k-${k}`} />
                  </marker>
                ))}
              </defs>
              {edges.map((e) => {
                const r = layout.edges[e.id];
                if (!r) return null;
                const dim = highlight && !highlight.edges.has(e.id);
                return (
                  <g key={e.id} className={`fc2-edge k-${e.kind}${dim ? ' is-dim' : ''}${visitedE?.has(e.id) ? ' is-visited' : ''}`}>
                    <path d={roundedPath(r.points)} markerEnd={`url(#fc2-ah-${e.kind})`} />
                    <title>{`${EDGE_TEXT[e.kind]}${e.label ? `: ${e.label}` : ''}${e.timer ? ` · ${e.timer}` : ''} (${e.evidence[0]?.file}${e.evidence[0]?.line ? `:${e.evidence[0].line}` : ''})`}</title>
                    {level === 'full' && (e.label || e.timer) && (
                      <text x={r.mid[0]} y={r.mid[1] - 8} className="fc2-edge-label">
                        {[e.label, e.timer && `⏱ ${e.timer}`].filter(Boolean).join(' · ')}
                      </text>
                    )}
                  </g>
                );
              })}
              {anim &&
                anim.t < 1 &&
                anim.edges.map((e) => {
                  const r = layout.edges[e.id];
                  if (!r) return null;
                  const [x, y] = pointAlong(r.points, anim.t);
                  return <circle key={e.id} cx={x} cy={y} r={9} className={`fc2-token k-${e.kind}`} />;
                })}
            </svg>
            {[...nodes]
              .sort((a, b) => a.order - b.order)
              .map((n) => {
                const p = layout.nodes[n.id];
                if (!p) return null;
                const dim = highlight && !highlight.nodes.has(n.id);
                const meta = NODE_META[n.type];
                const Icon = meta.icon;
                const where = `${n.file.slice(n.file.lastIndexOf('/') + 1)}${n.line ? `:${n.line}` : ''}`;
                const isToken = pb?.tokens.includes(n.id);
                return (
                  <button
                    key={n.id}
                    type="button"
                    data-id={n.id}
                    className={`fc2-node t-${n.type}${dim ? ' is-dim' : ''}${selected === n.id ? ' is-selected' : ''}${visitedN?.has(n.id) ? ' is-visited' : ''}${isToken ? ' is-token' : ''}${n.confidence === 'unknown' ? ' is-unknown' : ''}`}
                    style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(selected === n.id ? null : n.id);
                    }}
                    title={`${meta.label}: ${n.label} (${n.file}${n.line ? `:${n.line}` : ''})`}
                    aria-label={`${meta.label}: ${n.label}. ${n.file}${n.line ? ` line ${n.line}` : ''}.`}
                    aria-pressed={selected === n.id}
                  >
                    <svg className="fc2-shape" viewBox={`0 0 ${NODE_W} ${NODE_H}`} preserveAspectRatio="none" aria-hidden="true">
                      <Shape type={n.type} />
                    </svg>
                    <span className="fc2-body">
                      {level === 'shape' ? (
                        <Icon className="fc2-big-icon" aria-hidden="true" />
                      ) : level === 'title' ? (
                        <span className="fc2-title-big">{n.label}</span>
                      ) : (
                        <>
                          <span className="fc2-kind">
                            <Icon size={16} aria-hidden="true" /> {meta.label}
                          </span>
                          <span className="fc2-title">{n.label}</span>
                          <span className="fc2-meta">
                            <span className="fc2-where">{where}</span>
                            {n.tools.slice(0, 2).map((t) => (
                              <span key={t} className="fc2-chip">
                                {t.replace(/^(tool|host|app):/, '')}
                              </span>
                            ))}
                          </span>
                        </>
                      )}
                    </span>
                    {n.type === 'decision' && level === 'full' && flow.edges.some((e) => e.source === n.id && byId.get(e.target)?.type === 'end') && (
                      <span
                        role="button"
                        tabIndex={0}
                        className="fc2-collapse"
                        aria-label={collapsed.has(n.id) ? 'Show the exit branch' : 'Hide the exit branch'}
                        onClick={(e) => {
                          e.stopPropagation();
                          setCollapsed((c) => {
                            const next = new Set(c);
                            if (next.has(n.id)) next.delete(n.id);
                            else next.add(n.id);
                            return next;
                          });
                        }}
                      >
                        {collapsed.has(n.id) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                      </span>
                    )}
                  </button>
                );
              })}
          </div>
        )}

        {/* Screen-space overlays */}
        <div className="fc2-overlay fc2-sticky-title" aria-hidden="true">
          {flow.name}
        </div>
        {swimlanes &&
          direction === 'LR' &&
          layout.lanes.map((l) => {
            const top = l.start * v.k + v.y;
            const h = l.size * v.k;
            if (top + h < 0 || top > size.h) return null;
            return (
              <div key={l.lane} className="fc2-overlay fc2-lane-label" style={{ top: Math.max(top, 0) + 4 }} aria-hidden="true">
                {LANE_TEXT[l.lane]}
              </div>
            );
          })}
        {pb?.waiting && waitingBox && (
          <div className="fc2-overlay fc2-choice" style={{ left: Math.min(size.w - 260, Math.max(8, (waitingBox.x + waitingBox.w / 2) * v.k + v.x - 120)), top: Math.max(44, waitingBox.y * v.k + v.y - 56) }} role="group" aria-label="Choose a branch">
            <span className="small">Which branch?</span>
            {waitingEdges.map((e) => (
              <button key={e.id} type="button" className="btn btn-sm" onClick={() => runStep(e.id)}>
                {e.label ?? EDGE_TEXT[e.kind]}
              </button>
            ))}
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => (setAllPaths(true), runStep())}>
              Run all paths
            </button>
          </div>
        )}
        {hint && (
          <div className="fc2-overlay fc2-hint" role="status">
            Ctrl + scroll to zoom
          </div>
        )}
        {lost && (
          <button type="button" className="fc2-overlay btn btn-sm fc2-back" onClick={toTrigger}>
            <Crosshair size={14} /> Back to flow
          </button>
        )}
        <div className="fc2-overlay fc2-legend-wrap">
          <button type="button" className="btn btn-sm" aria-expanded={legend} onClick={() => setLegend(!legend)}>
            <Layers size={14} /> Legend
          </button>
          {legend && <Legend />}
        </div>
        <div className={`fc2-overlay fc2-minimap${minimap ? '' : ' is-collapsed'}`}>
          <button type="button" className="fc2-mini-toggle" onClick={() => setMinimap(!minimap)} aria-label={minimap ? 'Hide minimap' : 'Show minimap'}>
            <MapIcon size={13} />
          </button>
          {minimap && ok && <Minimap layout={layout} view={v} size={size} onMove={setView} nodes={nodes} />}
        </div>
        {inspector}
      </div>
    </div>
  );
}

/** One shape per node type: color is never the only signal. */
function Shape({ type }: { type: AutoNodeType }) {
  const W = NODE_W;
  const H = NODE_H;
  const i = 2;
  switch (type) {
    case 'trigger':
    case 'end':
    case 'jump':
      return <rect x={i} y={i} width={W - 2 * i} height={H - 2 * i} rx={(H - 2 * i) / 2} className={`s s-${type}`} />;
    case 'decision':
      return <polygon points={`${W / 2},${i} ${W - i},${H / 2} ${W / 2},${H - i} ${i},${H / 2}`} className="s s-decision" />;
    case 'store':
      return (
        <g className="s s-store">
          <path d={`M${i} 16 Q${W / 2} 0 ${W - i} 16 L${W - i} ${H - 16} Q${W / 2} ${H} ${i} ${H - 16} Z`} />
          <path d={`M${i} 16 Q${W / 2} 32 ${W - i} 16`} fill="none" />
        </g>
      );
    case 'external':
      return <polygon points={`22,${i} ${W - 22},${i} ${W - i},${H / 2} ${W - 22},${H - i} 22,${H - i} ${i},${H / 2}`} className="s s-external" />;
    case 'group':
      return (
        <g className="s s-group">
          <rect x={10} y={i} width={W - 12} height={H - 12} rx={8} />
          <rect x={i} y={10} width={W - 12} height={H - 12} rx={8} />
        </g>
      );
    default:
      return <rect x={i} y={i} width={W - 2 * i} height={H - 2 * i} rx={8} className={`s s-${type}`} />;
  }
}

function Legend() {
  return (
    <div className="fc2-legend" role="dialog" aria-label="Legend">
      <ul>
        {(Object.keys(NODE_META) as AutoNodeType[]).map((t) => {
          const Icon = NODE_META[t].icon;
          return (
            <li key={t}>
              <svg width="34" height="18" viewBox={`0 0 ${NODE_W} ${NODE_H}`} preserveAspectRatio="none" aria-hidden="true" className={`fc2-legend-shape t-${t}`}>
                <Shape type={t} />
              </svg>
              <Icon size={13} aria-hidden="true" /> {NODE_META[t].label}
            </li>
          );
        })}
      </ul>
      <ul>
        {(Object.keys(EDGE_TEXT) as AutoEdge['kind'][]).map((k) => (
          <li key={k}>
            <svg width="34" height="10" aria-hidden="true">
              <path d="M1 5H28" className={`fc2-legend-edge k-${k}`} markerEnd={`url(#fc2-ah-${k})`} />
            </svg>
            {EDGE_TEXT[k]}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Minimap({ layout, view, size, onMove, nodes }: { layout: ReturnType<typeof layoutFlow>; view: View; size: { w: number; h: number }; onMove(v: View): void; nodes: AutoNode[] }) {
  // Sized to the flow's shape, so a long single-row flow gets a short strip, not an empty box.
  const aspect = Math.max(1, layout.height) / Math.max(1, layout.width);
  const W = aspect * 200 <= 120 ? 200 : Math.max(64, Math.round(120 / aspect));
  const H = Math.max(36, Math.min(120, Math.round(W * aspect)));
  const s = Math.min(W / Math.max(1, layout.width), H / Math.max(1, layout.height));
  const vx = -view.x / view.k;
  const vy = -view.y / view.k;
  const vw = size.w / view.k;
  const vh = size.h / view.k;
  const ref = useRef<SVGSVGElement>(null);
  const moveTo = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const cx = (e.clientX - r.left) / s;
    const cy = (e.clientY - r.top) / s;
    onMove({ ...view, x: size.w / 2 - cx * view.k, y: size.h / 2 - cy * view.k });
  };
  return (
    <svg
      ref={ref}
      width={W}
      height={H}
      className="fc2-mini"
      aria-label="Minimap: drag to move the view"
      onPointerDown={(e) => {
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        moveTo(e);
      }}
      onPointerMove={(e) => e.buttons && moveTo(e)}
    >
      {nodes.map((n) => {
        const p = layout.nodes[n.id];
        return p ? <rect key={n.id} x={p.x * s} y={p.y * s} width={Math.max(2, p.w * s)} height={Math.max(2, p.h * s)} className={`mm t-${n.type}`} /> : null;
      })}
      <rect x={vx * s} y={vy * s} width={vw * s} height={vh * s} className="mm-view" />
    </svg>
  );
}
