import { SYSTEM_LAYER_LABELS } from '@codepilot/analyzer/architecture/types';
import type { SystemLayer, SystemLink, SystemMap, SystemNode } from '../../lib/api.ts';

/*
 * Layout for the system map: one horizontal band per layer, top to bottom in request order
 * (client → transport → backend → services → data → async → external → infrastructure).
 * Each application's components form a contiguous column block with a boundary; everything else
 * sits under the components it connects to. Deterministic: same map, same positions.
 */

export const NODE_W = 200;
export const NODE_H = 60;
const GAP_X = 18;
const ROW_GAP = 16;
const LANE_HEAD = 30;
const LANE_PAD = 18;
const GROUP_PAD = 14;
const GROUP_GAP = 44;
const MAX_PER_ROW = 6;
const LEFT = 150;

export interface MapNode {
  id: string;
  x: number;
  y: number;
  node: SystemNode;
}
export interface MapLane {
  layer: SystemLayer;
  label: string;
  y: number;
  h: number;
}
export interface MapGroup {
  app: string;
  name: string;
  frameworks: string[];
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface MapLink {
  link: SystemLink;
  d: string;
  /** Label anchor (midpoint of the curve). */
  lx: number;
  ly: number;
}
export interface SystemLayout {
  nodes: MapNode[];
  lanes: MapLane[];
  groups: MapGroup[];
  links: MapLink[];
  width: number;
  height: number;
}

const KIND_ORDER: Record<SystemNode['kind'], number> = { client: 0, proxy: 1, transport: 2, api: 3, middleware: 4, handler: 5, service: 6, tool: 7, queue: 8, worker: 9, external: 10, infra: 11 };

export function layoutSystem(map: SystemMap): SystemLayout {
  const layers = map.layers;
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  const groupOf = new Map<string, number>();
  map.groups.forEach((g, gi) => g.nodes.forEach((id) => groupOf.set(id, gi)));
  const neighbours = new Map<string, string[]>();
  for (const l of map.links) {
    if (!neighbours.has(l.source)) neighbours.set(l.source, []);
    if (!neighbours.has(l.target)) neighbours.set(l.target, []);
    neighbours.get(l.source)!.push(l.target);
    neighbours.get(l.target)!.push(l.source);
  }
  const byName = (a: SystemNode, b: SystemNode) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1);

  // Rows per layer: rows[layer] = list of rows; a row is a list of node ids with an x start.
  const x = new Map<string, number>();
  const row = new Map<string, number>();
  const rowsInLayer = new Map<SystemLayer, number>(layers.map((l) => [l, 1]));

  // 1. Application blocks, left to right.
  let cursor = LEFT;
  map.groups.forEach((g, gi) => {
    const members = g.nodes.map((id) => byId.get(id)).filter((n): n is SystemNode => !!n);
    let width = 0;
    for (const layer of layers) {
      const inLayer = members.filter((n) => n.layer === layer).sort(byName);
      if (!inLayer.length) continue;
      // Middleware runs as a chain, in registration order (the order the map lists it): its own row, before handlers.
      const order = new Map(map.nodes.map((n, i) => [n.id, i]));
      const middleware = inLayer.filter((n) => n.kind === 'middleware').sort((a, b) => order.get(a.id)! - order.get(b.id)!);
      const chains = [middleware, inLayer.filter((n) => n.kind !== 'middleware')].filter((c) => c.length);
      let r = 0;
      for (const chain of chains) {
        for (let k = 0; k < chain.length; k += MAX_PER_ROW) {
          const slice = chain.slice(k, k + MAX_PER_ROW);
          slice.forEach((n, i) => {
            x.set(n.id, cursor + GROUP_PAD + i * (NODE_W + GAP_X));
            row.set(n.id, r);
          });
          width = Math.max(width, slice.length * (NODE_W + GAP_X) - GAP_X);
          r++;
        }
      }
      rowsInLayer.set(layer, Math.max(rowsInLayer.get(layer)!, r));
    }
    void gi;
    cursor += width + GROUP_PAD * 2 + GROUP_GAP;
  });

