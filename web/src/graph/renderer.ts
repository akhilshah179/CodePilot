import { edgeControlPoint, SHAPES, shapePath } from '@codepilot/analyzer/shapes';
import type { NodeType } from '../lib/api.ts';
import { basename, dirname } from '../lib/format.ts';
import type { Hull } from './geometry.ts';
import { hopAlpha, NodeState, PairState, UNRELATED, type GraphModel, type Highlight, type Visibility } from './model.ts';

export interface Camera {
  k: number;
  x: number;
  y: number;
}

/** A highlighted dependency path (path finder), with the time its pulse started. */
export interface PathHighlight {
  pairs: number[];
  nodes: Set<number>;
  start: number;
}

export interface RenderInput {
  model: GraphModel;
  vis: Visibility;
  hl: Highlight;
  camera: Camera;
  selected: number | null;
  hovered: number | null;
  kbFocus: number | null;
  /** 'auto' follows semantic zoom; 'none' draws glyphs only (landing preview). */
  labels: 'auto' | 'none';
  hulls?: Hull[];
  /** Bundle edges between directory clusters through the cluster centres. */
  bundle?: boolean;
  /** Outline every edge that lies on an import cycle. */
  showCycles?: boolean;
  path?: PathHighlight | null;
  /** Cycle members to pulse (after selecting a node in a cycle, or a cycle in the summary). */
  cyclePulse?: { nodes: Set<number>; start: number } | null;
  /** Changes whenever node positions change, to refresh cached geometry. */
  geomVersion?: number;
}

export const COLORS = {
  bg: '#0b0d0a',
  node: '#d4d8cf',
  nodeExternal: '#8b9183',
  text: '#ffffff',
  text2: 'rgba(255,255,255,0.72)',
  text3: 'rgba(255,255,255,0.5)',
  accent: '#ffb020',
  data: '#00d2ff',
  dep: '#ff5c5c',
  con: '#4c9aff',
  risk: '#ef4444',
  warn: '#f59e0b',
  ok: '#10b981',
  unresolved: '#8b9183',
  sweep: '255, 176, 32',
};

/** Semantic zoom thresholds (camera scale). */
export const ZOOM = { mid: 0.9, near: 2.2 };
export type ZoomLevel = 'far' | 'mid' | 'near';
export const zoomLevel = (k: number): ZoomLevel => (k >= ZOOM.near ? 'near' : k >= ZOOM.mid ? 'mid' : 'far');

const NODE_TYPES: NodeType[] = ['page', 'route', 'api', 'component', 'action', 'service', 'utility', 'config', 'other', 'external', 'unresolved'];
const TYPE_BADGE: Record<NodeType, string> = { page: 'page', route: 'route', api: 'api', component: 'component', action: 'action', service: 'service', utility: 'util', config: 'config', other: 'other', external: 'package', unresolved: 'unresolved' };

/**
 * One orchestrated reveal (~3.7 s): directory regions fade in, a radar sweep turns once and
 * activates nodes as it passes (hubs resolve first), edges draw from source to target, and a
 * few signals travel along the most important edges. Nothing animates afterwards.
 */
export const REVEAL = { hullMs: 500, sweepStart: 300, sweepMs: 1600, nodeFadeMs: 260, edgeDelayMs: 120, edgeDrawMs: 520, signalStart: 2500, signalMs: 1100, totalMs: 3700 };

export interface Reveal {
  start: number;
  cx: number;
  cy: number;
  radius: number;
  nodeAt: Float32Array;
  signals: number[];
}

