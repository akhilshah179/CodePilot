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
  github: { clientId?: string; clientSecret?: string; apiUrl: string; webUrl: string; oauthUrl: string };
  google: { clientId?: string; clientSecret?: string };
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

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const repoRoot = path.resolve(import.meta.dirname, '../..');
  loadDotEnv(path.join(repoRoot, '.env'));
  const env = process.env;
  const production = env.NODE_ENV === 'production';
  const dataDir = overrides.dataDir ?? path.resolve(repoRoot, env.DATA_DIR ?? '.data');
  mkdirSync(dataDir, { recursive: true });

  let tokenKey: Buffer;
  if (env.TOKEN_ENCRYPTION_KEY) {
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

  return {
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? '127.0.0.1',
    production,
    appOrigin: (env.APP_ORIGIN ?? 'http://localhost:5175').replace(/\/$/, ''),
    dataDir,
    github: {
      clientId: env.GITHUB_CLIENT_ID || undefined,
      clientSecret: env.GITHUB_CLIENT_SECRET || undefined,
      apiUrl: (env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, ''),
      webUrl: (env.GITHUB_WEB_URL ?? 'https://github.com').replace(/\/$/, ''),
      oauthUrl: (env.GITHUB_OAUTH_URL ?? 'https://github.com').replace(/\/$/, ''),
    },
    google: { clientId: env.GOOGLE_CLIENT_ID || undefined, clientSecret: env.GOOGLE_CLIENT_SECRET || undefined },
    tokenKey,
    devGithubToken,
    maxRepoSizeMb: Number(env.MAX_REPO_SIZE_MB ?? 1024),
    cloneTimeoutMs: Number(env.CLONE_TIMEOUT_MS ?? 5 * 60_000),
    analysisConcurrency: Number(env.ANALYSIS_CONCURRENCY ?? 2),
    sampleRoot: env.SAMPLE_DISABLED === '1' ? undefined : repoRoot,
    webDist: path.join(repoRoot, 'web/dist'),
    collective: {
      // Privacy floors: configuration can raise the thresholds, never lower them below these.
      minN: Math.max(10, Number(env.COLLECTIVE_MIN_N ?? 20) || 20),
      minCell: Math.max(3, Number(env.COLLECTIVE_MIN_CELL ?? 5) || 5),
      reviewers: (env.COLLECTIVE_REVIEWERS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      dbFile: 'collective.sqlite',
    },
    ...overrides,
  };
}
