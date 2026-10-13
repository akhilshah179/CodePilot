import { LAYER_LABELS, type ArchEdge, type ArchNode, type Architecture, type Layer, type Overlay } from './types.ts';

/**
 * Architecture diagram geometry, shared by the web page and the server-side exports so both
 * draw exactly the same picture: one horizontal swimlane per layer that has nodes, nodes ordered
 * to reduce crossings, edges as cubic Béziers between side anchors.
 */

export const NODE_W = 236;
export const GAP_X = 28;
export const GAP_Y = 26;
export const LANE_HEAD = 34;
export const LANE_PAD = 20;
export const MAX_FILES = 3;

export interface DiagramNode {
  id: string;
  layer: Layer;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DiagramLane {
  layer: Layer;
  label: string;
  y: number;
  h: number;
}

export interface DiagramEdge {
  id: string;
  source: string;
  target: string;
  d: string;
  /** Point on the curve for the label (t = 0.5). */
  mid: [number, number];
  /** Arrow tip and direction. */
  end: [number, number];
  angle: number;
  /** Sample points along the curve, for animating signals. */
  points: [number, number][];
}

export interface Diagram {
  width: number;
  height: number;
  lanes: DiagramLane[];
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

/** Fixed height of a node card, derived from its content (the web renders exactly this). */
export function nodeHeight(n: ArchNode): number {
  // Matches the web card: type row, name/version, role, category · connections.
  let h = 96;
  if (n.app?.chips.length) h += 24;
  const files = Math.min(MAX_FILES, n.files.length);
  if (files) h += 26 + files * 16 + (n.files.length > MAX_FILES ? 16 : 0);
  if (n.badges.length) h += 24;
  return h;
}

export function visibleEdges(arch: Architecture, overlay: Overlay): ArchEdge[] {
  const shown = new Set(arch.nodes.filter((n) => n.display === 'node').map((n) => n.id));
  return arch.edges.filter((e) => e.overlays.includes(overlay) && shown.has(e.source) && shown.has(e.target));
}

export function layoutDiagram(arch: Architecture, overlay: Overlay = 'dataflow'): Diagram {
  const nodes = arch.nodes.filter((n) => n.display === 'node');
  const edges = visibleEdges(arch, overlay);
  const allEdges = arch.edges.filter((e) => nodes.some((n) => n.id === e.source) && nodes.some((n) => n.id === e.target));
  const byLayer = new Map<Layer, ArchNode[]>();
  for (const l of arch.layers) byLayer.set(l, []);
  for (const n of nodes) {
    if (!byLayer.has(n.layer)) byLayer.set(n.layer, []);
    byLayer.get(n.layer)!.push(n);
  }
  const layers = [...byLayer.keys()].filter((l) => byLayer.get(l)!.length);
  const perRow = Math.max(3, Math.min(8, Math.ceil(Math.sqrt(nodes.length * 1.6))));

  // Initial order: apps first, then by name; then barycenter passes over all connections (stable across overlays).
  const order = new Map<Layer, ArchNode[]>();
  for (const l of layers) order.set(l, [...byLayer.get(l)!].sort((a, b) => (a.kind === 'app' ? 0 : 1) - (b.kind === 'app' ? 0 : 1) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
  const pos = new Map<string, number>();
  const index = () => {
    for (const l of layers) order.get(l)!.forEach((n, i) => pos.set(n.id, i - (order.get(l)!.length - 1) / 2));
  };
  index();
  const neighbours = new Map<string, string[]>();
  for (const e of allEdges) {
    if (!neighbours.has(e.source)) neighbours.set(e.source, []);
    if (!neighbours.has(e.target)) neighbours.set(e.target, []);
    neighbours.get(e.source)!.push(e.target);
    neighbours.get(e.target)!.push(e.source);
  }
  const layerOf = new Map(nodes.map((n) => [n.id, n.layer]));
  for (let pass = 0; pass < 4; pass++) {
    const seq = pass % 2 === 0 ? layers : [...layers].reverse();
    for (const l of seq) {
      const li = layers.indexOf(l);
      const score = new Map<string, number>();
      for (const n of order.get(l)!) {
        const ns = (neighbours.get(n.id) ?? []).filter((m) => {
          const ml = layers.indexOf(layerOf.get(m)!);
          return pass % 2 === 0 ? ml < li : ml > li;
        });
        score.set(n.id, ns.length ? ns.reduce((s, m) => s + pos.get(m)!, 0) / ns.length : pos.get(n.id)!);
      }
      order.get(l)!.sort((a, b) => score.get(a.id)! - score.get(b.id)! || (a.name < b.name ? -1 : 1));
      order.get(l)!.forEach((n, i) => pos.set(n.id, i - (order.get(l)!.length - 1) / 2));
    }
  }

  // Rows inside lanes; lanes stretch to the widest row.
  const rowsByLayer = new Map<Layer, ArchNode[][]>();
  let maxRow = 0;
  for (const l of layers) {
    const list = order.get(l)!;
    const rows: ArchNode[][] = [];
    for (let i = 0; i < list.length; i += perRow) rows.push(list.slice(i, i + perRow));
    rowsByLayer.set(l, rows);
    for (const r of rows) maxRow = Math.max(maxRow, r.length);
  }
  const width = Math.max(960, LANE_PAD * 2 + 140 + maxRow * NODE_W + (maxRow - 1) * GAP_X);
  const out: DiagramNode[] = [];
  const lanes: DiagramLane[] = [];
  let y = 0;
  for (const l of layers) {
    const laneTop = y;
    y += LANE_HEAD;
    for (const row of rowsByLayer.get(l)!) {
      const rowH = Math.max(...row.map(nodeHeight));
      const rowW = row.length * NODE_W + (row.length - 1) * GAP_X;
      let x = 140 + (width - 140 - rowW) / 2;
      for (const n of row) {
        out.push({ id: n.id, layer: l, x: Math.round(x), y: Math.round(y), w: NODE_W, h: nodeHeight(n) });
        x += NODE_W + GAP_X;
      }
      y += rowH + GAP_Y;
    }
    y += LANE_PAD - GAP_Y + 12;
    lanes.push({ layer: l, label: LAYER_LABELS[l], y: laneTop, h: y - laneTop });
  }
  return { width: Math.round(width), height: Math.round(y), lanes, nodes: out, edges: routeEdges(out, edges, layers) };
}

/** Cubic Bézier edges between anchors spread along the facing sides of each node. */
export function routeEdges(nodes: DiagramNode[], edges: { id: string; source: string; target: string }[], layers: Layer[]): DiagramEdge[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  type Side = 'top' | 'bottom';
  const attach = new Map<string, { edge: string; other: DiagramNode; end: 'source' | 'target' }[]>();
  const sides = new Map<string, { s: Side; t: Side }>();
  const rank = (n: DiagramNode) => layers.indexOf(n.layer) * 100000 + n.y;
  for (const e of edges) {
    const a = byId.get(e.source);
    const b = byId.get(e.target);
    if (!a || !b) continue;
    const down = rank(b) > rank(a) + 1;
    const up = rank(b) < rank(a) - 1;
    const s: Side = down ? 'bottom' : up ? 'top' : 'top';
    const t: Side = down ? 'top' : up ? 'bottom' : 'top';
    sides.set(e.id, { s, t });
    const ka = `${a.id}|${s}`;
    const kb = `${b.id}|${t}`;
    if (!attach.has(ka)) attach.set(ka, []);
    if (!attach.has(kb)) attach.set(kb, []);
    attach.get(ka)!.push({ edge: e.id, other: b, end: 'source' });
    attach.get(kb)!.push({ edge: e.id, other: a, end: 'target' });
  }
  const anchor = new Map<string, [number, number]>();
  for (const [key, list] of attach) {
    const [id, side] = key.split('|') as [string, Side];
    const n = byId.get(id)!;
    list.sort((p, q) => p.other.x - q.other.x || (p.edge < q.edge ? -1 : 1));
    list.forEach((item, i) => {
      const x = n.x + (n.w * (i + 1)) / (list.length + 1);
      const y = side === 'top' ? n.y : n.y + n.h;
      anchor.set(`${item.edge}|${item.end}`, [x, y]);
    });
  }
  const out: DiagramEdge[] = [];
  for (const e of edges) {
    const sd = sides.get(e.id);
    const p0 = anchor.get(`${e.id}|source`);
    const p3 = anchor.get(`${e.id}|target`);
    if (!sd || !p0 || !p3) continue;
    const dy = Math.max(40, Math.abs(p3[1] - p0[1]) * 0.45);
    const sameRow = sd.s === 'top' && sd.t === 'top';
    // Edges that skip lanes go around the cards in between instead of passing behind them.
    const yTop = Math.min(p0[1], p3[1]);
    const yBot = Math.max(p0[1], p3[1]);
    const xl = Math.min(p0[0], p3[0]) - 14;
    const xr = Math.max(p0[0], p3[0]) + 14;
    const blockers = sameRow ? [] : nodes.filter((n) => n.id !== e.source && n.id !== e.target && n.y < yBot - 4 && n.y + n.h > yTop + 4 && n.x < xr && n.x + n.w > xl);
    if (blockers.length) {
      const right = Math.max(...blockers.map((n) => n.x + n.w)) + 44;
      const left = Math.min(...blockers.map((n) => n.x)) - 44;
      const cx = Math.abs(right - (p0[0] + p3[0]) / 2) <= Math.abs(left - (p0[0] + p3[0]) / 2) ? right : left;
      const dir = p3[1] > p0[1] ? 1 : -1;
      const midY = (p0[1] + p3[1]) / 2;
      // Turn only once clear of the blocking cards, so the curve never grazes their corners.
      const clearStart = dir > 0 ? Math.min(...blockers.map((n) => n.y)) - 12 : Math.max(...blockers.map((n) => n.y + n.h)) + 12;
      const clearEnd = dir > 0 ? Math.max(...blockers.map((n) => n.y + n.h)) + 30 : Math.min(...blockers.map((n) => n.y)) - 30;
      const seg1: [number, number][] = [p0, [p0[0], clearStart], [cx, p0[1] + dir * 30], [cx, midY]];
      const seg2: [number, number][] = [[cx, midY], [cx, clearEnd], [p3[0], clearEnd], p3];
      const bez = (q: [number, number][], t: number): [number, number] => {
        const u = 1 - t;
        return [u * u * u * q[0][0] + 3 * u * u * t * q[1][0] + 3 * u * t * t * q[2][0] + t * t * t * q[3][0], u * u * u * q[0][1] + 3 * u * u * t * q[1][1] + 3 * u * t * t * q[2][1] + t * t * t * q[3][1]];
      };
      const points: [number, number][] = [];
      for (let i = 0; i <= 12; i++) points.push(bez(seg1, i / 12).map(r) as [number, number]);
      for (let i = 1; i <= 12; i++) points.push(bez(seg2, i / 12).map(r) as [number, number]);
      const before = bez(seg2, 0.97);
      out.push({
        id: e.id,
        source: e.source,
        target: e.target,
        d: `M${r(p0[0])} ${r(p0[1])}C${r(seg1[1][0])} ${r(seg1[1][1])} ${r(seg1[2][0])} ${r(seg1[2][1])} ${r(cx)} ${r(midY)}C${r(seg2[1][0])} ${r(seg2[1][1])} ${r(seg2[2][0])} ${r(seg2[2][1])} ${r(p3[0])} ${r(p3[1])}`,
        mid: [r(cx), r(midY)],
        end: [r(p3[0]), r(p3[1])],
        angle: Math.atan2(p3[1] - before[1], p3[0] - before[0]),
        points,
      });
      continue;
    }
    const c1: [number, number] = sameRow ? [p0[0], p0[1] - 60] : [p0[0], p0[1] + (sd.s === 'bottom' ? dy : -dy)];
    const c2: [number, number] = sameRow ? [p3[0], p3[1] - 60] : [p3[0], p3[1] + (sd.t === 'top' ? -dy : dy)];
    const at = (t: number): [number, number] => {
      const u = 1 - t;
      return [u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p3[0], u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p3[1]];
    };
    const points: [number, number][] = [];
    for (let i = 0; i <= 24; i++) points.push(at(i / 24).map((v) => Math.round(v * 10) / 10) as [number, number]);
    const before = at(0.97);
    out.push({
      id: e.id,
      source: e.source,
      target: e.target,
      d: `M${r(p0[0])} ${r(p0[1])}C${r(c1[0])} ${r(c1[1])} ${r(c2[0])} ${r(c2[1])} ${r(p3[0])} ${r(p3[1])}`,
      mid: at(0.5).map(r) as [number, number],
      end: [r(p3[0]), r(p3[1])],
      angle: Math.atan2(p3[1] - before[1], p3[0] - before[0]),
      points,
    });
  }
  return out;
}

const r = (v: number) => Math.round(v * 10) / 10;
