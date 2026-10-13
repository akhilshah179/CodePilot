import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeRepositoryWithFacts } from '../../packages/analyzer/src/index.ts';
import { detectArchitecture } from '../../packages/analyzer/src/architecture/detect.ts';
import { buildApp, type AppContext } from '../src/app.ts';
import { extractFingerprint } from '../src/collective/fingerprint.ts';
import { FingerprintRejected, validateFingerprint, type Fingerprint } from '../src/collective/schema.ts';
import { chiSquare, computeAggregates, discoverPatterns, type PrivacyPolicy } from '../src/collective/stats.ts';
import { CollectiveStore } from '../src/collective/store.ts';
import { loadConfig } from '../src/config.ts';
import { sha256 } from '../src/crypto.ts';
import { createRemote, readSse, startMockGitHub, TOKEN } from './helpers.ts';

const FIXTURES = path.join(import.meta.dirname, '../../packages/analyzer/test/fixtures');
const POLICY: PrivacyPolicy = { minN: 20, minCell: 5 };

/** Every string value anywhere in a JSON value. */
const strings = (v: unknown): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...strings(x)]) : []);

async function fixtureFingerprint(name: string) {
  const { graph, facts } = await analyzeRepositoryWithFacts(path.join(FIXTURES, name), { repository: { name } });
  const arch = detectArchitecture({ facts, graph });
  return { graph, arch, fp: extractFingerprint(graph, arch, '2026-10-02T09:15:00.000Z') };
}

describe('collective fingerprint: allowlist and extraction', () => {
  it('is deterministic and contains only allowlisted fields and values', async () => {
    const a = await fixtureFingerprint('arch-fastapi-celery');
    const b = await fixtureFingerprint('arch-fastapi-celery');
    expect(JSON.stringify(a.fp)).toBe(JSON.stringify(b.fp));
    expect(() => validateFingerprint(JSON.parse(JSON.stringify(a.fp)))).not.toThrow();
    expect(Object.keys(a.fp).sort()).toEqual(['architecture', 'month', 'nodesByType', 'risks', 'size', 'strengths', 'topology', 'v']);
    expect(a.fp.month).toBe('2026-10');
    expect(a.fp.architecture.toolCategories).toEqual(expect.arrayContaining(['cache', 'database', 'worker']));
    expect(a.fp.risks).toContain('cache-no-expiry');
    expect(a.fp.architecture.relations.every((r) => /^[a-z-]+>[a-z-]+:.+$/.test(r))).toBe(true);
  });

  it('carries no path, file name, symbol, repository, URL, environment variable or snippet', async () => {
    for (const name of ['arch-fastapi-celery', 'arch-fastify-react', 'arch-next-pg', 'arch-compose-multi']) {
      const { graph, arch, fp } = await fixtureFingerprint(name);
      const values = strings(fp);
      const json = JSON.stringify(fp);
      const forbidden = [
        name,
        ...graph.nodes.map((n) => n.id),
        ...graph.nodes.filter((n) => n.type !== 'external').map((n) => n.id.split('/').pop()!),
        ...Object.values(graph.files).flatMap((f) => f.exports.map((e) => e.name)).filter((x) => x.length > 3 && x !== 'default'),
        ...arch.nodes.map((n) => n.name).filter((x) => !['application'].includes(x.toLowerCase())),
        ...Object.values(arch.evidence).flatMap((e) => [e.file, e.snippet ?? '']).filter((x) => x.length > 3),
      ];
      for (const f of new Set(forbidden)) if (f.includes('/') || f.includes('.') || f.length > 6) expect(json, `${name}: ${f}`).not.toContain(f);
      for (const v of values) expect(v.length).toBeLessThan(60);
      expect(json).not.toMatch(/https?:|@|\.(ts|tsx|js|py|yml|yaml)\b|[A-Z_]{4,}=/);
    }
  });

  it('rejects anything outside the schema', async () => {
    const { fp } = await fixtureFingerprint('arch-fastify-react');
    const bad = (patch: (f: Record<string, any>) => void) => {
      const f = JSON.parse(JSON.stringify(fp));
      patch(f);
      return () => validateFingerprint(f);
    };
    expect(bad((f) => (f.repoName = 'acme/fixture'))).toThrow(FingerprintRejected);
    expect(bad((f) => (f.size.files = '137'))).toThrow(/allowlist/);
    expect(bad((f) => (f.architecture.toolCategories = ['postgres']))).toThrow(/allowlist/);
    expect(bad((f) => (f.architecture.relations = ['application>database:SELECT * FROM users']))).toThrow(/allowlist/);
    expect(bad((f) => (f.risks = ['credentials in server/src/config.ts']))).toThrow(/allowlist/);
    expect(bad((f) => (f.nodesByType = { 'src/secret.ts': '1-9' }))).toThrow(/allowlist/);
    expect(bad((f) => (f.month = '2026-10-02T09:15:00Z'))).toThrow(/YYYY-MM/);
    expect(bad((f) => (f.architecture.layers = [...f.architecture.layers].reverse()))).toThrow(fp.architecture.layers.length > 1 ? /sorted/ : FingerprintRejected);
  });

  it('refuses to store a non-conforming fingerprint', () => {
    const store = new CollectiveStore('', ':memory:');
    expect(() => store.putFingerprint('x', 'c', { v: 1 } as unknown as Fingerprint)).toThrow(FingerprintRejected);
    expect(store.population()).toHaveLength(0);
    store.close();
  });
});

