import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MASK } from '@codepilot/analyzer';
import { buildApp, type AppContext } from '../src/app.ts';
import { validPath } from '../src/codeStore.ts';
import { loadConfig } from '../src/config.ts';
import { sha256 } from '../src/crypto.ts';
import { createRemote, readSse, startMockGitHub, TOKEN } from './helpers.ts';

// Fake credentials, assembled so the literal never appears in one piece in this file.
const STRIPE = ['sk', 'live', 'T3stOnlyNotARealKey00000000'].join('_');
const DB_PASSWORD = 'hunter2-' + 'Pa55word';
const XSS = '<script>window.__pwned = 1</script><img src=x onerror="window.__pwned = 2">';

describe('Code tab API', () => {
  let tmp: string;
  let gh: Awaited<ReturnType<typeof startMockGitHub>>;
  let ctx: AppContext;
  let base: string;
  let cookie: string;
  let projectId: string;
  let analysisId: string;
  const otherSession = randomBytes(16).toString('hex');
  const get = (p: string, c: string | null = cookie) => fetch(`${base}${p}`, { headers: c ? { cookie: c } : {} });
  const json = async (p: string, c: string | null = cookie) => (await get(p, c)).json();
  const post = (p: string, body: unknown) => fetch(`${base}${p}`, { method: 'POST', headers: { cookie, origin: 'http://app.test', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const code = (rest = '', q = '') => `/api/projects/${projectId}/code${rest}${q}`;

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'codepilot-code-'));
    gh = await startMockGitHub();
    const webUrl = createRemote(tmp, (work) => {
      writeFileSync(path.join(work, 'src/billing.ts'), `export const STRIPE_KEY = '${STRIPE}';\nexport const DATABASE_URL = 'postgres://app:${DB_PASSWORD}@db:5432/app';\nexport function charge() {\n  return STRIPE_KEY.length;\n}\n`);
      writeFileSync(path.join(work, 'public-xss.html'), `<!doctype html>\n<p>hello</p>\n${XSS}\n`);
      writeFileSync(path.join(work, '.env'), `STRIPE_KEY=${STRIPE}\n`);
      writeFileSync(path.join(work, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
      writeFileSync(path.join(work, 'data.bin'), Buffer.from([1, 2, 0, 3, 0, 4]));
      writeFileSync(path.join(work, 'huge.txt'), 'x'.repeat(1_000_001));
      mkdirSync(path.join(work, 'node_modules/left-pad'), { recursive: true });
      writeFileSync(path.join(work, 'node_modules/left-pad/index.js'), 'module.exports = 1;\n');
    });
    // An empty repository: a remote with no commits, which GitHub reports as size 0.
    execFileSync('git', ['init', '-q', '--bare', path.join(tmp, 'remotes/octo/repo-001.git')]);
    gh.state.sizes['octo/repo-001'] = 0;
    const config = loadConfig({ dataDir: path.join(tmp, 'data'), appOrigin: 'http://app.test', devGithubToken: TOKEN, github: { apiUrl: gh.url, webUrl, oauthUrl: gh.url }, google: {}, sampleRoot: undefined, production: false });
    mkdirSync(config.dataDir, { recursive: true });
    ctx = await buildApp(config, { logger: false });
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
    cookie = (await fetch(`${base}/api/auth/dev`, { method: 'POST' })).headers.get('set-cookie')!.split(';')[0];
    const created = await (await post('/api/projects', { owner: 'acme', repo: 'fixture', branch: 'main' })).json();
    projectId = created.projectId;
    analysisId = created.analysisId;
    await readSse(`${base}/api/projects/${projectId}/analysis/stream?analysisId=${analysisId}`, cookie);
    // The Code tab's copy is written alongside the analysis; wait for it to finish.
    for (let i = 0; i < 100 && (ctx.db.prepare('SELECT status FROM code_snapshots WHERE analysis_id = ?').get(analysisId) as { status: string } | undefined)?.status !== 'ready'; i++) await new Promise((r) => setTimeout(r, 50));
    ctx.db.prepare('INSERT INTO users (id, name, email, avatar_url, created_at) VALUES (?, ?, ?, ?, ?)').run('someone-else', 'Other', null, null, new Date().toISOString());
    ctx.db.prepare('INSERT INTO sessions (id_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(sha256(otherSession), 'someone-else', Date.now() + 3_600_000, new Date().toISOString());
  }, 90_000);

  afterAll(async () => {
    await ctx?.app.close();
    gh?.server.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('lists stored files and every entry that was not stored, with accurate counts and reasons', async () => {
    const t = await json(code());
    expect(t.state).toBe('ready');
    expect(t.snapshot.analysisId).toBe(analysisId);
    const stored = t.entries.filter((e: { r?: string }) => !e.r);
    const notStored = t.entries.filter((e: { r?: string }) => e.r);
    expect(t.counts.stored).toBe(stored.length);
    expect(t.counts.notStored).toBe(notStored.length);
    expect(t.counts.stored + t.counts.notStored).toBe(t.entries.length);
    const reason = (p: string) => t.entries.find((e: { p: string }) => e.p === p)?.r;
    expect(reason('.git/')).toBe('excluded-directory');
    expect(reason('node_modules/')).toBe('excluded-directory');
    expect(reason('.env')).toBe('secret-file');
    expect(reason('logo.png')).toBe('binary');
    expect(reason('data.bin')).toBe('binary');
    expect(reason('huge.txt')).toBe('too-large');
    expect(t.entries.some((e: { p: string }) => e.p.startsWith('node_modules/left-pad'))).toBe(false);
    expect(t.counts.notStoredDirectories).toBe(2);
    expect(t.reasons['too-large']).toMatch(/1 MB/);
    // Every source file of the fixture is stored.
    for (const p of ['src/main.ts', 'src/app.tsx', 'src/widgets/Hello.vue', 'src/billing.ts', 'public-xss.html', 'package.json']) expect(reason(p), p).toBeUndefined();
    expect(stored.find((e: { p: string }) => e.p === 'src/main.ts').l).toBe('typescript');
  });

  it('masks seeded secrets before anything reaches the client: file, search and the tree', async () => {
    const res = await get(code('/file', '?path=src/billing.ts'));
    const raw = await res.text();
    expect(raw).not.toContain(STRIPE);
    expect(raw).not.toContain(DB_PASSWORD);
    const f = JSON.parse(raw);
    expect(f.content).toContain(`STRIPE_KEY = '${MASK}'`);
    expect(f.content).toContain(`postgres://app:${MASK}@db`);
    expect(f.maskedLines).toEqual([1, 2]);
    expect(f.content.split('\n')).toHaveLength(6); // line numbers never move
    // The database never holds the raw value either.
    const blobs = ctx.db.prepare('SELECT content FROM code_blobs').all() as { content: string }[];
    expect(blobs.some((b) => b.content.includes(STRIPE) || b.content.includes(DB_PASSWORD))).toBe(false);
    // Searching for the secret finds nothing; searching near it returns the masked line.
    const s1 = await (await get(code('/search', `?q=${encodeURIComponent(STRIPE.slice(0, 16))}`))).text();
    expect(JSON.parse(s1).matches).toBe(0);
    const s2raw = await (await get(code('/search', '?q=STRIPE_KEY'))).text();
    expect(s2raw).not.toContain(STRIPE);
    const s2 = JSON.parse(s2raw);
    expect(s2.results.map((r: { path: string }) => r.path)).toEqual(['src/billing.ts']);
    expect(s2.results[0].matches[0]).toMatchObject({ line: 1, col: 13, len: 10 });
    expect(s2.results[0].matches[0].text).toContain(MASK);
    // .env is never stored, so it cannot be read.
    const env = await json(code('/file', '?path=.env'));
    expect(env).toMatchObject({ stored: false, reason: 'secret-file' });
    expect(JSON.stringify(env)).not.toContain(STRIPE);
  });

  it('returns HTML and scripts as JSON text, never as a page', async () => {
    const res = await get(code('/file', '?path=public-xss.html'));
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const f = await res.json();
    expect(f.content).toContain(XSS);
    expect(f.language).toBe('html');
  });

  it('searches stored code grouped by file, with line, column, case and whole-word options', async () => {
    const s = await json(code('/search', '?q=export'));
    expect(s.filesMatched).toBe(s.results.length);
    expect(s.results.every((r: { matches: { text: string; col: number; len: number }[] }) => r.matches.every((m) => m.text.slice(m.col, m.col + m.len).toLowerCase() === 'export'))).toBe(true);
    const caseHit = await json(code('/search', '?q=EXPORT&case=1'));
    expect(caseHit.matches).toBe(0);
    const word = await json(code('/search', '?q=charge&word=1'));
    expect(word.results[0]).toMatchObject({ path: 'src/billing.ts', total: 1 });
    expect((await get(code('/search', '?q='))).status).toBe(400);
    expect((await get(code('/search', `?q=${'a'.repeat(201)}`))).status).toBe(400);
    // Regex characters are literal.
    expect((await json(code('/search', '?q=' + encodeURIComponent('(.*')))).matches).toBe(0);
  });

  it('gives an outline and the files that use (and are used by) a file, from the same snapshot', async () => {
    const o = await json(code('/outline', '?path=src/billing.ts'));
    expect(o.supported).toBe(true);
    expect(o.symbols).toContainEqual({ name: 'charge', kind: 'function', line: 3, depth: 0 });
    const r = await json(code('/relations', '?path=src/lib/format.ts'));
    expect(r.status).toBe('ready');
    expect(r.importers.length).toBeGreaterThan(0);
    for (const i of r.importers) expect(ctx.db.prepare('SELECT 1 FROM code_files WHERE analysis_id = ? AND path = ? AND stored = 1').get(analysisId, i.path)).toBeTruthy();
    const main = await json(code('/relations', '?path=src/main.ts'));
    expect(main.imports.length).toBeGreaterThan(0);
    for (const i of main.imports) {
      if (i.resolved && !i.external) expect(i.target).toBeTruthy();
      if (!i.resolved) expect(i.reason).toBeTruthy();
    }
    const md = await json(code('/outline', '?path=public-xss.html'));
    expect(md.supported).toBe(false);
  });

  it('keeps content tied to the requested snapshot', async () => {
    const sha = (ctx.db.prepare('SELECT commit_sha FROM analyses WHERE id = ?').get(analysisId) as { commit_sha: string }).commit_sha;
    expect((await json(code('', `?commit=${sha}`))).snapshot.analysisId).toBe(analysisId);
    expect((await json(code('', `?analysisId=${analysisId}`))).snapshot.commitSha).toBe(sha);
    expect((await get(code('', '?analysisId=nope'))).status).toBe(404);
    expect((await get(code('/file', '?path=src/missing.ts'))).status).toBe(404);
  });

  it('rejects path traversal and malformed paths', async () => {
    expect(validPath('src/a.ts')).toBe(true);
    for (const bad of ['../etc/passwd', 'src/../../etc/passwd', '/etc/passwd', 'src//a.ts', './src/a.ts', 'src\\a.ts', 'a\0b', '']) expect(validPath(bad), bad).toBe(false);
    for (const bad of ['../etc/passwd', '%2e%2e/%2e%2e/etc/passwd', '/etc/passwd', 'src/..']) {
      const res = await get(code('/file', `?path=${bad}`));
      expect(res.status, bad).toBe(400);
    }
  });

  it('returns 404 to anyone who cannot open the project, on every endpoint', async () => {
    const other = `sid=${otherSession}`;
    const cookieName = cookie.split('=')[0];
    const paths = [code(), code('/file', '?path=src/billing.ts'), code('/search', '?q=STRIPE'), code('/outline', '?path=src/billing.ts'), code('/relations', '?path=src/main.ts'), code('/file', '?path=../x')];
    for (const p of paths) {
      for (const c of [`${cookieName}=${otherSession}`, null, other]) {
        const res = await get(p, c);
        expect(res.status, `${p} ${c}`).toBe(404);
        expect(await res.text()).not.toContain('STRIPE');
      }
    }
  });

  it('shows where an import failed, and retry runs the real import again', async () => {
    const failed = await (await post('/api/projects', { owner: 'acme', repo: 'fixture', branch: 'no-such-branch' })).json();
    await readSse(`${base}/api/projects/${projectId}/analysis/stream?analysisId=${failed.analysisId}`, cookie);
    const t = await json(code('', `?analysisId=${failed.analysisId}`));
    expect(t.state).toBe('failed');
    expect(t.failure).toMatchObject({ stage: 'cloning', code: 'branch_not_found' });
    expect(t.canRetry).toBe(true);
    // The default view keeps the last stored snapshot and reports the newer failure.
    const latest = await json(code());
    expect(latest.state).toBe('ready');
    expect(latest.failure.stage).toBe('cloning');
    const again = await (await post('/api/projects', { owner: 'acme', repo: 'fixture', branch: 'main' })).json();
    await readSse(`${base}/api/projects/${projectId}/analysis/stream?analysisId=${again.analysisId}`, cookie);
    for (let i = 0; i < 100 && (ctx.db.prepare('SELECT status FROM code_snapshots WHERE analysis_id = ?').get(again.analysisId) as { status: string } | undefined)?.status !== 'ready'; i++) await new Promise((r) => setTimeout(r, 50));
    const after = await json(code());
    expect(after.snapshot.analysisId).toBe(again.analysisId);
    expect(after.failure).toBeNull();
    // Unchanged files share their stored contents across snapshots.
    const blobsPerSnapshot = (id: string) => (ctx.db.prepare('SELECT COUNT(DISTINCT blob_hash) AS n FROM code_files WHERE analysis_id = ? AND stored = 1').get(id) as { n: number }).n;
    expect((ctx.db.prepare('SELECT COUNT(*) AS n FROM code_blobs').get() as { n: number }).n).toBe(blobsPerSnapshot(again.analysisId));
  }, 60_000);

  it('says "Repository was empty" for a repository with nothing to import', async () => {
    const created = await (await post('/api/projects', { owner: 'octo', repo: 'repo-001', branch: 'main' })).json();
    await readSse(`${base}/api/projects/${created.projectId}/analysis/stream?analysisId=${created.analysisId}`, cookie);
    const t = await json(`/api/projects/${created.projectId}/code`);
    expect(t.state).toBe('empty');
    expect(t.failure).toBeNull();
    expect(t.counts).toMatchObject({ stored: 0, notStored: 0 });
  }, 30_000);
});
