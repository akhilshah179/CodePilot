import type { GraphModel, Visibility } from './model.ts';
import { categoryOf, CATEGORY_COLORS, CATEGORY_LABELS, isDefaultThread, polar, splinePath, threadSpline, type RingCategory, type RingLayout } from './ring.ts';

/*
 * Canvas renderer for the Wireframe ring. Threads are drawn in world space from cached Path2D
 * splines, batched by style and weight; ticks, bands and labels are drawn in screen space so they
 * stay crisp at every zoom. Nothing animates unless the view is changing (load sequence, focus
 * transitions) — an idle ring costs no frames.
 */

export interface RingCamera {
  k: number;
  x: number;
  y: number;
}

export interface RingOptions {
  /** Draw dependencies between files in the same category. */
  showIntra: boolean;
  /** Ignore the default noise reduction (intra-category and weight threshold). */
  showAll: boolean;
  /** Minimum imported-symbol weight for a thread to be drawn by default. */
  threshold: number;
}

export interface RingState {
  vis: Visibility;
  options: RingOptions;
  /** Hovered or locked file. */
  focus: number | null;
  locked: number | null;
  arc: RingCategory | null;
  /** With `arc`: only threads from that category into this one. */
  arcTarget: RingCategory | null;
  isolated: number | null;
  kbFocus: number | null;
  hoverPair: number | null;
  /** 0 → 1 transition into the current focus state. */
  mix: number;
  /** Milliseconds into the load sequence; null once it has finished. */
  reveal: number | null;
}

export type LabelLevel = 'ticks' | 'names' | 'detail';

const DEP = '255, 92, 92';
const CON = '76, 154, 255';
const UNRES = '160, 160, 160';
const BASE_ALPHA = [0.12, 0.2, 0.32];
const BASE_WIDTH = [0.75, 1.2, 1.9];
const HI_WIDTH = [1.3, 1.9, 2.7];
const DIM_ALPHA = 0.07;
export const REVEAL_MS = 2700;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const ease = (t: number) => 1 - Math.pow(1 - clamp01(t), 3);

export function labelLevel(L: RingLayout, k: number): LabelLevel {
  const spacing = L.step * L.R * k;
  return spacing < 10 ? 'ticks' : spacing < 24 ? 'names' : 'detail';
}

export function tierOf(weight: number): 0 | 1 | 2 {
  return weight >= 4 ? 2 : weight >= 2 ? 1 : 0;
}

export class RingRenderer {
  private paths: (Path2D | undefined)[];
  private ends: Float64Array;
  private buckets: { style: number; tier: number; path: Path2D; pairs: number[] }[] = [];
  private bucketKey = '';
  /** Pairs drawn in the default (unfocused) state. */
  base = new Uint8Array(0);
  readonly inter: Uint8Array;
  readonly style: Uint8Array;
  readonly tier: Uint8Array;
  /** Both ends are on the ring (external packages are not). */
  readonly onRing: Uint8Array;

  constructor(
    private ctx: CanvasRenderingContext2D,
    readonly model: GraphModel,
    readonly L: RingLayout,
  ) {
    const n = model.pairs.length;
    this.paths = new Array(n);
    this.ends = new Float64Array(n * 3).fill(NaN);
    this.inter = new Uint8Array(n);
    this.style = new Uint8Array(n);
    this.tier = new Uint8Array(n);
    this.onRing = new Uint8Array(n);
    model.pairs.forEach((p, i) => {
      this.onRing[i] = !Number.isNaN(L.angle[p.s]) && !Number.isNaN(L.angle[p.t]) ? 1 : 0;
      const tt = model.nodes[p.t].type;
      this.inter[i] = categoryOf(model.nodes[p.s].type) !== categoryOf(tt) ? 1 : 0;
      this.style[i] = !p.resolved || tt === 'unresolved' ? 2 : p.dynamic ? 1 : 0;
      this.tier[i] = tierOf(p.weight);
    });
  }

