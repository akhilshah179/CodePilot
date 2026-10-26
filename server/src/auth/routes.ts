import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.ts';
import { randomId } from '../crypto.ts';
import { AppError } from '../errors.ts';
import { GitHubClient } from '../github.ts';
import type { AuthStore } from './store.ts';

import type { RateLimiter } from '../rateLimit.ts';
import { getClientKey } from '../rateLimit.ts';

const GITHUB_SCOPES = 'repo read:org read:user user:email';

/** Only same-origin relative paths are accepted as post-login destinations. */
export function safeNext(next: unknown): string | undefined {
  if (typeof next !== 'string') return undefined;
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\') || /[\x00-\x1f\s]/.test(next)) return undefined;
  if (/^\/[\\/\s]/.test(next)) return undefined;
  return next;
}

export function registerAuthRoutes(app: FastifyInstance, config: Config, store: AuthStore, rateLimiter?: RateLimiter, codeStore?: { collectGarbage(): void }) {
  const callbackUrl = (provider: string) => `${config.appOrigin}/api/auth/${provider}/callback`;
  const failRedirect = (reply: FastifyReply, code: string) => reply.redirect(`${config.appOrigin}/signin?error=${encodeURIComponent(code)}`);

  const checkAuthRateLimit = (request: FastifyRequest, reply: FastifyReply) => {
    if (!rateLimiter) return;
    const key = `auth:${getClientKey(request)}`;
    rateLimiter.check(key, { max: 20, windowMs: 60_000 }, reply);
  };

  app.get('/api/auth/providers', async () => ({
    github: !!(config.github.clientId && config.github.clientSecret),
    google: !!(config.google.clientId && config.google.clientSecret),
    dev: !config.production && !!config.devGithubToken,
  }));

  app.get('/api/me', async (request) => {
    const user = store.userFromRequest(request);
    if (!user) return { user: null };
    const accounts = store.accounts(user.id);
    const gh = accounts.find((a) => a.provider === 'github');
    const google = accounts.find((a) => a.provider === 'google');
    return {
      user: { id: user.id, name: user.name, email: user.email, avatarUrl: user.avatar_url },
      github: gh ? { login: gh.login } : null,
      google: google ? { email: google.login } : null,
    };
  });

  app.delete('/api/me', async (request, reply) => {
    const user = store.requireUser(request);
    store.deleteUser(user.id);
    codeStore?.collectGarbage();
    store.destroySession(request, reply);
    return { ok: true, deleted: true };
  });

  app.get('/api/me/export', async (request) => {
    const user = store.requireUser(request);
    return store.exportUserData(user.id);
  });

  app.post('/api/auth/logout', async (request, reply) => {
    store.destroySession(request, reply);
    return { ok: true };
  });

  // --- GitHub OAuth -------------------------------------------------------
  app.get<{ Querystring: { intent?: string; next?: string } }>('/api/auth/github/start', async (request, reply) => {
    checkAuthRateLimit(request, reply);
    if (!config.github.clientId || !config.github.clientSecret) return failRedirect(reply, 'github_not_configured');
    const user = store.userFromRequest(request);
    const intent = request.query.intent === 'connect' && user ? 'connect' : 'signin';
    const state = store.saveState({ provider: 'github', intent, userId: intent === 'connect' ? user!.id : undefined, next: safeNext(request.query.next) });
    const url = new URL(`${config.github.oauthUrl}/login/oauth/authorize`);
    url.searchParams.set('client_id', config.github.clientId);
    url.searchParams.set('redirect_uri', callbackUrl('github'));
    url.searchParams.set('scope', GITHUB_SCOPES);
    url.searchParams.set('state', state);
    url.searchParams.set('allow_signup', 'true');
    return reply.redirect(url.toString());
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/api/auth/github/callback', async (request, reply) => {
    checkAuthRateLimit(request, reply);
    const { code, state, error } = request.query;
    if (error) return failRedirect(reply, error === 'access_denied' ? 'github_denied' : 'oauth_failed');
    const saved = state ? store.consumeState(state, 'github') : null;
    if (!code || !saved) return failRedirect(reply, 'oauth_state');

    const tokenRes = await fetch(`${config.github.oauthUrl}/login/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: config.github.clientId, client_secret: config.github.clientSecret, code, redirect_uri: callbackUrl('github') }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    const body = (await tokenRes?.json().catch(() => null)) as { access_token?: string; scope?: string } | null;
    if (!body?.access_token) return failRedirect(reply, 'oauth_failed');

    const gh = new GitHubClient(config.github.apiUrl, body.access_token);
    const profile = await gh.user();
    const email = profile.email ?? (await gh.primaryEmail());
    let userId: string;
    try {
      userId = store.upsertAccount({
        provider: 'github',
        providerUserId: String(profile.id),
        login: profile.login,
        token: body.access_token,
        scopes: body.scope,
        profile: { name: profile.name ?? profile.login, email, avatarUrl: profile.avatar_url },
        linkTo: saved.intent === 'connect' ? (saved.user_id ?? undefined) : undefined,
      });
    } catch (err) {
      if (err instanceof AppError) return failRedirect(reply, 'github_linked_elsewhere');
      throw err;
    }
    if (saved.intent !== 'connect') store.createSession(reply, userId);
    return reply.redirect(`${config.appOrigin}${saved.next ?? '/onboarding/repos'}`);
  });

  // --- Google OpenID Connect ----------------------------------------------
  app.get<{ Querystring: { next?: string } }>('/api/auth/google/start', async (request, reply) => {
    checkAuthRateLimit(request, reply);
    if (!config.google.clientId || !config.google.clientSecret) return failRedirect(reply, 'google_not_configured');
    const nonce = randomId();
    const state = store.saveState({ provider: 'google', intent: 'signin', nonce, next: safeNext(request.query.next) });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', config.google.clientId);
    url.searchParams.set('redirect_uri', callbackUrl('google'));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('prompt', 'select_account');
    return reply.redirect(url.toString());
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/api/auth/google/callback', async (request, reply) => {
    checkAuthRateLimit(request, reply);
    const { code, state, error } = request.query;
    if (error) return failRedirect(reply, 'oauth_failed');
    const saved = state ? store.consumeState(state, 'google') : null;
    if (!code || !saved) return failRedirect(reply, 'oauth_state');

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: config.google.clientId!,
        client_secret: config.google.clientSecret!,
        redirect_uri: callbackUrl('google'),
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    const body = (await tokenRes?.json().catch(() => null)) as { id_token?: string } | null;
    const claims = body?.id_token ? decodeIdToken(body.id_token) : null;
    // The ID token comes straight from Google's token endpoint over TLS (OIDC Core §3.1.3.7),
    // so issuer/audience/expiry/nonce checks are sufficient here.
    if (
      !claims ||
      !['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) ||
      claims.aud !== config.google.clientId ||
      claims.exp * 1000 < Date.now() ||
      claims.nonce !== saved.nonce
    ) {
      return failRedirect(reply, 'oauth_failed');
    }
    const userId = store.upsertAccount({
      provider: 'google',
      providerUserId: claims.sub,
      login: claims.email ?? null,
      profile: { name: claims.name ?? null, email: claims.email_verified ? (claims.email ?? null) : null, avatarUrl: claims.picture ?? null },
    });
    store.createSession(reply, userId);
    // Google identifies the user; it does not grant repository access. Onboarding asks for GitHub next.
    return reply.redirect(`${config.appOrigin}${saved.next ?? '/onboarding/repos'}`);
  });

  // --- Development sign-in --------------------------------------------------
  app.post('/api/auth/dev', async (request, reply) => {
    checkAuthRateLimit(request, reply);
    if (config.production || !config.devGithubToken) throw new AppError('not_found', 'Not found', 404);
    const gh = new GitHubClient(config.github.apiUrl, config.devGithubToken);
    const profile = await gh.user();
    const userId = store.upsertAccount({
      provider: 'github',
      providerUserId: String(profile.id),
      login: profile.login,
      token: config.devGithubToken,
      scopes: 'dev-token',
      profile: { name: profile.name ?? profile.login, email: profile.email, avatarUrl: profile.avatar_url },
    });
    store.createSession(reply, userId);
    return { ok: true };
  });
}

interface IdTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  exp: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

function decodeIdToken(token: string): IdTokenClaims | null {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as IdTokenClaims;
  } catch {
    return null;
  }
}
