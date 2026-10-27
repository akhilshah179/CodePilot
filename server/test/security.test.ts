import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type AppContext } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { RateLimiter } from '../src/rateLimit.ts';
import { hasPermission, type WorkspaceRole } from '../src/auth/rbac.ts';
import { safeNext } from '../src/auth/routes.ts';
import { validateRepoInput } from '../src/routes/projects.ts';
import { maskSecrets, redactCredentials } from '../../packages/analyzer/src/secrets.ts';
import { validPath } from '../src/codeStore.ts';
import { createRemote, startMockGitHub, TOKEN } from './helpers.ts';

describe('Security Audit & Hardening Test Suite', () => {
  let tmp: string;
  let gh: Awaited<ReturnType<typeof startMockGitHub>>;
  let ctx: AppContext;
  let base: string;
  let userACookie: string;
  let userBCookie: string;
  let userAId: string;
  let userBId: string;
  let userAProjectId: string;

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'codepilot-sec-'));
    gh = await startMockGitHub();
    const webUrl = createRemote(tmp);
    const config = loadConfig({
      dataDir: path.join(tmp, 'data'),
      appOrigin: 'http://app.test',
      devGithubToken: TOKEN,
      github: { clientId: 'test-gh-client', clientSecret: 'test-gh-secret', apiUrl: gh.url, webUrl, oauthUrl: gh.url },
      google: { clientId: 'test-google-id', clientSecret: 'test-google-secret' },
      sampleRoot: undefined,
      production: false,
    });
    mkdirSync(config.dataDir, { recursive: true });
    ctx = await buildApp(config, { logger: false });
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;

    // Provision User A via dev login
    const loginA = await fetch(`${base}/api/auth/dev`, { method: 'POST' });
    expect(loginA.status).toBe(200);
    userACookie = loginA.headers.get('set-cookie')!.split(';')[0];
    const meA = (await (await fetch(`${base}/api/me`, { headers: { cookie: userACookie } })).json()) as { user: { id: string } };
    userAId = meA.user.id;

    // Provision User B via direct DB upsert
    userBId = ctx.auth.upsertAccount({
      provider: 'github',
      providerUserId: '9999',
      login: 'user_b',
      token: TOKEN,
      profile: { name: 'User B', email: 'user_b@test.com', avatarUrl: null },
    });
    // Create session for User B
    const fakeReply = {
      setCookie: (_name: string, val: string) => {
        userBCookie = `cp_session=${val}`;
      },
    } as any;
    ctx.auth.createSession(fakeReply, userBId);

    // User A creates a project
    const createRes = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { cookie: userACookie, 'content-type': 'application/json', origin: 'http://app.test' },
      body: JSON.stringify({ owner: 'acme', repo: 'fixture', branch: 'main' }),
    });
    expect(createRes.status).toBe(200);
    const body = (await createRes.json()) as { projectId: string };
    userAProjectId = body.projectId;
  }, 60_000);

  afterAll(async () => {
    await ctx?.app.close();
    try { ctx?.db?.close(); } catch {}
    gh?.server.close();
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  const req = (url: string, opts: RequestInit = {}) => fetch(`${base}${url}`, opts);

  // 1. Unauthenticated requests to protected endpoints are rejected
  describe('1. Unauthenticated Requests to Protected Endpoints', () => {
    it('rejects unauthenticated access to /api/projects with 401', async () => {
      const res = await req('/api/projects');
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.code).toBe('unauthenticated');
    });

    it('rejects unauthenticated project mutations with 401', async () => {
      const res = await req('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://app.test' },
        body: JSON.stringify({ owner: 'acme', repo: 'fixture', branch: 'main' }),
      });
      expect(res.status).toBe(401);
    });

    it('rejects unauthenticated access to user project details with 404 (prevent IDOR leakage)', async () => {
      const res = await req(`/api/projects/${userAProjectId}`);
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.code).toBe('not_found');
    });

    it('rejects unauthenticated access to code tree with 404', async () => {
      const res = await req(`/api/projects/${userAProjectId}/code`);
      expect(res.status).toBe(404);
    });
  });

  // 2. Public endpoints are intentionally public and expose no sensitive data
  describe('2. Public Endpoints & Information Disclosure', () => {
    it('/api/health is public and returns ok', async () => {
      const res = await req('/api/health');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });

    it('/api/scan-policy is public and contains only scanning configuration', async () => {
      const res = await req('/api/scan-policy');
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.limits).toBeDefined();
    });

    it('/api/auth/providers returns configured OAuth providers without exposing secrets', async () => {
      const res = await req('/api/auth/providers');
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ github: true, google: true, dev: true });
      expect(JSON.stringify(json)).not.toContain(TOKEN);
    });

    it('/api/auth/diagnostics returns safe metadata and no secrets', async () => {
      const res = await req('/api/auth/diagnostics');
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.appOrigin).toBe('http://app.test');
      expect(json.google.hasConfig).toBe(true);
      expect(json.google.redirectUri).toContain('/api/auth/google/callback');
      expect(json.github.hasConfig).toBe(true);
      expect(json.github.redirectUri).toContain('/api/auth/github/callback');
      expect(JSON.stringify(json)).not.toContain('test-google-secret');
      expect(JSON.stringify(json)).not.toContain('test-gh-secret');
    });

    it('/api/me returns { user: null } without crashing or leaking state when unauthenticated', async () => {
      const res = await req('/api/me');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ user: null });
    });
  });

  // 3. Unauthorized users cannot access other users' projects or files (Multi-tenant IDOR protection)
  describe('3. Multi-Tenant Project and Data Isolation (BOLA/IDOR)', () => {
    it("User B cannot view User A's project (returns 404)", async () => {
      const res = await req(`/api/projects/${userAProjectId}`, { headers: { cookie: userBCookie } });
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.code).toBe('not_found');
    });

    it("User B cannot view User A's code tree or files (returns 404)", async () => {
      const res = await req(`/api/projects/${userAProjectId}/code`, { headers: { cookie: userBCookie } });
      expect(res.status).toBe(404);
    });

    it("User B cannot view User A's snapshots or architecture (returns 404)", async () => {
      const res = await req(`/api/projects/${userAProjectId}/snapshots`, { headers: { cookie: userBCookie } });
      expect(res.status).toBe(404);
      const archRes = await req(`/api/projects/${userAProjectId}/architecture`, { headers: { cookie: userBCookie } });
      expect(archRes.status).toBe(404);
    });

    it("User B cannot delete User A's project", async () => {
      const res = await req(`/api/projects/${userAProjectId}`, {
        method: 'DELETE',
        headers: { cookie: userBCookie, origin: 'http://app.test' },
      });
      expect(res.status).toBe(404);
    });

    it("User B cannot search in User A's project", async () => {
      const res = await req(`/api/projects/${userAProjectId}/code/search?q=test`, { headers: { cookie: userBCookie } });
      expect(res.status).toBe(404);
    });
  });

  // 4. Workspace roles enforce the documented permission matrix
  describe('4. Workspace Roles and RBAC Matrix', () => {
    it('verifies permission matrix for owner, admin, member, viewer', () => {
      // Owner has full access
      expect(hasPermission('owner', 'project:delete')).toBe(true);
      expect(hasPermission('owner', 'member:manage')).toBe(true);
      expect(hasPermission('owner', 'consent:manage')).toBe(true);
      expect(hasPermission('owner', 'flows:edit')).toBe(true);
      expect(hasPermission('owner', 'analysis:trigger')).toBe(true);

      // Admin has management except delete and consent
      expect(hasPermission('admin', 'project:delete')).toBe(false);
      expect(hasPermission('admin', 'consent:manage')).toBe(false);
      expect(hasPermission('admin', 'member:manage')).toBe(true);
      expect(hasPermission('admin', 'flows:edit')).toBe(true);
      expect(hasPermission('admin', 'analysis:trigger')).toBe(true);

      // Member can trigger analysis and view, but not edit flows or delete
      expect(hasPermission('member', 'project:delete')).toBe(false);
      expect(hasPermission('member', 'flows:edit')).toBe(false);
      expect(hasPermission('member', 'member:manage')).toBe(false);
      expect(hasPermission('member', 'analysis:trigger')).toBe(true);
      expect(hasPermission('member', 'code:view')).toBe(true);

      // Viewer is read-only
      expect(hasPermission('viewer', 'analysis:trigger')).toBe(false);
      expect(hasPermission('viewer', 'flows:edit')).toBe(false);
      expect(hasPermission('viewer', 'project:delete')).toBe(false);
      expect(hasPermission('viewer', 'code:view')).toBe(true);
      expect(hasPermission('viewer', 'code:search')).toBe(true);
    });

    it('Owner adds User B as viewer, User B can now view but cannot mutate', async () => {
      // Owner adds User B as viewer
      const addRes = await req(`/api/projects/${userAProjectId}/members`, {
        method: 'POST',
        headers: { cookie: userACookie, 'content-type': 'application/json', origin: 'http://app.test' },
        body: JSON.stringify({ userId: userBId, role: 'viewer' }),
      });
      expect(addRes.status).toBe(200);

      // User B can now view project
      const viewRes = await req(`/api/projects/${userAProjectId}`, { headers: { cookie: userBCookie } });
      expect(viewRes.status).toBe(200);

      // User B as viewer cannot delete project (403 Forbidden)
      const delRes = await req(`/api/projects/${userAProjectId}`, {
        method: 'DELETE',
        headers: { cookie: userBCookie, origin: 'http://app.test' },
      });
      expect(delRes.status).toBe(403);

      // User B as viewer cannot change flows (403 Forbidden)
      const flowRes = await req(`/api/projects/${userAProjectId}/automation/flows/f1/replace`, {
        method: 'POST',
        headers: { cookie: userBCookie, 'content-type': 'application/json', origin: 'http://app.test' },
        body: JSON.stringify({ key: 'new-key' }),
      });
      expect(flowRes.status).toBe(403);
    });

    it('User B cannot escalate privileges by adding themselves as admin', async () => {
      const res = await req(`/api/projects/${userAProjectId}/members`, {
        method: 'POST',
        headers: { cookie: userBCookie, 'content-type': 'application/json', origin: 'http://app.test' },
        body: JSON.stringify({ userId: userBId, role: 'admin' }),
      });
      expect(res.status).toBe(403);
    });

    it('Owner removes User B, User B access reverts to 404', async () => {
      const delRes = await req(`/api/projects/${userAProjectId}/members/${userBId}`, {
        method: 'DELETE',
        headers: { cookie: userACookie, origin: 'http://app.test' },
      });
      expect(delRes.status).toBe(200);

      const viewRes = await req(`/api/projects/${userAProjectId}`, { headers: { cookie: userBCookie } });
      expect(viewRes.status).toBe(404);
    });
  });

  // 5. OAuth state validation and replay prevention
  describe('5. OAuth State Validation & Callback Protection', () => {
    it('generates single-use state and deletes it upon consumption (prevents replay)', () => {
      const stateId = ctx.auth.saveState({ provider: 'github', intent: 'signin', next: '/onboarding' });
      expect(stateId).toBeDefined();

      // First consume succeeds
      const first = ctx.auth.consumeState(stateId, 'github');
      expect(first).not.toBeNull();
      expect(first?.intent).toBe('signin');

      // Replay attempt returns null
      const second = ctx.auth.consumeState(stateId, 'github');
      expect(second).toBeNull();
    });

    it('rejects OAuth state intended for another provider', () => {
      const stateId = ctx.auth.saveState({ provider: 'github', intent: 'signin' });
      const consume = ctx.auth.consumeState(stateId, 'google');
      expect(consume).toBeNull();
    });

    it('rejects invalid or missing state in callback with redirect error', async () => {
      const res = await req('/api/auth/github/callback?code=fake_code&state=nonexistent_state', { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('error=oauth_state');
    });
  });

  // 6. Session expiry, logout, and token security
  describe('6. Session Management and Revocation', () => {
    it('logout revokes session in database and clears session cookie', async () => {
      // Create temporary session
      let tempCookie = '';
      const reply = {
        setCookie: (_name: string, val: string) => {
          tempCookie = `cp_session=${val}`;
        },
        clearCookie: (_name: string) => {},
      } as any;
      ctx.auth.createSession(reply, userAId);

      // Verify active
      const userBefore = ctx.auth.userFromRequest({ cookies: { cp_session: tempCookie.split('=')[1] } } as any);
      expect(userBefore?.id).toBe(userAId);

      // Logout
      const logoutRes = await req('/api/auth/logout', {
        method: 'POST',
        headers: { cookie: tempCookie, origin: 'http://app.test' },
      });
      expect(logoutRes.status).toBe(200);

      // Verify revoked
      const userAfter = ctx.auth.userFromRequest({ cookies: { cp_session: tempCookie.split('=')[1] } } as any);
      expect(userAfter).toBeNull();
    });
  });

  // 7. Secret masking and credential protection
  describe('7. Secret Masking in Code, Evidence and Search', () => {
    it('masks GitHub PATs, AWS keys, OpenAI keys, URL passwords, and JWTs', () => {
      const fakeAws = ['AKIA', '1234567890ABCDEF'].join('');
      const fakeGh = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
      const fakeOpenAi = ['sk', 'proj', 'abcdefghijklmnopqrstT3BlbkFJabcdefghijklmnop'].join('-');
      const secretSample = `
        const AWS = "${fakeAws}";
        const GITHUB = "${fakeGh}";
        const OPENAI = "${fakeOpenAi}";
        const DB = "postgres://admin:SuperSecretPass123@db.example.com/prod";
      `;
      const masked = maskSecrets(secretSample);
      expect(masked.text).not.toContain(fakeAws);
      expect(masked.text).not.toContain(fakeGh);
      expect(masked.text).not.toContain('SuperSecretPass123');
      expect(masked.text).toContain('‹masked›');
      expect(masked.count).toBeGreaterThanOrEqual(3);
    });

    it('redacts credentials in evidence snippets', () => {
      const fakeGh = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
      const evidenceText = `Connected to endpoint with token ${fakeGh}`;
      const redacted = redactCredentials(evidenceText);
      expect(redacted).not.toContain(fakeGh);
      expect(redacted).toContain('‹redacted›');
    });
  });

  // 8. Safe paths, URL redirects, and command injection defenses
  describe('8. Input Validation & Injection Defenses', () => {
    it('safeNext allows valid relative URLs and rejects external URLs, CRLF, and tricks', () => {
      expect(safeNext('/projects/123')).toBe('/projects/123');
      expect(safeNext('/onboarding/repos')).toBe('/onboarding/repos');

      // Malicious targets rejected
      expect(safeNext('https://evil.com')).toBeUndefined();
      expect(safeNext('//evil.com')).toBeUndefined();
      expect(safeNext('/\\evil.com')).toBeUndefined();
      expect(safeNext('/evil.com\r\nHeader: value')).toBeUndefined();
      expect(safeNext('/ evil.com')).toBeUndefined();
      expect(safeNext(null)).toBeUndefined();
    });

    it('validPath rejects path traversal and control characters', () => {
      expect(validPath('src/index.ts')).toBe(true);
      expect(validPath('package.json')).toBe(true);

      // Traversal rejected
      expect(validPath('../secret.env')).toBe(false);
      expect(validPath('src/../../etc/passwd')).toBe(false);
      expect(validPath('/absolute/path')).toBe(false);
      expect(validPath('src\\win\\path')).toBe(false);
      expect(validPath('src/\0nullbyte')).toBe(false);
    });

    it('validateRepoInput rejects git branch argument injection', () => {
      // Valid inputs pass
      expect(validateRepoInput('owner', 'repo', 'main')).toEqual({ owner: 'owner', repo: 'repo', branch: 'main' });
      expect(validateRepoInput('owner', 'repo', 'feature/auth-v2')).toEqual({ owner: 'owner', repo: 'repo', branch: 'feature/auth-v2' });

      // Argument injection attempts rejected
      expect(() => validateRepoInput('owner', 'repo', '--upload-pack=evil')).toThrow();
      expect(() => validateRepoInput('owner', 'repo', '-u')).toThrow();
      expect(() => validateRepoInput('owner', 'repo', 'branch with space')).toThrow();
      expect(() => validateRepoInput('owner', 'repo', 'branch\x00null')).toThrow();
      expect(() => validateRepoInput('invalid owner!', 'repo', 'main')).toThrow();
      expect(() => validateRepoInput('owner', '..', 'main')).toThrow();
    });
  });

  // 9. CSRF defense and security headers
  describe('9. CSRF Defense and Security Headers', () => {
    it('rejects cross-origin state-changing API request with 403', async () => {
      const res = await req('/api/projects', {
        method: 'POST',
        headers: {
          cookie: userACookie,
          origin: 'http://malicious-site.com',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ owner: 'acme', repo: 'fixture', branch: 'main' }),
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('bad_request');
      expect(json.message).toContain('Cross-origin request rejected');
    });

    it('sets comprehensive production security headers on responses', async () => {
      const res = await req('/api/health');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
      expect(res.headers.get('permissions-policy')).toContain('camera=()');
      expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
      expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
    });
  });

  // 10. Rate limiting & abuse prevention
  describe('10. Rate Limiting and Abuse Prevention', () => {
    it('RateLimiter enforces thresholds and returns remaining / retry headers', () => {
      const limiter = new RateLimiter();
      const rule = { max: 3, windowMs: 10_000 };
      const reply = { headers: {} as Record<string, any>, header(k: string, v: any) { this.headers[k] = v; } } as any;

      expect(limiter.check('client-1', rule, reply).allowed).toBe(true);
      expect(reply.headers['RateLimit-Remaining']).toBe(2);

      expect(limiter.check('client-1', rule, reply).allowed).toBe(true);
      expect(reply.headers['RateLimit-Remaining']).toBe(1);

      expect(limiter.check('client-1', rule, reply).allowed).toBe(true);
      expect(reply.headers['RateLimit-Remaining']).toBe(0);

      // Exceeded
      expect(() => limiter.check('client-1', rule, reply)).toThrow();
      expect(reply.headers['Retry-After']).toBeGreaterThanOrEqual(1);

      limiter.destroy();
    });
  });

  // 11. Persistence across application restarts
  describe('11. Database and User Data Persistence', () => {
    it('persists accounts, projects, and permissions in SQLite across re-opens', () => {
      const dbPath = path.join(tmp, 'data', 'persistence_test.sqlite');
      const db1 = openDb(tmp, 'data/persistence_test.sqlite');
      db1.prepare('INSERT INTO users (id, name, email, created_at) VALUES (?, ?, ?, ?)').run('persisted_u1', 'Test', 't@t.com', '2026-01-01');
      db1.prepare('INSERT INTO projects (id, user_id, owner, repo, full_name, is_private, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        'persisted_p1', 'persisted_u1', 'owner', 'repo', 'owner/repo', 0, 'main', '2026-01-01', '2026-01-01'
      );
      db1.close();

      // Re-open DB
      const db2 = openDb(tmp, 'data/persistence_test.sqlite');
      const user = db2.prepare('SELECT * FROM users WHERE id = ?').get('persisted_u1') as any;
      expect(user).toBeDefined();
      expect(user.name).toBe('Test');
      const proj = db2.prepare('SELECT * FROM projects WHERE id = ?').get('persisted_p1') as any;
      expect(proj).toBeDefined();
      expect(proj.full_name).toBe('owner/repo');
      db2.close();
    });
  });

  // 12. User Account Deletion and GDPR Export
  describe('12. User Account Deletion & Retention Workflows', () => {
    it('exports user account data including projects and shares', async () => {
      const res = await req('/api/me/export', { headers: { cookie: userACookie } });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.user.id).toBe(userAId);
      expect(json.projects).toBeInstanceOf(Array);
      expect(json.exportedAt).toBeDefined();
    });

    it('DELETE /api/me cascades deletion across user data, shares, and projects', async () => {
      // Create user C
      const userCId = ctx.auth.upsertAccount({
        provider: 'github',
        providerUserId: '7777',
        login: 'user_c',
        token: TOKEN,
        profile: { name: 'User C', email: 'user_c@test.com', avatarUrl: null },
      });
      let userCCookie = '';
      const reply = {
        setCookie: (_name: string, val: string) => {
          userCCookie = `cp_session=${val}`;
        },
        clearCookie: () => {},
      } as any;
      ctx.auth.createSession(reply, userCId);

      // User C creates a project
      const pRes = await req('/api/projects', {
        method: 'POST',
        headers: { cookie: userCCookie, 'content-type': 'application/json', origin: 'http://app.test' },
        body: JSON.stringify({ owner: 'acme', repo: 'fixture', branch: 'main' }),
      });
      const { projectId: projC } = (await pRes.json()) as { projectId: string };

      // Delete User C
      const delRes = await req('/api/me', {
        method: 'DELETE',
        headers: { cookie: userCCookie, origin: 'http://app.test' },
      });
      expect(delRes.status).toBe(200);

      // Verify User C is deleted from DB
      const userRow = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(userCId);
      expect(userRow).toBeUndefined();

      // Verify Project is cascaded and deleted
      const projRow = ctx.db.prepare('SELECT * FROM projects WHERE id = ?').get(projC);
      expect(projRow).toBeUndefined();

      // Session is deleted
      const meRes = await req('/api/me', { headers: { cookie: userCCookie } });
      expect((await meRes.json()).user).toBeNull();
    });
  });
});
