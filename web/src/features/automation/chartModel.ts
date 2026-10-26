import type { AutoEdge, AutoNode } from '@codepilot/analyzer/automation/types';
import type { FlowLayout } from '@codepilot/analyzer/automation/layout';

/*
 * Pure logic behind the flowchart canvas: zoom levels, view transforms, path highlighting,
 * collapsed branches and token playback. No DOM, so it is unit-tested directly.
 */

export interface View {
  x: number;
  y: number;
  k: number;
}

export const MIN_K = 0.15;
export const MAX_K = 2.5;
export const DEFAULT_K = 0.85;

/**
 * Semantic zoom. Card text is 16px in world units, so it stays ≥ 11px on screen down to 0.7×;
 * below that only the title is shown (28px world → ≥ 11px down to 0.4×); below 0.4× nodes are
 * typed shapes and titles appear on hover.
 */
export type ZoomLevel = 'full' | 'title' | 'shape';
export function zoomLevel(k: number): ZoomLevel {
  return k >= 0.7 ? 'full' : k >= 0.4 ? 'title' : 'shape';
}

export const clampK = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k));

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function boundsOf(boxes: Box[]): Box {
  if (!boxes.length) return { x: 0, y: 0, w: 1, h: 1 };
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The view that fits `b` into a viewport of `vw`×`vh` with padding, capped at `maxK`. */
export function fitView(b: Box, vw: number, vh: number, pad = 48, maxK = 1.2, widthOnly = false): View {
  const kx = (vw - pad * 2) / Math.max(1, b.w);
  const ky = (vh - pad * 2) / Math.max(1, b.h);
  const k = clampK(Math.min(maxK, widthOnly ? kx : Math.min(kx, ky)));
  return { k, x: vw / 2 - (b.x + b.w / 2) * k, y: widthOnly ? pad - b.y * k : vh / 2 - (b.y + b.h / 2) * k };
}

/**
 * The default view: 0.85× with the trigger near the left edge (or the top in a vertical layout).
 * Across the flow, the whole content is centred when it fits; otherwise the trigger is.
 */
export function anchorView(trigger: Box, vw: number, vh: number, k = DEFAULT_K, vertical = false, content?: Box): View {
  if (vertical) {
    const x = content && content.w * k < vw - 80 ? vw / 2 - (content.x + content.w / 2) * k : vw / 2 - (trigger.x + trigger.w / 2) * k;
    return { k, x, y: 40 - trigger.y * k };
  }
  const y = content && content.h * k < vh - 80 ? vh / 2 - (content.y + content.h / 2) * k : vh / 2 - (trigger.y + trigger.h / 2) * k;
  return { k, x: 40 - trigger.x * k, y };
}

/** Zoom by `factor` keeping the screen point (px, py) fixed. */
export function zoomAt(v: View, factor: number, px: number, py: number): View {
  const k = clampK(v.k * factor);
  const f = k / v.k;
  return { k, x: px - (px - v.x) * f, y: py - (py - v.y) * f };
}

/** Keep at least `margin` px of the content on screen, so the flow can always be reached. */
export function clampView(v: View, content: Box, vw: number, vh: number, margin = 80): View {
  const left = content.x * v.k + v.x;
  const right = (content.x + content.w) * v.k + v.x;
  const top = content.y * v.k + v.y;
  const bottom = (content.y + content.h) * v.k + v.y;
  let { x, y } = v;
  if (right < margin) x += margin - right;
  if (left > vw - margin) x -= left - (vw - margin);
  if (bottom < margin) y += margin - bottom;
  if (top > vh - margin) y -= top - (vh - margin);
  return { ...v, x, y };
}

/** Whether any node box is visible in the viewport. */
export function anyVisible(v: View, boxes: Box[], vw: number, vh: number): boolean {
  return boxes.some((b) => b.x * v.k + v.x < vw && (b.x + b.w) * v.k + v.x > 0 && b.y * v.k + v.y < vh && (b.y + b.h) * v.k + v.y > 0);
}

/* ------------------------------------------------------------------ paths */

export function adjacency(edges: AutoEdge[]) {
  const out = new Map<string, AutoEdge[]>();
  const inn = new Map<string, AutoEdge[]>();
  for (const e of edges) {
    out.set(e.source, [...(out.get(e.source) ?? []), e]);
    inn.set(e.target, [...(inn.get(e.target) ?? []), e]);
  }
  return { out, inn };
}

/** Nodes and edges upstream and downstream of `id` (the selection's whole path). */
export function pathThrough(id: string, edges: AutoEdge[]): { nodes: Set<string>; edges: Set<string> } {
  const { out, inn } = adjacency(edges);
  const nodes = new Set([id]);
  const es = new Set<string>();
  const walk = (start: string, dir: Map<string, AutoEdge[]>, next: (e: AutoEdge) => string) => {
    const stack = [start];
    const seen = new Set([start]);
    while (stack.length) {
      for (const e of dir.get(stack.pop()!) ?? []) {
        es.add(e.id);
        const n = next(e);
        nodes.add(n);
        if (!seen.has(n)) (seen.add(n), stack.push(n));
      }
    }
  };
  walk(id, out, (e) => e.target);
  walk(id, inn, (e) => e.source);
  return { nodes, edges: es };
}

/** Nodes under `id` (descendants), for "Focus branch". */
export function descendants(id: string, edges: AutoEdge[]): Set<string> {
  const { out } = adjacency(edges);
  const seen = new Set([id]);
  const stack = [id];
  while (stack.length) for (const e of out.get(stack.pop()!) ?? []) if (!seen.has(e.target)) (seen.add(e.target), stack.push(e.target));
  return seen;
}

/**
 * Collapsing a decision hides what only its exit branch leads to; nodes still reachable from the
 * trigger without passing through a collapsed exit stay visible (branches that rejoin).
 */
export function hiddenByCollapse(nodes: AutoNode[], edges: AutoEdge[], collapsed: Set<string>): Set<string> {
  if (!collapsed.size) return new Set();
  const trigger = nodes.find((n) => n.type === 'trigger') ?? nodes[0];
  const isExit = (e: AutoEdge) => collapsed.has(e.source) && (e.kind === 'true' || e.kind === 'false' || e.kind === 'error') && nodes.find((n) => n.id === e.target)?.type === 'end';
  const { out } = adjacency(edges.filter((e) => !isExit(e) && !(collapsed.has(e.source) && e.kind === 'group')));
  const seen = new Set<string>();
  const stack = trigger ? [trigger.id] : [];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of out.get(id) ?? []) stack.push(e.target);
  }
  return new Set(nodes.filter((n) => !seen.has(n.id)).map((n) => n.id));
}