  /** Cached spline for a pair (computed on first use). */
  path(pi: number): Path2D {
    let p = this.paths[pi];
    if (!p) {
      const pair = this.model.pairs[pi];
      const sp = threadSpline(this.L, this.model, pair.s, pair.t);
      p = splinePath(sp);
      this.paths[pi] = p;
      this.ends[pi * 3] = sp.end[0];
      this.ends[pi * 3 + 1] = sp.end[1];
      this.ends[pi * 3 + 2] = sp.endAngle;
    }
    return p;
  }

  private end(pi: number): [number, number, number] {
    if (Number.isNaN(this.ends[pi * 3])) this.path(pi);
    return [this.ends[pi * 3], this.ends[pi * 3 + 1], this.ends[pi * 3 + 2]];
  }

  /** Which pairs the default view draws: visible, and past the noise filters unless "show all". */
  defaultPair(pi: number, vis: Visibility, o: RingOptions): boolean {
    return isDefaultThread(this.model, this.L, pi, vis, o);
  }

  private rebuild(vis: Visibility, o: RingOptions) {
    const key = `${o.showIntra}|${o.showAll}|${o.threshold}`;
    if (this.bucketKey === key && this.base.length === this.model.pairs.length && this.lastVis === vis) return;
    this.bucketKey = key;
    this.lastVis = vis;
    this.base = new Uint8Array(this.model.pairs.length);
    const map = new Map<number, { style: number; tier: number; path: Path2D; pairs: number[] }>();
    this.model.pairs.forEach((_, pi) => {
      if (!this.defaultPair(pi, vis, o)) return;
      this.base[pi] = 1;
      const k = this.style[pi] * 3 + this.tier[pi];
      let b = map.get(k);
      if (!b) {
        b = { style: this.style[pi], tier: this.tier[pi], path: new Path2D(), pairs: [] };
        map.set(k, b);
      }
      b.path.addPath(this.path(pi));
      b.pairs.push(pi);
    });
    // Light threads first so heavy ones sit on top.
    this.buckets = [...map.values()].sort((a, b) => a.tier - b.tier || b.style - a.style);
  }
  private lastVis: Visibility | null = null;

  baseCount(): number {
    let c = 0;
    for (let i = 0; i < this.base.length; i++) c += this.base[i];
    return c;
  }

  /** Nodes and pairs emphasised by the current focus (file, arc or isolation). */
  emphasis(s: RingState): { nodes: Set<number>; out: number[]; in: number[] } | null {
    const { model } = this;
    const f = s.isolated ?? s.focus;
    if (f !== null) {
      const out = model.outPairs[f].filter((pi) => s.vis.pairs[pi] && this.onRing[pi]);
      const inn = model.inPairs[f].filter((pi) => s.vis.pairs[pi] && this.onRing[pi]);
      const nodes = new Set<number>([f]);
      for (const pi of out) nodes.add(model.pairs[pi].t);
      for (const pi of inn) nodes.add(model.pairs[pi].s);
      return { nodes, out, in: inn };
    }
    if (s.arc) {
      const out: number[] = [];
      const inn: number[] = [];
      const nodes = new Set<number>();
      model.pairs.forEach((p, pi) => {
        if (!s.vis.pairs[pi] || !this.onRing[pi]) return;
        const sIn = categoryOf(model.nodes[p.s].type) === s.arc;
        const tIn = categoryOf(model.nodes[p.t].type) === s.arc;
        if (s.arcTarget) {
          if (!sIn || categoryOf(model.nodes[p.t].type) !== s.arcTarget) return;
          out.push(pi);
          nodes.add(p.s);
          nodes.add(p.t);
          return;
        }
        if (!sIn && !tIn) return;
        if (!this.base[pi] && !(sIn && tIn && s.options.showIntra) && !this.inter[pi]) return;
        if (sIn) out.push(pi);
        else inn.push(pi);
        nodes.add(p.s);
        nodes.add(p.t);
      });
      return { nodes, out, in: inn };
    }
    return null;
  }

