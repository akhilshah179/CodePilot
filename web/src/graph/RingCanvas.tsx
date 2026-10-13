import { select } from 'd3-selection';
import 'd3-transition';
import { zoom as d3zoom, zoomIdentity, type ZoomBehavior } from 'd3-zoom';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { prefersReducedMotion } from '../lib/hooks.ts';
import type { GraphModel, Visibility } from './model.ts';
import { arcAtAngle, longestName, nodeAtAngle, polar, type RingCategory, type RingLayout } from './ring.ts';
import { labelLevel, REVEAL_MS, RingRenderer, type LabelLevel, type RingCamera, type RingOptions, type RingState } from './ringRenderer.ts';

export interface RingCanvasHandle {
  fit(animate?: boolean): void;
  zoomBy(factor: number): void;
  /** Bring a file into view (zooming in enough to read its label). */
  focusNode(index: number): void;
  screenOf(index: number): { x: number; y: number } | null;
  toBlob(): Promise<Blob | null>;
}

export interface RingCanvasProps {
  model: GraphModel;
  layout: RingLayout;
  vis: Visibility;
  options: RingOptions;
  hovered: number | null;
  selected: number | null;
  arc: RingCategory | null;
  arcTarget: RingCategory | null;
  isolated: number | null;
  kbFocus: number | null;
  reveal: boolean;
  ariaLabel: string;
  ariaDescribedBy?: string;
  onHover(i: number | null): void;
  onHoverPair(p: { pair: number; x: number; y: number } | null): void;
  onSelect(i: number | null): void;
  onArc(c: RingCategory | null): void;
  onIsolate(i: number): void;
  onKey(e: React.KeyboardEvent): void;
  onRevealDone(): void;
  onLevel?(level: LabelLevel): void;
}

const MIN_K = 0.15;
const MAX_K = 14;