/* ------------------------------------------------------------------ statistics */

const fpWith = (base: Fingerprint, patch: (f: Fingerprint) => void): Fingerprint => {
  const f = JSON.parse(JSON.stringify(base)) as Fingerprint;
  patch(f);
  f.risks.sort();
  f.architecture.toolCategories.sort();
  return validateFingerprint(f);
};
const contributor = (i: number) => `c${String(i).padStart(4, '0')}`;

describe('collective statistics', () => {
  it('discovers correlations only above the privacy floor, and never publishes them', async () => {
    const { fp } = await fixtureFingerprint('arch-fastapi-celery');
    const store = new CollectiveStore('', ':memory:');
    // 60 projects: 30 with a cache (24 of them with unpinned image tags), 30 without (3 with them).
    for (let i = 0; i < 60; i++) {
      const cache = i < 30;
      const risky = cache ? i < 24 : i < 33;
      store.putFingerprint(`f${i}`, contributor(i), fpWith(fp, (f) => {
        f.architecture.toolCategories = [...f.architecture.toolCategories.filter((c) => c !== 'cache'), ...(cache ? (['cache'] as const) : [])];
        f.risks = [...f.risks.filter((r) => r !== 'cache-no-expiry' && r !== 'unpinned-image-tags'), ...(risky ? (['unpinned-image-tags'] as const) : [])];
      }));
    }
    const found = discoverPatterns(store.population(), [], POLICY, '2026-10');
    const rule = found.find((r) => r.antecedent.join() === 'category:cache' && r.consequent === 'risk:unpinned-image-tags');
    expect(rule).toBeDefined();
    expect(rule!.n).toBe(60);
    expect(rule!.support).toBe(24);
    expect(rule!.confidence).toBeCloseTo(0.8);
    expect(rule!.lift).toBeGreaterThan(1.2);
    expect(rule!.chi2).toBeGreaterThan(6.63);
    store.upsertPatterns(found);
    expect(store.patterns({ status: 'approved' })).toHaveLength(0);
    expect(store.patterns({ status: 'pending_review' }).length).toBe(found.length);
    // Below the minimum population nothing is mined at all.
    expect(discoverPatterns(store.population().slice(0, 19), [], POLICY, '2026-10')).toEqual([]);
    store.close();
  });

  it('counts each contributor once per population and never above its current, active snapshot', async () => {
    const { fp } = await fixtureFingerprint('arch-fastify-react');
    const store = new CollectiveStore('', ':memory:');
    store.putFingerprint('old', 'same', fp);
    store.putFingerprint('new', 'same', fpWith(fp, (f) => (f.topology.cycles = '21+')));
    expect(store.population().map((f) => f.id)).toEqual(['new']);
    const rows = computeAggregates(store.population(), [], '2026-10');
    expect(rows.find((r) => r.population === 'all' && r.metric === 'cycles')!.counts).toEqual({ '21+': 1 });
    store.deactivate('same');
    expect(store.population()).toHaveLength(0);
    store.close();
  });

  it('uses a correct 2×2 chi-square', () => {
    expect(chiSquare(24, 6, 9, 21)).toBeGreaterThan(10);
    expect(chiSquare(10, 10, 10, 10)).toBe(0);
  });
});

/* ------------------------------------------------------------------ API acceptance */

