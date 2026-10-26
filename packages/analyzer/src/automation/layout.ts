import { LANES, type AutoEdge, type AutoLane, type AutoNode } from './types.ts';

/*
 * Deterministic flowchart layout, shared by the server (stored with the flow) and the browser
 * (re-run when the reader switches swimlanes, spacing or direction):
 *   rank  = longest path from the trigger (so every step sits right of what precedes it),
 *   lane  = the node's swimlane (or one shared lane when swimlanes are off),
 *   slot  = position within (lane, rank), in path order.
 * Every node owns a distinct (lane, rank, slot) cell, so boxes cannot overlap. Edges are
 * orthogonal: out of the source's side, a vertical run between columns, into the target's side.
 */

export interface LayoutOptions {
  swimlanes: boolean;
  spacing: 'compact' | 'spacious';
  direction: 'LR' | 'TB';
}

export const NODE_W = 232;
export const NODE_H = 104;
const LANE_PAD = 12; // top and bottom padding of a lane (24px in total)
/** Room at the top of each swimlane for its sticky label. */
const LANE_HEAD = 26;

export interface PlacedNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rank: number;
  lane: AutoLane | 'all';
}

export interface PlacedEdge {
  id: string;
  points: [number, number][];
  /** Where to put the label. */
  mid: [number, number];
}

export interface FlowLayout {
  options: LayoutOptions;
  nodes: Record<string, PlacedNode>;
  edges: Record<string, PlacedEdge>;
  lanes: { lane: AutoLane | 'all'; start: number; size: number }[];
  width: number;
  height: number;
  ranks: number;
}

export const DEFAULT_LAYOUT: LayoutOptions = { swimlanes: true, spacing: 'spacious', direction: 'LR' };

/** Longest-path ranks from the trigger; edges that would close a cycle are ignored for ranking. */
export function rankNodes(nodes: AutoNode[], edges: AutoEdge[]): Map<string, number> {
  const out = new Map<string, AutoEdge[]>();
  for (const e of edges) {
    if (!out.has(e.source)) out.set(e.source, []);
    out.get(e.source)!.push(e);
  }
  // Topological order by DFS from the trigger (then any unreached node), skipping back edges.
  const state = new Map<string, 1 | 2>();
  const order: string[] = [];
  const back = new Set<AutoEdge>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const e of out.get(id) ?? []) {
      const s = state.get(e.target);
      if (s === 1) back.add(e);
      else if (!s) visit(e.target);
    }
    state.set(id, 2);
    order.push(id);
  };
  const trigger = nodes.find((n) => n.type === 'trigger') ?? nodes[0];
  if (trigger) visit(trigger.id);
  for (const n of nodes) if (!state.has(n.id)) visit(n.id);
  order.reverse();
  const rank = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (const id of order)
    for (const e of out.get(id) ?? []) {
      if (back.has(e)) continue;
      rank.set(e.target, Math.max(rank.get(e.target) ?? 0, (rank.get(id) ?? 0) + 1));
    }
  return rank;
}

export function layoutFlow(nodes: AutoNode[], edges: AutoEdge[], options: LayoutOptions = DEFAULT_LAYOUT): FlowLayout {
  const gapMain = options.spacing === 'compact' ? 40 : 72; // between columns (ranks)
  const gapCross = options.spacing === 'compact' ? 16 : 28; // between slots in a lane
  const rank = rankNodes(nodes, edges);
  const ranks = Math.max(0, ...rank.values()) + 1;
  const laneOf = (n: AutoNode): AutoLane | 'all' => (options.swimlanes ? n.lane : 'all');
  const lanesUsed: (AutoLane | 'all')[] = options.swimlanes ? LANES.filter((l) => nodes.some((n) => n.lane === l)) : ['all'];

  // Slots: in flow order (`order`, then id) within each (lane, rank) cell.
  const sorted = [...nodes].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
  const slotOf = new Map<string, number>();
  const cellCount = new Map<string, number>();
  for (const n of sorted) {
    const key = `${laneOf(n)}|${rank.get(n.id)}`;
    const s = cellCount.get(key) ?? 0;
    slotOf.set(n.id, s);
    cellCount.set(key, s + 1);
  }
  const laneSlots = new Map<string, number>(lanesUsed.map((l) => [l, 1]));
  for (const [key, count] of cellCount) {
    const lane = key.split('|')[0];
    laneSlots.set(lane, Math.max(laneSlots.get(lane) ?? 1, count));
  }

  const along = options.direction === 'LR' ? NODE_W : NODE_H; // size along the flow
  const across = options.direction === 'LR' ? NODE_H : NODE_W; // size across lanes
  const lanes: FlowLayout['lanes'] = [];
  let cursor = 0;
  const head = options.swimlanes && options.direction === 'LR' ? LANE_HEAD : 0;
  for (const l of lanesUsed) {
    const slots = laneSlots.get(l) ?? 1;
    const size = head + LANE_PAD * 2 + slots * across + (slots - 1) * gapCross;
    lanes.push({ lane: l, start: cursor, size });
    cursor += size;
  }
  const laneStart = new Map(lanes.map((l) => [l.lane, l]));
  const placed: Record<string, PlacedNode> = {};
  for (const n of nodes) {
    const r = rank.get(n.id) ?? 0;
    const lane = laneStart.get(laneOf(n))!;
    const slot = slotOf.get(n.id) ?? 0;
    const mainPos = 24 + r * (along + gapMain);
    const crossPos = lane.start + head + LANE_PAD + slot * (across + gapCross);
    placed[n.id] =
      options.direction === 'LR'
        ? { id: n.id, x: mainPos, y: crossPos, w: NODE_W, h: NODE_H, rank: r, lane: laneOf(n) }
        : { id: n.id, x: crossPos, y: mainPos, w: NODE_W, h: NODE_H, rank: r, lane: laneOf(n) };
  }
  const mainSize = 48 + ranks * along + Math.max(0, ranks - 1) * gapMain;
  const width = options.direction === 'LR' ? mainSize : cursor;
  const height = options.direction === 'LR' ? cursor : mainSize;

  const routed: Record<string, PlacedEdge> = {};
  for (const e of edges) {
    const a = placed[e.source];
    const b = placed[e.target];
    if (!a || !b) continue;
    routed[e.id] = route(a, b, options.direction, gapMain);
  }
  return { options, nodes: placed, edges: routed, lanes, width, height, ranks };
}

