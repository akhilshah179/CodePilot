import { quadtree, type Quadtree } from 'd3-quadtree';
import { select } from 'd3-selection';
import 'd3-transition';
import { zoom as d3zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from 'd3-zoom';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { prefersReducedMotion } from '../lib/hooks.ts';
import type { Hull } from './geometry.ts';
import type { GraphModel, Highlight, Visibility } from './model.ts';
import type { ArrowDirection } from './navigation.ts';
import { createReveal, GraphRenderer, type Camera, type PathHighlight, type Reveal } from './renderer.ts';

export interface GraphCanvasHandle {
  /** Fit the given nodes (or all visible nodes) into view. */
  fit(indices?: number[], animate?: boolean): void;
  focusNode(index: number, animate?: boolean): void;
  zoomBy(factor: number): void;
  /** Centre the view on a world coordinate (minimap). */
  centerOn(x: number, y: number): void;
  /** Animate node positions to new coordinates (layout morphing). Resolves when done. */
  morphTo(xs: ArrayLike<number>, ys: ArrayLike<number>, duration?: number): Promise<void>;
  /** Screen position (relative to the canvas) of a node, for tooltips. */
  screenOf(index: number): { x: number; y: number } | null;
  camera(): Camera;
  size(): { w: number; h: number };
  /** Canvas pixels of the current view, for PNG export of exactly what is on screen. */
  toBlob(): Promise<Blob | null>;
  /** Redraw (after positions or other mutable state changed). */
  redraw(): void;
}

export interface GraphCanvasProps {
  model: GraphModel;
  vis: Visibility;
  hl: Highlight;
  selected: number | null;
  hovered: number | null;
  kbFocus: number | null;
  /** Play the reveal the first time this model is shown. */
  reveal?: boolean;
  labels?: 'auto' | 'none';
  interactive?: boolean;
  /** Allow wheel/drag/pinch zooming and panning (off for embedded previews so page scrolling works). */
  zoomable?: boolean;
  hulls?: Hull[];
  bundle?: boolean;
  showCycles?: boolean;
  path?: PathHighlight | null;
  cyclePulse?: { nodes: Set<number>; start: number } | null;
  geomVersion?: number;
  ariaLabel: string;
  ariaDescribedBy?: string;
  onHover?(index: number | null): void;
  onSelect?(index: number | null): void;
  onNavigate?(dir: ArrowDirection): void;
  onActivate?(): void;
  onEscape?(): void;
  onRevealDone?(): void;
  onCamera?(camera: Camera): void;
  className?: string;
}

const MIN_K = 0.03;
const MAX_K = 8;
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export const GraphCanvas = forwardRef<GraphCanvasHandle, GraphCanvasProps>(function GraphCanvas(props, ref) {
  const { model, vis, hl, selected, hovered, kbFocus, interactive = true, zoomable = true } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<GraphRenderer | null>(null);
  const zoomRef = useRef<ZoomBehavior<HTMLCanvasElement, unknown> | null>(null);
  const cameraRef = useRef<Camera>({ k: 1, x: 0, y: 0 });
  const sizeRef = useRef({ w: 0, h: 0 });
  const revealRef = useRef<Reveal | null>(null);
  const frameRef = useRef(0);
  const morphRef = useRef(false);
  const fittedRef = useRef<GraphModel | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  const tree: Quadtree<number> = useMemo(() => {
    const t = quadtree<number>()
      .x((i) => model.nodes[i].x)
      .y((i) => model.nodes[i].y);
    for (let i = 0; i < model.nodes.length; i++) if (vis.nodes[i]) t.add(i);
    return t;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, vis, props.geomVersion]);
  const maxR = useMemo(() => model.nodes.reduce((m, n) => Math.max(m, n.r), 4), [model]);

  const draw = useCallback(() => {
    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame((now) => {
      const r = rendererRef.current;
      const p = propsRef.current;
      if (!r) return;
      const animating = r.draw(
        {
          model: p.model,
          vis: p.vis,
          hl: p.hl,
          camera: cameraRef.current,
          selected: p.selected,
          hovered: p.hovered,
          kbFocus: p.kbFocus,
          labels: p.labels ?? 'auto',
          hulls: morphRef.current ? undefined : p.hulls,
          bundle: p.bundle && !morphRef.current,
          showCycles: p.showCycles,
          path: p.path,
          cyclePulse: p.cyclePulse,
          geomVersion: p.geomVersion,
        },
        revealRef.current,
        now,
      );
      if (animating && !prefersReducedMotion()) draw();
      else if (revealRef.current && !animating) {
        revealRef.current = null;
        p.onRevealDone?.();
      }
    });
  }, []);

  const transformFor = useCallback(
    (indices: number[]): ZoomTransform => {
      const { w, h } = sizeRef.current;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const i of indices) {
        const n = model.nodes[i];
        x0 = Math.min(x0, n.x - n.r);
        y0 = Math.min(y0, n.y - n.r);
        x1 = Math.max(x1, n.x + n.r);
        y1 = Math.max(y1, n.y + n.r);
      }
      if (!Number.isFinite(x0)) return zoomIdentity.translate(w / 2, h / 2);
      const pad = Math.min(80, Math.max(24, Math.min(w, h) * 0.08));
      const k = Math.min(MAX_K, Math.max(MIN_K, Math.min((w - pad * 2) / Math.max(1, x1 - x0), (h - pad * 2) / Math.max(1, y1 - y0), 2.2)));
      return zoomIdentity.translate(w / 2 - ((x0 + x1) / 2) * k, h / 2 - ((y0 + y1) / 2) * k).scale(k);
    },
    [model],
  );

  const applyTransform = useCallback((t: ZoomTransform, animate: boolean) => {
    const canvas = canvasRef.current;
    const z = zoomRef.current;
    if (!canvas || !z) return;
    const sel = select(canvas);
    if (animate && !prefersReducedMotion()) sel.transition().duration(650).call(z.transform, t);
    else sel.call(z.transform, t);
  }, []);

  const visibleIndices = useCallback(() => {
    const out: number[] = [];
    for (let i = 0; i < model.nodes.length; i++) if (vis.nodes[i]) out.push(i);
    return out;
  }, [model, vis]);

  useImperativeHandle(
    ref,
    () => ({
      fit: (indices, animate = true) => applyTransform(transformFor(indices?.length ? indices : visibleIndices()), animate),
      focusNode: (index, animate = true) => {
        const n = model.nodes[index];
        const { w, h } = sizeRef.current;
        const k = Math.max(cameraRef.current.k, 1.6);
        applyTransform(zoomIdentity.translate(w / 2 - n.x * k, h / 2 - n.y * k).scale(k), animate);
      },
      zoomBy: (factor) => {
        const canvas = canvasRef.current;
        if (!canvas || !zoomRef.current) return;
        const sel = select(canvas);
        if (prefersReducedMotion()) sel.call(zoomRef.current.scaleBy, factor);
        else sel.transition().duration(250).call(zoomRef.current.scaleBy, factor);
      },
      centerOn: (x, y) => {
        const { w, h } = sizeRef.current;
        const k = cameraRef.current.k;
        applyTransform(zoomIdentity.translate(w / 2 - x * k, h / 2 - y * k).scale(k), false);
      },
      morphTo: (xs, ys, duration = 720) =>
        new Promise<void>((resolve) => {
          const from = model.nodes.map((n) => [n.x, n.y]);
          const finish = () => {
            model.nodes.forEach((n, i) => {
              n.x = xs[i];
              n.y = ys[i];
            });
            morphRef.current = false;
            draw();
            resolve();
          };
          if (prefersReducedMotion() || duration <= 0) return finish();
          morphRef.current = true;
          const start = performance.now();
          const step = (now: number) => {
            const t = Math.min(1, (now - start) / duration);
            const e = easeInOutCubic(t);
            model.nodes.forEach((n, i) => {
              n.x = from[i][0] + (xs[i] - from[i][0]) * e;
              n.y = from[i][1] + (ys[i] - from[i][1]) * e;
            });
            if (t < 1) {
              rendererRef.current?.draw(
                { model, vis: propsRef.current.vis, hl: propsRef.current.hl, camera: cameraRef.current, selected: null, hovered: null, kbFocus: null, labels: 'none' },
                null,
                now,
              );
              requestAnimationFrame(step);
            } else finish();
          };
          requestAnimationFrame(step);
        }),
      screenOf: (index) => {
        const n = model.nodes[index];
        if (!n) return null;
        const { k, x, y } = cameraRef.current;
        return { x: n.x * k + x, y: n.y * k + y };
      },
      camera: () => cameraRef.current,
      size: () => sizeRef.current,
      toBlob: () => new Promise((resolve) => canvasRef.current?.toBlob(resolve, 'image/png') ?? resolve(null)),
      redraw: draw,
    }),
    [applyTransform, transformFor, visibleIndices, model, draw],
  );

  // Renderer + zoom behaviour setup (d3-zoom handles wheel, drag and pinch).
  useEffect(() => {
    const canvas = canvasRef.current!;
    rendererRef.current = new GraphRenderer(canvas);
    const z = d3zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([MIN_K, MAX_K])
      .filter((event: Event) => interactive && zoomable && (!('button' in event) || (event as MouseEvent).button === 0))
      .on('zoom', (event: { transform: ZoomTransform }) => {
        cameraRef.current = { k: event.transform.k, x: event.transform.x, y: event.transform.y };
        propsRef.current.onCamera?.(cameraRef.current);
        draw();
      });
    zoomRef.current = z;
    select(canvas).call(z).on('dblclick.zoom', null);

    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (!width || !height) return;
      const first = sizeRef.current.w === 0;
      sizeRef.current = { w: width, h: height };
      rendererRef.current!.resize(width, height);
      if (first || fittedRef.current !== propsRef.current.model) {
        fittedRef.current = propsRef.current.model;
        const all: number[] = [];
        propsRef.current.model.nodes.forEach((_, i) => propsRef.current.vis.nodes[i] && all.push(i));
        select(canvas).call(z.transform, transformFor(all));
      }
      draw();
    });
    ro.observe(canvas);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frameRef.current);
      select(canvas).on('.zoom', null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // New graph: fit it and (optionally) play the reveal once.
  useEffect(() => {
    if (sizeRef.current.w && fittedRef.current !== model) {
      fittedRef.current = model;
      applyTransform(transformFor(visibleIndices()), false);
    }
    revealRef.current = props.reveal && !prefersReducedMotion() ? createReveal(model, performance.now()) : null;
    if (props.reveal && !revealRef.current) props.onRevealDone?.();
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  useEffect(() => {
    draw();
  }, [vis, hl, selected, hovered, kbFocus, props.hulls, props.bundle, props.showCycles, props.path, props.cyclePulse, props.geomVersion, draw]);

  const hit = (clientX: number, clientY: number): number | null => {
    if (morphRef.current) return null;
    const rect = canvasRef.current!.getBoundingClientRect();
    const { k, x, y } = cameraRef.current;
    const wx = (clientX - rect.left - x) / k;
    const wy = (clientY - rect.top - y) / k;
    const found = tree.find(wx, wy, maxR * 1.3 + 6 / k);
    if (found === undefined) return null;
    const n = model.nodes[found];
    return Math.hypot(n.x - wx, n.y - wy) <= Math.max(n.r * 1.3, 2.2 / k) + 5 / k ? found : null;
  };

  const down = useRef<{ x: number; y: number } | null>(null);

  return (
    <canvas
      ref={canvasRef}
      className={props.className}
      tabIndex={interactive ? 0 : -1}
      role="application"
      aria-roledescription="dependency graph"
      aria-label={props.ariaLabel}
      aria-describedby={props.ariaDescribedBy}
      style={{ display: 'block', width: '100%', height: '100%', cursor: hovered !== null ? 'pointer' : zoomable ? 'grab' : 'default', touchAction: zoomable ? 'none' : 'auto' }}
      onPointerDown={(e) => (down.current = { x: e.clientX, y: e.clientY })}
      onPointerMove={(e) => {
        if (!interactive || e.buttons) return;
        const i = hit(e.clientX, e.clientY);
        if (i !== propsRef.current.hovered) props.onHover?.(i);
      }}
      onPointerLeave={() => props.onHover?.(null)}
      onClick={(e) => {
        if (!interactive) return;
        const d = down.current;
        if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return; // it was a pan
        props.onSelect?.(hit(e.clientX, e.clientY));
      }}
      onKeyDown={(e) => {
        if (!interactive) return;
        const dirs: Record<string, ArrowDirection> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
        if (dirs[e.key]) {
          e.preventDefault();
          props.onNavigate?.(dirs[e.key]);
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          props.onActivate?.();
        } else if (e.key === 'Escape') {
          props.onEscape?.();
        } else if (e.key === '+' || e.key === '=') {
          e.preventDefault();
          zoomRef.current && select(canvasRef.current!).call(zoomRef.current.scaleBy, 1.4);
        } else if (e.key === '-' || e.key === '_') {
          e.preventDefault();
          zoomRef.current && select(canvasRef.current!).call(zoomRef.current.scaleBy, 1 / 1.4);
        } else if (e.key === '0') {
          e.preventDefault();
          applyTransform(transformFor(visibleIndices()), true);
        }
      }}
    />
  );
});
