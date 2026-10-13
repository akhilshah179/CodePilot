import { describe, expect, it } from 'vitest';
import type { GraphEdge, PositionedNode } from '../lib/api.ts';
import { searchPaths } from '../lib/search.ts';
import { computeHighlight, computeVisibility, defaultFilters, GraphModel, NodeState, PairState } from './model.ts';
import { pickNeighbor } from './navigation.ts';

const node = (id: string, x: number, y: number, type: PositionedNode['type'] = 'utility'): PositionedNode => ({
  id,
  path: id,
  type,
  language: 'typescript',
  size: 10,
  classification_evidence: [],
  directory: 'src',
  analyzed: true,
  x,
  y,
});

const edge = (source: string, target: string, extra: Partial<GraphEdge> = {}): GraphEdge => ({
  id: `${source}->${target}`,
  source,
  target,
  symbols: [],
  kind: 'static',
  line: 1,
  resolved: true,
  specifier: target,
  typeOnly: false,
  external: false,
  ...extra,
});

// app → lib → util ; page → app ; test → app ; ext:react (external)
const nodes = [node('app', 0, 0), node('lib', 100, 0), node('util', 200, 0), node('page', 0, -100, 'page'), node('test', 0, 100), node('ext:react', -100, 0, 'external')];
const edges = [edge('app', 'lib'), edge('lib', 'util'), edge('page', 'app'), edge('test', 'app'), edge('app', 'ext:react', { external: true })];

describe('graph highlighting', () => {
  const model = new GraphModel(nodes, edges);
  const vis = computeVisibility(model, defaultFilters());
  const i = (id: string) => model.index.get(id)!;
  const pairOf = (s: string, t: string) => model.pairs.findIndex((p) => p.s === i(s) && p.t === i(t));

  it('marks outgoing edges as dependencies (red) and incoming edges as consumers (blue)', () => {
    const h = computeHighlight(model, vis, i('app'), 1);
    expect(h.node[i('app')]).toBe(NodeState.FOCUS);
    expect(h.node[i('lib')]).toBe(NodeState.DEPENDENCY);
    expect(h.node[i('page')]).toBe(NodeState.CONSUMER);
    expect(h.node[i('test')]).toBe(NodeState.CONSUMER);
    expect(h.node[i('util')]).toBe(NodeState.DIM);
    expect(h.pair[pairOf('app', 'lib')]).toBe(PairState.OUTGOING);
    expect(h.pair[pairOf('page', 'app')]).toBe(PairState.INCOMING);
    expect(h.pair[pairOf('lib', 'util')]).toBe(PairState.DIM);
  });

  it('uses the stored edge direction only — consumers are the sources of incoming edges', () => {
    const h = computeHighlight(model, vis, i('lib'), 1);
    expect([...h.consumers.keys()]).toEqual([i('app')]);
    expect([...h.dependencies.keys()]).toEqual([i('util')]);
    // Number of drawn pairs equals number of stored relationships (no synthetic reverse edges).
    expect(model.pairs).toHaveLength(edges.length);
  });

  it('follows transitive depth', () => {
    const h = computeHighlight(model, vis, i('app'), 2);
    expect(h.dependencies.get(i('util'))).toBe(2);
    expect(h.pair[pairOf('lib', 'util')]).toBe(PairState.OUTGOING);
  });

  it('hides external packages by default and ignores hidden edges when highlighting', () => {
    expect(vis.nodes[i('ext:react')]).toBe(0);
    const h = computeHighlight(model, vis, i('app'), 1);
    expect(h.dependencies.has(i('ext:react'))).toBe(false);
  });

  it('clears to the neutral state with no focus', () => {
    const h = computeHighlight(model, vis, null);
    expect(h.active).toBe(false);
    expect([...h.node].every((s) => s === NodeState.NORMAL)).toBe(true);
  });
});

describe('keyboard navigation', () => {
  const model = new GraphModel(nodes, edges);
  const vis = computeVisibility(model, defaultFilters());
  const i = (id: string) => model.index.get(id)!;

  it('moves between connected nodes in the arrow direction', () => {
    expect(pickNeighbor(model, vis, i('app'), 'right')).toBe(i('lib'));
    expect(pickNeighbor(model, vis, i('app'), 'up')).toBe(i('page'));
    expect(pickNeighbor(model, vis, i('app'), 'down')).toBe(i('test'));
    // ext:react is to the left but hidden; nothing else is connected there.
    expect(pickNeighbor(model, vis, i('app'), 'left')).toBeNull();
    // util is to the right of app but not directly connected.
    expect(pickNeighbor(model, vis, i('lib'), 'right')).toBe(i('util'));
  });
});

describe('search', () => {
  const paths = ['src/components/Button.tsx', 'src/lib/button-utils.ts', 'src/pages/index.tsx', 'server/src/routes/projects.ts'];
  it('ranks exact file names first, then prefixes, then paths', () => {
    expect(searchPaths(paths, (p) => p, 'button').map((h) => h.item)).toEqual(['src/components/Button.tsx', 'src/lib/button-utils.ts']);
    expect(searchPaths(paths, (p) => p, 'routes/').map((h) => h.item)).toEqual(['server/src/routes/projects.ts']);
    expect(searchPaths(paths, (p) => p, 'spi').map((h) => h.item)).toContain('src/pages/index.tsx');
    expect(searchPaths(paths, (p) => p, '')).toEqual([]);
  });
});
