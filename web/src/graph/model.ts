import { clusterKeys } from '@codepilot/analyzer/cluster';
import type { ComplexityFacts } from '@codepilot/analyzer/types';
import type { EdgeKind, GraphEdge, GraphSummary, NodeType, PositionedNode } from '../lib/api.ts';

export interface ModelNode {
  id: string;
  path: string;
  type: NodeType;
  directory: string;
  language: string;
  x: number;
  y: number;
  /** World-space radius (grows with connection count, so hubs read as hubs). */
  r: number;
  analyzed: boolean;
  loc?: number;
  complexity?: ComplexityFacts;
  exportsPreview: string[];
  exportCount: number;
  isTest: boolean;
  /** Directory cluster this node is drawn in. */
  cluster: string;
  /** Unique internal dependents / dependencies (file-to-file, resolved). */
  fanIn: number;
  fanOut: number;
  hub: boolean;
}

/** One drawn connection per (source, target) pair; `edges` lists the import statements behind it. */
export interface VisualPair {
  s: number;
  t: number;
  edges: number[];
  kinds: EdgeKind[];
  resolved: boolean;
  typeOnly: boolean;
  /** Every statement behind the pair is a dynamic import(). */
  dynamic: boolean;
  /** Imported symbols across the statements (namespace/default/side effect count as one). */
  weight: number;
  /** Both ends are in the same strongly connected component, i.e. the edge lies on an import cycle. */
  cycle: boolean;
}

/** Evidence-backed health conditions for a file (thresholds are relative to this repository). */
export interface Health {
  cycle: boolean;
  orphan: boolean;
  highFanIn: boolean;
  highFanOut: boolean;
}

const TEST_PATH = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(__tests__|__mocks__|tests?|e2e)\//;

export class GraphModel {
  readonly nodes: ModelNode[];
  readonly edges: GraphEdge[];
  readonly index = new Map<string, number>();
  readonly pairs: VisualPair[] = [];
  readonly outPairs: number[][];
  readonly inPairs: number[][];
  readonly cycles: GraphSummary['cycles'];
  /** Node index → cycle indices it belongs to. */
  readonly cycleOf = new Map<number, number[]>();
  readonly orphans: Set<number>;
  readonly entryPoints: Set<number>;
  readonly thresholds: { fanIn: number; fanOut: number };

  constructor(nodes: PositionedNode[], edges: GraphEdge[], extra: { cycles?: GraphSummary['cycles']; orphans?: string[]; entryPoints?: string[] } = {}) {
    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    const clusters = clusterKeys(nodes);
    this.nodes = nodes.map((n, i) => {
      this.index.set(n.id, i);
      return {
        id: n.id,
        path: n.path,
        type: n.type,
        directory: n.directory,
        language: n.language,
        x: n.x,
        y: n.y,
        r: 3.6 + Math.min(7, Math.sqrt(degree.get(n.id) ?? 0) * 1.15),
        analyzed: n.analyzed,
        loc: n.loc,
        complexity: n.complexity,
        exportsPreview: n.exportsPreview ?? [],
        exportCount: n.exportCount ?? 0,
        isTest: TEST_PATH.test(n.path) || n.classification_evidence?.[0]?.rule === 'path:test',
        cluster: clusters.get(n.id) ?? n.directory,
        fanIn: 0,
        fanOut: 0,
        hub: false,
      };
    });
    this.edges = edges;
    this.outPairs = this.nodes.map(() => []);
    this.inPairs = this.nodes.map(() => []);
    const pairIndex = new Map<string, number>();
    edges.forEach((e, ei) => {
      const s = this.index.get(e.source);
      const t = this.index.get(e.target);
      if (s === undefined || t === undefined || s === t) return;
      const key = `${s}:${t}`;
      let pi = pairIndex.get(key);
      if (pi === undefined) {
        pi = this.pairs.length;
        pairIndex.set(key, pi);
        this.pairs.push({ s, t, edges: [], kinds: [], resolved: true, typeOnly: true, dynamic: true, weight: 0, cycle: false });
        this.outPairs[s].push(pi);
        this.inPairs[t].push(pi);
      }
      const p = this.pairs[pi];
      p.edges.push(ei);
      if (!p.kinds.includes(e.kind)) p.kinds.push(e.kind);
      p.resolved &&= e.resolved;
      p.typeOnly &&= e.typeOnly;
      p.dynamic &&= e.kind === 'dynamic';
      p.weight += Math.max(1, e.symbols.filter((sym) => sym !== '*' && sym !== 'default').length || 1);
    });

    // Internal fan-in / fan-out.
    for (const p of this.pairs) {
      if (!p.resolved || this.nodes[p.t].type === 'external') continue;
      this.nodes[p.s].fanOut++;
      this.nodes[p.t].fanIn++;
    }
    const files = this.nodes.filter((n) => n.type !== 'external' && n.type !== 'unresolved');
    const p95 = (vals: number[]) => {
      const sorted = vals.filter((v) => v > 0).sort((a, b) => a - b);
      return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;
    };
    this.thresholds = { fanIn: Math.max(8, p95(files.map((n) => n.fanIn))), fanOut: Math.max(8, p95(files.map((n) => n.fanOut))) };
    const degrees = files.map((n) => n.fanIn + n.fanOut).sort((a, b) => b - a);
    const hubCut = Math.max(6, degrees[Math.floor(degrees.length * 0.03)] ?? 0);
    for (const n of files) n.hub = n.fanIn + n.fanOut >= hubCut;

    this.cycles = extra.cycles ?? [];
    this.cycles.forEach((c, ci) => {
      const members = new Set(c.members.map((m) => this.index.get(m)).filter((x): x is number => x !== undefined));
      for (const m of members) this.cycleOf.set(m, [...(this.cycleOf.get(m) ?? []), ci]);
      for (const m of members) for (const pi of this.outPairs[m]) if (members.has(this.pairs[pi].t)) this.pairs[pi].cycle = true;
    });
    this.orphans = new Set((extra.orphans ?? []).map((id) => this.index.get(id)).filter((x): x is number => x !== undefined));
    this.entryPoints = new Set((extra.entryPoints ?? []).map((id) => this.index.get(id)).filter((x): x is number => x !== undefined));
  }

