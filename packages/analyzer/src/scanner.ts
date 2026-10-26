import { promises as fs } from 'node:fs';
import path from 'node:path';
import { detectLanguage, type FileCategory } from './languages.ts';
import { isSecretFileName, scanForSecrets } from './secrets.ts';
import type { ExcludedFile, ExclusionReason, ScanStats } from './types.ts';

/** Directory names that are never descended into. */
export const EXCLUDED_DIRECTORIES = [
  '.git',
  'node_modules',
  'bower_components',
  'jspm_packages',
  'vendor',
  'dist',
  'build',
  'out',
  'out-tsc',
  'target',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.astro',
  '.angular',
  '.expo',
  '.docusaurus',
  '.turbo',
  '.vercel',
  '.netlify',
  '.cache',
  '.parcel-cache',
  '.yarn',
  '.pnpm-store',
  'coverage',
  '.nyc_output',
  'storybook-static',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.gradle',
  '.terraform',
  '.idea',
];

export const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'bun.lock',
  'cargo.lock',
  'poetry.lock',
  'pipfile.lock',
  'gemfile.lock',
  'composer.lock',
  'go.sum',
]);

export const GENERATED_NAME = /(\.min\.(js|css)|\.map|\.bundle\.js|\.chunk\.js|\.generated\.[a-z]+|_pb2\.py|\.pb\.go)$/i;
export const GENERATED_HEADER = /@generated\b|Code generated .* DO NOT EDIT/;

/** Human-readable scan policy, surfaced verbatim in onboarding so users see exactly what is skipped. */
export const SCAN_POLICY = {
  excludedDirectories: EXCLUDED_DIRECTORIES,
  secretFiles: ['.env and .env.*', '*.pem, *.key, *.p12, *.pfx, *.keystore', 'id_rsa / id_ed25519 keys', '.npmrc, .netrc, .pypirc, .git-credentials', 'credentials.json, service-account*.json', '*.tfstate, *.tfvars'],
  secretContent: ['Files containing a private key block are skipped entirely', 'Credential-shaped values in source files are counted, never stored'],
  generated: ['Lockfiles', '*.min.js, *.map, *.bundle.js', 'Files marked @generated or "DO NOT EDIT"'],
  limits: { maxParseBytes: 1_000_000, maxFiles: 50_000 },
};

export interface ScannedFile {
  path: string;
  size: number;
  language: string;
  category: FileCategory;
  /** Loaded for text files up to maxParseBytes; dropped by the caller once parsed. */
  content?: string;
  tooLarge: boolean;
  /** Line count, for text files whose content was read. */
  lines?: number;
  secretsDetected: number;
  /** Files that are listed only so imports of them can resolve (assets, data). */
  importOnly: boolean;
}

export interface ScanResult {
  files: ScannedFile[];
  excluded: ExcludedFile[];
  stats: ScanStats;
}

export interface ScanOptions {
  ignore?: string[];
  maxParseBytes?: number;
  maxFiles?: number;
  signal?: AbortSignal;
  onFile?: (count: number) => void;
}

/** Physical lines, counting a final line without a trailing newline. */
export function countLines(text: string): number {
  if (!text) return 0;
  let n = 1;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++;
  return text.endsWith('\n') ? n - 1 : n;
}

const TEXT_CATEGORIES: FileCategory[] = ['source', 'config', 'style', 'markup', 'data', 'doc'];

export async function scanRepository(root: string, opts: ScanOptions = {}): Promise<ScanResult> {
  const maxParseBytes = opts.maxParseBytes ?? SCAN_POLICY.limits.maxParseBytes;
  const maxFiles = opts.maxFiles ?? SCAN_POLICY.limits.maxFiles;
  const ignore = (opts.ignore ?? []).map((p) => p.replace(/\/+$/, '') + '/');
  const excludedDirs = new Set(EXCLUDED_DIRECTORIES);

  const files: ScannedFile[] = [];
  const excluded: ExcludedFile[] = [];
  const excludedDirectoriesSeen = new Set<string>();
  let visited = 0;

  const exclude = (p: string, reason: ExclusionReason): void => {
    excluded.push({ path: p, reason });
  };

  async function walk(relDir: string): Promise<void> {
    opts.signal?.throwIfAborted();
    const absDir = path.join(root, relDir);
    const entries = await fs.readdir(absDir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (ignore.some((prefix) => (rel + '/').startsWith(prefix))) continue;
      if (entry.isSymbolicLink()) {
        // Never follow symlinks: they can point outside the repository.
        exclude(rel, 'symlink');
        continue;
      }
      if (entry.isDirectory()) {
        if (excludedDirs.has(entry.name)) {
          excludedDirectoriesSeen.add(entry.name);
          exclude(rel + '/', 'excluded-directory');
          continue;
        }
        await walk(rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= maxFiles) {
        throw new Error(`Repository has more than ${maxFiles.toLocaleString()} files after exclusions; analysis is capped at that size.`);
      }
      visited++;
      if (visited % 200 === 0) {
        opts.onFile?.(visited);
        await new Promise((r) => setImmediate(r));
      }
      await considerFile(rel);
    }
  }

  async function considerFile(rel: string): Promise<void> {
    const base = path.posix.basename(rel).toLowerCase();
    if (isSecretFileName(rel)) return exclude(rel, 'secret-file');
    if (LOCKFILES.has(base)) return exclude(rel, 'lockfile');
    if (GENERATED_NAME.test(base)) return exclude(rel, 'generated');

    const abs = path.join(root, rel);
    const stat = await fs.stat(abs);
    const { language, category } = detectLanguage(rel);
    const isText = TEXT_CATEGORIES.includes(category) || category === 'unknown';
    const file: ScannedFile = {
      path: rel,
      size: stat.size,
      language,
      category,
      tooLarge: false,
      secretsDetected: 0,
      importOnly: !(category === 'source' || category === 'config' || category === 'style' || category === 'markup'),
    };

    if (isText && stat.size > 0) {
      if (stat.size > maxParseBytes) {
        file.tooLarge = true;
      } else {
        const buf = await fs.readFile(abs);
        if (buf.subarray(0, 8000).includes(0)) {
          if (category === 'unknown') return exclude(rel, 'binary');
        } else {
          const text = buf.toString('utf8');
          if (GENERATED_HEADER.test(text.slice(0, 1024))) return exclude(rel, 'generated');
          const secrets = scanForSecrets(text);
          if (secrets.containsPrivateKey) return exclude(rel, 'secret-content');
          file.secretsDetected = secrets.credentialCount;
          file.lines = countLines(text);
          if (category !== 'unknown') file.content = text;
        }
      }
    }
    if (category === 'unknown') return; // Not part of the code graph and not importable in a meaningful way.
    files.push(file);
  }

  await walk('');
  opts.onFile?.(visited);

  const counts: Record<ExclusionReason, number> = {
    'excluded-directory': 0,
    'secret-file': 0,
    'secret-content': 0,
    generated: 0,
    lockfile: 0,
    binary: 0,
    symlink: 0,
  };
  for (const e of excluded) counts[e.reason]++;

  return {
    files,
    excluded,
    stats: { filesScanned: visited, excluded: counts, excludedDirectories: [...excludedDirectoriesSeen].sort() },
  };
}
