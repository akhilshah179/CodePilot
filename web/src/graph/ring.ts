import type { NodeType } from '../lib/api.ts';
import type { GraphModel, Visibility } from './model.ts';

/*
 * Wireframe ring: files on one circle, grouped into fixed category arcs, with dependencies drawn
 * as hierarchically bundled splines (Holten 2006) through category and directory control points.
 *
 * Everything here is a pure function of the full node list, so a file keeps its position through
 * reloads, filtering, searching, zooming and focusing: filters hide ticks and threads, they never
 * move them.
 */

/** Arc order. External packages are not files, so they are not on the ring (Layered mode shows them). */
export const RING_CATEGORIES = ['page', 'route', 'component', 'action', 'service', 'utility', 'api', 'config', 'other', 'unresolved'] as const;
export type RingCategory = (typeof RING_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<RingCategory, string> = {
  page: 'Pages',
  route: 'Routes',
  component: 'Components',
  action: 'Actions',
  service: 'Services',
  utility: 'Utilities',
  api: 'APIs',
  config: 'Configuration',
  other: 'Other',
  unresolved: 'Unresolved',
};

/** Muted band colours. Red and blue stay reserved for dependency and consumer threads. */
export const CATEGORY_COLORS: Record<RingCategory, string> = {
  page: '#c3a6ff',
  route: '#00d2ff',
  component: '#6fd6c2',
  action: '#f0a6e6',
  service: '#10b981',
  utility: '#d9d38c',
  api: '#ffb020',
  config: '#9aa0a6',
  other: '#6f756b',
  unresolved: '#5c5f58',
};

export const categoryOf = (t: NodeType): RingCategory => (t === 'external' ? 'other' : (t as RingCategory));
export const onRing = (t: NodeType) => t !== 'external';

export interface RingArc {
  category: RingCategory;
  start: number;
  end: number;
  /** Node indices in ring order. */
  members: number[];
}

export interface RingLayout {
  /** World radius of the file circle. */
  R: number;
  /** Angle of each node (radians, 0 = 12 o'clock, clockwise), NaN for nodes not on the ring. */
  angle: Float64Array;
  /** Nodes in ring order. */
  order: number[];
  arcs: RingArc[];
  /** Position of each node within `order`. */
  rank: Int32Array;
  /** Angular spacing between neighbouring files. */
  step: number;
  /** Control-point hierarchy: node → directory group → category → centre. */
  dirOf: Int32Array;
  dirs: { category: RingCategory; directory: string; angle: number }[];
  catAngle: Map<RingCategory, number>;
}

const GAP_STEPS = 2.2;

/** Deterministic ring layout: categories in fixed order, files by directory path then file name. */
export function ringLayout(model: GraphModel): RingLayout {
  const byCat = new Map<RingCategory, number[]>();
  model.nodes.forEach((n, i) => {
    if (!onRing(n.type)) return;
    const c = categoryOf(n.type);
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c)!.push(i);
  });
  const cats = RING_CATEGORIES.filter((c) => byCat.get(c)?.length);
  const nameOf = (i: number) => {
    const p = model.nodes[i].path;
    const slash = p.lastIndexOf('/');
    return [slash >= 0 ? p.slice(0, slash) : '', slash >= 0 ? p.slice(slash + 1) : p] as const;
  };
  for (const c of cats) {
    byCat.get(c)!.sort((a, b) => {
      const [da, fa] = nameOf(a);
      const [db, fb] = nameOf(b);
      return da < db ? -1 : da > db ? 1 : fa < fb ? -1 : fa > fb ? 1 : 0;
    });
  }
  const total = cats.reduce((s, c) => s + byCat.get(c)!.length, 0);
  // Each file gets one step; each category boundary gets a gap; small categories keep a readable minimum.
  const slots = cats.map((c) => Math.max(byCat.get(c)!.length, 3));
  const units = slots.reduce((s, x) => s + x, 0) + cats.length * GAP_STEPS;
  const step = (Math.PI * 2) / Math.max(units, 1);
  const R = Math.max(240, (total * 3.4) / (Math.PI * 2) + 120);

  const angle = new Float64Array(model.nodes.length).fill(NaN);
  const rank = new Int32Array(model.nodes.length).fill(-1);
  const order: number[] = [];
  const arcs: RingArc[] = [];
  const dirOf = new Int32Array(model.nodes.length).fill(-1);
  const dirs: RingLayout['dirs'] = [];
  const catAngle = new Map<RingCategory, number>();
  let a = (GAP_STEPS / 2) * step;
  cats.forEach((c, ci) => {
    const members = byCat.get(c)!;
    const span = slots[ci] * step;
    const pad = ((slots[ci] - members.length) * step) / 2;
    const start = a;
    members.forEach((i, k) => {
      angle[i] = start + pad + (k + 0.5) * step;
      rank[i] = order.length;
      order.push(i);
    });
    arcs.push({ category: c, start, end: start + span, members });
    catAngle.set(c, start + span / 2);
    // Directory groups within the category (contiguous, because members are sorted by directory).
    let k = 0;
    while (k < members.length) {
      const dir = nameOf(members[k])[0];
      let j = k;
      while (j < members.length && nameOf(members[j])[0] === dir) j++;
      const id = dirs.length;
      dirs.push({ category: c, directory: dir, angle: (angle[members[k]] + angle[members[j - 1]]) / 2 });
      for (let m = k; m < j; m++) dirOf[members[m]] = id;
      k = j;
    }
    a += span + GAP_STEPS * step;
  });
  return { R, angle, order, arcs, rank, step, dirOf, dirs, catAngle };
}

