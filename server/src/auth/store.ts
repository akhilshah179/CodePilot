import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.ts';
import { decryptToken, encryptToken, randomId, sha256 } from '../crypto.ts';
import { now, type Db } from '../db.ts';
import { AppError, githubNotConnected } from '../errors.ts';

export const SESSION_COOKIE = 'cp_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface User {
  id: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
}

export interface Account {
  provider: 'github' | 'google';
  provider_user_id: string;
  login: string | null;
}

export class AuthStore {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
  ) {}

  createSession(reply: FastifyReply, userId: string) {
    const token = randomId(32);
    this.db
      .prepare('INSERT INTO sessions (id_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(sha256(token), userId, Date.now() + SESSION_TTL_MS, now());
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.production,
      maxAge: SESSION_TTL_MS / 1000,
    });
  }

  destroySession(request: FastifyRequest, reply: FastifyReply) {
    const token = request.cookies[SESSION_COOKIE];
    if (token) this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha256(token));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  userFromRequest(request: FastifyRequest): User | null {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return null;
    const row = this.db
      .prepare('SELECT u.id, u.name, u.email, u.avatar_url, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?')
      .get(sha256(token)) as (User & { expires_at: number }) | undefined;
    if (!row || row.expires_at < Date.now()) return null;
    return { id: row.id, name: row.name, email: row.email, avatar_url: row.avatar_url };
  }

  requireUser(request: FastifyRequest): User {
    const user = this.userFromRequest(request);
    if (!user) throw new AppError('unauthenticated', 'Sign in to continue.', 401, { label: 'Sign in', href: '/signin' });
    return user;
  }

  accounts(userId: string): Account[] {
    return this.db.prepare('SELECT provider, provider_user_id, login FROM accounts WHERE user_id = ? ORDER BY provider').all(userId) as unknown as Account[];
  }

  /**
   * Link or create an account. `linkTo` attaches the identity to an existing signed-in user
   * (explicit "Connect GitHub"); accounts are never merged implicitly by email.
   */
  upsertAccount(input: {
    provider: 'github' | 'google';
    providerUserId: string;
    login: string | null;
    token?: string;
    scopes?: string;
    profile: { name: string | null; email: string | null; avatarUrl: string | null };
    linkTo?: string;
  }): string {
    const existing = this.db
      .prepare('SELECT id, user_id FROM accounts WHERE provider = ? AND provider_user_id = ?')
      .get(input.provider, input.providerUserId) as { id: string; user_id: string } | undefined;
    const tokenEnc = input.token ? encryptToken(this.config.tokenKey, input.token) : null;
    const ts = now();

    let userId = existing?.user_id ?? input.linkTo;
    if (existing && input.linkTo && existing.user_id !== input.linkTo) {
      throw new AppError('oauth_failed', 'This GitHub account is already connected to a different CodePilot user. Sign in with that account instead.', 409);
    }
    if (!userId) {
      userId = randomId();
      this.db
        .prepare('INSERT INTO users (id, name, email, avatar_url, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(userId, input.profile.name, input.profile.email, input.profile.avatarUrl, ts);
    } else {
      this.db
        .prepare('UPDATE users SET name = COALESCE(name, ?), email = COALESCE(email, ?), avatar_url = COALESCE(avatar_url, ?) WHERE id = ?')
        .run(input.profile.name, input.profile.email, input.profile.avatarUrl, userId);
    }
    if (existing) {
      this.db
        .prepare('UPDATE accounts SET login = ?, token_enc = COALESCE(?, token_enc), scopes = COALESCE(?, scopes), updated_at = ? WHERE id = ?')
        .run(input.login, tokenEnc, input.scopes ?? null, ts, existing.id);
    } else {
      // A user has at most one account per provider; connecting a new one replaces the old link.
      this.db.prepare('DELETE FROM accounts WHERE user_id = ? AND provider = ?').run(userId, input.provider);
      this.db
        .prepare('INSERT INTO accounts (id, user_id, provider, provider_user_id, login, token_enc, scopes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(randomId(), userId, input.provider, input.providerUserId, input.login, tokenEnc, input.scopes ?? null, ts, ts);
    }
    return userId;
  }

  /** Decrypted GitHub token for server-side use only. */
  githubToken(userId: string): string {
    const row = this.db.prepare("SELECT token_enc FROM accounts WHERE user_id = ? AND provider = 'github'").get(userId) as { token_enc: string | null } | undefined;
    if (!row?.token_enc) throw githubNotConnected();
    return decryptToken(this.config.tokenKey, row.token_enc);
  }

  saveState(state: { provider: string; intent: string; userId?: string; nonce?: string; next?: string }): string {
    const id = randomId(24);
    this.db.prepare('DELETE FROM oauth_states WHERE created_at < ?').run(Date.now() - 15 * 60_000);
    this.db
      .prepare('INSERT INTO oauth_states (state, provider, intent, user_id, nonce, next, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, state.provider, state.intent, state.userId ?? null, state.nonce ?? null, state.next ?? null, Date.now());
    return id;
  }

  /** One-time use: the state row is deleted when consumed. */
  consumeState(id: string, provider: string) {
    const row = this.db.prepare('SELECT * FROM oauth_states WHERE state = ? AND provider = ?').get(id, provider) as
      | { intent: string; user_id: string | null; nonce: string | null; next: string | null; created_at: number }
      | undefined;
    this.db.prepare('DELETE FROM oauth_states WHERE state = ?').run(id);
    if (!row || row.created_at < Date.now() - 15 * 60_000) return null;
    return row;
  }
}
