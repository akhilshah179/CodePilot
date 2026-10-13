import { createHash } from 'node:crypto';
import { APP_BUCKETS, COUNT_BUCKETS, CYCLE_BUCKETS, DENSITY_BUCKETS, FAN_IN_BUCKETS, FAN_OUT_BUCKETS, LAYER_COUNTS, type Fingerprint } from './schema.ts';
import type { AggregateRow, DiscoveredPattern, StoredFingerprint } from './store.ts';

/*
 * Aggregate statistics over the collective dataset. Everything here is a population statistic:
 * counts of anonymized fingerprints in buckets. Results are withheld when the population is below
 * the minimum N, and individual cells with fewer than `minCell` projects are suppressed.
 */

export interface PrivacyPolicy {
  /** Minimum number of contributing projects in a population before any statistic about it is shown. */
  minN: number;
  /** Minimum count for a single cell (bucket, trait) to be shown as a number. */
  minCell: number;
}

/* ------------------------------------------------------------------ metrics and traits */

export interface MetricDef {
  id: string;
  label: string;
  definition: string;
  buckets: readonly string[];
  of(fp: Fingerprint): string;
}

export const METRICS: MetricDef[] = [
  { id: 'fanOutP90', label: 'Dependency fan-out', definition: 'Internal imports per file at the 90th percentile, as a range.', buckets: FAN_OUT_BUCKETS, of: (f) => f.topology.fanOutP90 },
  { id: 'fanInMax', label: 'Dependency concentration', definition: 'Files depending on the most-depended-on file, as a range.', buckets: FAN_IN_BUCKETS, of: (f) => f.topology.fanInMax },
  { id: 'density', label: 'Dependency density', definition: 'Resolved internal imports per source file, as a range.', buckets: DENSITY_BUCKETS, of: (f) => f.topology.density },
  { id: 'cycles', label: 'Circular import chains', definition: 'Number of import cycles, as a range.', buckets: CYCLE_BUCKETS, of: (f) => f.topology.cycles },
  { id: 'layerCount', label: 'Architecture layers', definition: 'Architecture layers present (clients, edge, application, data, async, external, delivery).', buckets: LAYER_COUNTS, of: (f) => f.architecture.layerCount },
  { id: 'apps', label: 'Applications', definition: 'Runnable applications built from the repository, as a range.', buckets: APP_BUCKETS, of: (f) => f.architecture.apps },
  { id: 'files', label: 'Size', definition: 'Source files, as a range.', buckets: COUNT_BUCKETS, of: (f) => f.size.files },
];

const FINDING_LABEL: Record<string, string> = {
  'async-background-work': 'background work runs outside the request path',
  'read-cache': 'reads are cached in front of slower calls',
  'ci-tests': 'CI runs the test suite',
  'container-healthchecks': 'containers declare health checks',
  'versioned-migrations': 'schema changes are versioned as migrations',
  'route-auth-checks': 'auth checks are visible on routes',
  'no-import-cycles': 'no circular imports',
  'credentials-in-source': 'credential-like values in source',
  'compose-plaintext-secrets': 'plain-text secrets in Compose files',
  'datastore-host-ports': 'data stores publish host ports',
  'shared-single-point-of-failure': 'a shared single point of failure',
  'cache-no-expiry': 'cache writes without expiry',
  'sync-external-calls-no-queue': 'requests wait on external calls with no queue',
  'import-cycles': 'circular import chains',
  'unpinned-image-tags': 'unpinned container image tags',
};

const BAND_LABEL: Record<string, string> = { small: 'small (under 100 files)', medium: 'medium (100–999 files)', large: 'large (1,000+ files)' };

/** Traits are the discrete, anonymized facts of a fingerprint that statistics are counted over. */
export function traitsOf(fp: Fingerprint): string[] {
  return [
    `pattern:${fp.architecture.pattern}`,
    `band:${fp.size.band}`,
    `cycles:${fp.topology.cycles === '0' ? 'absent' : 'present'}`,
    `layers:${fp.architecture.layerCount}`,
    ...fp.architecture.toolCategories.map((c) => `category:${c}`),
    ...fp.risks.map((r) => `risk:${r}`),
    ...fp.strengths.map((s) => `strength:${s}`),
  ];
}

