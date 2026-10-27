import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface Config {
  port: number;
  host: string;
  production: boolean;
  /** Public origin of the web app (OAuth callbacks go through it; the dev server proxies /api). */
  appOrigin: string;
  dataDir: string;
  github: { clientId?: string; clientSecret?: string; apiUrl: string; webUrl: string; oauthUrl: string; callbackUrl: string };
  google: { clientId?: string; clientSecret?: string; callbackUrl: string };
  /** 32-byte key used to encrypt OAuth tokens at rest. */
  tokenKey: Buffer;
  /** Development-only: sign in with a personal access token from the environment. */
  devGithubToken?: string;
  maxRepoSizeMb: number;
  cloneTimeoutMs: number;
  analysisConcurrency: number;
  /** Repository root analyzed as the public sample project. */
  sampleRoot?: string;
  webDist?: string;
  collective: {
    /** Minimum contributing projects in a population before any statistic about it is shown (k-anonymity). */
    minN: number;
    /** Minimum projects in a single cell (bucket, trait) before its count is shown. */
    minCell: number;
    /** GitHub logins or user ids allowed to review discovered patterns. */
    reviewers: string[];
    /** Database file of the isolated collective dataset (relative to dataDir). */
    dbFile: string;
  };
}

function loadDotEnv(file: string) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

/**
 * Validates and converts a port value to a valid TCP port number (1-65535).
 * Throws a descriptive error if the value is invalid.
 */
export function parsePort(value: unknown, defaultPort = 8787): number {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    return defaultPort;
  }
  const str = typeof value === 'string' ? value.trim() : String(value);
  const num = Number(str);
  if (!Number.isInteger(num) || num < 1 || num > 65535) {
    throw new Error(`Invalid port: "${value}". Port must be a valid integer between 1 and 65535.`);
  }
  return num;
}

export interface ConfigOverrides extends Partial<Omit<Config, 'github' | 'google' | 'collective'>> {
  github?: Partial<Config['github']>;
  google?: Partial<Config['google']>;
  collective?: Partial<Config['collective']>;
}

