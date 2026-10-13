import type { DependencyGraph, GraphEdge, GraphNode, NodeType } from '@codepilot/analyzer/types';
import { computeLayout, LAYOUTS, type LayoutName, type Positions } from '@codepilot/analyzer/layout';
import type { Db } from './db.ts';

export interface GraphIndex {
  graph: DependencyGraph;
  nodeById: Map<string, GraphNode>;
  out: Map<string, GraphEdge[]>;
  in: Map<string, GraphEdge[]>;
}

export function isLayout(v: unknown): v is LayoutName {
  return typeof v === 'string' && (LAYOUTS as readonly string[]).includes(v);
}

export function buildIndex(graph: DependencyGraph): GraphIndex {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const out = new Map<string, GraphEdge[]>();
  const inn = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) {
    if (!out.has(e.source)) out.set(e.source, []);
    out.get(e.source)!.push(e);
    if (!inn.has(e.target)) inn.set(e.target, []);
    inn.get(e.target)!.push(e);
  }
  return { graph, nodeById, out, in: inn };
}

/** Internal (file→file, resolved) neighbours, reached through at most `depth` hops. */
export function transitive(index: GraphIndex, start: string, direction: 'out' | 'in', maxDepth: number): { id: string; depth: number }[] {
  const seen = new Map<string, number>([[start, 0]]);
  let frontier = [start];
  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of (direction === 'out' ? index.out : index.in).get(id) ?? []) {
        if (!e.resolved || e.external) continue;
        const other = direction === 'out' ? e.target : e.source;
        if (!seen.has(other)) {
          seen.set(other, depth);
          next.push(other);
        }
      }
    }
    frontier = next;
  }
  seen.delete(start);
  return [...seen].map(([id, depth]) => ({ id, depth })).sort((a, b) => a.depth - b.depth || (a.id < b.id ? -1 : 1));
}

export function nodeDetails(index: GraphIndex, nodeId: string) {
  const node = index.nodeById.get(nodeId);
  if (!node) return null;
  const { graph } = index;
  const outgoing = index.out.get(nodeId) ?? [];
  const incoming = index.in.get(nodeId) ?? [];
  const typeOf = (id: string): NodeType | undefined => index.nodeById.get(id)?.type;

  const imports = outgoing.map((e) => ({
    edgeId: e.id,
    target: e.target,
    targetPath: index.nodeById.get(e.target)?.path ?? e.target,
    targetType: typeOf(e.target),
    specifier: e.specifier,
    symbols: e.symbols,
    kind: e.kind,
    line: e.line,
    resolved: e.resolved,
    external: e.external,
    typeOnly: e.typeOnly,
    resolution: e.resolution,
    unresolvedReason: e.unresolved_reason,
  }));
  const consumers = incoming.map((e) => ({
    edgeId: e.id,
    source: e.source,
    sourceType: typeOf(e.source),
    specifier: e.specifier,
    symbols: e.symbols,
    kind: e.kind,
    line: e.line,
    typeOnly: e.typeOnly,
  }));
  const dependencies = [...new Set(outgoing.filter((e) => e.resolved && !e.external).map((e) => e.target))].sort();
  const dependents = [...new Set(incoming.map((e) => e.source))].sort();
  const deps3 = transitive(index, nodeId, 'out', 3);
  const dependents3 = transitive(index, nodeId, 'in', 3);
  const byDepth = (list: { id: string; depth: number }[]) => ({
    1: list.filter((x) => x.depth === 1).map((x) => x.id),
    2: list.filter((x) => x.depth === 2).map((x) => x.id),
    3: list.filter((x) => x.depth === 3).map((x) => x.id),
  });

  return {
    node,
    facts: graph.files[nodeId] ?? { exports: [], diagnostics: [] },
    imports,
    consumers,
    dependencies,
    dependents,
    counts: {
      dependencies: dependencies.length,
      dependents: dependents.length,
      externalImports: outgoing.filter((e) => e.external).length,
      unresolvedImports: outgoing.filter((e) => !e.resolved).length,
    },
    transitive: { dependencies: byDepth(deps3), dependents: byDepth(dependents3) },
    entryPoint: graph.summary.entryPoints.find((e) => e.id === nodeId)?.reasons ?? null,
    orphan: graph.summary.orphans.some((o) => o.id === nodeId),
    cycles: graph.summary.cycles.map((c, i) => (c.members.includes(nodeId) ? i : -1)).filter((i) => i >= 0),
  };
}

