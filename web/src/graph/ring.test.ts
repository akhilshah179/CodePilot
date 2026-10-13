import { describe, expect, it } from 'vitest';
import type { GraphEdge, PositionedNode } from '../lib/api.ts';
import { computeVisibility, defaultFilters, GraphModel } from './model.ts';
import { basisSpline, controlPoints, isDefaultThread, nodeAtAngle, polar, RING_CATEGORIES, ringLayout, THREAD_INSET, threadSpline } from './ring.ts';

const node = (path: string, type: PositionedNode['type']): PositionedNode => ({
  id: path,
  path,
  type,
  language: 'typescript',
  size: 10,
  classification_evidence: [],
  directory: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
  analyzed: true,
  x: 0,
  y: 0,
});
const edge = (source: string, target: string, symbols = ['x'], extra: Partial<GraphEdge> = {}): GraphEdge => ({
  id: `${source}->${target}`,
  source,
  target,
  symbols,
  kind: 'static',
  line: 3,
  resolved: true,
  specifier: target,
  typeOnly: false,
  external: false,
  ...extra,
});

const nodes = [
  node('src/lib/format.ts', 'utility'),
  node('app/login/page.tsx', 'page'),
  node('src/components/Login.tsx', 'component'),
  node('src/lib/auth.ts', 'utility'),
  node('app/api/me/route.ts', 'route'),
  node('src/components/Button.tsx', 'component'),
  node('src/services/users.ts', 'service'),
  node('react', 'external'),
];
const edges = [
  edge('app/login/page.tsx', 'src/components/Login.tsx'),
  edge('src/components/Login.tsx', 'src/lib/auth.ts', ['signIn', 'session', 'user', 'token']),
  edge('src/components/Login.tsx', 'src/components/Button.tsx'),
  edge('app/api/me/route.ts', 'src/services/users.ts'),
  edge('src/services/users.ts', 'src/lib/format.ts'),
  edge('src/components/Login.tsx', 'react', ['useState'], { external: true }),
];

