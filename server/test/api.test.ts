import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { edgeKey, expectedEdgeKeys } from '../../packages/analyzer/test/expected.ts';
import { buildApp, type AppContext } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { createRemote, readSse, startMockGitHub, TOKEN, TOTAL_REPOS, type SseEvent } from './helpers.ts';

describe('API: onboarding → analysis → graph', () => {
  let tmp: string;
  let gh: Awaited<ReturnType<typeof startMockGitHub>>;
  let ctx: AppContext;
  let base: string;
  let cookie: string;
  let projectId: string;
  let streamEvents: SseEvent[];

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'codepilot-api-'));
    gh = await startMockGitHub();
    const webUrl = createRemote(tmp);
    const config = loadConfig({
      dataDir: path.join(tmp, 'data'),
      appOrigin: 'http://app.test',
      devGithubToken: TOKEN,
      github: { apiUrl: gh.url, webUrl, oauthUrl: gh.url },
      google: {},
      sampleRoot: undefined,
      production: false,
    });
    mkdirSync(config.dataDir, { recursive: true });
    ctx = await buildApp(config, { logger: false });
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;

    const login = await fetch(`${base}/api/auth/dev`, { method: 'POST' });
    expect(login.status).toBe(200);
    cookie = login.headers.get('set-cookie')!.split(';')[0];
  }, 60_000);

  afterAll(async () => {
    await ctx?.app.close();
    gh?.server.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const api = (p: string, init: RequestInit = {}) => fetch(`${base}${p}`, { ...init, headers: { cookie, ...(init.headers ?? {}) } });

  it('never sends the GitHub token to the browser', async () => {
    const me = await (await api('/api/me')).text();
    expect(me).toContain('"login":"octo"');
    expect(me).not.toContain(TOKEN);
    // Stored encrypted at rest, not in plaintext.
    const row = ctx.db.prepare("SELECT token_enc FROM accounts WHERE provider = 'github'").get() as { token_enc: string };
    expect(row.token_enc.startsWith('v1:')).toBe(true);
    expect(row.token_enc).not.toContain(TOKEN);
  });

  it('lists the real repositories GitHub returns, across API pages, with search, owner filter and pagination', async () => {
    const all = await (await api('/api/github/repos?perPage=100')).json();
    expect(all.total).toBe(TOTAL_REPOS);
    expect(all.pages).toBe(2);
    expect(all.repos).toHaveLength(100);
    expect(all.owners.map((o: { login: string }) => o.login)).toEqual(['octo', 'acme']);
    const page2 = await (await api('/api/github/repos?perPage=100&page=2')).json();
    expect(page2.repos).toHaveLength(50);
    const acme = await (await api('/api/github/repos?owner=acme')).json();
    expect(acme.repos.every((r: { owner: string }) => r.owner === 'acme')).toBe(true);
    const search = await (await api('/api/github/repos?q=fixture')).json();
    expect(search.repos.map((r: { fullName: string }) => r.fullName)).toEqual(['acme/fixture']);
    expect(search.repos[0]).toMatchObject({ language: 'TypeScript', private: true, project: null });
  });

  it('lists branches with the default branch first', async () => {
    const body = await (await api('/api/github/repos/acme/fixture')).json();
    expect(body.branches.map((b: { name: string; isDefault: boolean }) => [b.name, b.isDefault])).toEqual([
      ['main', true],
      ['feature/x', false],
    ]);
  });

  it('rejects cross-origin state-changing requests', async () => {
    const res = await api('/api/projects', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(403);
  });

  it('starts a real analysis and streams real progress over SSE until complete', async () => {
    const res = await api('/api/projects', {
      method: 'POST',
      headers: { origin: 'http://app.test', 'content-type': 'application/json' },
      body: JSON.stringify({ owner: 'acme', repo: 'fixture', branch: 'main' }),
    });
    expect(res.status).toBe(200);
    const created = await res.json();
    projectId = created.projectId;
    streamEvents = await readSse(`${base}/api/projects/${projectId}/analysis/stream?analysisId=${created.analysisId}`, cookie);

    const stages = streamEvents.filter((e) => e.event === 'stage').map((e) => e.data.stage);
    const snapshotStage = streamEvents[0].data.stage;
    const seen = [snapshotStage, ...stages];
    const order = ['queued', 'cloning', 'scanning', 'parsing', 'resolving', 'building', 'complete'];
    const indices = seen.map((s) => order.indexOf(s));
    expect(indices.every((v, i) => i === 0 || v >= indices[i - 1])).toBe(true);
    expect(seen.at(-1)).toBe('complete');
    for (const s of ['parsing', 'resolving', 'complete']) expect(seen).toContain(s);

    const progress = streamEvents.filter((e) => e.event === 'progress').map((e) => e.data);
    expect(progress.length).toBeGreaterThan(0);
    const last = progress.at(-1);
    expect(last.edgesFound).toBe(expectedEdgeKeys().length);
    for (let i = 1; i < progress.length; i++) expect(progress[i].edgesFound).toBeGreaterThanOrEqual(progress[i - 1].edgesFound);

    const partialEdges = streamEvents.filter((e) => e.event === 'partial').flatMap((e) => e.data.edges);
    expect(partialEdges).toHaveLength(expectedEdgeKeys().length);
    expect(streamEvents.at(-1)!.event).toBe('complete');
    expect(JSON.stringify(streamEvents)).not.toContain(TOKEN);
  });

  it('serves the analyzed graph with exactly the hand-verified edges and stable positions', async () => {
    const g = await (await api(`/api/projects/${projectId}/graph?layout=force`)).json();
    expect(g.edges.map(edgeKey).sort()).toEqual(expectedEdgeKeys());
    expect(g.analysis.commitSha).toMatch(/^[0-9a-f]{40}$/);
    for (const n of g.nodes) expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true);
    const again = await (await api(`/api/projects/${projectId}/graph?layout=force`)).json();
    expect(again.nodes.map((n: { x: number }) => n.x)).toEqual(g.nodes.map((n: { x: number }) => n.x));

    const filtered = await (await api(`/api/projects/${projectId}/graph?types=component`)).json();
    expect(new Set(filtered.nodes.map((n: { type: string }) => n.type))).toEqual(new Set(['component']));
    const focus = await (await api(`/api/projects/${projectId}/graph?focus=${encodeURIComponent('src/lib/format.ts')}&depth=1`)).json();
    expect(focus.nodes.map((n: { id: string }) => n.id).sort()).toEqual([
      'src/components/Button.tsx',
      'src/lib/format.ts',
      'src/main.ts',
      'src/orphan.ts',
      'src/widgets/Hello.vue',
    ]);
  });

  it('returns node details whose imports and consumers match the source', async () => {
    const d = await (await api(`/api/projects/${projectId}/graph/nodes/${encodeURIComponent('src/app.tsx')}`)).json();
    expect(d.imports.map((i: { specifier: string; line: number; resolved: boolean }) => [i.specifier, i.line, i.resolved])).toEqual([
      ['react', 1, true],
      ['./components', 2, true],
      ['./hooks/useSession.js', 3, true],
      ['./does-not-exist', 4, false],
    ]);
    expect(d.consumers.map((c: { source: string; line: number }) => [c.source, c.line])).toEqual([
      ['src/app.test.ts', 1],
      ['src/main.ts', 1],
    ]);
    expect(d.counts).toEqual({ dependencies: 2, dependents: 2, externalImports: 1, unresolvedImports: 1 });
    expect(d.transitive.dependencies[2]).toContain('src/components/Button.tsx');

    const fmt = await (await api(`/api/projects/${projectId}/graph/nodes/${encodeURIComponent('src/lib/format.ts')}`)).json();
    expect(fmt.facts.exports.map((e: { name: string; line: number }) => [e.name, e.line])).toEqual([
      ['formatDate', 1],
      ['cn', 5],
    ]);
    expect(fmt.transitive.dependents[1].length).toBe(4);
  });

  it('serves the summary: cycles, orphans and entry points', async () => {
    const s = (await (await api(`/api/projects/${projectId}/graph/summary`)).json()).summary;
    expect(s.cycles).toHaveLength(2);
    expect(s.orphans.map((o: { id: string }) => o.id)).toContain('src/isolated.ts');
    expect(s.entryPoints.map((e: { id: string }) => e.id)).toContain('src/main.ts');
  });

  it('exports JSON, SVG and PNG', async () => {
    const json = await api(`/api/projects/${projectId}/graph/export?format=json`);
    expect(json.headers.get('content-disposition')).toContain('.json');
    const body = await json.json();
    expect(body.repository).toMatchObject({ fullName: 'acme/fixture', branch: 'main' });
    expect(body.nodes.length).toBeGreaterThan(0);
    expect(body.edges.map(edgeKey).sort()).toEqual(expectedEdgeKeys());

    const svg = await api(`/api/projects/${projectId}/graph/export?format=svg`);
    expect(svg.headers.get('content-type')).toContain('image/svg+xml');
    expect(await svg.text()).toContain('<svg');

    const png = await api(`/api/projects/${projectId}/graph/export?format=png`);
    expect(png.headers.get('content-type')).toBe('image/png');
    const bytes = new Uint8Array(await png.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('serves an evidence-backed architecture, cached by commit, with flows, summary and exports', async () => {
    const res = await api(`/api/projects/${projectId}/architecture`);
    expect(res.status).toBe(200);
    const { architecture: a } = await res.json();
    expect(a.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(a.nodes.length).toBeGreaterThan(0);
    for (const n of a.nodes) for (const id of n.evidence) expect(a.evidence[id]).toBeDefined();
    for (const e of a.edges) expect(e.evidence.length).toBeGreaterThan(0);
    // Computed once per commit: detection ran after analysis and the stored result is reused.
    const rows = ctx.db.prepare('SELECT COUNT(*) AS n FROM architectures WHERE project_id = ?').get(projectId) as { n: number };
    expect(rows.n).toBe(1);
    const again = (await (await api(`/api/projects/${projectId}/architecture`)).json()).architecture;
    expect(again.id).toBe(a.id);

    // Technology intelligence belongs to this snapshot: same architecture, same commit, every citation present.
    const intel = await (await api(`/api/projects/${projectId}/architecture/intelligence`)).json();
    expect(intel.snapshot).toMatchObject({ architectureId: a.id, commitSha: a.commitSha });
    expect(intel.technologies.length).toBeGreaterThan(0);
    for (const t of intel.technologies) {
      expect(['confirmed', 'strong', 'possible', 'unknown']).toContain(t.why.confidence);
      for (const id of [...t.role.evidence, ...t.why.evidence]) expect(intel.evidence[id]).toBeDefined();
    }

    const tool = await (await api(`/api/projects/${projectId}/architecture/tools/${encodeURIComponent(a.nodes[0].id)}`)).json();
    expect(tool.node.id).toBe(a.nodes[0].id);
    expect(Object.keys(tool.evidence).length).toBeGreaterThan(0);
    expect((await api(`/api/projects/${projectId}/architecture/tools/nope`)).status).toBe(404);
    expect(Array.isArray((await (await api(`/api/projects/${projectId}/architecture/flows`)).json()).flows)).toBe(true);

    // Snapshots: completed analyses of this project, newest first; flows can be read per snapshot.
    const { snapshots } = await (await api(`/api/projects/${projectId}/snapshots`)).json();
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots[0]).toMatchObject({ current: true, commitSha: a.commitSha });
    expect(snapshots.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    const pinned = await api(`/api/projects/${projectId}/architecture/flows?analysisId=${snapshots[0].analysisId}`);
    expect(pinned.status).toBe(200);
    expect((await api(`/api/projects/${projectId}/architecture/flows?analysisId=nope`)).status).toBe(404);
    expect((await (await api(`/api/projects/${projectId}/architecture/summary`)).json()).summary.totals.apps).toBeGreaterThan(0);

    const regen = await api(`/api/projects/${projectId}/architecture/regenerate`, { method: 'POST', headers: { origin: 'http://app.test' } });
    expect(regen.status).toBe(200);
    expect((await regen.json()).architecture.id).not.toBe(a.id);

    const mermaid = await (await api(`/api/projects/${projectId}/architecture/export?format=mermaid`)).text();
    expect(mermaid.startsWith('flowchart TB')).toBe(true);
    const svg = await (await api(`/api/projects/${projectId}/architecture/export?format=svg`)).text();
    expect(svg).toContain('<svg');
    const png = new Uint8Array(await (await api(`/api/projects/${projectId}/architecture/export?format=png`)).arrayBuffer());
    expect([...png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const pdf = Buffer.from(await (await api(`/api/projects/${projectId}/architecture/export?format=pdf`)).arrayBuffer());
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.subarray(-6).toString()).toContain('%%EOF');
    const json = await (await api(`/api/projects/${projectId}/architecture/export?format=json`)).json();
    expect(json.repository.fullName).toBe('acme/fixture');
    expect(json.nodes.length).toBe(a.nodes.length);
  });

  it('serves graph layouts by name, including the layered layout', async () => {
    for (const layout of ['force', 'circular', 'layered']) {
      const body = await (await api(`/api/projects/${projectId}/graph/layout?layout=${layout}`)).json();
      expect(Object.keys(body.positions).length).toBeGreaterThan(0);
    }
    expect((await api(`/api/projects/${projectId}/graph/layout?layout=nope`)).status).toBe(400);
  });

  it('creates read-only share links scoped to one view, which can be revoked', async () => {
    const created = await (await api(`/api/projects/${projectId}/shares`, { method: 'POST', headers: { origin: 'http://app.test', 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'architecture' }) })).json();
    expect(created.url).toContain('/share/');
    // Anyone with the token can read, without a session.
    expect((await fetch(`${base}/api/shared/${created.token}/architecture`)).status).toBe(200);
    // …but only the shared view.
    expect((await fetch(`${base}/api/shared/${created.token}/graph`)).status).toBe(404);
    const stored = ctx.db.prepare('SELECT token_hash FROM shares WHERE id = ?').get(created.id) as { token_hash: string };
    expect(stored.token_hash).not.toBe(created.token);
    expect((await api(`/api/projects/${projectId}/shares/${created.id}`, { method: 'DELETE', headers: { origin: 'http://app.test' } })).status).toBe(200);
    expect((await fetch(`${base}/api/shared/${created.token}/architecture`)).status).toBe(404);
  });

  it('marks imported repositories in the repository list', async () => {
    const search = await (await api('/api/github/repos?q=fixture')).json();
    expect(search.repos[0].project).toMatchObject({ id: projectId, lastStatus: 'complete' });
  });

  it('hides projects from other users', async () => {
    const res = await fetch(`${base}/api/projects/${projectId}/graph`);
    expect(res.status).toBe(404);
  });

  it('streams an actionable error when the branch does not exist', async () => {
    const created = await (
      await api('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ owner: 'acme', repo: 'fixture', branch: 'no-such-branch' }),
      })
    ).json();
    const events = await readSse(`${base}/api/projects/${created.projectId}/analysis/stream?analysisId=${created.analysisId}`, cookie);
    const err = events.find((e) => e.event === 'failure')!;
    expect(err.data.code).toBe('branch_not_found');
    expect(err.data.message).toContain('no-such-branch');
  });

  it('reports expired GitHub access with a reconnect action', async () => {
    gh.state.expired = true;
    try {
      const res = await api('/api/github/repos?refresh=1');
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        code: 'github_auth_expired',
        message: 'GitHub access expired. Reconnect GitHub to continue.',
        action: { label: 'Reconnect GitHub', href: '/api/auth/github/start?intent=connect' },
      });
    } finally {
      gh.state.expired = false;
    }
  });
});