  health(i: number): Health {
    const n = this.nodes[i];
    return {
      cycle: this.cycleOf.has(i),
      orphan: this.orphans.has(i),
      highFanIn: n.fanIn >= this.thresholds.fanIn,
      highFanOut: n.fanOut >= this.thresholds.fanOut,
    };
  }

  /** Shortest directed dependency path from a to b over resolved file imports, or null. */
  shortestPath(a: number, b: number): number[] | null {
    const prev = new Map<number, number>([[a, -1]]);
    const queue = [a];
    while (queue.length) {
      const v = queue.shift()!;
      if (v === b) break;
      for (const pi of this.outPairs[v]) {
        const p = this.pairs[pi];
        if (!p.resolved || prev.has(p.t)) continue;
        prev.set(p.t, pi);
        queue.push(p.t);
      }
    }
    if (!prev.has(b) || a === b) return null;
    const out: number[] = [];
    for (let v = b; v !== a; ) {
      const pi = prev.get(v)!;
      out.push(pi);
      v = this.pairs[pi].s;
    }
    return out.reverse();
  }
}

export interface Filters {
  types: Set<NodeType>;
  /** null means every directory. */
  directories: Set<string> | null;
  kinds: Set<EdgeKind>;
  showTypeOnly: boolean;
  hideTests: boolean;
}

export const FILE_TYPES: NodeType[] = ['page', 'route', 'api', 'component', 'action', 'service', 'utility', 'config', 'other'];
export const ALL_KINDS: EdgeKind[] = ['static', 'dynamic', 're-export', 'require'];

export function defaultFilters(): Filters {
  return {
    // External packages are grouped out of the way by default; unresolved imports stay visible.
    types: new Set<NodeType>([...FILE_TYPES, 'unresolved']),
    directories: null,
    kinds: new Set(ALL_KINDS),
    showTypeOnly: true,
    hideTests: false,
  };
}

export interface Visibility {
  nodes: Uint8Array;
  pairs: Uint8Array;
  nodeCount: number;
  pairCount: number;
}

export function computeVisibility(model: GraphModel, f: Filters): Visibility {
  const nodes = new Uint8Array(model.nodes.length);
  let nodeCount = 0;
  model.nodes.forEach((n, i) => {
    const isFile = n.type !== 'external' && n.type !== 'unresolved';
    const ok = f.types.has(n.type) && (!isFile || !f.directories || f.directories.has(n.directory)) && !(f.hideTests && n.isTest);
    if (ok) {
      nodes[i] = 1;
      nodeCount++;
    }
  });
  const pairs = new Uint8Array(model.pairs.length);
  let pairCount = 0;
  model.pairs.forEach((p, i) => {
    if (!nodes[p.s] || !nodes[p.t]) return;
    const ok = p.edges.some((ei) => {
      const e = model.edges[ei];
      return f.kinds.has(e.kind) && (f.showTypeOnly || !e.typeOnly);
    });
    if (ok) {
      pairs[i] = 1;
      pairCount++;
    }
  });
  return { nodes, pairs, nodeCount, pairCount };
}

