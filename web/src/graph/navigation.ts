import type { GraphModel, Visibility } from './model.ts';

export type ArrowDirection = 'up' | 'down' | 'left' | 'right';

const ANGLE: Record<ArrowDirection, number> = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 };

/** Connected (dependency or consumer), visible neighbours of a node. */
export function connectedNeighbors(model: GraphModel, vis: Visibility, from: number): number[] {
  const out = new Set<number>();
  for (const pi of model.outPairs[from]) if (vis.pairs[pi]) out.add(model.pairs[pi].t);
  for (const pi of model.inPairs[from]) if (vis.pairs[pi]) out.add(model.pairs[pi].s);
  out.delete(from);
  return [...out];
}

/**
 * Arrow-key navigation between connected nodes: choose the neighbour whose direction best
 * matches the arrow, within a 100° cone, preferring closer nodes on ties.
 */
export function pickNeighbor(model: GraphModel, vis: Visibility, from: number, dir: ArrowDirection): number | null {
  const origin = model.nodes[from];
  let best: { i: number; score: number } | null = null;
  for (const i of connectedNeighbors(model, vis, from)) {
    const n = model.nodes[i];
    const dx = n.x - origin.x;
    const dy = n.y - origin.y;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) continue;
    let diff = Math.abs(Math.atan2(dy, dx) - ANGLE[dir]);
    if (diff > Math.PI) diff = 2 * Math.PI - diff;
    if (diff > (50 * Math.PI) / 180) continue;
    const score = diff * 2 + dist / 500;
    if (!best || score < best.score) best = { i, score };
  }
  return best?.i ?? null;
}