export function traitLabel(t: string): string {
  const [family, ...rest] = t.split(':');
  const v = rest.join(':');
  switch (family) {
    case 'pattern':
      return `${v} architecture`;
    case 'band':
      return `${BAND_LABEL[v] ?? v} size`;
    case 'cycles':
      return v === 'present' ? 'at least one circular import chain' : 'no circular import chains';
    case 'layers':
      return `${v} architecture layer${v === '1' ? '' : 's'}`;
    case 'category':
      return v === 'service' ? 'calls an external service' : v === 'application' ? 'an application component' : `uses a ${v} technology`;
    case 'risk':
    case 'strength':
      return FINDING_LABEL[v] ?? v;
    case 'incident': {
      const [kind, x] = v.split(':');
      return `reported an incident on a ${kind === 'category' ? `${x} component` : `${x} file`}`;
    }
    default:
      return t;
  }
}

/* ------------------------------------------------------------------ populations */

export function populationsOf(fp: Fingerprint): string[] {
  return [`pattern=${fp.architecture.pattern};band=${fp.size.band}`, `band=${fp.size.band}`, 'all'];
}

export function describePopulation(key: string): string {
  if (key === 'all') return 'All projects contributing to Collective Intelligence.';
  const parts = Object.fromEntries(key.split(';').map((p) => p.split('=')));
  if (parts.pattern) return `Contributing projects with the same detected pattern (${parts.pattern}) and size band (${BAND_LABEL[parts.band] ?? parts.band}).`;
  return `Contributing projects of the same size band (${BAND_LABEL[parts.band] ?? parts.band}).`;
}

/** Recompute every aggregate from the projects that currently count. */
export function computeAggregates(population: StoredFingerprint[], outcomes: { contributor: string; element: string }[], month: string): AggregateRow[] {
  const incidents = new Map<string, Set<string>>();
  for (const o of outcomes) {
    if (!incidents.has(o.contributor)) incidents.set(o.contributor, new Set());
    incidents.get(o.contributor)!.add(o.element);
  }
  const rows = new Map<string, AggregateRow>();
  const row = (pop: string, metric: string) => {
    const k = `${pop}|${metric}`;
    if (!rows.has(k)) rows.set(k, { population: pop, metric, n: 0, counts: {}, computedMonth: month });
    return rows.get(k)!;
  };
  for (const f of population) {
    const reported = [...(incidents.get(f.contributor) ?? [])];
    // `reported:any` counts projects that report outcomes at all — the context every incident share needs.
    const traits = [...traitsOf(f.data), ...reported.map((e) => `incident:${e}`), ...(reported.length ? ['reported:any'] : [])];
    for (const pop of populationsOf(f.data)) {
      row(pop, 'n').n++;
      for (const m of METRICS) {
        const r = row(pop, m.id);
        r.n++;
        const b = m.of(f.data);
        r.counts[b] = (r.counts[b] ?? 0) + 1;
      }
      const t = row(pop, 'traits');
      t.n++;
      for (const tr of traits) t.counts[tr] = (t.counts[tr] ?? 0) + 1;
    }
  }
  return [...rows.values()];
}

export interface PopulationChoice {
  key: string;
  n: number;
  definition: string;
}

/** The most specific population with at least `minN` projects — or nothing, with the closest size. */
export function choosePopulation(fp: Fingerprint, sizeOf: (key: string) => number, policy: PrivacyPolicy): { chosen: PopulationChoice | null; considered: PopulationChoice[] } {
  const considered = populationsOf(fp).map((key) => ({ key, n: sizeOf(key), definition: describePopulation(key) }));
  return { chosen: considered.find((p) => p.n >= policy.minN) ?? null, considered };
}

/* ------------------------------------------------------------------ cells */

export interface Cell {
  /** Null when suppressed. */
  count: number | null;
  share: number | null;
  suppressed: boolean;
}

export function cell(count: number, n: number, policy: PrivacyPolicy): Cell {
  if (count > 0 && count < policy.minCell) return { count: null, share: null, suppressed: true };
  return { count, share: n ? count / n : 0, suppressed: false };
}

/* ------------------------------------------------------------------ benchmark */

export interface MetricBenchmark {
  metric: string;
  label: string;
  definition: string;
  n: number;
  thisProject: { bucket: string };
  distribution: ({ bucket: string; isThisProject: boolean } & Cell)[];
  position: { lower: Cell; same: Cell; higher: Cell };
}

export function benchmarkMetric(m: MetricDef, agg: AggregateRow, projectBucket: string, policy: PrivacyPolicy): MetricBenchmark {
  const idx = m.buckets.indexOf(projectBucket);
  let lower = 0;
  let higher = 0;
  m.buckets.forEach((b, i) => {
    const c = agg.counts[b] ?? 0;
    if (i < idx) lower += c;
    if (i > idx) higher += c;
  });
  return {
    metric: m.id,
    label: m.label,
    definition: m.definition,
    n: agg.n,
    thisProject: { bucket: projectBucket },
    distribution: m.buckets.map((b) => ({ bucket: b, isThisProject: b === projectBucket, ...cell(agg.counts[b] ?? 0, agg.n, policy) })),
    position: { lower: cell(lower, agg.n, policy), same: cell(agg.counts[projectBucket] ?? 0, agg.n, policy), higher: cell(higher, agg.n, policy) },
  };
}

