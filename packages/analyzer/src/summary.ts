import { FILE_NODE_TYPES, type CycleChain, type EntryPoint, type FileNodeType, type GraphEdge, type GraphNode, type GraphSummary, type RankedNode } from './types.ts';

interface PairInfo {
  line: number;
  typeOnly: boolean;
}

/** Unique file→file dependencies (resolved, internal). Multiple import statements between the same pair collapse to one. */
export function internalPairs(edges: GraphEdge[]): Map<string, Map<string, PairInfo>> {
  const out = new Map<string, Map<string, PairInfo>>();
  for (const e of edges) {
    if (!e.resolved || e.external) continue;
    let targets = out.get(e.source);
    if (!targets) out.set(e.source, (targets = new Map()));
    const prev = targets.get(e.target);
    if (!prev) targets.set(e.target, { line: e.line, typeOnly: e.typeOnly });
    else targets.set(e.target, { line: Math.min(prev.line, e.line), typeOnly: prev.typeOnly && e.typeOnly });
  }
  return out;
}

/** Tarjan's strongly connected components (iterative, deterministic order). */
export function stronglyConnected(ids: string[], adj: Map<string, Map<string, PairInfo>>): string[][] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result: string[][] = [];

  for (const start of ids) {
    if (idx.has(start)) continue;
    const work: { v: string; it: Iterator<string> }[] = [];
    const push = (v: string) => {
      idx.set(v, index);
      low.set(v, index);
      index++;
      stack.push(v);
      onStack.add(v);
      work.push({ v, it: [...(adj.get(v)?.keys() ?? [])].sort()[Symbol.iterator]() });
    };
    push(start);
    while (work.length) {
      const frame = work[work.length - 1];
      const next = frame.it.next();
      if (!next.done) {
        const w = next.value;
        if (!idx.has(w)) push(w);
        else if (onStack.has(w)) low.set(frame.v, Math.min(low.get(frame.v)!, idx.get(w)!));
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1].v;
        low.set(parent, Math.min(low.get(parent)!, low.get(frame.v)!));
      }
      if (low.get(frame.v) === idx.get(frame.v)) {
        const comp: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          comp.push(w);
        } while (w !== frame.v);
        result.push(comp.sort());
      }
    }
  }
  return result;
}

/** Shortest cycle through `start` restricted to `members` (BFS). */
function shortestCycle(start: string, members: Set<string>, adj: Map<string, Map<string, PairInfo>>): string[] {
  const prev = new Map<string, string>();
  const queue = [start];
  const seen = new Set([start]);
  while (queue.length) {
    const v = queue.shift()!;
    for (const w of [...(adj.get(v)?.keys() ?? [])].sort()) {
      if (!members.has(w)) continue;
      if (w === start) {
        const pathNodes = [v];
        let cur = v;
        while (cur !== start) {
          cur = prev.get(cur)!;
          pathNodes.push(cur);
        }
        return pathNodes.reverse();
      }
      if (!seen.has(w)) {
        seen.add(w);
        prev.set(w, v);
        queue.push(w);
      }
    }
  }
  return [start];
}

export function findCycles(fileIds: string[], edges: GraphEdge[], limit = 100): CycleChain[] {
  const adj = internalPairs(edges);
  const sccs = stronglyConnected([...fileIds].sort(), adj);
  const cycles: CycleChain[] = [];
  for (const comp of sccs) {
    const selfLoop = comp.length === 1 && adj.get(comp[0])?.has(comp[0]);
    if (comp.length < 2 && !selfLoop) continue;
    const members = new Set(comp);
    const nodesInCycle = shortestCycle(comp[0], members, adj);
    const chain = nodesInCycle.map((source, i) => {
      const target = nodesInCycle[(i + 1) % nodesInCycle.length];
      return { source, target, line: adj.get(source)!.get(target)!.line };
    });
    const typeOnly = chain.every((hop) => adj.get(hop.source)!.get(hop.target)!.typeOnly);
    cycles.push({ members: comp, chain, typeOnly });
  }
  cycles.sort((a, b) => b.members.length - a.members.length || (a.members[0] < b.members[0] ? -1 : 1));
  return cycles.slice(0, limit);
}

export function computeSummary(nodes: GraphNode[], edges: GraphEdge[], entryPoints: EntryPoint[]): GraphSummary {
  const fileNodes = nodes.filter((n) => n.type !== 'external' && n.type !== 'unresolved');
  const adj = internalPairs(edges);

  const consumers = new Map<string, Set<string>>();
  let dependencies = 0;
  for (const [source, targets] of adj) {
    for (const target of targets.keys()) {
      dependencies++;
      if (!consumers.has(target)) consumers.set(target, new Set());
      consumers.get(target)!.add(source);
    }
  }

  const rank = (entries: [string, number][]): RankedNode[] =>
    entries
      .filter(([, c]) => c > 0)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 10)
      .map(([id, count]) => ({ id, count }));

  const countsByType = Object.fromEntries(FILE_NODE_TYPES.map((t) => [t, 0])) as Record<FileNodeType, number>;
  for (const n of fileNodes) countsByType[n.type as FileNodeType]++;

  const entryIds = new Set(entryPoints.map((e) => e.id));
  const orphans = fileNodes
    .filter((n) => n.analyzed && n.type !== 'config' && !entryIds.has(n.id) && !consumers.has(n.id))
    .map((n) => ({ id: n.id, hasDependencies: (adj.get(n.id)?.size ?? 0) > 0 }));

  const externalEdges = edges.filter((e) => e.external);

  return {
    totals: {
      files: fileNodes.length,
      analyzedFiles: fileNodes.filter((n) => n.analyzed).length,
      dependencies,
      externalImports: externalEdges.length,
      externalPackages: new Set(externalEdges.map((e) => e.target)).size,
      unresolvedImports: edges.filter((e) => !e.resolved).length,
    },
    countsByType,
    mostDependedOn: rank([...consumers.entries()].map(([id, s]) => [id, s.size])),
    mostDependencies: rank([...adj.entries()].map(([id, t]) => [id, t.size])),
    cycles: findCycles(fileNodes.map((n) => n.id), edges),
    orphans,
    entryPoints,
  };
}