describe('ring layout', () => {
  const model = new GraphModel(nodes, edges);
  const L = ringLayout(model);

  it('orders arcs by category and files by directory then name', () => {
    expect(L.arcs.map((a) => a.category)).toEqual(['page', 'route', 'component', 'service', 'utility']);
    const utility = L.arcs.find((a) => a.category === 'utility')!.members.map((i) => model.nodes[i].path);
    expect(utility).toEqual(['src/lib/auth.ts', 'src/lib/format.ts']);
    const comps = L.arcs.find((a) => a.category === 'component')!.members.map((i) => model.nodes[i].path);
    expect(comps).toEqual(['src/components/Button.tsx', 'src/components/Login.tsx']);
    // Arc order is the fixed category order.
    const order = L.arcs.map((a) => RING_CATEGORIES.indexOf(a.category));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('places angles monotonically around the circle, and leaves external packages off it', () => {
    const angles = L.order.map((i) => L.angle[i]);
    for (let k = 1; k < angles.length; k++) expect(angles[k]).toBeGreaterThan(angles[k - 1]);
    expect(angles.at(-1)!).toBeLessThan(Math.PI * 2);
    expect(Number.isNaN(L.angle[model.index.get('react')!])).toBe(true);
  });

  it('is deterministic and independent of input order and of filters', () => {
    const shuffled = new GraphModel([...nodes].reverse(), [...edges].reverse());
    const L2 = ringLayout(shuffled);
    for (const n of nodes) {
      if (n.type === 'external') continue;
      expect(L2.angle[shuffled.index.get(n.id)!]).toBeCloseTo(L.angle[model.index.get(n.id)!], 12);
    }
    // Filters hide ticks; they never feed into the layout.
    const f = defaultFilters();
    f.types.delete('component');
    const vis = computeVisibility(model, f);
    expect(vis.nodes[model.index.get('src/components/Login.tsx')!]).toBe(0);
    expect(ringLayout(model).angle).toEqual(L.angle);
  });

  it('connects the exact source file to the exact target file', () => {
    const s = model.index.get('src/components/Login.tsx')!;
    const t = model.index.get('src/lib/auth.ts')!;
    const sp = threadSpline(L, model, s, t);
    const [sx, sy] = polar(L.angle[s], L.R - THREAD_INSET);
    const [tx, ty] = polar(L.angle[t], L.R - THREAD_INSET);
    expect(sp.start[0]).toBeCloseTo(sx, 9);
    expect(sp.start[1]).toBeCloseTo(sy, 9);
    expect(sp.end[0]).toBeCloseTo(tx, 9);
    expect(sp.end[1]).toBeCloseTo(ty, 9);
    // It arrives heading outward (toward the target tick), so the arrowhead points at B.
    const outward = Math.atan2(ty, tx);
    const diff = Math.abs(Math.atan2(Math.sin(sp.endAngle - outward), Math.cos(sp.endAngle - outward)));
    expect(diff).toBeLessThan(Math.PI / 2);
  });

  it('bundles threads between categories through shared category control points', () => {
    const login = model.index.get('src/components/Login.tsx')!;
    const button = model.index.get('src/components/Button.tsx')!;
    const auth = model.index.get('src/lib/auth.ts')!;
    const format = model.index.get('src/lib/format.ts')!;
    const a = controlPoints(L, model, login, auth);
    const b = controlPoints(L, model, button, format);
    // Both leave the Components arc through the same category point and arrive via the same one.
    expect(a.length).toBe(b.length);
    expect(a[2]).toEqual(b[2]);
    expect(a[3]).toEqual([0, 0]);
    expect(a[4]).toEqual(b[4]);
    // Same category, same directory: a short arc, not a trip through the centre.
    const c = controlPoints(L, model, login, button);
    expect(c.some(([x, y]) => x === 0 && y === 0)).toBe(false);
  });

  it('hides intra-category and light threads by default, never unresolved ones', () => {
    const vis = computeVisibility(model, defaultFilters());
    const pi = (s: string, t: string) => model.pairs.findIndex((p) => model.nodes[p.s].id === s && model.nodes[p.t].id === t);
    const o = { showIntra: false, showAll: false, threshold: 1 };
    expect(isDefaultThread(model, L, pi('src/components/Login.tsx', 'src/components/Button.tsx'), vis, o)).toBe(false);
    expect(isDefaultThread(model, L, pi('src/components/Login.tsx', 'src/components/Button.tsx'), vis, { ...o, showIntra: true })).toBe(true);
    expect(isDefaultThread(model, L, pi('app/api/me/route.ts', 'src/services/users.ts'), vis, o)).toBe(true);
    expect(isDefaultThread(model, L, pi('app/api/me/route.ts', 'src/services/users.ts'), vis, { ...o, threshold: 2 })).toBe(false);
    expect(isDefaultThread(model, L, pi('src/components/Login.tsx', 'src/lib/auth.ts'), vis, { ...o, threshold: 4 })).toBe(true);
    // External packages are not on the ring.
    expect(isDefaultThread(model, L, pi('src/components/Login.tsx', 'react'), computeVisibility(model, { ...defaultFilters(), types: new Set([...defaultFilters().types, 'external']) }), { ...o, showAll: true })).toBe(false);
  });

  it('finds the file under an angle, skipping hidden ones', () => {
    const i = model.index.get('src/services/users.ts')!;
    expect(nodeAtAngle(L, L.angle[i] + L.step * 0.2, () => true, L.step)).toBe(i);
    expect(nodeAtAngle(L, L.angle[i], (j) => j !== i, L.step * 0.4)).toBe(-1);
  });

  it('produces B-spline segments that start and end on the control polygon ends', () => {
    const sp = basisSpline([
      [0, 0],
      [10, 0],
      [10, 10],
      [20, 10],
    ]);
    expect(sp.start).toEqual([0, 0]);
    expect(sp.end).toEqual([20, 10]);
    expect(sp.segs.length % 6).toBe(0);
  });
});

describe('ring at scale', () => {
  it('lays out 1,500 files and computes 6,000 bundled threads quickly', () => {
    const cats: PositionedNode['type'][] = ['page', 'route', 'component', 'action', 'service', 'utility', 'api', 'config', 'other'];
    const big: PositionedNode[] = [];
    for (let i = 0; i < 1500; i++) big.push(node(`src/d${i % 40}/f${i}.ts`, cats[i % cats.length]));
    const bigEdges: GraphEdge[] = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    while (bigEdges.length < 6000) {
      const a = Math.floor(rnd() * 1500);
      const b = Math.floor(rnd() * 1500);
      if (a !== b) bigEdges.push(edge(big[a].id, big[b].id, ['x'], { id: `e${bigEdges.length}` }));
    }
    const model = new GraphModel(big, bigEdges);
    const t0 = performance.now();
    const L = ringLayout(model);
    const t1 = performance.now();
    for (const p of model.pairs) threadSpline(L, model, p.s, p.t);
    const t2 = performance.now();
    expect(L.order.length).toBe(1500);
    expect(t1 - t0).toBeLessThan(200);
    expect(t2 - t1).toBeLessThan(600);
  });
});