export const RingCanvas = forwardRef<RingCanvasHandle, RingCanvasProps>(function RingCanvas(props, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<RingRenderer | null>(null);
  const camRef = useRef<RingCamera>({ k: 1, x: 0, y: 0 });
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const zoomRef = useRef<ZoomBehavior<HTMLCanvasElement, unknown> | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const revealStart = useRef<number | null>(null);
  const mixRef = useRef({ value: 1, from: 1, start: 0, key: '' });
  const hoverPairRef = useRef<number | null>(null);
  const frame = useRef(0);
  const fitted = useRef(false);
  const levelRef = useRef<LabelLevel | null>(null);

  const renderer = useMemo(() => {
    const ctx = canvasRef.current?.getContext('2d');
    return ctx ? new RingRenderer(ctx, props.model, props.layout) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.model, props.layout, canvasRef.current]);

  const draw = () => {
    frame.current = 0;
    const r = rendererRef.current;
    const { w, h, dpr } = sizeRef.current;
    if (!r || !w) return;
    const p = propsRef.current;
    const now = performance.now();
    const reveal = revealStart.current === null ? null : now - revealStart.current;
    // Focus transitions: a short cross-fade whenever the emphasised set changes.
    const key = `${p.isolated ?? ''}|${p.selected ?? p.hovered ?? ''}|${p.arc ?? ''}|${p.arcTarget ?? ''}`;
    const m = mixRef.current;
    if (m.key !== key) {
      m.from = m.key && key.replace(/\|/g, '') ? 0.35 : 0;
      m.key = key;
      m.start = now;
    }
    const dur = prefersReducedMotion() ? 0 : 170;
    m.value = dur ? Math.min(1, m.from + ((now - m.start) / dur) * (1 - m.from)) : 1;
    const state: RingState = {
      vis: p.vis,
      options: p.options,
      focus: p.selected ?? p.hovered,
      locked: p.selected,
      arc: p.arc,
      arcTarget: p.arcTarget,
      isolated: p.isolated,
      kbFocus: p.kbFocus,
      hoverPair: hoverPairRef.current,
      mix: m.value,
      reveal: reveal !== null && reveal < REVEAL_MS ? reveal : null,
    };
    r.draw(camRef.current, w, h, dpr, state);
    const level = labelLevel(p.layout, camRef.current.k);
    if (level !== levelRef.current) {
      levelRef.current = level;
      p.onLevel?.(level);
    }
    if (reveal !== null && reveal >= REVEAL_MS) {
      revealStart.current = null;
      p.onRevealDone();
    }
    if (state.reveal !== null || m.value < 1) schedule();
  };
  const schedule = () => {
    if (!frame.current) frame.current = requestAnimationFrame(draw);
  };

  useEffect(() => {
    rendererRef.current = renderer;
    schedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderer]);

  /** Fit the ring below the toolbar, leaving room for the band and — when they will show — file names. */
  const fitTransform = () => {
    const { w, h } = sizeRef.current;
    const L = propsRef.current.layout;
    const top = 64;
    const avail = Math.min(w, h - top) / 2;
    // Prefer a fit where file names are readable and fully on screen; otherwise ticks and band only.
    const labelRoom = 34 + Math.min(190, longestName(propsRef.current.model, L) * 6.4);
    const withNames = (avail - labelRoom) / L.R;
    let k = L.step * L.R * withNames >= 10 ? withNames : Math.min((avail - 48) / L.R, 9.8 / (L.step * L.R));
    k = Math.max(MIN_K, Math.min(MAX_K, k));
    return zoomIdentity.translate(w / 2, top + (h - top) / 2).scale(k);
  };

  // Canvas sizing, zoom behaviour and the load sequence.
  useEffect(() => {
    const canvas = canvasRef.current!;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      sizeRef.current = { w: rect.width, h: rect.height, dpr };
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      if (!rendererRef.current) {
        const ctx = canvas.getContext('2d');
        if (ctx) rendererRef.current = new RingRenderer(ctx, propsRef.current.model, propsRef.current.layout);
      }
      if (!fitted.current && rect.width > 0) {
        fitted.current = true;
        select(canvas).call(zoomRef.current!.transform, fitTransform());
        if (propsRef.current.reveal && !prefersReducedMotion()) revealStart.current = performance.now();
        else propsRef.current.onRevealDone();
      }
      schedule();
    };
    const z = d3zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([MIN_K, MAX_K])
      .filter((e: Event) => !(e.type === 'dblclick') && (!(e as MouseEvent).button || e.type === 'wheel'))
      .on('zoom', (e) => {
        camRef.current = { k: e.transform.k, x: e.transform.x, y: e.transform.y };
        schedule();
      });
    zoomRef.current = z;
    select(canvas).call(z).on('dblclick.zoom', null);
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    return () => {
      ro.disconnect();
      select(canvas).on('.zoom', null);
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Redraw on any state change.
  useEffect(schedule);

  /** What is under a screen point: a file, a category arc, or nothing. */
  const hit = (sx: number, sy: number): { node?: number; arc?: RingCategory } => {
    const p = propsRef.current;
    const cam = camRef.current;
    const L = p.layout;
    const dx = sx - cam.x;
    const dy = sy - cam.y;
    const rs = Math.hypot(dx, dy);
    const Rs = L.R * cam.k;
    const a = Math.atan2(dx, -dy);
    const iso = p.isolated !== null ? new Set([p.isolated, ...p.model.outPairs[p.isolated].map((pi) => p.model.pairs[pi].t), ...p.model.inPairs[p.isolated].map((pi) => p.model.pairs[pi].s)]) : null;
    const visible = (i: number) => p.vis.nodes[i] === 1 && !Number.isNaN(L.angle[i]) && (!iso || iso.has(i));
    const level = labelLevel(L, cam.k);
    const labelReach = level === 'ticks' ? 0 : 220;
    if (rs >= Rs - 16 && rs <= Rs + 8) {
      const i = nodeAtAngle(L, a, visible, Math.max(L.step * 0.75, 6 / Rs));
      if (i >= 0) return { node: i };
    }
    if (rs > Rs + 8 && rs <= Rs + 25) {
      const arc = arcAtAngle(L, a);
      if (arc) return { arc: arc.category };
    }
    if (rs > Rs + 25 && rs <= Rs + 25 + labelReach) {
      const i = nodeAtAngle(L, a, visible, Math.max(L.step * 0.5, 4 / rs));
      if (i >= 0) return { node: i };
    }
    return {};
  };

  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };

  const down = useRef<{ x: number; y: number } | null>(null);
  const hoverFrame = useRef(0);

  useImperativeHandle(ref, () => ({
    fit(animate = true) {
      const canvas = canvasRef.current;
      if (!canvas || !zoomRef.current) return;
      const sel = select(canvas);
      if (animate && !prefersReducedMotion()) sel.transition().duration(450).call(zoomRef.current.transform, fitTransform());
      else sel.call(zoomRef.current.transform, fitTransform());
    },
    zoomBy(f) {
      const canvas = canvasRef.current;
      if (!canvas || !zoomRef.current) return;
      const sel = select(canvas);
      if (prefersReducedMotion()) sel.call(zoomRef.current.scaleBy, f);
      else sel.transition().duration(220).call(zoomRef.current.scaleBy, f);
    },
    focusNode(i) {
      const canvas = canvasRef.current;
      const p = propsRef.current;
      if (!canvas || !zoomRef.current || Number.isNaN(p.layout.angle[i])) return;
      const { w, h } = sizeRef.current;
      const L = p.layout;
      // Zoom until neighbouring labels have room (≈ 14px apart), keeping the file near the centre.
      const k = Math.min(MAX_K, Math.max(camRef.current.k, 14 / (L.step * L.R)));
      const [x, y] = polar(L.angle[i], L.R);
      const t = zoomIdentity.translate(w / 2 - x * k * 0.82, h / 2 - y * k * 0.82).scale(k);
      const sel = select(canvas);
      if (prefersReducedMotion()) sel.call(zoomRef.current.transform, t);
      else sel.transition().duration(500).call(zoomRef.current.transform, t);
    },
    screenOf(i) {
      const p = propsRef.current;
      const a = p.layout.angle[i];
      if (Number.isNaN(a)) return null;
      const cam = camRef.current;
      const [x, y] = polar(a, p.layout.R * cam.k + 12);
      return { x: cam.x + x, y: cam.y + y };
    },
    toBlob() {
      return new Promise((resolve) => canvasRef.current?.toBlob((b) => resolve(b), 'image/png') ?? resolve(null));
    },
  }));

  return (
    <canvas
      ref={canvasRef}
      className="ring-canvas"
      tabIndex={0}
      role="img"
      aria-label={props.ariaLabel}
      aria-describedby={props.ariaDescribedBy}
      onKeyDown={props.onKey}
      onPointerDown={(e) => {
        const [x, y] = local(e);
        down.current = { x, y };
      }}
      onPointerMove={(e) => {
        if (e.buttons) return;
        const [x, y] = local(e);
        cancelAnimationFrame(hoverFrame.current);
        hoverFrame.current = requestAnimationFrame(() => {
          const p = propsRef.current;
          const h = hit(x, y);
          if ((h.node ?? null) !== p.hovered) p.onHover(h.node ?? null);
          canvasRef.current!.style.cursor = h.node !== undefined || h.arc ? 'pointer' : 'grab';
          // Thread labels only for the locked file's threads (a handful), never for the whole graph.
          let pair: number | null = null;
          const f = p.isolated ?? p.selected;
          const r = rendererRef.current;
          if (h.node === undefined && !h.arc && f !== null && r) {
            const candidates = [...p.model.outPairs[f], ...p.model.inPairs[f]].filter((pi) => p.vis.pairs[pi]);
            for (const pi of candidates) {
              if (r.hitPair(pi, x, y, camRef.current, sizeRef.current.dpr)) {
                pair = pi;
                break;
              }
            }
          }
          if (pair !== hoverPairRef.current) {
            hoverPairRef.current = pair;
            p.onHoverPair(pair === null ? null : { pair, x, y });
            schedule();
          } else if (pair !== null) p.onHoverPair({ pair, x, y });
        });
      }}
      onPointerLeave={() => {
        cancelAnimationFrame(hoverFrame.current);
        propsRef.current.onHover(null);
        if (hoverPairRef.current !== null) {
          hoverPairRef.current = null;
          propsRef.current.onHoverPair(null);
          schedule();
        }
      }}
      onClick={(e) => {
        const [x, y] = local(e);
        if (down.current && Math.hypot(down.current.x - x, down.current.y - y) > 4) return;
        const h = hit(x, y);
        const p = propsRef.current;
        if (h.node !== undefined) p.onSelect(h.node);
        else if (h.arc) p.onArc(p.arc === h.arc ? null : h.arc);
        else {
          p.onSelect(null);
          p.onArc(null);
        }
      }}
      onDoubleClick={(e) => {
        const [x, y] = local(e);
        const h = hit(x, y);
        if (h.node !== undefined) propsRef.current.onIsolate(h.node);
      }}
    />
  );
});