export const NodeState = { DIM: 0, NORMAL: 1, FOCUS: 2, DEPENDENCY: 3, CONSUMER: 4, BOTH: 5 } as const;
export const PairState = { DIM: 0, NORMAL: 1, OUTGOING: 2, INCOMING: 3 } as const;
/** Hop value for nodes and pairs outside the focus neighbourhood. */
export const UNRELATED = 255;

export interface Highlight {
  active: boolean;
  node: Uint8Array;
  pair: Uint8Array;
  /** Hop distance from the focus (0 for the focus itself, UNRELATED otherwise). */
  nodeHop: Uint8Array;
  pairHop: Uint8Array;
  /** Node indices reached as dependencies / consumers, with hop depth. */
  dependencies: Map<number, number>;
  consumers: Map<number, number>;
}

/** Opacity for hop distances when a node is selected: 1 hop 100%, 2 hops 45%, 3 hops 20%, unrelated 8%. */
export function hopAlpha(hop: number): number {
  return hop <= 1 ? 1 : hop === 2 ? 0.45 : hop === 3 ? 0.2 : 0.08;
}

/**
 * Hover/selection highlighting. From the focus node, outgoing edges (its dependencies) are
 * marked OUTGOING and drawn red; incoming edges (its consumers) are marked INCOMING and drawn
 * blue. Both come from the same stored edges — no reverse edges are invented. Everything else
 * is dimmed. `depth` follows transitive hops (1–3).
 */
export function computeHighlight(model: GraphModel, vis: Visibility, focus: number | null, depth = 1, pinned?: Set<number>): Highlight {
  const n = model.nodes.length;
  const node = new Uint8Array(n);
  const pair = new Uint8Array(model.pairs.length);
  const nodeHop = new Uint8Array(n).fill(UNRELATED);
  const pairHop = new Uint8Array(model.pairs.length).fill(UNRELATED);
  const dependencies = new Map<number, number>();
  const consumers = new Map<number, number>();

  if (focus === null && !pinned?.size) {
    node.fill(NodeState.NORMAL);
    pair.fill(PairState.NORMAL);
    nodeHop.fill(1);
    pairHop.fill(1);
    return { active: false, node, pair, nodeHop, pairHop, dependencies, consumers };
  }

  if (pinned?.size) {
    for (const i of pinned) {
      node[i] = NodeState.NORMAL;
      nodeHop[i] = 1;
    }
    model.pairs.forEach((p, pi) => {
      if (vis.pairs[pi] && pinned.has(p.s) && pinned.has(p.t)) {
        pair[pi] = PairState.OUTGOING;
        pairHop[pi] = 1;
      }
    });
  }

  if (focus !== null) {
    node[focus] = NodeState.FOCUS;
    nodeHop[focus] = 0;
    const walk = (dir: 'out' | 'in') => {
      const reached = dir === 'out' ? dependencies : consumers;
      let frontier = [focus];
      for (let d = 1; d <= depth && frontier.length; d++) {
        const next: number[] = [];
        for (const v of frontier) {
          for (const pi of dir === 'out' ? model.outPairs[v] : model.inPairs[v]) {
            if (!vis.pairs[pi]) continue;
            const p = model.pairs[pi];
            const other = dir === 'out' ? p.t : p.s;
            pair[pi] = dir === 'out' ? PairState.OUTGOING : pair[pi] === PairState.OUTGOING ? PairState.OUTGOING : PairState.INCOMING;
            pairHop[pi] = Math.min(pairHop[pi], d);
            if (other === focus || reached.has(other)) continue;
            reached.set(other, d);
            nodeHop[other] = Math.min(nodeHop[other], d);
            next.push(other);
          }
        }
        frontier = next;
      }
    };
    walk('out');
    walk('in');
    for (const i of dependencies.keys()) node[i] = consumers.has(i) ? NodeState.BOTH : NodeState.DEPENDENCY;
    for (const i of consumers.keys()) if (!dependencies.has(i)) node[i] = NodeState.CONSUMER;
  }
  return { active: true, node, pair, nodeHop, pairHop, dependencies, consumers };
}