function route(a: PlacedNode, b: PlacedNode, dir: 'LR' | 'TB', gap: number): PlacedEdge {
  if (dir === 'LR') {
    const forward = b.x > a.x;
    const y1 = a.y + a.h / 2;
    const y2 = b.y + b.h / 2;
    if (forward) {
      const x1 = a.x + a.w;
      const x2 = b.x;
      // Turn in the gap just before the target's column, so runs into a column never cross its cards.
      const xm = x2 - gap / 2;
      const pts: [number, number][] = y1 === y2 ? [[x1, y1], [x2, y2]] : [[x1, y1], [xm, y1], [xm, y2], [x2, y2]];
      return { id: '', points: pts, mid: y1 === y2 ? [(x1 + x2) / 2, y1] : [xm, (y1 + y2) / 2] };
    }
    // Same column (or backwards): leave from the bottom/top and come in from the side.
    const x1 = a.x + a.w / 2;
    const below = b.y > a.y;
    const ys = below ? a.y + a.h : a.y;
    const xe = b.x - gap / 2;
    const pts: [number, number][] = [[x1, ys], [x1, ys + (below ? gap / 3 : -gap / 3)], [xe, ys + (below ? gap / 3 : -gap / 3)], [xe, y2], [b.x, y2]];
    return { id: '', points: pts, mid: [xe, (ys + y2) / 2] };
  }
  const forward = b.y > a.y;
  const x1 = a.x + a.w / 2;
  const x2 = b.x + b.w / 2;
  if (forward) {
    const y1 = a.y + a.h;
    const y2 = b.y;
    const ym = y2 - gap / 2;
    const pts: [number, number][] = x1 === x2 ? [[x1, y1], [x2, y2]] : [[x1, y1], [x1, ym], [x2, ym], [x2, y2]];
    return { id: '', points: pts, mid: x1 === x2 ? [x1, (y1 + y2) / 2] : [(x1 + x2) / 2, ym] };
  }
  const y1 = a.y + a.h / 2;
  const right = b.x > a.x;
  const xs = right ? a.x + a.w : a.x;
  const ye = b.y - gap / 2;
  const pts: [number, number][] = [[xs, y1], [xs + (right ? gap / 3 : -gap / 3), y1], [xs + (right ? gap / 3 : -gap / 3), ye], [x2, ye], [x2, b.y]];
  return { id: '', points: pts, mid: [(xs + x2) / 2, ye] };
}

/** Sanity: a multi-node flow must have distinct positions and finite coordinates. */
export function layoutProblems(layout: FlowLayout): string[] {
  const ps = Object.values(layout.nodes);
  const problems: string[] = [];
  if (ps.some((p) => ![p.x, p.y, p.w, p.h].every(Number.isFinite))) problems.push('non-finite coordinates');
  if (ps.length > 1 && new Set(ps.map((p) => `${p.x}|${p.y}`)).size !== ps.length) problems.push('overlapping positions');
  if (ps.length > 1 && new Set(ps.map((p) => (layout.options.direction === 'LR' ? p.x : p.y))).size === 1) problems.push('all nodes in one column');
  for (let i = 0; i < ps.length; i++)
    for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i];
      const b = ps[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        problems.push(`boxes overlap (${a.id}, ${b.id})`);
        return problems;
      }
    }
  return problems;
}