describe('Collective Intelligence API', () => {
  let tmp: string;
  let gh: Awaited<ReturnType<typeof startMockGitHub>>;
  let ctx: AppContext;
  let base: string;
  let cookie: string;
  let projectId: string;
  let commitSha: string;
  let filePaths: string[];
  const otherToken = randomBytes(16).toString('hex');

  const api = (p: string, init: RequestInit = {}, c = cookie) => fetch(`${base}${p}`, { ...init, headers: { cookie: c, origin: 'http://app.test', 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const consent = (enabled: unknown, c = cookie) => api(`/api/projects/${projectId}/collective-intelligence/consent`, { method: 'POST', body: JSON.stringify({ enabled }) }, c);
  const collectiveRows = () => ({
    fingerprints: ctx.collective.store.db.prepare('SELECT * FROM collective_fingerprints').all(),
    outcomes: ctx.collective.store.db.prepare('SELECT * FROM pattern_outcomes').all(),
    aggregates: ctx.collective.store.db.prepare('SELECT * FROM aggregate_statistics').all(),
  });

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'codepilot-collective-'));
    gh = await startMockGitHub();
    const webUrl = createRemote(tmp);
    const config = loadConfig({ dataDir: path.join(tmp, 'data'), appOrigin: 'http://app.test', devGithubToken: TOKEN, github: { apiUrl: gh.url, webUrl, oauthUrl: gh.url }, google: {}, sampleRoot: undefined, production: false });
    config.collective.reviewers = ['reviewer-user'];
    mkdirSync(config.dataDir, { recursive: true });
    ctx = await buildApp(config, { logger: false });
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
    const login = await fetch(`${base}/api/auth/dev`, { method: 'POST' });
    cookie = login.headers.get('set-cookie')!.split(';')[0];

    const created = await (await api('/api/projects', { method: 'POST', body: JSON.stringify({ owner: 'acme', repo: 'fixture', branch: 'main' }) })).json();
    projectId = created.projectId;
    await readSse(`${base}/api/projects/${projectId}/analysis/stream?analysisId=${created.analysisId}`, cookie);
    const graph = await (await api(`/api/projects/${projectId}/graph`)).json();
    commitSha = graph.analysis.commitSha;
    filePaths = graph.nodes.filter((n: { type: string }) => n.type !== 'external' && n.type !== 'unresolved').map((n: { id: string }) => n.id);

    // A second, unrelated user with their own session.
    ctx.db.prepare('INSERT INTO users (id, name, email, avatar_url, created_at) VALUES (?, ?, ?, ?, ?)').run('other-user', 'Other', 'o@example.com', null, new Date().toISOString());
    ctx.db.prepare('INSERT INTO sessions (id_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(sha256(otherToken), 'other-user', Date.now() + 3_600_000, new Date().toISOString());
  }, 90_000);

  afterAll(async () => {
    await ctx?.app.close();
    gh?.server.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('1 · consent defaults to off', async () => {
    const s = await (await api(`/api/projects/${projectId}/collective-intelligence/status`)).json();
    expect(s.enabled).toBe(false);
    expect(s.history).toEqual([]);
    expect(s.contributed).toEqual([]);
  });

  it('2 · no fingerprint is generated without explicit consent', () => {
    const rows = collectiveRows();
    expect(rows.fingerprints).toHaveLength(0);
    expect(rows.outcomes).toHaveLength(0);
  });

  it('rejects anything but an explicit boolean, and consent changes from other users or origins', async () => {
    expect((await consent('yes')).status).toBe(400);
    expect((await consent(true, `cp_session=${otherToken}`)).status).toBe(404);
    expect((await api(`/api/projects/${projectId}/collective-intelligence/consent`, { method: 'POST', body: '{"enabled":true}', headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect(collectiveRows().fingerprints).toHaveLength(0);
  });

  it('3 & 4 · with consent, stores only an allowlisted fingerprint — no code, paths or identifiers', async () => {
    const res = await consent(true);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    const rows = collectiveRows();
    expect(rows.fingerprints).toHaveLength(1);
    const row = rows.fingerprints[0] as { data_json: string; contributor: string; id: string };
    expect(() => validateFingerprint(JSON.parse(row.data_json))).not.toThrow();
    const dump = JSON.stringify(rows);
    for (const s of [projectId, 'acme', 'fixture', 'octo', commitSha, TOKEN, ...filePaths]) expect(dump).not.toContain(s);
    expect(row.contributor).toMatch(/^[0-9a-f]{32}$/);
    // The project sees exactly what it shared.
    expect(body.status.contributed[0].fingerprint).toEqual(JSON.parse(row.data_json));
    expect(body.status.history[0]).toMatchObject({ action: 'granted' });
  });

  it('5 & 6 · withholds statistics below the minimum N; every shown aggregate carries its sample size', async () => {
    let b = await (await api(`/api/projects/${projectId}/benchmark`)).json();
    expect(b.collective.status).toBe('withheld');
    expect(b.collective.metrics).toEqual([]);
    expect(b.collective.considered.map((p: { n: number }) => p.n)).toEqual([1, 1, 1]);
    expect(b.thisProject.metrics.length).toBeGreaterThan(0);

    // 18 other anonymized projects of the same shape: 19 in total, still below 20.
    const own = (ctx.collective.store.population()[0]).data;
    for (let i = 0; i < 18; i++) ctx.collective.store.putFingerprint(`seed${i}`, contributor(i), fpWith(own, (f) => (f.topology.cycles = i % 2 ? '0' : '2-5')));
    ctx.collective.reaggregate();
    b = await (await api(`/api/projects/${projectId}/benchmark`)).json();
    expect(b.collective.status).toBe('withheld');
    const insightsWithheld = await (await api(`/api/projects/${projectId}/pattern-insights`)).json();
    expect(insightsWithheld.collective.prevalence).toEqual([]);

    ctx.collective.store.putFingerprint('seed18', contributor(18), own);
    ctx.collective.reaggregate();
    b = await (await api(`/api/projects/${projectId}/benchmark`)).json();
    expect(b.collective.status).toBe('available');
    expect(b.collective.population).toMatchObject({ n: 20 });
    expect(b.collective.population.definition).toMatch(/same detected pattern/);
    expect(b.collective.metrics.length).toBeGreaterThan(0);
    for (const m of b.collective.metrics) {
      expect(m.n).toBe(20);
      expect(m.definition).toBeTruthy();
      for (const c of m.distribution) if (!c.suppressed) expect(typeof c.count).toBe('number');
    }
    // Small cells are suppressed, never shown as exact counts.
    const cycles = b.collective.metrics.find((m: { metric: string }) => m.metric === 'cycles');
    expect(cycles.distribution.every((c: { count: number | null; suppressed: boolean }) => c.suppressed || c.count === 0 || c.count! >= 5)).toBe(true);
  });

  it('7 · keeps repository evidence and aggregate statistics apart', async () => {
    const b = await (await api(`/api/projects/${projectId}/benchmark`)).json();
    expect(b.thisProject.label).toBe('THIS PROJECT');
    expect(b.collective.label).toBe('COLLECTIVE DATA');
    const collective = JSON.stringify(b.collective);
    for (const f of filePaths) expect(collective).not.toContain(f);
    expect(collective).not.toMatch(/"ev_[a-z0-9]+"|"evidence":|"snippet"|"file":/);
    expect(JSON.stringify(b.thisProject)).not.toMatch(/"n":/);
  });

  it('10 · labels statistical insights as aggregate observations, never as predictions or causes', async () => {
    const i = await (await api(`/api/projects/${projectId}/pattern-insights`)).json();
    expect(i.collective.label).toBe('COLLECTIVE DATA');
    expect(i.collective.note).toMatch(/not evidence from this repository, not a prediction, and not a cause/);
    expect(i.collective.prevalence.length).toBeGreaterThan(0);
    for (const p of i.collective.prevalence) {
      expect(p.kind).toBe('observed');
      expect(p.n).toBe(20);
      expect(p.statement).toMatch(/similar projects/);
      expect(p.statement).not.toMatch(/\b(will|causes?|guarantee[ds]?)\b/i);
    }
  });

  it('incident tags contribute only the element kind and month; descriptions never leave the project', async () => {
    const node = encodeURIComponent(filePaths[0]);
    const res = await api(`/api/projects/${projectId}/graph/nodes/${node}/incident-tag`, { method: 'POST', body: JSON.stringify({ month: '2026-09', source: 'pagerduty', description: 'DB pool exhausted at 3am — TOP SECRET detail' }) });
    expect(res.status).toBe(201);
    const tag = await res.json();
    expect(tag.descriptionShared).toBe(false);
    expect(tag.contributed).toMatchObject({ month: '2026-09', outcome: 'incident' });
    const dump = JSON.stringify(collectiveRows());
    expect(dump).not.toContain('TOP SECRET');
    expect(dump).not.toContain(filePaths[0]);
    expect((collectiveRows().outcomes[0] as { element: string }).element).toMatch(/^file:/);
    expect((await api(`/api/projects/${projectId}/graph/nodes/${node}/incident-tag`, { method: 'POST', body: '{}' }, `cp_session=${otherToken}`)).status).toBe(404);
  });

  it('9 · a project only ever sees its own contribution, and nobody else can read it', async () => {
    expect((await api(`/api/projects/${projectId}/collective-intelligence/status`, {}, `cp_session=${otherToken}`)).status).toBe(404);
    expect((await api(`/api/projects/${projectId}/benchmark`, {}, `cp_session=${otherToken}`)).status).toBe(404);
    const s = await (await api(`/api/projects/${projectId}/collective-intelligence/status`)).json();
    expect(s.contributed).toHaveLength(1);
    // There is no endpoint that takes a pseudonym or returns another contributor's rows.
    const routes = ctx.app.printRoutes();
    expect(routes).not.toMatch(/contributor|fingerprints\/:/);
  });

  it('8 · revoking consent excludes the fingerprint from all future aggregation', async () => {
    const before = ctx.collective.store.populationSize('all');
    const res = await (await consent(false)).json();
    expect(res.enabled).toBe(false);
    expect(res.effect.deactivated).toMatchObject({ fingerprints: 1, outcomes: 1 });
    expect(ctx.collective.store.populationSize('all')).toBe(before - 1);
    const b = await (await api(`/api/projects/${projectId}/benchmark`)).json();
    expect(b.collective.status).toBe('withheld');
    const s = res.status;
    expect(s.contributed.every((f: { active: boolean }) => !f.active)).toBe(true);
    expect(s.history.map((h: { action: string }) => h.action)).toEqual(['revoked', 'granted']);
    expect(s.retention).toMatch(/inactive/);
    // Later analyses or regenerations add nothing while consent is off.
    ctx.collective.contributeLatest(projectId);
    expect(ctx.collective.store.population().some((f) => f.contributor === ctx.collective.contributorOf(projectId))).toBe(false);
  });

  it('serves the State of Architecture only above the minimum population, and the schema publicly', async () => {
    const soa = await (await fetch(`${base}/api/collective-intelligence/state-of-architecture`)).json();
    expect(soa.label).toBe('COLLECTIVE DATA');
    expect(soa.population.n).toBe(19);
    expect(soa.status).toBe('withheld');
    expect(soa.sections).toEqual([]);
    const schema = await (await fetch(`${base}/api/collective-intelligence/schema`)).json();
    expect(schema.never).toEqual(expect.arrayContaining(['source code or file contents', 'file paths or file names']));
    expect(schema.policy).toEqual({ minN: 20, minCell: 5 });
  });
  it('keeps discovered patterns out of insights until a reviewer approves them, and causal claims need support', async () => {
    expect((await api('/api/collective-intelligence/review')).status).toBe(403);
    // 40 more anonymized projects in which having a cache goes with unpinned image tags.
    const shape = ctx.collective.store.population()[0].data;
    for (let i = 0; i < 40; i++)
      ctx.collective.store.putFingerprint(`corr${i}`, contributor(100 + i), fpWith(shape, (f) => {
        f.architecture.toolCategories = [...f.architecture.toolCategories.filter((c) => c !== 'cache'), ...(i < 20 ? (['cache'] as const) : [])];
        f.risks = [...f.risks.filter((r) => r !== 'unpinned-image-tags'), ...(i < 17 || i === 30 ? (['unpinned-image-tags'] as const) : [])];
      }));
    ctx.collective.reaggregate();
    const ran = ctx.collective.discover();
    expect(ran.found).toBeGreaterThan(0);
    expect(ran.found).toBe(ran.pending);
    const p = ctx.collective.store.patterns({ status: 'pending_review' }).find((x) => x.consequent === 'risk:unpinned-image-tags' && x.antecedent.includes('category:cache'))!;
    expect(p).toBeDefined();
    expect(ctx.collective.store.patterns({ status: 'approved' })).toEqual([]);
    expect((await (await api(`/api/projects/${projectId}/pattern-insights`)).json()).collective.reviewedPatterns).toEqual([]);
    expect(() => ctx.collective.review(p.id, 'approved', 'causal', 'trust me')).toThrow(/supporting evidence/);
    const approved = ctx.collective.review(p.id, 'approved', 'correlation', null);
    expect(approved.kind).toBe('statistical pattern (correlation)');
    expect(approved.statement).toMatch(/^Across \d+ contributing projects/);
  });

});