export const polar = (a: number, r: number): [number, number] => [Math.sin(a) * r, -Math.cos(a) * r];

/** Radii of the bundling hierarchy, as fractions of R. */
const R_CAT = 0.36;
const R_DIR = 0.7;
/** Where threads end: just inside the ticks, leaving room for the arrowhead. */
export const THREAD_INSET = 5;

/**
 * Control points for the thread s → t: up the hierarchy from s to the lowest common ancestor and
 * down to t. Threads between different categories pass near the centre and share their category
 * and directory legs with every other thread from the same place — that sharing is the bundling.
 */
export function controlPoints(L: RingLayout, model: GraphModel, s: number, t: number): [number, number][] {
  const R = L.R;
  const cs = categoryOf(model.nodes[s].type);
  const ct = categoryOf(model.nodes[t].type);
  const ds = L.dirOf[s];
  const dt = L.dirOf[t];
  const pts: [number, number][] = [polar(L.angle[s], R - THREAD_INSET)];
  if (ds !== dt || cs !== ct) pts.push(polar(L.dirs[ds].angle, R * R_DIR));
  if (cs !== ct) {
    pts.push(polar(L.catAngle.get(cs)!, R * R_CAT));
    pts.push([0, 0]);
    pts.push(polar(L.catAngle.get(ct)!, R * R_CAT));
  } else if (ds !== dt) {
    pts.push(polar(L.catAngle.get(cs)!, R * (R_CAT + R_DIR) * 0.5));
  } else {
    // Same directory: a shallow arc toward the centre.
    const mid = (L.angle[s] + L.angle[t]) / 2;
    pts.push(polar(mid, R * (1 - Math.min(0.45, Math.abs(L.angle[s] - L.angle[t]) * 0.9))));
  }
  if (ds !== dt || cs !== ct) pts.push(polar(L.dirs[dt].angle, R * R_DIR));
  pts.push(polar(L.angle[t], R - THREAD_INSET));
  return pts;
}

/** Holten's bundling strength: straighten control points toward the chord by (1 − beta). */
export function straighten(pts: [number, number][], beta: number): [number, number][] {
  const n = pts.length - 1;
  if (n < 2) return pts;
  const [x0, y0] = pts[0];
  const [xn, yn] = pts[n];
  return pts.map(([x, y], i) => [beta * x + (1 - beta) * (x0 + ((xn - x0) * i) / n), beta * y + (1 - beta) * (y0 + ((yn - y0) * i) / n)]);
}

/** A uniform cubic B-spline through the control polygon, as cubic Bézier segments (d3 curveBasis). */
export interface Spline {
  start: [number, number];
  /** [c1x, c1y, c2x, c2y, x, y] per segment. */
  segs: number[];
  /** End point and direction of arrival (radians), for the arrowhead. */
  end: [number, number];
  endAngle: number;
}

