/**
 * Pure geometry for the wireframe: directory hulls and the radial layout. Kept free of DOM and
 * React so it can run in a Web Worker (see layoutWorker.ts) and in unit tests.
 */

export interface Hull {
  key: string;
  points: [number, number][];
  cx: number;
  top: number;
  count: number;
}

/** Monotone-chain convex hull. */
export function convexHull(points: [number, number][]): [number, number][] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/**
 * One hull per directory cluster with ≥ 3 members. Outliers pulled far away by imports (beyond
 * mean + 2σ from the centroid) are left out so a region is not stretched across the canvas.
 */
export function clusterHulls(keys: string[], xs: ArrayLike<number>, ys: ArrayLike<number>, visible: ArrayLike<number>, pad = 18): Hull[] {
  const groups = new Map<string, number[]>();
  keys.forEach((k, i) => {
    if (!visible[i]) return;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(i);
  });
  const out: Hull[] = [];
  for (const [key, idx] of groups) {
    if (idx.length < 3) continue;
    let cx = 0, cy = 0;
    for (const i of idx) {
      cx += xs[i];
      cy += ys[i];
    }
    cx /= idx.length;
    cy /= idx.length;
    const d = idx.map((i) => Math.hypot(xs[i] - cx, ys[i] - cy));
    const mean = d.reduce((a, b) => a + b, 0) / d.length;
    const sd = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / d.length);
    const core = idx.filter((_, k) => d[k] <= mean + 2 * sd);
    const pts: [number, number][] = [];
    for (const i of core) {
      // Pad each point with a small octagon so the hull keeps a margin around nodes.
      for (let a = 0; a < 8; a++) pts.push([xs[i] + Math.cos((a * Math.PI) / 4) * pad, ys[i] + Math.sin((a * Math.PI) / 4) * pad]);
    }
    const hull = convexHull(pts);
    out.push({ key, points: hull, cx, top: Math.min(...hull.map((p) => p[1])), count: idx.length });
  }
  return out;
}

export interface RadialInput {
  center: number;
  n: number;
  /** Visible pairs as [source, target]. */
  pairs: [number, number][];
  /** Cluster key per node, to keep unreached nodes grouped on the outer ring. */
  clusters: string[];
  visible: ArrayLike<number>;
  ring?: number;
}

/**
 * Radial layout around `center`: rings by hop count (either direction), each subtree given an
 * angular span proportional to its size; nodes not reachable within the graph sit on an outer
 * ring grouped by directory.
 */
export function radialLayout({ center, n, pairs, clusters, visible, ring = 150 }: RadialInput): { x: Float64Array; y: Float64Array; hops: Int16Array } {
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const [s, t] of pairs) {
    adj[s].push(t);
    adj[t].push(s);
  }
  for (const a of adj) a.sort((p, q) => p - q);
  const hops = new Int16Array(n).fill(-1);
  const parent = new Int32Array(n).fill(-1);
  hops[center] = 0;
  const order = [center];
  for (let qi = 0; qi < order.length; qi++) {
    const v = order[qi];
    for (const w of adj[v]) {
      if (hops[w] !== -1 || !visible[w]) continue;
      hops[w] = hops[v] + 1;
      parent[w] = v;
      order.push(w);
    }
  }
  const children: number[][] = Array.from({ length: n }, () => []);
  for (const v of order) if (parent[v] >= 0) children[parent[v]].push(v);
  const size = new Float64Array(n);
  for (let i = order.length - 1; i >= 0; i--) {
    const v = order[i];
    size[v] = 1 + children[v].reduce((s, c) => s + size[c], 0);
  }
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const place = (v: number, a0: number, a1: number) => {
    const mid = (a0 + a1) / 2;
    const r = hops[v] * ring;
    x[v] = Math.cos(mid) * r;
    y[v] = Math.sin(mid) * r;
    const total = children[v].reduce((s, c) => s + size[c], 0);
    let a = a0;
    for (const c of children[v]) {
      const span = ((a1 - a0) * size[c]) / Math.max(1, total);
      place(c, a, a + span);
      a += span;
    }
  };
  place(center, -Math.PI / 2, (Math.PI * 3) / 2);
  const maxHop = order.reduce((m, v) => Math.max(m, hops[v]), 0);
  const rest = [...Array(n).keys()].filter((i) => hops[i] === -1).sort((a, b) => (clusters[a] === clusters[b] ? a - b : clusters[a] < clusters[b] ? -1 : 1));
  const outer = (maxHop + 1.6) * ring;
  rest.forEach((v, k) => {
    const a = (k / Math.max(1, rest.length)) * Math.PI * 2 - Math.PI / 2;
    x[v] = Math.cos(a) * outer;
    y[v] = Math.sin(a) * outer;
  });
  return { x, y, hops };
}