export function loadConfig(overrides: ConfigOverrides = {}): Config {
  const repoRoot = path.resolve(import.meta.dirname, '../..');
  loadDotEnv(path.join(repoRoot, '.env'));
  const env = process.env;
  const isRender = Boolean(env.RENDER);
  const production = overrides.production ?? (env.NODE_ENV === 'production' || isRender);
  const dataDir = overrides.dataDir ?? path.resolve(repoRoot, env.DATA_DIR ?? '.data');
  mkdirSync(dataDir, { recursive: true });

  let tokenKey: Buffer;
  if (overrides.tokenKey) {
    tokenKey = overrides.tokenKey;
  } else if (env.TOKEN_ENCRYPTION_KEY) {
    tokenKey = Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'base64');
    if (tokenKey.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32).');
  } else if (production) {
    throw new Error('TOKEN_ENCRYPTION_KEY is required in production.');
  } else {
    // Development convenience: a per-checkout key stored with owner-only permissions.
    const keyFile = path.join(dataDir, 'dev-token-key');
    if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString('base64'), { mode: 0o600 });
    tokenKey = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64');
  }

  const devGithubToken = !production && env.DEV_GITHUB_TOKEN ? env.DEV_GITHUB_TOKEN : undefined;

  // On Render, process.env.PORT is injected dynamically and has highest priority.
  let rawPort: unknown;
  if (isRender && env.PORT !== undefined) {
    rawPort = env.PORT;
  } else if (overrides.port !== undefined) {
    rawPort = overrides.port;
  } else if (env.PORT !== undefined) {
    rawPort = env.PORT;
  } else {
    rawPort = 8787;
  }
  const port = parsePort(rawPort, 8787);

  // In production (and on Render), bind to 0.0.0.0 so external port scans and ingress succeed.
  // In local development, preserve default binding to 127.0.0.1.
  const defaultHost = production ? '0.0.0.0' : '127.0.0.1';
  let rawHost = overrides.host ?? env.HOST;
  if (isRender && (rawHost === '127.0.0.1' || rawHost === 'localhost')) {
    // Prevent accidental localhost binding from a .env file on Render
    rawHost = '0.0.0.0';
  }
  const host = rawHost ?? defaultHost;

  let rawOrigin = overrides.appOrigin ?? env.APP_ORIGIN;
  if (isRender && (!rawOrigin || rawOrigin.includes('localhost') || rawOrigin.includes('127.0.0.1'))) {
    // Prevent accidental localhost origin from a .env file on Render
    rawOrigin = env.RENDER_EXTERNAL_URL ?? rawOrigin;
  }
  let appOrigin: string;
  if (rawOrigin && rawOrigin.trim()) {
    const trimmed = rawOrigin.trim();
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Invalid protocol ${parsed.protocol}`);
      }
      appOrigin = parsed.origin;
    } catch {
      appOrigin = trimmed.replace(/\/+$/, '');
    }
  } else {
    appOrigin = 'http://localhost:5175';
  }

  const githubClientId = overrides.github?.clientId ?? (env.GITHUB_CLIENT_ID?.trim() || undefined);
  const githubClientSecret = overrides.github?.clientSecret ?? (env.GITHUB_CLIENT_SECRET?.trim() || undefined);
  if ((githubClientId && !githubClientSecret) || (!githubClientId && githubClientSecret)) {
    throw new Error('Both GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be configured together.');
  }
  const githubCallbackUrl = (overrides.github?.callbackUrl ?? env.GITHUB_CALLBACK_URL?.trim() ?? `${appOrigin}/api/auth/github/callback`).replace(/\/+$/, '');

  const googleClientId = overrides.google?.clientId ?? (env.GOOGLE_CLIENT_ID?.trim() || undefined);
  const googleClientSecret = overrides.google?.clientSecret ?? (env.GOOGLE_CLIENT_SECRET?.trim() || undefined);
  if ((googleClientId && !googleClientSecret) || (!googleClientId && googleClientSecret)) {
    throw new Error('Both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together.');
  }
  const googleCallbackUrl = (overrides.google?.callbackUrl ?? env.GOOGLE_CALLBACK_URL?.trim() ?? `${appOrigin}/api/auth/google/callback`).replace(/\/+$/, '');

  return {
    production,
    appOrigin,
    dataDir,
    github: {
      clientId: overrides.github?.clientId ?? githubClientId,
      clientSecret: overrides.github?.clientSecret ?? githubClientSecret,
      apiUrl: overrides.github?.apiUrl ?? (env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, ''),
      webUrl: overrides.github?.webUrl ?? (env.GITHUB_WEB_URL ?? 'https://github.com').replace(/\/$/, ''),
      oauthUrl: overrides.github?.oauthUrl ?? (env.GITHUB_OAUTH_URL ?? 'https://github.com').replace(/\/$/, ''),
      callbackUrl: overrides.github?.callbackUrl ?? githubCallbackUrl,
    },
    google: {
      clientId: overrides.google?.clientId ?? googleClientId,
      clientSecret: overrides.google?.clientSecret ?? googleClientSecret,
      callbackUrl: overrides.google?.callbackUrl ?? googleCallbackUrl,
    },
    tokenKey,
    devGithubToken: overrides.devGithubToken !== undefined ? overrides.devGithubToken : devGithubToken,
    maxRepoSizeMb: overrides.maxRepoSizeMb ?? Number(env.MAX_REPO_SIZE_MB ?? 1024),
    cloneTimeoutMs: overrides.cloneTimeoutMs ?? Number(env.CLONE_TIMEOUT_MS ?? 5 * 60_000),
    analysisConcurrency: overrides.analysisConcurrency ?? Number(env.ANALYSIS_CONCURRENCY ?? 2),
    sampleRoot: overrides.sampleRoot !== undefined ? overrides.sampleRoot : (env.SAMPLE_DISABLED === '1' ? undefined : repoRoot),
    webDist: overrides.webDist ?? path.join(repoRoot, 'web/dist'),
    collective: {
      // Privacy floors: configuration can raise the thresholds, never lower them below these.
      minN: overrides.collective?.minN ?? Math.max(10, Number(env.COLLECTIVE_MIN_N ?? 20) || 20),
      minCell: overrides.collective?.minCell ?? Math.max(3, Number(env.COLLECTIVE_MIN_CELL ?? 5) || 5),
      reviewers: overrides.collective?.reviewers ?? (env.COLLECTIVE_REVIEWERS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      dbFile: overrides.collective?.dbFile ?? 'collective.sqlite',
    },
    port,
    host,
  };
}
