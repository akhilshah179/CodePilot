import { createHmac, hkdfSync } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { ArchitectureStore } from '../architectureStore.ts';
import { randomId } from '../crypto.ts';
import { now, type Db } from '../db.ts';
import { AppError } from '../errors.ts';
import type { GraphIndex, GraphStore } from '../graphStore.ts';
import { extractFingerprint, monthOf, structuralMetrics } from './fingerprint.ts';
import { FINGERPRINT_VERSION, OUTCOME_ELEMENTS, SCHEMA_DOC, TOOL_CATEGORIES, type Fingerprint } from './schema.ts';
import { benchmarkMetric, cell, choosePopulation, computeAggregates, describePopulation, discoverPatterns, METRICS, traitLabel, traitsOf, type PrivacyPolicy } from './stats.ts';
import type { CollectiveStore, DiscoveredPattern } from './store.ts';

/*
 * Collective Architecture Intelligence. Pipeline:
 *   analysis → architecture → consent check → structural fingerprint → isolated collective store
 *   → aggregation (k-anonymous) → benchmark / pattern insights.
 *
 * The bridge between a project and its collective rows is a keyed pseudonym (HMAC with a server
 * key derived from the token-encryption key). The collective database never sees project ids; the
 * server can recompute a project's pseudonym, which is what makes revocation and "show me what I
 * shared" possible.
 */

export const OBSERVATION_NOTE = 'Observed in anonymized contributing projects. A statistical observation about other projects — not evidence from this repository, not a prediction, and not a cause.';

interface Ctx {
  project: { id: string; user_id: string | null };
  analysis: { id: string; commit_sha: string | null; branch: string; finished_at: string | null; created_at: string };
  index: GraphIndex;
}

export class CollectiveService {
  private readonly key: Buffer;

  constructor(
    private readonly db: Db,
    readonly store: CollectiveStore,
    tokenKey: Buffer,
    readonly policy: PrivacyPolicy,
    private readonly graphs: GraphStore,
    private readonly architectures: ArchitectureStore,
    private readonly log?: FastifyBaseLogger,
  ) {
    this.key = Buffer.from(hkdfSync('sha256', tokenKey, Buffer.alloc(0), 'codepilot collective pseudonym v1', 32));
  }

  private hmac(s: string) {
    return createHmac('sha256', this.key).update(s).digest('hex').slice(0, 32);
  }

  /** Pseudonym of a project in the collective dataset. */
  contributorOf(projectId: string) {
    return this.hmac(`contributor:${projectId}`);
  }

  private snapshotOf(projectId: string, analysisId: string) {
    return this.hmac(`snapshot:${projectId}:${analysisId}`);
  }

  /* ------------------------------------------------------------ consent */

  isEnabled(projectId: string): boolean {
    const r = this.db.prepare('SELECT enabled FROM collective_consent WHERE project_id = ?').get(projectId) as { enabled: number } | undefined;
    return !!r?.enabled;
  }

