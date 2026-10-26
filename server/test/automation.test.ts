import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTOMATION_SCHEMA_VERSION } from '@codepilot/analyzer/automation';
import { buildApp, type AppContext } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { sha256 } from '../src/crypto.ts';
import { createRemote, readSse, startMockGitHub, TOKEN } from './helpers.ts';

describe('Automation API', () => {
  let tmp: string;
  let gh: Awaited<ReturnType<typeof startMockGitHub>>;
  let ctx: AppContext;
  let base: string;
  let cookie: string;
  let projectId: string;
  let analysisId: string;
  const other = randomBytes(16).toString('hex');
  const api = (p: string, init: RequestInit = {}, c = cookie) => fetch(`${base}${p}`, { ...init, headers: { cookie: c, origin: 'http://app.test', 'content-type': 'application/json', ...(init.headers ?? {}) } });

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'codepilot-automation-'));
    gh = await startMockGitHub();
    const webUrl = createRemote(tmp);
    const config = loadConfig({ dataDir: path.join(tmp, 'data'), appOrigin: 'http://app.test', devGithubToken: TOKEN, github: { apiUrl: gh.url, webUrl, oauthUrl: gh.url }, google: {}, sampleRoot: undefined, production: false });
    mkdirSync(config.dataDir, { recursive: true });
    ctx = await buildApp(config, { logger: false });
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
    cookie = (await fetch(`${base}/api/auth/dev`, { method: 'POST' })).headers.get('set-cookie')!.split(';')[0];
    const created = await (await api('/api/projects', { method: 'POST', body: JSON.stringify({ owner: 'acme', repo: 'fixture', branch: 'main' }) })).json();
    projectId = created.projectId;
    analysisId = created.analysisId;
    await readSse(`${base}/api/projects/${projectId}/analysis/stream?analysisId=${analysisId}`, cookie);
    ctx.db.prepare('INSERT INTO users (id, name, email, avatar_url, created_at) VALUES (?, ?, ?, ?, ?)').run('someone-else', 'Other', null, null, new Date().toISOString());
    ctx.db.prepare('INSERT INTO sessions (id_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(sha256(other), 'someone-else', Date.now() + 3_600_000, new Date().toISOString());
  }, 90_000);

  afterAll(async () => {
    await ctx?.app.close();
    gh?.server.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('builds the flows right after the analysis, stored with the engine schema version and a layout', async () => {
    const run = ctx.db.prepare('SELECT schema_version, status FROM automation_runs WHERE analysis_id = ?').get(analysisId) as { schema_version: number; status: string };
    expect(run.schema_version).toBe(AUTOMATION_SCHEMA_VERSION);
    const nodes = ctx.db.prepare('SELECT x, y FROM flow_nodes WHERE analysis_id = ?').all(analysisId) as { x: number; y: number }[];
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
  });

  it('never returns an empty page: the fixture library gets its startup flow, with a stated reason and consistent counts', async () => {
    const v = await (await api(`/api/projects/${projectId}/automation/flows`)).json();
    expect(v.flows.length).toBeGreaterThanOrEqual(1);
    expect(v.flows.length).toBeLessThanOrEqual(4);
    expect(v.diagnostics.fallback?.reason).toBeTruthy();
    expect(v.coverage.shown + v.coverage.folded + v.coverage.omitted).toBe(v.coverage.total);
    const c = await (await api(`/api/projects/${projectId}/automation/coverage`)).json();
    expect(c.shown.length + c.folded.length + c.omitted.length).toBe(c.total);
    for (const f of v.flows) {
      expect(f.nodes.filter((n: { type: string }) => n.type === 'trigger')).toHaveLength(1);
      expect(f.nodes.every((n: { evidence: unknown[] }) => n.evidence.length > 0)).toBe(true);
      expect(f.edges.every((e: { evidence: unknown[] }) => e.evidence.length > 0)).toBe(true);
    }
  });

  it('regenerates automatically when the stored schema version differs', async () => {
    ctx.db.prepare('UPDATE automation_runs SET schema_version = 0 WHERE analysis_id = ?').run(analysisId);
    const v = await (await api(`/api/projects/${projectId}/automation/flows`)).json();
    expect(v.regenerated).toBe(true);
    expect((ctx.db.prepare('SELECT schema_version FROM automation_runs WHERE analysis_id = ?').get(analysisId) as { schema_version: number }).schema_version).toBe(AUTOMATION_SCHEMA_VERSION);
    const again = await (await api(`/api/projects/${projectId}/automation/flows`)).json();
    expect(again.regenerated).toBe(false);
  });

  it('renames a flow per project (and resets it), rejecting generic names', async () => {
    const v = await (await api(`/api/projects/${projectId}/automation/flows`)).json();
    const f = v.flows[0];
    const renamed = await (await api(`/api/projects/${projectId}/automation/flows/${f.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'Library boots and loads its modules' }) })).json();
    expect(renamed.flows[0]).toMatchObject({ name: 'Library boots and loads its modules', renamed: true });
    expect((await api(`/api/projects/${projectId}/automation/flows/${f.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'Core application flow' }) })).status).toBe(400);
    const reset = await (await api(`/api/projects/${projectId}/automation/flows/${f.id}`, { method: 'PATCH', body: JSON.stringify({ name: null }) })).json();
    expect(reset.flows[0].renamed).toBe(false);
  });

  it('replaces a shown flow only with an existing candidate, and only for the owner', async () => {
    const v = await (await api(`/api/projects/${projectId}/automation/flows`)).json();
    const f = v.flows[0];
    expect((await api(`/api/projects/${projectId}/automation/flows/${f.id}/replace`, { method: 'POST', body: JSON.stringify({ key: 'nope' }) })).status).toBe(404);
    const same = await (await api(`/api/projects/${projectId}/automation/flows/${f.id}/replace`, { method: 'POST', body: JSON.stringify({ key: v.candidates[0].key }) })).json();
    expect(same.flows.map((x: { key: string }) => x.key)).toContain(v.candidates[0].key);
    expect((await api(`/api/projects/${projectId}/automation/flows/${f.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'x y z' }) }, `cp_session=${other}`)).status).toBe(404);
    expect((await api(`/api/projects/${projectId}/automation/flows`, {}, `cp_session=${other}`)).status).toBe(404);
  });
});