export function createReveal(model: GraphModel, start: number): Reveal {
  let cx = 0, cy = 0;
  for (const n of model.nodes) {
    cx += n.x;
    cy += n.y;
  }
  cx /= Math.max(1, model.nodes.length);
  cy /= Math.max(1, model.nodes.length);
  let radius = 1;
  const nodeAt = new Float32Array(model.nodes.length);
  const hubs = model.nodes.map((n, i) => ({ i, d: n.fanIn + n.fanOut, hub: n.hub })).filter((h) => h.hub).sort((a, b) => b.d - a.d);
  const hubRank = new Map(hubs.map((h, k) => [h.i, k]));
  model.nodes.forEach((n, i) => {
    radius = Math.max(radius, Math.hypot(n.x - cx, n.y - cy));
    // Angle measured clockwise from 12 o'clock, matching the sweep.
    let a = Math.atan2(n.y - cy, n.x - cx) + Math.PI / 2;
    if (a < 0) a += Math.PI * 2;
    const swept = REVEAL.sweepStart + (a / (Math.PI * 2)) * (REVEAL.sweepMs - REVEAL.sweepStart);
    const rank = hubRank.get(i);
    nodeAt[i] = rank !== undefined ? Math.min(swept, REVEAL.sweepStart + rank * 45) : swept;
  });
  const signals = model.pairs
    .map((p, pi) => ({ pi, score: p.resolved ? p.weight + model.nodes[p.s].fanIn + model.nodes[p.t].fanIn : -1 }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map((x) => x.pi);
  return { start, cx, cy, radius, nodeAt, signals };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

type Curve = { x1: number; y1: number; c1x: number; c1y: number; c2x: number; c2y: number; ex: number; ey: number; ux: number; uy: number };

export class GraphRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly unit: Record<NodeType, Path2D>;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private readonly textWidth = new Map<string, number>();
  private centroidKey = '';
  private centroids = new Map<string, [number, number]>();

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.unit = Object.fromEntries(NODE_TYPES.map((t) => [t, new Path2D(shapePath(t, 0, 0, 1))])) as Record<NodeType, Path2D>;
  }

  resize(width: number, height: number) {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.width = width;
    this.height = height;
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
  }

  private measure(text: string, font: string): number {
    const key = font + text;
    let w = this.textWidth.get(key);
    if (w === undefined) {
      this.ctx.font = font;
      w = this.ctx.measureText(text).width;
      this.textWidth.set(key, w);
    }
    return w;
  }

  private clusterCentroids(model: GraphModel, version: number) {
    const key = `${version}:${model.nodes.length}`;
    if (key === this.centroidKey) return this.centroids;
    const sums = new Map<string, [number, number, number]>();
    for (const n of model.nodes) {
      const s = sums.get(n.cluster) ?? [0, 0, 0];
      s[0] += n.x;
      s[1] += n.y;
      s[2]++;
      sums.set(n.cluster, s);
    }
    this.centroids = new Map([...sums].map(([k, [x, y, c]]) => [k, [x / c, y / c]]));
    this.centroidKey = key;
    return this.centroids;
  }

  /** Returns true while an animation (reveal, pulse) is still running and another frame is needed. */
  draw(input: RenderInput, reveal: Reveal | null, now: number): boolean {
    const { ctx, dpr } = this;
    const { model, vis, hl, camera } = input;
    const { k } = camera;
    const level = zoomLevel(k);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, this.width, this.height);
    this.drawGrid(camera);
    if (!model.nodes.length) return false;

    const elapsed = reveal ? now - reveal.start : Infinity;
    const revealing = elapsed < REVEAL.totalMs;
    let animating = revealing;
    const nodeAlpha = (i: number) => (reveal && revealing ? clamp01((elapsed - reveal.nodeAt[i]) / REVEAL.nodeFadeMs) : 1);
    const edgeProgress = (s: number, t: number) =>
      reveal && revealing ? clamp01((elapsed - Math.max(reveal.nodeAt[s], reveal.nodeAt[t]) - REVEAL.edgeDelayMs) / REVEAL.edgeDrawMs) : 1;

    // Viewport in world coordinates, for culling.
    const pad = 40 / k;
    const vx0 = -camera.x / k - pad, vy0 = -camera.y / k - pad;
    const vx1 = (this.width - camera.x) / k + pad, vy1 = (this.height - camera.y) / k + pad;
    const inView = (x: number, y: number) => x >= vx0 && x <= vx1 && y >= vy0 && y <= vy1;

    // --- Directory regions ---------------------------------------------------------------
    if (input.hulls?.length && input.labels !== 'none') {
      const a = reveal && revealing ? clamp01(elapsed / REVEAL.hullMs) : 1;
      this.drawHulls(input, a * (hl.active ? 0.5 : 1), level);
    }

    // --- Edges ---------------------------------------------------------------------------
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * camera.x, dpr * camera.y);
    ctx.lineCap = 'round';
    const bundle = !!input.bundle;
    const centroids = bundle ? this.clusterCentroids(model, input.geomVersion ?? 0) : null;
    const pathSet = input.path ? new Set(input.path.pairs) : null;
    const dense = model.pairs.length > 1500;
    type Bucket = { color: string; alpha: number; width: number; dash: number[]; arrows: boolean; pairs: number[] };
    const buckets = new Map<string, Bucket>();
    const bucket = (key: string, init: () => Bucket) => {
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = init()));
      return b;
    };
    const cycleOutline: number[] = [];
    const cyclePulseActive = input.cyclePulse && now - input.cyclePulse.start < 2400;
    for (let pi = 0; pi < model.pairs.length; pi++) {
      if (!vis.pairs[pi]) continue;
      const p = model.pairs[pi];
      const a = model.nodes[p.s], b = model.nodes[p.t];
      if ((a.x < vx0 && b.x < vx0) || (a.x > vx1 && b.x > vx1) || (a.y < vy0 && b.y < vy0) || (a.y > vy1 && b.y > vy1)) continue;
      const state = hl.pair[pi];
      if (pathSet?.has(pi)) continue; // drawn on top
      // Level of detail: at far zoom on dense graphs, skip weak edges between minor files.
      if (level === 'far' && dense && state === PairState.NORMAL && !hl.active && p.weight <= 1 && a.fanIn + a.fanOut < 3 && b.fanIn + b.fanOut < 3) continue;
      if ((input.showCycles || (input.cyclePulse && input.cyclePulse.nodes.has(p.s) && input.cyclePulse.nodes.has(p.t))) && p.cycle) cycleOutline.push(pi);
      const style = !p.resolved ? 'unresolved' : p.dynamic ? 'dynamic' : 'solid';
      const hop = hl.pairHop[pi];
      const alphaHop = hl.active ? (state === PairState.DIM ? 0.05 : hopAlpha(hop)) : 1;
      const kind = state === PairState.OUTGOING ? 'out' : state === PairState.INCOMING ? 'in' : state === PairState.NORMAL ? 'normal' : 'dim';
      const wb = Math.min(2.4, 0.7 + 0.35 * Math.log2(1 + p.weight));
      const wBand = Math.round(wb * 2) / 2;
      const key = `${kind}|${style}|${wBand}|${alphaHop}`;
      const b2 = bucket(key, () => ({
        color: style === 'unresolved' ? COLORS.unresolved : kind === 'in' ? COLORS.con : COLORS.dep,
        alpha: (kind === 'out' || kind === 'in' ? 0.95 : kind === 'normal' ? (style === 'unresolved' ? 0.5 : 0.3) : 0.05) * alphaHop,
        width: (kind === 'out' || kind === 'in' ? 1.2 : 0.75) * wBand,
        dash: style === 'dynamic' ? [4, 3] : style === 'unresolved' ? [0.5, 3] : [],
        arrows: kind === 'out' || kind === 'in' || (kind === 'normal' && k > 0.45),
        pairs: [],
      }));
      b2.pairs.push(pi);
    }

    const curveOf = (pi: number, unbundled: boolean): Curve => {
      const p = model.pairs[pi];
      const a = model.nodes[p.s], b = model.nodes[p.t];
      const x1 = a.x, y1 = a.y, x2 = b.x, y2 = b.y;
      let c1x: number, c1y: number, c2x: number, c2y: number;
      if (!unbundled && centroids && a.cluster !== b.cluster) {
        // Hierarchical bundling: pull the curve through both clusters' centres.
        const ca = centroids.get(a.cluster)!, cb = centroids.get(b.cluster)!;
        const beta = 0.62;
        c1x = x1 + (ca[0] - x1) * beta;
        c1y = y1 + (ca[1] - y1) * beta;
        c2x = x2 + (cb[0] - x2) * beta;
        c2y = y2 + (cb[1] - y2) * beta;
      } else {
        const [qx, qy] = edgeControlPoint(x1, y1, x2, y2);
        c1x = x1 + ((qx - x1) * 2) / 3;
        c1y = y1 + ((qy - y1) * 2) / 3;
        c2x = x2 + ((qx - x2) * 2) / 3;
        c2y = y2 + ((qy - y2) * 2) / 3;
      }
      // Stop at the target's outline so the arrow tip touches the shape.
      const rt = Math.max(b.r * SHAPES[b.type].scale, 2.2 / k) + 1 / k;
      const tx = x2 - c2x, ty = y2 - c2y;
      const tl = Math.hypot(tx, ty) || 1;
      return { x1, y1, c1x, c1y, c2x, c2y, ex: x2 - (tx / tl) * rt, ey: y2 - (ty / tl) * rt, ux: tx / tl, uy: ty / tl };
    };

    const strokeCurves = (list: number[], color: string, alpha: number, width: number, dash: number[], arrows: boolean, unbundled: boolean, progressOf?: (pi: number) => number) => {
      if (!list.length) return;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = width / k;
      ctx.setLineDash(dash.map((d) => d / k));
      const arrowBatches: Path2D[] = [];
      let arrowPath = new Path2D();
      let inBatch = 0;
      ctx.beginPath();
      for (const pi of list) {
        const c = curveOf(pi, unbundled);
        const prog = progressOf ? progressOf(pi) : 1;
        if (prog <= 0) continue;
        ctx.moveTo(c.x1, c.y1);
        if (prog >= 1) {
          ctx.bezierCurveTo(c.c1x, c.c1y, c.c2x, c.c2y, c.ex, c.ey);
          if (arrows) {
            const L = 6 / k, W = 2.6 / k;
            arrowPath.moveTo(c.ex, c.ey);
            arrowPath.lineTo(c.ex - c.ux * L - c.uy * W, c.ey - c.uy * L + c.ux * W);
            arrowPath.lineTo(c.ex - c.ux * L + c.uy * W, c.ey - c.uy * L - c.ux * W);
            arrowPath.closePath();
            if (++inBatch === 300) {
              arrowBatches.push(arrowPath);
              arrowPath = new Path2D();
              inBatch = 0;
            }
          }
        } else {
          // De Casteljau split draws the first `prog` of the cubic.
          const t = prog;
          const ax = c.x1 + (c.c1x - c.x1) * t, ay = c.y1 + (c.c1y - c.y1) * t;
          const bx = c.c1x + (c.c2x - c.c1x) * t, by = c.c1y + (c.c2y - c.c1y) * t;
          const cx2 = c.c2x + (c.ex - c.c2x) * t, cy2 = c.c2y + (c.ey - c.c2y) * t;
          const dx = ax + (bx - ax) * t, dy = ay + (by - ay) * t;
          const ex2 = bx + (cx2 - bx) * t, ey2 = by + (cy2 - by) * t;
          ctx.bezierCurveTo(ax, ay, dx, dy, dx + (ex2 - dx) * t, dy + (ey2 - dy) * t);
        }
      }
      ctx.globalAlpha = alpha;
      ctx.stroke();
      if (arrows) {
        ctx.setLineDash([]);
        if (inBatch) arrowBatches.push(arrowPath);
        for (const batch of arrowBatches) ctx.fill(batch);
      }
      ctx.globalAlpha = 1;
    };

    // Cycle outlines under the edges: a soft red band, pulsing briefly after a cycle is focused.
    if (cycleOutline.length) {
      const pulse = cyclePulseActive ? 0.35 + 0.35 * Math.sin(((now - input.cyclePulse!.start) / 400) * Math.PI) ** 2 : 0.28;
      strokeCurves(cycleOutline, COLORS.risk, pulse, 4.5, [], false, true);
      if (cyclePulseActive) animating = true;
    }
    const order = ['dim', 'normal', 'in', 'out'];
    const sorted = [...buckets.entries()].sort((a, b) => order.indexOf(a[0].split('|')[0]) - order.indexOf(b[0].split('|')[0]));
    for (const [key, b] of sorted) {
      const highlighted = key.startsWith('out') || key.startsWith('in');
      strokeCurves(b.pairs, b.color, b.alpha, b.width, b.dash, b.arrows, highlighted, reveal && revealing ? (pi) => edgeProgress(model.pairs[pi].s, model.pairs[pi].t) : undefined);
    }
    // Path finder result on top, in the accent colour.
    if (input.path) strokeCurves(input.path.pairs.filter((pi) => vis.pairs[pi] || true), COLORS.accent, 1, 2.4, [], true, true);
    ctx.setLineDash([]);

    // --- Nodes ---------------------------------------------------------------------------
    const back: number[] = [];
    const front: number[] = [];
    for (let i = 0; i < model.nodes.length; i++) {
      const n = model.nodes[i];
      if (!vis.nodes[i] || !inView(n.x, n.y)) continue;
      if (hl.node[i] === NodeState.DIM || hl.node[i] === NodeState.NORMAL) back.push(i);
      else front.push(i);
    }
    for (const i of [...back, ...front]) this.drawNode(input, i, nodeAlpha(i), level);

    // Rings for hover / selection / keyboard focus / path endpoints.
    const rings: [number | null, 'hover' | 'selected' | 'focus' | 'path'][] = [
      [input.hovered, 'hover'],
      [input.selected, 'selected'],
      [input.kbFocus, 'focus'],
    ];
    if (input.path) for (const i of input.path.nodes) rings.push([i, 'path']);
    for (const [i, kind] of rings) {
      if (i === null || !vis.nodes[i]) continue;
      const n = model.nodes[i];
      const sx = n.x * k + camera.x, sy = n.y * k + camera.y;
      const rs = Math.max(n.r * SHAPES[n.type].scale * k, 2.2) + (kind === 'focus' ? 7 : 4);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.beginPath();
      ctx.arc(sx, sy, rs, 0, Math.PI * 2);
      ctx.strokeStyle = COLORS.accent;
      ctx.lineWidth = kind === 'selected' ? 2 : 1.5;
      ctx.setLineDash(kind === 'focus' ? [3, 3] : []);
      ctx.globalAlpha = kind === 'hover' ? 0.8 : kind === 'path' ? 0.7 : 1;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // Path pulse: one dot travelling from source to destination, twice, then still.
    if (input.path?.pairs.length) {
      const per = 380;
      const t = now - input.path.start;
      const total = per * input.path.pairs.length;
      if (t < total * 2) {
        animating = true;
        const local = t % total;
        const idx = Math.min(input.path.pairs.length - 1, Math.floor(local / per));
        const c = curveOf(input.path.pairs[idx], true);
        const u = (local - idx * per) / per;
        const [px, py] = cubicAt(c, u);
        this.drawSignal(px * k + camera.x, py * k + camera.y, COLORS.accent);
      }
    }

    // --- Labels and cards (semantic zoom) -------------------------------------------------
    if (input.labels !== 'none') this.drawLabels(input, nodeAlpha, [...front, ...back], level);

    // --- Reveal overlays -------------------------------------------------------------------
    if (reveal && revealing) {
      const sweepT = elapsed - REVEAL.sweepStart;
      if (sweepT > -1 && sweepT < REVEAL.sweepMs + 400) this.drawSweep(reveal, camera, sweepT);
      if (elapsed > REVEAL.signalStart) {
        reveal.signals.forEach((pi, n) => {
          const local = (elapsed - REVEAL.signalStart - n * 40) / (REVEAL.signalMs - 12 * 40);
          if (local <= 0 || local >= 1) return;
          const [px, py] = cubicAt(curveOf(pi, true), easeOutCubic(local));
          this.drawSignal(px * k + camera.x, py * k + camera.y, COLORS.data, 1 - local * 0.6);
        });
      }
    }
    return animating;
  }

  private drawGrid(camera: Camera) {
    const { ctx } = this;
    const step = 28;
    const ox = ((camera.x % step) + step) % step;
    const oy = ((camera.y % step) + step) % step;
    ctx.fillStyle = 'rgba(255,255,255,0.035)';
    for (let x = ox; x < this.width; x += step) for (let y = oy; y < this.height; y += step) ctx.fillRect(x, y, 1, 1);
  }

  private drawHulls(input: RenderInput, alpha: number, level: ZoomLevel) {
    const { ctx, dpr } = this;
    const { camera } = input;
    ctx.setTransform(dpr * camera.k, 0, 0, dpr * camera.k, dpr * camera.x, dpr * camera.y);
    for (const h of input.hulls!) {
      if (h.points.length < 3) continue;
      ctx.beginPath();
      h.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = 'rgba(255,255,255,0.022)';
      ctx.fill();
      ctx.lineWidth = 1 / camera.k;
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (level === 'near') return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '500 10.5px "IBM Plex Mono", ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (const h of input.hulls!) {
      const sx = h.cx * camera.k + camera.x;
      const sy = h.top * camera.k + camera.y - 4;
      if (sx < -100 || sx > this.width + 100 || sy < 0 || sy > this.height) continue;
      ctx.globalAlpha = alpha * 0.9;
      ctx.fillStyle = COLORS.text3;
      ctx.fillText(`${h.key}/ · ${h.count}`, sx, sy);
    }
    ctx.textAlign = 'left';
    ctx.globalAlpha = 1;
  }

  private drawSweep(reveal: Reveal, camera: Camera, sweepT: number) {
    const { ctx, dpr } = this;
    const k = camera.k;
    const theta = (Math.min(Math.max(sweepT, 0), REVEAL.sweepMs) / REVEAL.sweepMs) * Math.PI * 2 - Math.PI / 2;
    const fade = sweepT > REVEAL.sweepMs ? 1 - (sweepT - REVEAL.sweepMs) / 400 : 1;
    const sx = reveal.cx * k + camera.x, sy = reveal.cy * k + camera.y;
    const R = reveal.radius * k * 1.12 + 20;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const grad = ctx.createConicGradient(theta - 0.9, sx, sy);
    grad.addColorStop(0, `rgba(${COLORS.sweep}, 0)`);
    grad.addColorStop(0.9 / (Math.PI * 2), `rgba(${COLORS.sweep}, ${0.14 * fade})`);
    grad.addColorStop(0.9 / (Math.PI * 2) + 0.0001, `rgba(${COLORS.sweep}, 0)`);
    grad.addColorStop(1, `rgba(${COLORS.sweep}, 0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(sx, sy, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(${COLORS.sweep}, ${0.7 * fade})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + Math.cos(theta) * R, sy + Math.sin(theta) * R);
    ctx.stroke();
    ctx.strokeStyle = `rgba(${COLORS.sweep}, ${0.16 * fade})`;
    for (const f of [0.33, 0.66, 1]) {
      ctx.beginPath();
      ctx.arc(sx, sy, R * f, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private drawSignal(x: number, y: number, color: string, alpha = 1) {
    const { ctx, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = alpha * 0.25;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(x, y, 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  private drawNode(input: RenderInput, i: number, revealAlpha: number, level: ZoomLevel) {
    if (revealAlpha <= 0) return;
    const { ctx, dpr } = this;
    const { camera, hl, model } = input;
    const n = model.nodes[i];
    const state = hl.node[i];
    const rs = Math.max(n.r * camera.k, 2.2);
    const sx = n.x * camera.k + camera.x, sy = n.y * camera.k + camera.y;
    const hopA = hl.active ? (state === NodeState.DIM ? 0.08 : hl.nodeHop[i] === UNRELATED ? 0.08 : hopAlpha(hl.nodeHop[i])) : 1;
    const onPath = input.path?.nodes.has(i);
    const alpha = (onPath ? 1 : hopA) * revealAlpha;
    // Hubs read as hubs: a faint halo at far and mid zoom.
    if (n.hub && level !== 'near') {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalAlpha = alpha * 0.18;
      ctx.fillStyle = COLORS.node;
      ctx.beginPath();
      ctx.arc(sx, sy, rs * 1.9 + 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.setTransform(dpr * rs, 0, 0, dpr * rs, dpr * sx, dpr * sy);
    ctx.globalAlpha = alpha;
    const path = this.unit[n.type];
    const spec = SHAPES[n.type];
    if (spec.filled) {
      ctx.fillStyle = state === NodeState.FOCUS || onPath ? COLORS.accent : COLORS.node;
      ctx.fill(path);
      ctx.lineWidth = 1.2 / rs;
      ctx.strokeStyle = COLORS.bg;
      ctx.stroke(path);
    } else {
      ctx.lineWidth = 1.6 / rs;
      ctx.strokeStyle = n.type === 'unresolved' ? COLORS.risk : state === NodeState.FOCUS ? COLORS.accent : COLORS.nodeExternal;
      ctx.stroke(path);
    }
    // Neighbour rings reinforce edge colours without relying on them alone.
    if (state === NodeState.DEPENDENCY || state === NodeState.CONSUMER || state === NodeState.BOTH) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineWidth = 1.5;
      const ring = rs * spec.scale + 3.5;
      if (state !== NodeState.CONSUMER) {
        ctx.strokeStyle = COLORS.dep;
        ctx.beginPath();
        ctx.arc(sx, sy, ring, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (state !== NodeState.DEPENDENCY) {
        ctx.strokeStyle = COLORS.con;
        ctx.setLineDash(state === NodeState.BOTH ? [3, 3] : []);
        ctx.beginPath();
        ctx.arc(sx, sy, state === NodeState.BOTH ? ring + 3 : ring, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    ctx.globalAlpha = 1;
  }

  private drawLabels(input: RenderInput, alphaOf: (i: number) => number, candidates: number[], level: ZoomLevel) {
    const { ctx, dpr } = this;
    const { camera, hl, model } = input;
    const forced = new Set<number>();
    for (const i of [input.selected, input.hovered, input.kbFocus]) if (i !== null) forced.add(i);
    if (input.path) for (const i of input.path.nodes) forced.add(i);
    const highlightCount = hl.dependencies.size + hl.consumers.size;
    if (hl.active && highlightCount <= 80) {
      for (const [i, d] of hl.dependencies) if (d === 1) forced.add(i);
      for (const [i, d] of hl.consumers) if (d === 1) forced.add(i);
    }
    // Far: only forced labels and hubs. Mid: names. Near: cards where there is room.
    const eligible = level === 'far' ? candidates.filter((i) => forced.has(i) || (model.nodes[i].hub && !hl.active)) : hl.active ? candidates.filter((i) => forced.has(i) || hl.nodeHop[i] <= 2) : candidates;
    eligible.sort((a, b) => Number(forced.has(b)) - Number(forced.has(a)) || model.nodes[b].fanIn + model.nodes[b].fanOut - (model.nodes[a].fanIn + model.nodes[a].fanOut));

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textBaseline = 'middle';
    const CELL = 96;
    const grid = new Map<number, number[][]>();
    const cells = (x: number, y: number, w: number, h: number) => {
      const out: number[] = [];
      for (let cx = Math.floor(x / CELL); cx <= Math.floor((x + w) / CELL); cx++) for (let cy = Math.floor(y / CELL); cy <= Math.floor((y + h) / CELL); cy++) out.push(cx * 100003 + cy);
      return out;
    };
    const free = (x: number, y: number, w: number, h: number) => !cells(x, y, w, h).some((key) => grid.get(key)?.some(([bx, by, bw, bh]) => x < bx + bw && x + w > bx && y < by + bh && y + h > by));
    const occupy = (x: number, y: number, w: number, h: number) => {
      const box = [x, y, w, h];
      for (const key of cells(x, y, w, h)) {
        const list = grid.get(key);
        if (list) list.push(box);
        else grid.set(key, [box]);
      }
    };
    // Node glyphs occupy their own space so labels do not cover them.
    let count = 0;
    for (const i of eligible) {
      if (count > 380) break;
      const n = model.nodes[i];
      const sx = n.x * camera.k + camera.x;
      const sy = n.y * camera.k + camera.y;
      const rs = Math.max(n.r * camera.k, 2.2) * SHAPES[n.type].scale;
      const isForced = forced.has(i);
      const dimmed = hl.active && !isForced && hl.node[i] === NodeState.DIM;
      const alpha = alphaOf(i) * (dimmed ? 0.15 : hl.active && !isForced ? hopAlpha(hl.nodeHop[i]) : 1);
      if (level === 'near') {
        const w = 200, h = 92;
        const bx = sx + rs + 8, by = sy - h / 2;
        if (bx > this.width || by > this.height || bx + w < 0 || by + h < 0) continue;
        if (free(bx, by, w, h)) {
          occupy(bx, by, w, h);
          this.drawCard(input, i, bx, by, w, h, alpha, isForced);
          count++;
          continue;
        }
      }
      const text = n.type === 'external' || n.type === 'unresolved' ? n.path : basename(n.path);
      const font = '500 11px "IBM Plex Mono", ui-monospace, monospace';
      const tw = this.measure(text, font);
      const badge = level === 'far' ? '' : TYPE_BADGE[n.type];
      const counts = level === 'far' ? '' : `${n.fanOut}↗ ${n.fanIn}↙`;
      const bw = tw + 8 + (badge ? this.measure(badge, '500 9px "IBM Plex Mono", monospace') + 12 : 0) + (counts ? this.measure(counts, '500 10px "IBM Plex Mono", monospace') + 8 : 0);
      const bx = sx + rs + 5, by = sy - 9, bh = 18;
      if (bx > this.width || by > this.height || bx + bw < 0 || by + bh < 0) continue;
      if (!free(bx, by, bw, bh)) continue;
      occupy(bx, by, bw, bh);
      count++;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = 'rgba(11, 13, 10, 0.86)';
      roundRect(ctx, bx - 3, by, bw, bh, 3);
      ctx.fill();
      ctx.font = font;
      ctx.fillStyle = i === input.selected ? COLORS.accent : isForced ? COLORS.text : COLORS.text2;
      ctx.fillText(text, bx, sy);
      let x = bx + tw + 8;
      if (badge) {
        ctx.font = '500 9px "IBM Plex Mono", monospace';
        const w = this.measure(badge, ctx.font) + 8;
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.lineWidth = 1;
        roundRect(ctx, x - 2, sy - 6.5, w, 13, 2.5);
        ctx.stroke();
        ctx.fillStyle = COLORS.text3;
        ctx.fillText(badge, x + 2, sy + 0.5);
        x += w + 6;
      }
      if (counts) {
        ctx.font = '500 10px "IBM Plex Mono", monospace';
        const out = `${n.fanOut}↗`;
        ctx.fillStyle = COLORS.dep;
        ctx.fillText(out, x, sy);
        ctx.fillStyle = COLORS.con;
        ctx.fillText(` ${n.fanIn}↙`, x + this.measure(out, ctx.font), sy);
      }
    }
    ctx.globalAlpha = 1;
  }

  /** Near-zoom file card: path, language, LOC, first exports, complexity and health. */
  private drawCard(input: RenderInput, i: number, x: number, y: number, w: number, h: number, alpha: number, forced: boolean) {
    const { ctx } = this;
    const { model } = input;
    const n = model.nodes[i];
    const health = model.health(i);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(16, 19, 15, 0.94)';
    roundRect(ctx, x, y, w, h, 6);
    ctx.fill();
    ctx.strokeStyle = i === input.selected ? COLORS.accent : forced ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 1;
    ctx.stroke();
    const px = x + 10;
    let py = y + 15;
    ctx.textBaseline = 'middle';
    ctx.font = '600 12px "Inter Variable", Inter, system-ui, sans-serif';
    ctx.fillStyle = COLORS.text;
    ctx.fillText(clip(basename(n.path), 22), px, py);
    ctx.font = '500 9px "IBM Plex Mono", monospace';
    const badge = TYPE_BADGE[n.type];
    const bw = this.measure(badge, ctx.font) + 8;
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    roundRect(ctx, x + w - bw - 8, py - 6.5, bw, 13, 2.5);
    ctx.stroke();
    ctx.fillStyle = COLORS.text3;
    ctx.fillText(badge, x + w - bw - 4, py + 0.5);
    py += 15;
    ctx.font = '400 10px "IBM Plex Mono", monospace';
    ctx.fillStyle = COLORS.text3;
    ctx.fillText(clipStart(dirname(n.path) || '(root)', 30), px, py);
    py += 14;
    ctx.fillStyle = COLORS.text2;
    ctx.fillText(`${n.language}${n.loc !== undefined ? ` · ${n.loc} LOC` : ''} · ${n.fanOut}↗ ${n.fanIn}↙`, px, py);
    py += 14;
    ctx.fillStyle = n.exportsPreview.length ? COLORS.text2 : COLORS.text3;
    ctx.fillText(clip(n.exportsPreview.length ? `exports ${n.exportsPreview.join(', ')}${n.exportCount > 3 ? ` +${n.exportCount - 3}` : ''}` : n.analyzed ? 'no exports' : 'not parsed', 30), px, py);
    py += 16;
    // Complexity pips: McCabe max per function (1–5 low, ≤10, ≤20, ≤30, >30).
    const cx = n.complexity?.max ?? 0;
    const level = !n.complexity ? 0 : cx <= 5 ? 1 : cx <= 10 ? 2 : cx <= 20 ? 3 : cx <= 30 ? 4 : 5;
    for (let p = 0; p < 5; p++) {
      ctx.fillStyle = p < level ? (level >= 4 ? COLORS.risk : level === 3 ? COLORS.warn : COLORS.node) : 'rgba(255,255,255,0.12)';
      ctx.fillRect(px + p * 7, py - 3, 5, 6);
    }
    ctx.fillStyle = COLORS.text3;
    ctx.fillText(n.complexity ? `cx ${cx}` : 'cx —', px + 38, py);
    // Health: only conditions the graph shows.
    const chips: [string, string][] = [];
    if (health.cycle) chips.push(['cycle', COLORS.risk]);
    if (health.orphan) chips.push(['orphan', COLORS.warn]);
    if (health.highFanIn) chips.push(['fan-in', COLORS.data]);
    if (health.highFanOut) chips.push(['fan-out', COLORS.data]);
    let hx = px + 78;
    if (!chips.length && n.analyzed) chips.push(['no issues', COLORS.ok]);
    for (const [label, color] of chips) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(hx + 3, py, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = COLORS.text2;
      ctx.fillText(label, hx + 9, py);
      hx += this.measure(label, ctx.font) + 18;
      if (hx > x + w - 20) break;
    }
    ctx.globalAlpha = 1;
  }
}

function cubicAt(c: Curve, t: number): [number, number] {
  const u = 1 - t;
  return [
    u * u * u * c.x1 + 3 * u * u * t * c.c1x + 3 * u * t * t * c.c2x + t * t * t * c.ex,
    u * u * u * c.y1 + 3 * u * u * t * c.c1y + 3 * u * t * t * c.c2y + t * t * t * c.ey,
  ];
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const clipStart = (s: string, n: number) => (s.length > n ? '…' + s.slice(s.length - n + 1) : s);