/* ------------------------------------------------------------------ pattern discovery */

/** Pairs of traits that say the same thing; a rule between them would be a tautology, not a pattern. */
const EQUIVALENT: [string, string][] = [
  ['risk:import-cycles', 'cycles:present'],
  ['strength:no-import-cycles', 'cycles:absent'],
];
const tautology = (a: string[], b: string) => a.some((x) => x.split(':')[0] === b.split(':')[0] && (x.startsWith('cycles:') || x.startsWith('pattern:') || x.startsWith('band:') || x.startsWith('layers:'))) || EQUIVALENT.some(([x, y]) => (a.includes(x) && b === y) || (a.includes(y) && b === x));

const CONSEQUENT_FAMILIES = ['risk', 'strength', 'incident', 'cycles'];

/** Yates-corrected chi-square for a 2×2 table (1 degree of freedom). */
export function chiSquare(a: number, b: number, c: number, d: number): number {
  const n = a + b + c + d;
  const den = (a + b) * (c + d) * (a + c) * (b + d);
  if (!den) return 0;
  const diff = Math.max(0, Math.abs(a * d - b * c) - n / 2);
  return (n * diff * diff) / den;
}

/** χ² ≥ 6.63 corresponds to p < 0.01 at one degree of freedom. */
export const CHI2_P01 = 6.63;

/**
 * Association rules A → B over contributors' traits. A rule is kept only when the subgroup A is
 * itself k-anonymous (support ≥ minN), the co-occurrence clears the cell minimum, it is notably
 * more common than the baseline (lift ≥ 1.2) and unlikely to be chance (χ², p < 0.01).
 * These are correlations; discovery never publishes anything — every rule starts pending review.
 */
export function discoverPatterns(population: StoredFingerprint[], outcomes: { contributor: string; element: string }[], policy: PrivacyPolicy, month: string): Omit<DiscoveredPattern, 'status' | 'claim' | 'reviewNote' | 'reviewedMonth' | 'current'>[] {
  const N = population.length;
  if (N < policy.minN) return [];
  const incidents = new Map<string, string[]>();
  for (const o of outcomes) incidents.set(o.contributor, [...(incidents.get(o.contributor) ?? []), `incident:${o.element}`]);
  const tx = population.map((f) => new Set([...traitsOf(f.data), ...(incidents.get(f.contributor) ?? [])]));
  const support = (items: string[]) => tx.filter((t) => items.every((i) => t.has(i))).length;

  const items = [...new Set(tx.flatMap((t) => [...t]))].sort();
  const frequent = items.filter((i) => support([i]) >= policy.minN);
  const antecedents: string[][] = [...frequent.map((i) => [i])];
  for (let i = 0; i < frequent.length; i++)
    for (let j = i + 1; j < frequent.length; j++) {
      if (frequent[i].split(':')[0] === frequent[j].split(':')[0] && ['pattern', 'band', 'cycles', 'layers'].includes(frequent[i].split(':')[0])) continue;
      if (support([frequent[i], frequent[j]]) >= policy.minN) antecedents.push([frequent[i], frequent[j]]);
    }
  const consequents = items.filter((i) => CONSEQUENT_FAMILIES.includes(i.split(':')[0]));
  const out: ReturnType<typeof discoverPatterns> = [];
  for (const A of antecedents) {
    const sA = support(A);
    for (const B of consequents) {
      if (A.includes(B) || tautology(A, B)) continue;
      const sB = support([B]);
      const sAB = support([...A, B]);
      if (sAB < policy.minCell) continue;
      const confidence = sAB / sA;
      const baseline = sB / N;
      const lift = baseline ? confidence / baseline : 0;
      const chi2 = chiSquare(sAB, sA - sAB, sB - sAB, N - sA - sB + sAB);
      if (lift < 1.2 || chi2 < CHI2_P01) continue;
      const id = createHash('sha256').update(`${A.join('&')}=>${B}|all`).digest('hex').slice(0, 16);
      out.push({ id, antecedent: A, consequent: B, population: 'all', n: N, support: sAB, antecedentSupport: sA, confidence, baseline, lift, chi2, discoveredMonth: month });
    }
  }
  return out.sort((a, b) => b.lift - a.lift || a.id.localeCompare(b.id)).slice(0, 200);
}
