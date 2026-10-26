import { describe, expect, it } from 'vitest';
import type { AutoEdge, AutoNode } from '@codepilot/analyzer/automation/types';
import { anchorView, anyVisible, clampView, fitView, hiddenByCollapse, pathThrough, pointAlong, roundedPath, startPlayback, stepPlayback, zoomAt, zoomLevel } from './chartModel.ts';

const node = (id: string, type: AutoNode['type'], order: number): AutoNode => ({ id, type, label: id, lane: 'backend', file: 'a.ts', line: order, evidence: [{ file: 'a.ts', line: order }], tools: [], confidence: 'confirmed', order });
const edge = (id: string, source: string, target: string, kind: AutoEdge['kind'] = 'sequence', label?: string): AutoEdge => ({ id, source, target, kind, label, evidence: [{ file: 'a.ts' }] });

// trigger → handler → decision ─No→ 401 end
//                              └Yes→ store → response(end); store ─async→ job
const nodes = [node('t', 'trigger', 1), node('h', 'server', 2), node('d', 'decision', 3), node('x', 'end', 500), node('s', 'store', 4), node('r', 'end', 5), node('j', 'job', 501)];
const edges = [edge('e1', 't', 'h'), edge('e2', 'h', 'd'), edge('e3', 'd', 'x', 'false', 'No'), edge('e4', 'd', 's', 'true', 'Yes'), edge('e5', 's', 'r'), edge('e6', 's', 'j', 'async')];

describe('flowchart view', () => {
  it('switches semantic levels so text stays at least 11px on screen', () => {
    expect(zoomLevel(1)).toBe('full');
    expect(zoomLevel(0.7)).toBe('full');
    expect(16 * 0.7).toBeGreaterThanOrEqual(11); // card text is 16px world
    expect(zoomLevel(0.69)).toBe('title');
    expect(28 * 0.4).toBeGreaterThanOrEqual(11); // title-only text is 28px world
    expect(zoomLevel(0.39)).toBe('shape');
  });

  it('fits content, anchors on the trigger at 0.85×, and zooms to the cursor', () => {
    const fit = fitView({ x: 0, y: 0, w: 2000, h: 400 }, 1000, 500);
    expect(fit.k).toBeCloseTo((1000 - 96) / 2000);
    const a = anchorView({ x: 100, y: 200, w: 232, h: 104 }, 1200, 600);
    expect(a.k).toBe(0.85);
    expect(100 * a.k + a.x).toBe(40);
    expect((200 + 52) * a.k + a.y).toBeCloseTo(300);
    const z = zoomAt({ x: 10, y: 20, k: 1 }, 2, 300, 200);
    // The world point under the cursor stays under the cursor.
    expect((300 - 10) / 1).toBeCloseTo((300 - z.x) / z.k);
    expect(zoomAt({ x: 0, y: 0, k: 2.4 }, 10, 0, 0).k).toBe(2.5);
    expect(zoomAt({ x: 0, y: 0, k: 0.2 }, 0.1, 0, 0).k).toBe(0.15);
  });

  it('keeps the flow reachable when panned away, and knows when nothing is visible', () => {
    const content = { x: 0, y: 0, w: 1000, h: 300 };
    const far = clampView({ x: -5000, y: 0, k: 1 }, content, 800, 600);
    expect((content.x + content.w) * far.k + far.x).toBeGreaterThanOrEqual(80);
    expect(anyVisible({ x: -5000, y: 0, k: 1 }, [{ x: 0, y: 0, w: 232, h: 104 }], 800, 600)).toBe(false);
    expect(anyVisible({ x: 0, y: 0, k: 1 }, [{ x: 0, y: 0, w: 232, h: 104 }], 800, 600)).toBe(true);
  });
});

describe('flowchart paths', () => {
  it('highlights the whole path through a selection', () => {
    const p = pathThrough('s', edges);
    expect([...p.nodes].sort()).toEqual(['d', 'h', 'j', 'r', 's', 't']);
    expect(p.nodes.has('x')).toBe(false);
  });

  it('collapsing a decision hides only its exit branch', () => {
    expect([...hiddenByCollapse(nodes, edges, new Set(['d']))]).toEqual(['x']);
    expect(hiddenByCollapse(nodes, edges, new Set()).size).toBe(0);
  });

  it('draws rounded orthogonal paths and finds points along them', () => {
    expect(roundedPath([[0, 0], [100, 0], [100, 50]])).toMatch(/^M0 0 L90 0 Q100 0 100 10 L100 50$/);
    expect(pointAlong([[0, 0], [100, 0], [100, 100]], 0.5)).toEqual([100, 0]);
    expect(pointAlong([[0, 0], [100, 0]], 0.25)).toEqual([25, 0]);
  });
});

describe('flowchart playback', () => {
  it('stops at a decision until a branch is chosen, then forks async work in parallel', () => {
    let p = startPlayback(nodes);
    expect(p.tokens).toEqual(['t']);
    p = stepPlayback(p, nodes, edges, { allPaths: false });
    p = stepPlayback(p, nodes, edges, { allPaths: false });
    expect(p.tokens).toEqual(['d']);
    p = stepPlayback(p, nodes, edges, { allPaths: false });
    expect(p.waiting).toBe('d');
    p = stepPlayback(p, nodes, edges, { allPaths: false, choice: 'e4' });
    expect(p.tokens).toEqual(['s']);
    expect(p.visitedNodes.has('x')).toBe(false);
    p = stepPlayback(p, nodes, edges, { allPaths: false });
    expect(p.tokens.sort()).toEqual(['j', 'r']); // response and the async job, in parallel
    expect(p.done).toBe(true);
  });

  it('runs every branch when asked to', () => {
    let p = startPlayback(nodes);
    for (let i = 0; i < 3; i++) p = stepPlayback(p, nodes, edges, { allPaths: true });
    expect(p.visitedNodes.has('x')).toBe(true);
    expect(p.visitedNodes.has('s')).toBe(true);
    expect(p.waiting).toBeNull();
  });
});
