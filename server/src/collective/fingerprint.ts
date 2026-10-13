import type { DependencyGraph } from '@codepilot/analyzer';
import type { Architecture } from '@codepilot/analyzer/architecture';
import {
  APP_BUCKETS,
  COUNT_BUCKETS,
  CYCLE_BUCKETS,
  DENSITY_BUCKETS,
  FAN_IN_BUCKETS,
  FAN_OUT_BUCKETS,
  FINGERPRINT_VERSION,
  isRelation,
  LAYER_LIST,
  LOC_BUCKETS,
  PATTERNS,
  TOOL_CATEGORIES,
  validateFingerprint,
  type Fingerprint,
} from './schema.ts';

/*
 * Deterministic extraction of a structural fingerprint from CodePilot's existing analysis — the
 * dependency graph and the detected architecture. Same input, same fingerprint. Every value is
 * bucketed or taken from a fixed vocabulary, and the result is validated against the allowlist
 * before anyone can store it.
 */

/** Bucket `n` by inclusive upper bounds: `bounds[i]` is the largest value of bucket `labels[i]`. */
function bucket<T extends string>(n: number, bounds: number[], labels: readonly T[]): T {
  for (let i = 0; i < bounds.length; i++) if (n <= bounds[i]) return labels[i];
  return labels[labels.length - 1];
}

export const countBucket = (n: number) => bucket(n, [0, 9, 49, 99, 249, 499, 999, 2499, 4999, 9999], COUNT_BUCKETS);
export const locBucket = (n: number) => bucket(n, [999, 4999, 19999, 49999, 99999, 249999, 999999], LOC_BUCKETS);
export const densityBucket = (r: number) => (r < 1 ? '<1' : r < 2 ? '1-2' : r < 4 ? '2-4' : r < 8 ? '4-8' : '8+') as (typeof DENSITY_BUCKETS)[number];
export const fanOutBucket = (n: number) => bucket(n, [2, 5, 10, 20], FAN_OUT_BUCKETS);
export const fanInBucket = (n: number) => bucket(n, [5, 20, 50, 100], FAN_IN_BUCKETS);
export const cycleBucket = (n: number) => bucket(n, [0, 1, 5, 20], CYCLE_BUCKETS);
export const appBucket = (n: number) => bucket(n, [0, 1, 2, 5], APP_BUCKETS);
export const sizeBand = (files: number) => (files < 100 ? 'small' : files < 1000 ? 'medium' : 'large') as Fingerprint['size']['band'];

/** Month (UTC) of a timestamp: the only time information a fingerprint carries. */
export const monthOf = (iso: string) => iso.slice(0, 7);

const uniqSorted = <T extends string>(xs: T[]) => [...new Set(xs)].sort();

export interface StructuralMetrics {
  files: number;
  loc: number;
  edges: number;
  fanOutP90: number;
  fanInMax: number;
  cycles: number;
}

/** Exact metrics of one project — used for the project's own side of a benchmark, never stored collectively. */
export function structuralMetrics(graph: DependencyGraph): StructuralMetrics {
  const files = graph.nodes.filter((n) => n.type !== 'external' && n.type !== 'unresolved');
  const internal = graph.edges.filter((e) => e.resolved && !e.external);
  const outs = new Map<string, Set<string>>();
  const ins = new Map<string, Set<string>>();
  for (const e of internal) {
    if (!outs.has(e.source)) outs.set(e.source, new Set());
    outs.get(e.source)!.add(e.target);
    if (!ins.has(e.target)) ins.set(e.target, new Set());
    ins.get(e.target)!.add(e.source);
  }
  const fanOut = files.filter((n) => n.analyzed).map((n) => outs.get(n.id)?.size ?? 0).sort((a, b) => a - b);
  const p90 = fanOut.length ? fanOut[Math.min(fanOut.length - 1, Math.floor(fanOut.length * 0.9))] : 0;
  return {
    files: files.length,
    loc: files.reduce((s, n) => s + (n.loc ?? 0), 0),
    edges: internal.length,
    fanOutP90: p90,
    fanInMax: Math.max(0, ...[...ins.values()].map((s) => s.size)),
    cycles: graph.summary.cycles.length,
  };
}

export function extractFingerprint(graph: DependencyGraph, arch: Architecture, analyzedAt: string): Fingerprint {
  const m = structuralMetrics(graph);
  const nodesByType: Fingerprint['nodesByType'] = {};
  for (const [type, n] of Object.entries(graph.summary.countsByType).sort(([a], [b]) => a.localeCompare(b))) if (n > 0) nodesByType[type as keyof typeof nodesByType] = countBucket(n);

  const categoryOf = new Map(arch.nodes.map((n) => [n.id, n.kind === 'app' ? 'application' : n.category]));
  const isCategory = (c: string | undefined): c is (typeof TOOL_CATEGORIES)[number] => !!c && (TOOL_CATEGORIES as readonly string[]).includes(c);
  const relations = arch.edges.flatMap((e) => {
    const s = categoryOf.get(e.source);
    const t = categoryOf.get(e.target);
    if (!isCategory(s) || !isCategory(t)) return [];
    return e.labels.map((l) => `${s}>${t}:${l}`).filter(isRelation);
  });
  const pattern = arch.summary.patterns[0]?.name;
  const layers = uniqSorted(arch.layers.filter((l) => (LAYER_LIST as readonly string[]).includes(l)));

  return validateFingerprint({
    v: FINGERPRINT_VERSION,
    month: monthOf(analyzedAt),
    size: { files: countBucket(m.files), loc: locBucket(m.loc), band: sizeBand(m.files) },
    nodesByType,
    topology: {
      edges: countBucket(m.edges),
      density: densityBucket(m.files ? m.edges / m.files : 0),
      fanOutP90: fanOutBucket(m.fanOutP90),
      fanInMax: fanInBucket(m.fanInMax),
      cycles: cycleBucket(m.cycles),
    },
    architecture: {
      pattern: pattern && (PATTERNS as readonly string[]).includes(pattern) ? pattern : 'undetermined',
      layers,
      layerCount: String(layers.length),
      apps: appBucket(arch.nodes.filter((n) => n.kind === 'app').length),
      toolCategories: uniqSorted(arch.nodes.filter((n) => n.kind !== 'app').map((n) => n.category).filter(isCategory)),
      relations: uniqSorted(relations).slice(0, 120),
    },
    risks: uniqSorted(arch.summary.risks.map((r) => r.code)),
    strengths: uniqSorted(arch.summary.strengths.map((r) => r.code)),
  });
}