  draw(cam: RingCamera, w: number, h: number, dpr: number, s: RingState) {
    const { ctx, L, model } = this;
    this.rebuild(s.vis, s.options);
    const em = this.emphasis(s);
    const isoNodes = s.isolated !== null ? em?.nodes : null;
    const shown = (i: number) => s.vis.nodes[i] === 1 && !Number.isNaN(L.angle[i]) && (!isoNodes || isoNodes.has(i));
    const t = s.reveal;
    const phase = (from: number, len: number) => (t === null ? 1 : ease((t - from) / len));
    const mix = s.mix;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const Rs = L.R * cam.k;
    const cx = cam.x;
    const cy = cam.y;

    // Guide circle: draws itself first in the load sequence.
    const circleP = phase(0, 450);
    ctx.beginPath();
    ctx.arc(cx, cy, Rs, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * circleP);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Threads (world space).
    ctx.setTransform(dpr * cam.k, 0, 0, dpr * cam.k, dpr * cx, dpr * cy);
    ctx.lineCap = 'round';
    const inv = 1 / cam.k;
    const majorP = phase(1250, 600);
    const minorP = phase(1800, 650);
    const threadsP = (tier: number) => (tier >= 1 ? majorP : minorP);
    const dimmed = em !== null;
    if (!isoNodes) {
      for (const b of this.buckets) {
        const alpha = (dimmed ? BASE_ALPHA[b.tier] + (DIM_ALPHA - BASE_ALPHA[b.tier]) * mix : BASE_ALPHA[b.tier]) * threadsP(b.tier);
        if (alpha <= 0.002) continue;
        const color = b.style === 2 ? UNRES : DEP;
        ctx.strokeStyle = `rgba(${color}, ${alpha})`;
        ctx.lineWidth = BASE_WIDTH[b.tier] * inv;
        ctx.setLineDash(b.style === 1 ? [5 * inv, 4 * inv] : b.style === 2 ? [1.2 * inv, 3.2 * inv] : []);
        ctx.stroke(b.path);
        if (!dimmed || mix < 1) this.arrows(b.pairs, `rgba(${color}, ${Math.min(1, alpha * 1.6)})`, inv, 4 + b.tier);
      }
      ctx.setLineDash([]);
    }
    if (em) {
      const a = isoNodes ? 1 : mix;
      const drawSet = (pairs: number[], color: string) => {
        for (const pi of pairs) {
          const tier = this.tier[pi];
          const st = this.style[pi];
          const hovered = s.hoverPair === pi;
          const c = st === 2 ? UNRES : color;
          ctx.strokeStyle = `rgba(${c}, ${(hovered ? 1 : 0.85) * a})`;
          ctx.lineWidth = (HI_WIDTH[tier] + (hovered ? 1.2 : 0)) * inv;
          ctx.setLineDash(st === 1 ? [6 * inv, 4 * inv] : st === 2 ? [1.4 * inv, 3.4 * inv] : []);
          ctx.stroke(this.path(pi));
        }
        ctx.setLineDash([]);
      };
      drawSet(em.in, CON);
      drawSet(em.out, DEP);
      this.arrows(em.in, `rgba(${CON}, ${a})`, inv, 6.5, (pi) => this.style[pi] === 2);
      this.arrows(em.out, `rgba(${DEP}, ${a})`, inv, 6.5, (pi) => this.style[pi] === 2);
      this.arrows([...em.in, ...em.out].filter((pi) => this.style[pi] === 2), `rgba(${UNRES}, ${a})`, inv, 6.5);
    }

    // Screen space: category bands, ticks and labels.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bandIn = Rs + 9;
    const bandOut = Rs + 23;
    const sweep = t === null ? Infinity : ((t - 250) / 900) * Math.PI * 2;
    ctx.textBaseline = 'middle';
    for (const arc of L.arcs) {
      const end = Math.min(arc.end, sweep);
      if (end <= arc.start) continue;
      const visibleCount = arc.members.filter(shown).length;
      const active = s.arc === arc.category;
      const faded = visibleCount === 0 || (em && !active && !arc.members.some((i) => em.nodes.has(i)));
      ctx.beginPath();
      ctx.arc(cx, cy, (bandIn + bandOut) / 2, arc.start - Math.PI / 2, end - Math.PI / 2);
      ctx.strokeStyle = hexA(CATEGORY_COLORS[arc.category], active ? 0.42 : faded ? 0.07 : 0.17);
      ctx.lineWidth = bandOut - bandIn;
      ctx.lineCap = 'butt';
      ctx.stroke();
      if (end < arc.end) continue;
      const label = `${CATEGORY_LABELS[arc.category].toUpperCase()}  ${visibleCount === arc.members.length ? arc.members.length : `${visibleCount}/${arc.members.length}`}`;
      ctx.font = '600 9.5px "Inter Variable", Inter, system-ui, sans-serif';
      const fits = ctx.measureText(label).width + 10 < (arc.end - arc.start) * ((bandIn + bandOut) / 2);
      const short = String(visibleCount);
      ctx.fillStyle = active ? '#fff' : faded ? 'rgba(255,255,255,0.3)' : hexA(CATEGORY_COLORS[arc.category], 0.95);
      if (fits) arcText(ctx, label, cx, cy, (bandIn + bandOut) / 2, (arc.start + arc.end) / 2);
      else if (ctx.measureText(short).width + 4 < (arc.end - arc.start) * ((bandIn + bandOut) / 2)) arcText(ctx, short, cx, cy, (bandIn + bandOut) / 2, (arc.start + arc.end) / 2);
    }

    // Ticks.
    const tickSweep = t === null ? Infinity : ((t - 500) / 900) * Math.PI * 2;
    const level = labelLevel(L, cam.k);
    const tickLen = level === 'ticks' ? 5 : 7;
    for (const i of L.order) {
      if (!shown(i)) continue;
      const a = L.angle[i];
      if (a > tickSweep) continue;
      const cat = categoryOf(model.nodes[i].type);
      const related = em?.nodes.has(i);
      const focusNode = i === (s.isolated ?? s.focus);
      const alpha = em ? (related ? 1 : 0.9 - 0.7 * mix) : 0.85;
      const [ux, uy] = polar(a, 1);
      const r0 = Rs - (related ? 2 : 0);
      const r1 = Rs + tickLen + (related ? 2 : 0);
      ctx.beginPath();
      ctx.moveTo(cx + ux * r0, cy + uy * r0);
      ctx.lineTo(cx + ux * r1, cy + uy * r1);
      ctx.strokeStyle = focusNode ? '#ffb020' : hexA(CATEGORY_COLORS[cat], alpha);
      ctx.lineWidth = focusNode ? 3 : related ? 2.2 : level === 'ticks' ? 1.2 : 1.6;
      ctx.lineCap = 'round';
      ctx.stroke();
      if (focusNode || i === s.kbFocus) {
        ctx.beginPath();
        ctx.arc(cx + ux * (Rs - 7), cy + uy * (Rs - 7), focusNode ? 3.2 : 2.6, 0, Math.PI * 2);
        ctx.fillStyle = focusNode ? '#ffb020' : '#fff';
        ctx.fill();
      }
    }

    // Labels (semantic zoom): names at medium zoom, names + metadata when close; the focused
    // neighbourhood is always labelled.
    if (t === null || t > 1500) {
      const labelAlpha = t === null ? 1 : clamp01((t - 1500) / 500);
      const margin = 160;
      const onScreen = (a: number, r: number) => {
        const x = cx + Math.sin(a) * r;
        const y = cy - Math.cos(a) * r;
        return x > -margin && x < w + margin && y > -margin && y < h + margin;
      };
      const r0 = Rs + 29;
      const drawn: number[] = [];
      if (level !== 'ticks') {
        for (const i of L.order) if (shown(i) && onScreen(L.angle[i], r0)) drawn.push(i);
      } else if (em) {
        const list = [...em.nodes].filter(shown).sort((a, b) => L.rank[a] - L.rank[b]);
        // Keep labels from overlapping: skip ones closer than the text height to the previous.
        let lastA = -Infinity;
        const minGap = 12 / r0;
        for (const i of list) {
          if (L.angle[i] - lastA < minGap && i !== (s.isolated ?? s.focus)) continue;
          lastA = L.angle[i];
          drawn.push(i);
        }
      }
      for (const i of drawn) {
        const n = model.nodes[i];
        const related = em?.nodes.has(i);
        const focusNode = i === (s.isolated ?? s.focus);
        const alpha = (em ? (related ? 1 : 0.8 - 0.62 * mix) : level === 'ticks' ? 1 : 0.78) * labelAlpha;
        const name = n.path.slice(n.path.lastIndexOf('/') + 1);
        const meta = level === 'detail' ? `${n.directory || '.'} · ${CATEGORY_LABELS[categoryOf(n.type)]}${n.loc ? ` · ${n.loc} lines` : ''}` : '';
        radialText(ctx, cx, cy, r0, L.angle[i], name, meta, focusNode ? '#ffb020' : related ? '#fff' : `rgba(255,255,255,${alpha})`, alpha, level === 'detail');
      }
    }
  }