  setConsent(project: Ctx['project'], userId: string, enabled: boolean) {
    if (project.user_id === null) throw new AppError('forbidden', 'The public sample project cannot contribute to Collective Intelligence.', 403);
    if (project.user_id !== userId) throw new AppError('not_found', 'Project not found.', 404);
    const was = this.isEnabled(project.id);
    const ts = now();
    let effect: Record<string, unknown> = { changed: was !== enabled };
    if (was !== enabled) {
      this.db.prepare('INSERT INTO collective_consent (project_id, enabled, updated_at) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at').run(project.id, enabled ? 1 : 0, ts);
      if (enabled) {
        const contributed = this.contributeLatest(project.id);
        effect = { ...effect, contributed };
        this.log?.info({ projectId: project.id }, 'collective consent granted');
      } else {
        const deactivated = this.store.deactivate(this.contributorOf(project.id));
        this.reaggregate();
        effect = { ...effect, deactivated };
      }
      this.db
        .prepare('INSERT INTO consent_log (id, project_id, user_id, action, schema_version, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(randomId(12), project.id, userId, enabled ? 'granted' : 'revoked', FINGERPRINT_VERSION, JSON.stringify(effect), ts);
    }
    return { enabled, effect };
  }

  /* ------------------------------------------------------------ contribution */

  private latestComplete(projectId: string) {
    return this.db.prepare("SELECT * FROM analyses WHERE project_id = ? AND status = 'complete' ORDER BY created_at DESC LIMIT 1").get(projectId) as Ctx['analysis'] | undefined;
  }

  /**
   * Contribute the fingerprint of an analysis — only with consent, and only when it is the
   * project's latest completed snapshot (viewing an older snapshot never makes it current).
   */
  contribute(projectId: string, analysisId: string): boolean {
    if (!this.isEnabled(projectId)) return false;
    const latest = this.latestComplete(projectId);
    if (!latest || latest.id !== analysisId) return false;
    const index = this.graphs.load(analysisId);
    if (!index) return false;
    const arch = this.architectures.get(projectId, latest, index).architecture;
    const fp = extractFingerprint(index.graph, arch, latest.finished_at ?? latest.created_at);
    this.store.putFingerprint(this.snapshotOf(projectId, analysisId), this.contributorOf(projectId), fp);
    // Incidents tagged before consent (or before this snapshot) join now as abstract outcomes.
    for (const t of this.db.prepare('SELECT id, element, occurred_month FROM incident_tags WHERE project_id = ?').all(projectId) as { id: string; element: string; occurred_month: string }[]) {
      this.store.putOutcome(this.hmac(`outcome:${t.id}`), this.contributorOf(projectId), t.element, t.occurred_month);
      this.db.prepare('UPDATE incident_tags SET contributed = 1 WHERE id = ?').run(t.id);
    }
    this.reaggregate();
    return true;
  }

  contributeLatest(projectId: string): boolean {
    const latest = this.latestComplete(projectId);
    if (!latest) return false;
    try {
      return this.contribute(projectId, latest.id);
    } catch (err) {
      this.log?.warn({ err, projectId }, 'collective contribution failed');
      return false;
    }
  }

  /** Recompute stored aggregates from the projects that currently count. */
  reaggregate() {
    const population = this.store.population();
    const counted = new Set(population.map((f) => f.contributor));
    const outcomes = this.store.activeOutcomes().filter((o) => counted.has(o.contributor));
    this.store.replaceAggregates(computeAggregates(population, outcomes, monthOf(now())));
  }

  /** Periodic discovery: new correlations wait for human review; nothing is published automatically. */
  discover(): { found: number; pending: number } {
    const population = this.store.population();
    const counted = new Set(population.map((f) => f.contributor));
    const outcomes = this.store.activeOutcomes().filter((o) => counted.has(o.contributor));
    const found = discoverPatterns(population, outcomes, this.policy, monthOf(now()));
    this.store.upsertPatterns(found);
    return { found: found.length, pending: this.store.patterns({ status: 'pending_review', currentOnly: true }).length };
  }

  /* ------------------------------------------------------------ status */

  status(projectId: string, isSample: boolean) {
    const contributor = this.contributorOf(projectId);
    const own = this.store.ownFingerprints(contributor);
    const history = this.db
      .prepare('SELECT c.action, c.schema_version, c.detail, c.created_at, u.name FROM consent_log c LEFT JOIN users u ON u.id = c.user_id WHERE c.project_id = ? ORDER BY c.created_at DESC')
      .all(projectId) as { action: string; schema_version: number; detail: string | null; created_at: string; name: string | null }[];
    return {
      enabled: this.isEnabled(projectId),
      canChange: !isSample,
      schemaVersion: FINGERPRINT_VERSION,
      policy: this.policy,
      history: history.map((h) => ({ action: h.action, schemaVersion: h.schema_version, by: h.name, at: h.created_at, effect: h.detail ? JSON.parse(h.detail) : null })),
      // Exactly what is stored for this project — its own rows only.
      contributed: own.map((f) => ({ month: f.month, active: f.active, current: f.current, fingerprint: f.data })),
      outcomes: this.store.ownOutcomes(contributor),
      retention:
        'Revoking consent marks every fingerprint and outcome from this project inactive and recomputes all aggregates without them immediately. The inactive rows stay in the isolated collective store (pseudonymous, allowlisted structure only) and are never counted again.',
    };
  }

  /* ------------------------------------------------------------ this project */

  private thisProject(ctx: Ctx) {
    const arch = this.architectures.get(ctx.project.id, ctx.analysis, ctx.index).architecture;
    const fp = extractFingerprint(ctx.index.graph, arch, ctx.analysis.finished_at ?? ctx.analysis.created_at);
    const m = structuralMetrics(ctx.index.graph);
    const exact: Record<string, string> = {
      fanOutP90: String(m.fanOutP90),
      fanInMax: String(m.fanInMax),
      density: m.files ? (m.edges / m.files).toFixed(2) : '0',
      cycles: String(m.cycles),
      layerCount: fp.architecture.layerCount,
      apps: String(arch.nodes.filter((n) => n.kind === 'app').length),
      files: String(m.files),
    };
    return { fp, exact };
  }

  private snapshotJson(ctx: Ctx) {
    return { analysisId: ctx.analysis.id, branch: ctx.analysis.branch, commitSha: ctx.analysis.commit_sha, finishedAt: ctx.analysis.finished_at };
  }

  private collectiveFrame(fp: Fingerprint) {
    const { chosen, considered } = choosePopulation(fp, (k) => this.store.populationSize(k), this.policy);
    return {
      label: 'COLLECTIVE DATA' as const,
      status: chosen ? ('available' as const) : ('withheld' as const),
      population: chosen,
      considered,
      policy: this.policy,
      privacy: `Statistics are shown only for populations of at least ${this.policy.minN} contributing projects; any count below ${this.policy.minCell} is suppressed. Values are ranges, never exact.`,
      note: OBSERVATION_NOTE,
    };
  }

  benchmark(ctx: Ctx) {
    const { fp, exact } = this.thisProject(ctx);
    const frame = this.collectiveFrame(fp);
    const metrics = frame.population
      ? METRICS.map((m) => {
          const agg = this.store.aggregate(frame.population!.key, m.id);
          return agg && agg.n >= this.policy.minN ? benchmarkMetric(m, agg, m.of(fp), this.policy) : null;
        }).filter((x) => !!x)
      : [];
    return {
      snapshot: this.snapshotJson(ctx),
      thisProject: {
        label: 'THIS PROJECT' as const,
        source: 'Computed from this repository’s own analysis.',
        pattern: fp.architecture.pattern,
        sizeBand: fp.size.band,
        metrics: METRICS.map((m) => ({ metric: m.id, label: m.label, definition: m.definition, value: exact[m.id], bucket: m.of(fp) })),
      },
      collective: { ...frame, computedMonth: frame.population ? this.store.aggregate(frame.population.key, 'n')?.computedMonth ?? null : null, metrics },
      consent: { enabled: this.isEnabled(ctx.project.id) },
    };
  }

  insights(ctx: Ctx) {
    const { fp } = this.thisProject(ctx);
    const frame = this.collectiveFrame(fp);
    const own = traitsOf(fp);
    // The cycle risk/strength codes restate the cycles trait; show each fact once.
    const interesting = own.filter((t) => /^(risk|strength|cycles|category):/.test(t) && t !== 'risk:import-cycles' && t !== 'strength:no-import-cycles');
    let prevalence: unknown[] = [];
    let outcomes: { status: 'available' | 'no-outcome-data'; reporting: ReturnType<typeof cell> | null; items: unknown[] } = { status: 'no-outcome-data', reporting: null, items: [] };
    let reviewed: unknown[] = [];
    if (frame.population) {
      const traits = this.store.aggregate(frame.population.key, 'traits');
      if (traits && traits.n >= this.policy.minN) {
        const n = traits.n;
        prevalence = interesting.map((t) => {
          const c = cell(traits.counts[t] ?? 0, n, this.policy);
          return { trait: t, label: traitLabel(t), kind: 'observed', n, ...c, statement: c.suppressed ? `Across ${n} similar projects, fewer than ${this.policy.minCell} also show this: ${traitLabel(t)}.` : `Across ${n} similar projects, ${Math.round((c.share ?? 0) * 100)}% also show this: ${traitLabel(t)}.` };
        });
        const reportingCount = traits.counts['reported:any'] ?? 0;
        if (reportingCount >= this.policy.minCell) {
          const elements = [...fp.architecture.toolCategories.map((c) => `category:${c}`), ...Object.keys(fp.nodesByType).map((t) => `file:${t}`)];
          outcomes = {
            status: 'available',
            reporting: cell(reportingCount, n, this.policy),
            items: elements.map((e) => {
              const c = cell(traits.counts[`incident:${e}`] ?? 0, n, this.policy);
              return { element: e, label: traitLabel(`incident:${e}`), kind: 'correlated', n, ...c, statement: c.suppressed ? `Fewer than ${this.policy.minCell} of ${n} similar projects reported this.` : `${Math.round((c.share ?? 0) * 100)}% of ${n} similar projects ${traitLabel(`incident:${e}`)} (self-reported).` };
            }),
          };
        }
      }
    }
    // Reviewed patterns that match this project's own traits.
    reviewed = this.store
      .patterns({ status: 'approved', currentOnly: true })
      .filter((p) => p.n >= this.policy.minN && p.support >= this.policy.minCell && p.antecedent.every((a) => own.includes(a)))
      .map(patternJson);
    return {
      snapshot: this.snapshotJson(ctx),
      thisProject: { label: 'THIS PROJECT' as const, source: 'Computed from this repository’s own analysis.', traits: interesting.map((t) => ({ trait: t, label: traitLabel(t) })) },
      collective: { ...frame, prevalence, outcomes, reviewedPatterns: reviewed },
    };
  }

  stateOfArchitecture() {
    const traits = this.store.aggregate('all', 'traits');
    const n = traits?.n ?? 0;
    const base = { label: 'COLLECTIVE DATA' as const, population: { key: 'all', n, definition: describePopulation('all') }, policy: this.policy, note: OBSERVATION_NOTE };
    if (!traits || n < this.policy.minN) return { ...base, status: 'withheld' as const, sections: [] };
    const family = (prefix: string) =>
      Object.entries(traits.counts)
        .filter(([t]) => t.startsWith(prefix))
        .map(([t, c]) => ({ trait: t, label: traitLabel(t), ...cell(c, n, this.policy) }))
        .sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
    const metric = (id: string) => {
      const m = METRICS.find((x) => x.id === id)!;
      const agg = this.store.aggregate('all', id);
      return agg ? { metric: id, label: m.label, definition: m.definition, n: agg.n, distribution: m.buckets.map((b) => ({ bucket: b, ...cell(agg.counts[b] ?? 0, agg.n, this.policy) })) } : null;
    };
    return {
      ...base,
      status: 'available' as const,
      computedMonth: traits.computedMonth,
      sections: [
        { id: 'patterns', title: 'Architecture patterns', items: family('pattern:') },
        { id: 'categories', title: 'Technology categories in use', items: family('category:') },
        { id: 'risks', title: 'Structural risk indicators', items: family('risk:') },
        { id: 'strengths', title: 'Resilience and practice indicators', items: family('strength:') },
      ],
      metrics: ['layerCount', 'cycles', 'fanOutP90', 'files'].map(metric).filter(Boolean),
      reviewedPatterns: this.store.patterns({ status: 'approved', currentOnly: true }).filter((p) => p.n >= this.policy.minN && p.support >= this.policy.minCell).map(patternJson),
    };
  }

  /* ------------------------------------------------------------ incidents */

  /**
   * Tag a graph or architecture node with an incident. The tag (and any description) stays with the
   * project; only the abstract element kind and month enter the collective dataset, with consent.
   */
  tagIncident(ctx: Ctx, nodeId: string, body: { month?: string; source?: string; description?: string }, userId: string) {
    if (ctx.project.user_id === null) throw new AppError('forbidden', 'Incidents cannot be tagged on the public sample project.', 403);
    const graphNode = ctx.index.nodeById.get(nodeId);
    let element: string | null = null;
    if (graphNode && graphNode.type !== 'external' && graphNode.type !== 'unresolved') element = `file:${graphNode.type}`;
    else {
      const arch = this.architectures.get(ctx.project.id, ctx.analysis, ctx.index).architecture;
      const n = arch.nodes.find((x) => x.id === nodeId);
      const cat = n ? (n.kind === 'app' ? 'application' : n.category) : null;
      if (cat && (TOOL_CATEGORIES as readonly string[]).includes(cat)) element = `category:${cat}`;
    }
    if (!element || !(OUTCOME_ELEMENTS as readonly string[]).includes(element)) throw new AppError('not_found', 'Node not found in this analysis.', 404);
    const month = body.month ?? monthOf(now());
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new AppError('bad_request', 'month must be YYYY-MM.', 400);
    const source = ['manual', 'pagerduty', 'opsgenie', 'other'].includes(body.source ?? 'manual') ? (body.source ?? 'manual') : 'other';
    const description = typeof body.description === 'string' ? body.description.slice(0, 2000) : null;
    const id = randomId(12);
    const contribute = this.isEnabled(ctx.project.id);
    this.db
      .prepare('INSERT INTO incident_tags (id, project_id, analysis_id, node_id, element, occurred_month, source, description, contributed, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, ctx.project.id, ctx.analysis.id, nodeId, element, month, source, description, contribute ? 1 : 0, userId, now());
    if (contribute) {
      this.store.putOutcome(this.hmac(`outcome:${id}`), this.contributorOf(ctx.project.id), element, month);
      this.reaggregate();
    }
    return {
      id,
      nodeId,
      month,
      source,
      contributed: contribute ? { element, month, outcome: 'incident' } : null,
      descriptionShared: false,
      note: contribute
        ? 'Only the element kind and month entered Collective Intelligence. The node, its name and any description stay with this project.'
        : 'Collective contribution is off for this project; the tag is stored with this project only.',
    };
  }

  /* ------------------------------------------------------------ review */

  reviewQueue() {
    return { pending: this.store.patterns({ status: 'pending_review', currentOnly: true }).map(patternJson), reviewed: this.store.patterns({ currentOnly: true }).filter((p) => p.status !== 'pending_review').map(patternJson) };
  }

  review(id: string, decision: 'approved' | 'rejected', claim: 'correlation' | 'causal', note: string | null) {
    if (claim === 'causal' && (!note || note.trim().length < 20)) throw new AppError('bad_request', 'A causal claim needs a review note describing the supporting evidence.', 400);
    const p = this.store.review(id, decision, claim, note, monthOf(now()));
    if (!p) throw new AppError('not_found', 'Pattern not found.', 404);
    return patternJson(p);
  }

  static schema() {
    return SCHEMA_DOC;
  }
}

export function patternJson(p: DiscoveredPattern) {
  const when = p.antecedent.map(traitLabel).join(' and ');
  return {
    id: p.id,
    status: p.status,
    claim: p.claim,
    kind: p.claim === 'causal' ? 'reviewed causal finding' : 'statistical pattern (correlation)',
    statement: `Across ${p.n} contributing projects, those with ${when} also showed ${traitLabel(p.consequent)} in ${Math.round(p.confidence * 100)}% of cases, compared with ${Math.round(p.baseline * 100)}% overall.`,
    antecedent: p.antecedent.map((t) => ({ trait: t, label: traitLabel(t) })),
    consequent: { trait: p.consequent, label: traitLabel(p.consequent) },
    n: p.n,
    support: p.support,
    antecedentSupport: p.antecedentSupport,
    confidence: p.confidence,
    baseline: p.baseline,
    lift: p.lift,
    chi2: p.chi2,
    reviewNote: p.reviewNote,
    reviewedMonth: p.reviewedMonth,
    discoveredMonth: p.discoveredMonth,
  };
}