  // 2. Everything else (clients, transports, proxies, data stores, queues, external services),
  //    placed over/under what it connects to; within a layer these take the top rows, above any
  //    application block (a transport sits before the API groups it carries requests to).
  const groupRows = new Map(rowsInLayer);
  for (const layer of layers) if (!map.nodes.some((n) => groupOf.has(n.id) && n.layer === layer)) groupRows.set(layer, 0);
  const freeRows = new Map<SystemLayer, number>(layers.map((l) => [l, 0]));
  const free = map.nodes.filter((n) => !groupOf.has(n.id)).sort(byName);
  for (let pass = 0; pass < 3; pass++) {
    for (const layer of layers) {
      const inLayer = free.filter((n) => n.layer === layer);
      if (!inLayer.length) continue;
      const wanted = inLayer.map((n) => {
        const xs = (neighbours.get(n.id) ?? []).filter((m) => x.has(m) && m !== n.id && (byId.get(m)!.layer !== layer || groupOf.has(m))).map((m) => x.get(m)!);
        return { n, want: xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : (x.get(n.id) ?? Infinity) };
      });
      wanted.sort((a, b) => a.want - b.want || byName(a.n, b.n));
      let last = -Infinity;
      let r = 0;
      let count = 0;
      for (const w of wanted) {
        if (count === MAX_PER_ROW * 2) {
          r++;
          last = -Infinity;
          count = 0;
        }
        const px = Math.max(LEFT, Number.isFinite(w.want) ? Math.max(w.want, last + NODE_W + GAP_X) : last + NODE_W + GAP_X > LEFT ? last + NODE_W + GAP_X : LEFT);
        x.set(w.n.id, px);
        row.set(w.n.id, r);
        last = px;
        count++;
      }
      freeRows.set(layer, r + 1);
    }
  }
  for (const n of map.nodes) if (groupOf.has(n.id)) row.set(n.id, (row.get(n.id) ?? 0) + freeRows.get(n.layer)!);
  for (const layer of layers) rowsInLayer.set(layer, Math.max(1, freeRows.get(layer)! + groupRows.get(layer)!));

  // 3. Lane geometry.
  const lanes: MapLane[] = [];
  let y = 0;
  for (const layer of layers) {
    const rows = rowsInLayer.get(layer)!;
    const h = LANE_HEAD + LANE_PAD + rows * NODE_H + (rows - 1) * ROW_GAP + LANE_PAD;
    lanes.push({ layer, label: SYSTEM_LAYER_LABELS[layer], y, h });
    y += h;
  }
  const laneOf = new Map(lanes.map((l) => [l.layer, l]));
  const nodes: MapNode[] = map.nodes.map((n) => {
    const lane = laneOf.get(n.layer)!;
    return { id: n.id, node: n, x: x.get(n.id) ?? LEFT, y: lane.y + LANE_HEAD + LANE_PAD + (row.get(n.id) ?? 0) * (NODE_H + ROW_GAP) };
  });
  const pos = new Map(nodes.map((n) => [n.id, n]));
  const width = Math.max(960, ...nodes.map((n) => n.x + NODE_W + 60));

  // 4. Application boundaries.
  const groups: MapGroup[] = map.groups
    .map((g) => {
      const members = g.nodes.map((id) => pos.get(id)).filter((n): n is MapNode => !!n);
      if (!members.length) return null;
      const x0 = Math.min(...members.map((n) => n.x)) - GROUP_PAD;
      const x1 = Math.max(...members.map((n) => n.x + NODE_W)) + GROUP_PAD;
      const y0 = Math.min(...members.map((n) => n.y)) - GROUP_PAD - 16;
      const y1 = Math.max(...members.map((n) => n.y + NODE_H)) + GROUP_PAD;
      return { app: g.app, name: g.name, frameworks: g.frameworks, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    })
    .filter((g): g is MapGroup => !!g);

  // 5. Links: vertical curves between layers, horizontal ones within a layer.
  const links: MapLink[] = [];
  for (const l of map.links) {
    const a = pos.get(l.source);
    const b = pos.get(l.target);
    if (!a || !b) continue;
    let d: string;
    let lx: number;
    let ly: number;
    if (a.node.layer === b.node.layer && Math.abs(a.y - b.y) < NODE_H) {
      const leftToRight = a.x < b.x;
      const sx = leftToRight ? a.x + NODE_W : a.x;
      const tx = leftToRight ? b.x : b.x + NODE_W;
      const sy = a.y + NODE_H / 2;
      const ty = b.y + NODE_H / 2;
      const k = Math.max(20, Math.abs(tx - sx) * 0.4) * (leftToRight ? 1 : -1);
      d = `M${sx} ${sy} C${sx + k} ${sy} ${tx - k} ${ty} ${tx} ${ty}`;
      lx = (sx + tx) / 2;
      ly = (sy + ty) / 2 - 6;
    } else {
      const down = b.y > a.y;
      const sx = a.x + NODE_W / 2;
      const tx = b.x + NODE_W / 2;
      const sy = down ? a.y + NODE_H : a.y;
      const ty = down ? b.y : b.y + NODE_H;
      const k = Math.max(24, Math.abs(ty - sy) * 0.45) * (down ? 1 : -1);
      d = `M${sx} ${sy} C${sx} ${sy + k} ${tx} ${ty - k} ${tx} ${ty}`;
      lx = (sx + tx) / 2;
      ly = (sy + ty) / 2;
    }
    links.push({ link: l, d, lx, ly });
  }

  return { nodes, lanes, groups, links, width, height: y };
}