  /** Arrowheads at the target end of each pair, sized in screen pixels. */
  private arrows(pairs: number[], color: string, inv: number, size: number, skip?: (pi: number) => boolean) {
    const { ctx } = this;
    const p = new Path2D();
    const s = size * inv;
    for (const pi of pairs) {
      if (skip?.(pi)) continue;
      const [x, y, a] = this.end(pi);
      p.moveTo(x, y);
      p.lineTo(x - Math.cos(a - 0.42) * s, y - Math.sin(a - 0.42) * s);
      p.lineTo(x - Math.cos(a + 0.42) * s, y - Math.sin(a + 0.42) * s);
      p.closePath();
    }
    ctx.fillStyle = color;
    ctx.fill(p);
  }

  /** Is the point (screen) on the given pair's thread? */
  hitPair(pi: number, sx: number, sy: number, cam: RingCamera, dpr: number): boolean {
    const { ctx } = this;
    ctx.save();
    ctx.setTransform(dpr * cam.k, 0, 0, dpr * cam.k, dpr * cam.x, dpr * cam.y);
    ctx.lineWidth = 8 / cam.k;
    const hit = ctx.isPointInStroke(this.path(pi), sx * dpr, sy * dpr);
    ctx.restore();
    return hit;
  }
}

function hexA(hex: string, a: number): string {
  const v = parseInt(hex.slice(1), 16);
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${a})`;
}

/** Text along a circle, centred on angle `mid`; flipped on the lower half so it reads left to right. */
function arcText(ctx: CanvasRenderingContext2D, text: string, cx: number, cy: number, r: number, mid: number, spacing = 0.6) {
  const widths = [...text].map((ch) => ctx.measureText(ch).width + spacing);
  const total = widths.reduce((s, x) => s + x, 0);
  const lower = Math.cos(mid) < 0;
  ctx.textAlign = 'center';
  let a = mid + ((lower ? 1 : -1) * total) / 2 / r;
  [...text].forEach((ch, i) => {
    const half = widths[i] / 2 / r;
    a += lower ? -half : half;
    const [x, y] = polar(a, r);
    ctx.save();
    ctx.translate(cx + x, cy + y);
    ctx.rotate(lower ? a + Math.PI : a);
    ctx.fillText(ch, 0, 0.5);
    ctx.restore();
    a += lower ? -half : half;
  });
}

/** A file label running outward from the ring, flipped on the left half. */
function radialText(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, a: number, name: string, meta: string, color: string, alpha: number, detail: boolean) {
  const [x, y] = polar(a, r);
  const left = a > Math.PI;
  ctx.save();
  ctx.translate(cx + x, cy + y);
  ctx.rotate(left ? a + Math.PI / 2 : a - Math.PI / 2);
  ctx.textAlign = left ? 'right' : 'left';
  ctx.font = '500 11px "Inter Variable", Inter, system-ui, sans-serif';
  ctx.fillStyle = color;
  ctx.fillText(name, 0, detail ? -5 : 0);
  if (detail && meta) {
    ctx.font = '9.5px "IBM Plex Mono", ui-monospace, monospace';
    ctx.fillStyle = `rgba(255,255,255,${0.5 * alpha})`;
    ctx.fillText(meta, 0, 7);
  }
  ctx.restore();
}