export interface GraphQuery {
  types?: string[];
  focus?: string;
  depth?: number;
}

/** Filter by node type and/or restrict to a neighbourhood around a focus node (both directions). */
export function selectSubgraph(index: GraphIndex, q: GraphQuery): { nodes: GraphNode[]; edges: GraphEdge[] } {
  let keep: Set<string> | null = null;
  if (q.types?.length) {
    const types = new Set(q.types);
    keep = new Set(index.graph.nodes.filter((n) => types.has(n.type)).map((n) => n.id));
  }
  if (q.focus && index.nodeById.has(q.focus)) {
    const depth = Math.min(Math.max(q.depth ?? 1, 1), 3);
    const near = new Set([q.focus]);
    let frontier = [q.focus];
    for (let d = 0; d < depth; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const e of [...(index.out.get(id) ?? []), ...(index.in.get(id) ?? [])]) {
          const other = e.source === id ? e.target : e.source;
          if (!near.has(other)) {
            near.add(other);
            next.push(other);
          }
        }
      }
      frontier = next;
    }
    keep = keep ? new Set([...keep].filter((id) => near.has(id))) : near;
  }
  if (!keep) return { nodes: index.graph.nodes, edges: index.graph.edges };
  const k = keep;
  return { nodes: index.graph.nodes.filter((n) => k.has(n.id)), edges: index.graph.edges.filter((e) => k.has(e.source) && k.has(e.target)) };
}

export class GraphStore {
  private readonly cache = new Map<string, GraphIndex>();

  constructor(private readonly db: Db) {}

  save(analysisId: string, graph: DependencyGraph) {
    this.db.prepare('INSERT OR REPLACE INTO graphs (analysis_id, graph_json) VALUES (?, ?)').run(analysisId, JSON.stringify(graph));
    this.remember(analysisId, buildIndex(graph));
  }

  load(analysisId: string): GraphIndex | null {
    const hit = this.cache.get(analysisId);
    if (hit) {
      this.cache.delete(analysisId);
      this.cache.set(analysisId, hit);
      return hit;
    }
    const row = this.db.prepare('SELECT graph_json FROM graphs WHERE analysis_id = ?').get(analysisId) as { graph_json: string } | undefined;
    if (!row) return null;
    const index = buildIndex(JSON.parse(row.graph_json) as DependencyGraph);
    this.remember(analysisId, index);
    return index;
  }

  /** Layout positions are computed once per analysis and layout, then stored — reloads are stable. */
  positions(analysisId: string, layout: LayoutName): Positions {
    const row = this.db.prepare('SELECT positions_json FROM layouts WHERE analysis_id = ? AND layout = ?').get(analysisId, layout) as { positions_json: string } | undefined;
    if (row) return JSON.parse(row.positions_json) as Positions;
    const index = this.load(analysisId);
    if (!index) return {};
    const positions = computeLayout(
      index.graph.nodes.map((n) => ({ id: n.id, type: n.type, directory: n.directory, path: n.path })),
      index.graph.edges,
      layout,
    );
    this.db.prepare('INSERT OR REPLACE INTO layouts (analysis_id, layout, positions_json) VALUES (?, ?, ?)').run(analysisId, layout, JSON.stringify(positions));
    return positions;
  }

  private remember(id: string, index: GraphIndex) {
    this.cache.set(id, index);
    while (this.cache.size > 12) this.cache.delete(this.cache.keys().next().value!);
  }
}
