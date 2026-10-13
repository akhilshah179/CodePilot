import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from 'd3-force';
import { clusterKeys } from './cluster.ts';

export const LAYOUTS = ['force', 'circular', 'layered', 'type', 'directory'] as const;
export type LayoutName = (typeof LAYOUTS)[number];

export interface LayoutNodeInput {
  id: string;
  type: string;
  directory: string;
  /** Repo-relative path; used for directory clusters (falls back to the id). */
  path?: string;
}

export interface LayoutEdgeInput {
  source: string;
  target: string;
}

export type Positions = Record<string, [number, number]>;

interface SimNode extends SimulationNodeDatum {
  id: string;
  group: string;
}

const round = (n: number) => Math.round(n * 10) / 10;

/**
 * Deterministic layouts: nodes are sorted by id, initial positions come from d3's
 * phyllotaxis placement and d3-force's internal RNG is a fixed-seed LCG, so the same
 * graph always produces the same coordinates. Results are cached by the server.
 */
export function computeLayout(nodesIn: LayoutNodeInput[], edgesIn: LayoutEdgeInput[], layout: LayoutName): Positions {
  const nodes = [...nodesIn].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const clusters = clusterKeys(nodes);
  if (layout === 'circular') return circular(nodes, clusters);

  const ids = new Set(nodes.map((n) => n.id));
  const seen = new Set<string>();
  const links: { source: string; target: string }[] = [];
  for (const e of edgesIn) {
    if (e.source === e.target || !ids.has(e.source) || !ids.has(e.target)) continue;
    const key = e.source < e.target ? `${e.source}\0${e.target}` : `${e.target}\0${e.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ source: e.source, target: e.target });
  }
  links.sort((a, b) => (a.source + '\0' + a.target < b.source + '\0' + b.target ? -1 : 1));

  if (layout === 'type' || layout === 'directory') return grouped(nodes, links, layout === 'type' ? (n) => n.type : (n) => n.directory);
  if (layout === 'layered') return layered(nodes, edgesIn, links);
  const pos = forceLayout(nodes.map((n) => n.id), links, 0.045, undefined, clusterAnchors(nodes, clusters));
  for (const id of Object.keys(pos)) pos[id] = [round(pos[id][0]), round(pos[id][1])];
  return pos;
}

/**
 * Anchor per node: clusters are placed on a phyllotaxis spiral (largest first) so the force
 * layout keeps each directory together, which makes directory regions readable at low zoom.
 */
function clusterAnchors(nodes: LayoutNodeInput[], clusters: Map<string, string>): Map<string, [number, number]> | undefined {
  const sizes = new Map<string, number>();
  for (const n of nodes) sizes.set(clusters.get(n.id)!, (sizes.get(clusters.get(n.id)!) ?? 0) + 1);
  if (sizes.size < 2) return undefined;
  const order = [...sizes].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const golden = Math.PI * (3 - Math.sqrt(5));
  const unit = Math.sqrt(nodes.length) * 7 + 40;
  const at = new Map<string, [number, number]>();
  order.forEach(([key], i) => {
    const r = i === 0 ? 0 : unit * Math.sqrt(i + 0.5);
    at.set(key, [Math.cos(i * golden) * r, Math.sin(i * golden) * r]);
  });
  const out = new Map<string, [number, number]>();
  for (const n of nodes) out.set(n.id, at.get(clusters.get(n.id)!)!);
  return out;
}

function forceLayout(ids: string[], links: { source: string; target: string }[], centering: number, ticks?: number, anchors?: Map<string, [number, number]>): Positions {
  const simNodes: SimNode[] = ids.map((id) => ({ id, group: '' }));
  const n = simNodes.length;
  const spread = Math.max(120, Math.sqrt(n) * 26);
  const pull = anchors ? 0.07 : centering;
  const sim = forceSimulation(simNodes)
    .force('link', forceLink<SimNode, { source: string; target: string }>(links.map((l) => ({ ...l }))).id((d) => d.id).distance(36).strength(anchors ? 0.18 : 0.25))
    .force('charge', forceManyBody().strength(-38).distanceMax(spread * 1.5).theta(0.9))
    .force('collide', forceCollide(7))
    .force('x', forceX<SimNode>((d) => anchors?.get(d.id)?.[0] ?? 0).strength(pull))
    .force('y', forceY<SimNode>((d) => anchors?.get(d.id)?.[1] ?? 0).strength(pull))
    .stop();
  const total = ticks ?? (n > 2000 ? 180 : 300);
  for (let i = 0; i < total; i++) sim.tick();
  const out: Positions = {};
  for (const s of simNodes) out[s.id] = [s.x ?? 0, s.y ?? 0];
  return out;
}

/**
 * Two-level layout: each group gets its own force layout (intra-group links only),
 * then groups are packed around a ring sized by their radii so clusters never overlap.
 */
function grouped(nodes: LayoutNodeInput[], links: { source: string; target: string }[], groupOf: (n: LayoutNodeInput) => string): Positions {
  const members = new Map<string, string[]>();
  const groupById = new Map<string, string>();
  for (const n of nodes) {
    const g = groupOf(n);
    groupById.set(n.id, g);
    if (!members.has(g)) members.set(g, []);
    members.get(g)!.push(n.id);
  }
  const groups = [...members.keys()].sort((a, b) => members.get(b)!.length - members.get(a)!.length || (a < b ? -1 : 1));
  const local = new Map<string, { pos: Positions; radius: number }>();
  for (const g of groups) {
    const ids = members.get(g)!;
    const inner = links.filter((l) => groupById.get(l.source) === g && groupById.get(l.target) === g);
    const pos = forceLayout(ids, inner, 0.09, ids.length > 1500 ? 160 : 240);
    let cx = 0, cy = 0;
    for (const id of ids) { cx += pos[id][0]; cy += pos[id][1]; }
    cx /= ids.length; cy /= ids.length;
    let radius = 0;
    for (const id of ids) {
      pos[id] = [pos[id][0] - cx, pos[id][1] - cy];
      radius = Math.max(radius, Math.hypot(pos[id][0], pos[id][1]));
    }
    local.set(g, { pos, radius: radius + 28 });
  }

  const out: Positions = {};
  if (groups.length === 1) {
    for (const [id, p] of Object.entries(local.get(groups[0])!.pos)) out[id] = [round(p[0]), round(p[1])];
    return out;
  }
  const gap = 24;
  const circumference = groups.reduce((sum, g) => sum + 2 * local.get(g)!.radius + gap, 0);
  const largest = Math.max(...groups.map((g) => local.get(g)!.radius));
  const ring = Math.max(circumference / (2 * Math.PI), largest + gap);
  let angle = -Math.PI / 2;
  for (const g of groups) {
    const { pos, radius } = local.get(g)!;
    const span = ((2 * radius + gap) / circumference) * 2 * Math.PI;
    const a = angle + span / 2;
    angle += span;
    const gx = Math.cos(a) * ring, gy = Math.sin(a) * ring;
    for (const [id, p] of Object.entries(pos)) out[id] = [round(p[0] + gx), round(p[1] + gy)];
  }
  return out;
}

/** One ring; each directory cluster gets its own arc, separated by a gap. */
function circular(nodes: LayoutNodeInput[], clusters: Map<string, string>): Positions {
  const groups = new Map<string, LayoutNodeInput[]>();
  for (const n of nodes) {
    const k = clusters.get(n.id)!;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(n);
  }
  const keys = [...groups.keys()].sort();
  const gapSlots = groups.size > 1 ? 3 : 0;
  const slots = nodes.length + gapSlots * groups.size;
  const r = Math.max(120, (slots * 11) / (2 * Math.PI));
  const out: Positions = {};
  let slot = 0;
  for (const k of keys) {
    const members = groups.get(k)!.sort((a, b) => (a.type === b.type ? (a.id < b.id ? -1 : 1) : a.type < b.type ? -1 : 1));
    for (const node of members) {
      const a = (slot / Math.max(1, slots)) * Math.PI * 2 - Math.PI / 2;
      out[node.id] = [round(Math.cos(a) * r), round(Math.sin(a) * r)];
      slot++;
    }
    slot += gapSlots;
  }
  return out;
}

/** Approximate architectural order; the actual imports decide rows inside each tier. */
const TIER: Record<string, number> = { route: 0, page: 0, component: 1, action: 2, service: 3, api: 4, utility: 4, config: 4, other: 5, external: 6, unresolved: 6 };

/**
 * Layered layout: tiers by node type (routes/pages → components → actions → services →
 * utilities/APIs/config), rows inside a tier by longest import path among its files (importers
 * above what they import), order within rows by barycenter of neighbours to reduce crossings.
 */
function layered(nodes: LayoutNodeInput[], edgesIn: LayoutEdgeInput[], links: { source: string; target: string }[]): Positions {
  const tierOf = new Map(nodes.map((n) => [n.id, TIER[n.type] ?? 5]));
  const ids = new Set(nodes.map((n) => n.id));
  const out = new Map<string, string[]>();
  for (const e of edgesIn) {
    if (e.source === e.target || !ids.has(e.source) || !ids.has(e.target)) continue;
    if (tierOf.get(e.source) !== tierOf.get(e.target)) continue;
    if (!out.has(e.source)) out.set(e.source, []);
    out.get(e.source)!.push(e.target);
  }
  const depth = new Map<string, number>();
  // Depth = longest chain of importers above a node (reverse topological, cycles ignored).
  const incoming = new Map<string, string[]>();
  for (const [s, ts] of out) for (const t of ts) {
    if (!incoming.has(t)) incoming.set(t, []);
    incoming.get(t)!.push(s);
  }
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const d = depth.get(id);
    if (d !== undefined) return d;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let best = 0;
    for (const p of incoming.get(id) ?? []) best = Math.max(best, depthOf(p) + 1);
    visiting.delete(id);
    const capped = Math.min(best, 6);
    depth.set(id, capped);
    return capped;
  };
  const rows = new Map<string, string[]>();
  for (const n of nodes) {
    const key = `${tierOf.get(n.id)}:${depthOf(n.id)}`;
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key)!.push(n.id);
  }
  const maxPerRow = Math.max(24, Math.round(Math.sqrt(nodes.length) * 3));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const rowList: { tier: number; ids: string[] }[] = [];
  for (const key of [...rows.keys()].sort((a, b) => {
    const [ta, da] = a.split(':').map(Number);
    const [tb, db] = b.split(':').map(Number);
    return ta - tb || da - db;
  })) {
    const members = rows.get(key)!.sort((a, b) => {
      const na = byId.get(a)!, nb = byId.get(b)!;
      return na.directory === nb.directory ? (a < b ? -1 : 1) : na.directory < nb.directory ? -1 : 1;
    });
    for (let i = 0; i < members.length; i += maxPerRow) rowList.push({ tier: Number(key.split(':')[0]), ids: members.slice(i, i + maxPerRow) });
  }
  // Barycenter sweeps.
  const neighbours = new Map<string, string[]>();
  for (const l of links) {
    if (!neighbours.has(l.source)) neighbours.set(l.source, []);
    if (!neighbours.has(l.target)) neighbours.set(l.target, []);
    neighbours.get(l.source)!.push(l.target);
    neighbours.get(l.target)!.push(l.source);
  }
  const rowOf = new Map<string, number>();
  rowList.forEach((r, i) => r.ids.forEach((id) => rowOf.set(id, i)));
  const xIndex = new Map<string, number>();
  const place = () => rowList.forEach((r) => r.ids.forEach((id, i) => xIndex.set(id, i - (r.ids.length - 1) / 2)));
  place();
  for (let iter = 0; iter < 4; iter++) {
    const order = iter % 2 === 0 ? rowList.map((_, i) => i) : rowList.map((_, i) => rowList.length - 1 - i);
    for (const ri of order) {
      const row = rowList[ri];
      const score = new Map<string, number>();
      for (const id of row.ids) {
        const ns = (neighbours.get(id) ?? []).filter((n) => rowOf.get(n) !== ri && (iter % 2 === 0 ? rowOf.get(n)! < ri : rowOf.get(n)! > ri));
        score.set(id, ns.length ? ns.reduce((s, n) => s + xIndex.get(n)!, 0) / ns.length : xIndex.get(id)!);
      }
      row.ids.sort((a, b) => score.get(a)! - score.get(b)! || (a < b ? -1 : 1));
      row.ids.forEach((id, i) => xIndex.set(id, i - (row.ids.length - 1) / 2));
    }
  }
  const pos: Positions = {};
  let y = 0;
  let prevTier = -1;
  for (const r of rowList) {
    if (prevTier !== -1) y += r.tier !== prevTier ? 96 : 52;
    prevTier = r.tier;
    for (const id of r.ids) pos[id] = [round(xIndex.get(id)! * 34), round(y)];
  }
  return pos;
}