export function basisSpline(pts: [number, number][]): Spline {
  // A port of d3-shape's curveBasis, emitting line segments as degenerate cubics.
  const segs: number[] = [];
  let x0 = NaN;
  let y0 = NaN;
  let x1 = NaN;
  let y1 = NaN;
  let state = 0;
  let cx = 0;
  let cy = 0;
  let px = 0;
  let py = 0;
  const start: [number, number] = [pts[0][0], pts[0][1]];
  const emit = (c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number) => {
    segs.push(c1x, c1y, c2x, c2y, x, y);
    px = cx;
    py = cy;
    cx = x;
    cy = y;
  };
  const line = (x: number, y: number) => emit(cx, cy, x, y, x, y);
  const bez = (x: number, y: number) => emit((2 * x0 + x1) / 3, (2 * y0 + y1) / 3, (x0 + 2 * x1) / 3, (y0 + 2 * y1) / 3, (x0 + 4 * x1 + x) / 6, (y0 + 4 * y1 + y) / 6);
  for (const [x, y] of pts) {
    if (state === 0) {
      state = 1;
      cx = x;
      cy = y;
    } else if (state === 1) {
      state = 2;
    } else {
      if (state === 2) {
        state = 3;
        line((5 * x0 + x1) / 6, (5 * y0 + y1) / 6);
      }
      bez(x, y);
    }
    x0 = x1;
    x1 = x;
    y0 = y1;
    y1 = y;
  }
  if (state === 3) {
    bez(x1, y1);
    line(x1, y1);
  } else if (state === 2) {
    line(x1, y1);
  }
  let endAngle = Math.atan2(cy - py, cx - px);
  if (Math.hypot(cy - py, cx - px) < 1e-6 && segs.length >= 12) {
    const n = segs.length - 6;
    endAngle = Math.atan2(segs[n - 1] - segs[n - 3], segs[n - 2] - segs[n - 4]);
  }
  return { start, segs, end: [cx, cy], endAngle };
}

export function splinePath(sp: Spline): Path2D {
  const p = new Path2D();
  p.moveTo(sp.start[0], sp.start[1]);
  for (let i = 0; i < sp.segs.length; i += 6) p.bezierCurveTo(sp.segs[i], sp.segs[i + 1], sp.segs[i + 2], sp.segs[i + 3], sp.segs[i + 4], sp.segs[i + 5]);
  return p;
}

/** Bundling strength: strong enough to group threads, weak enough that each stays traceable. */
export const BETA = 0.85;

export function threadSpline(L: RingLayout, model: GraphModel, s: number, t: number, beta = BETA): Spline {
  return basisSpline(straighten(controlPoints(L, model, s, t), beta));
}

/** Nearest ring node to an angle among `visible`, within `tolerance` radians; -1 when none. */
export function nodeAtAngle(L: RingLayout, a: number, visible: (i: number) => boolean, tolerance: number): number {
  const norm = ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  // Binary search on ring order (angles increase along it).
  let lo = 0;
  let hi = L.order.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (L.angle[L.order[mid]] < norm) lo = mid + 1;
    else hi = mid;
  }
  let best = -1;
  let bestD = tolerance;
  for (let k = lo - 6; k <= lo + 6; k++) {
    const idx = ((k % L.order.length) + L.order.length) % L.order.length;
    const i = L.order[idx];
    if (!visible(i)) continue;
    let d = Math.abs(L.angle[i] - norm);
    d = Math.min(d, Math.PI * 2 - d);
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

export function arcAtAngle(L: RingLayout, a: number): RingArc | null {
  const norm = ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  return L.arcs.find((arc) => norm >= arc.start && norm <= arc.end) ?? null;
}

export interface ThreadFilter {
  showIntra: boolean;
  showAll: boolean;
  threshold: number;
}

/**
 * Is a dependency drawn in the ring's default state? Visible, on the ring, and past the noise
 * filters: threads within a category and threads below the weight threshold are hidden unless
 * asked for. Unresolved imports always show — they are problems, not noise.
 */
export function isDefaultThread(model: GraphModel, L: RingLayout, pi: number, vis: Visibility, o: ThreadFilter): boolean {
  const p = model.pairs[pi];
  if (!vis.pairs[pi] || Number.isNaN(L.angle[p.s]) || Number.isNaN(L.angle[p.t])) return false;
  if (o.showAll) return true;
  const unresolved = !p.resolved || model.nodes[p.t].type === 'unresolved';
  if (unresolved) return true;
  if (categoryOf(model.nodes[p.s].type) === categoryOf(model.nodes[p.t].type) && !o.showIntra) return false;
  return p.weight >= o.threshold;
}

/** Longest file name on the ring, in characters (for label room when fitting). */
export function longestName(model: GraphModel, L: RingLayout): number {
  let max = 0;
  for (const i of L.order) max = Math.max(max, model.nodes[i].path.length - model.nodes[i].path.lastIndexOf('/') - 1);
  return max;
}