/* ------------------------------------------------------------------ playback */

export interface Playback {
  /** Nodes tokens are on now. */
  tokens: string[];
  visitedNodes: Set<string>;
  visitedEdges: Set<string>;
  /** A decision waiting for the reader to choose a branch. */
  waiting: string | null;
  done: boolean;
}

export function startPlayback(nodes: AutoNode[]): Playback {
  const t = nodes.find((n) => n.type === 'trigger') ?? nodes[0];
  return { tokens: t ? [t.id] : [], visitedNodes: new Set(t ? [t.id] : []), visitedEdges: new Set(), waiting: null, done: !t };
}

/**
 * One step: every token moves along its outgoing edges. Async edges fork a parallel token. At a
 * decision the token waits for a choice unless `allPaths` (then both branches run). Group and
 * jump edges are not followed.
 */
export function stepPlayback(p: Playback, nodes: AutoNode[], edges: AutoEdge[], opts: { allPaths: boolean; choice?: string }): Playback {
  if (p.done) return p;
  const { out } = adjacency(edges.filter((e) => e.kind !== 'group' && e.kind !== 'jump'));
  const type = (id: string) => nodes.find((n) => n.id === id)?.type;
  const next: string[] = [];
  const visitedNodes = new Set(p.visitedNodes);
  const visitedEdges = new Set(p.visitedEdges);
  let waiting: string | null = null;
  for (const id of p.tokens) {
    let outs = out.get(id) ?? [];
    if (type(id) === 'decision' && outs.length > 1 && !opts.allPaths) {
      const chosen = opts.choice && p.waiting === id ? outs.find((e) => e.id === opts.choice) : undefined;
      if (!chosen) {
        waiting = id;
        next.push(id);
        continue;
      }
      outs = [chosen];
    }
    for (const e of outs) {
      visitedEdges.add(e.id);
      visitedNodes.add(e.target);
      if (!next.includes(e.target)) next.push(e.target);
    }
  }
  const moving = next.filter((id) => (out.get(id) ?? []).length > 0 || id === waiting);
  return { tokens: next, visitedNodes, visitedEdges, waiting, done: !moving.length && !waiting };
}

/* ------------------------------------------------------------------ geometry */

/** An orthogonal polyline with rounded corners, as an SVG path. */
export function roundedPath(points: [number, number][], r = 10): string {
  if (points.length < 2) return '';
  let d = `M${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    const [x2, y2] = points[i + 1];
    const d1 = Math.hypot(x1 - x0, y1 - y0);
    const d2 = Math.hypot(x2 - x1, y2 - y1);
    const rr = Math.min(r, d1 / 2, d2 / 2);
    const ax = x1 - ((x1 - x0) / (d1 || 1)) * rr;
    const ay = y1 - ((y1 - y0) / (d1 || 1)) * rr;
    const bx = x1 + ((x2 - x1) / (d2 || 1)) * rr;
    const by = y1 + ((y2 - y1) / (d2 || 1)) * rr;
    d += ` L${ax} ${ay} Q${x1} ${y1} ${bx} ${by}`;
  }
  const last = points[points.length - 1];
  return `${d} L${last[0]} ${last[1]}`;
}

/** A point at fraction `t` along a polyline, for the playback token. */
export function pointAlong(points: [number, number][], t: number): [number, number] {
  const segs = points.slice(1).map((p, i) => Math.hypot(p[0] - points[i][0], p[1] - points[i][1]));
  const total = segs.reduce((a, b) => a + b, 0) || 1;
  let left = Math.max(0, Math.min(1, t)) * total;
  for (let i = 0; i < segs.length; i++) {
    if (left <= segs[i] || i === segs.length - 1) {
      const f = segs[i] ? left / segs[i] : 0;
      return [points[i][0] + (points[i + 1][0] - points[i][0]) * f, points[i][1] + (points[i + 1][1] - points[i][1]) * f];
    }
    left -= segs[i];
  }
  return points[points.length - 1];
}

/** Layout is usable: finite coordinates and, for several nodes, more than one column. */
export function layoutOk(layout: FlowLayout): boolean {
  const ps = Object.values(layout.nodes);
  if (ps.some((p) => ![p.x, p.y].every(Number.isFinite))) return false;
  if (ps.length > 1 && new Set(ps.map((p) => (layout.options.direction === 'LR' ? p.x : p.y))).size === 1) return false;
  return true;
}
