import { promises as fs } from 'node:fs';
import path from 'node:path';
import { detectLanguage } from './languages.ts';
import { countLines, EXCLUDED_DIRECTORIES, GENERATED_HEADER, GENERATED_NAME, LOCKFILES, SCAN_POLICY } from './scanner.ts';
import { isSecretFileName, maskSecrets, scanForSecrets } from './secrets.ts';
import type { ExclusionReason } from './types.ts';

/*
 * The files a person can read in the Code tab. Uses the same exclusion rules as the analysis
 * scanner (so the two never disagree about what was skipped and why), plus binaries and files over
 * the size limit. Stored text has detected secrets masked; the raw values never leave this module.
 */

export type StoreExclusion = ExclusionReason | 'too-large';

export const STORE_EXCLUSION_TEXT: Record<StoreExclusion, string> = {
  'excluded-directory': 'Dependency, build or tool directory — not entered',
  'secret-file': 'Sensitive file (environment, key or credentials) — never stored',
  'secret-content': 'Contains a private key — never stored',
  generated: 'Generated file',
  lockfile: 'Lockfile',
  binary: 'Binary file',
  symlink: 'Symbolic link — not followed',
  'too-large': `Larger than ${SCAN_POLICY.limits.maxParseBytes / 1_000_000} MB`,
};

export type RepoEntry =
  | {
      kind: 'file';
      path: string;
      size: number;
      language: string;
      lines: number;
      /** Text with detected secrets replaced by MASK. */
      content: string;
      maskedLines: number[];
    }
  | { kind: 'excluded'; path: string; directory: boolean; reason: StoreExclusion; size?: number };

export interface WalkOptions {
  ignore?: string[];
  maxBytes?: number;
  signal?: AbortSignal;
}

/** Extensions that are binary by type; their bytes are never read. */
const BINARY_LANGUAGES = new Set(['image', 'font', 'media', 'wasm']);

/** Every entry of the repository in path order: stored files and excluded entries with their reason. */
export async function* walkRepositoryFiles(root: string, opts: WalkOptions = {}): AsyncGenerator<RepoEntry> {
  const maxBytes = opts.maxBytes ?? SCAN_POLICY.limits.maxParseBytes;
  const ignore = (opts.ignore ?? []).map((p) => p.replace(/\/+$/, '') + '/');
  const excludedDirs = new Set(EXCLUDED_DIRECTORIES);
  let visited = 0;

  async function* walk(relDir: string): AsyncGenerator<RepoEntry> {
    opts.signal?.throwIfAborted();
    const entries = await fs.readdir(path.join(root, relDir), { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (ignore.some((prefix) => (rel + '/').startsWith(prefix))) continue;
      if (entry.isSymbolicLink()) {
        yield { kind: 'excluded', path: rel, directory: false, reason: 'symlink' };
        continue;
      }
      if (entry.isDirectory()) {
        if (excludedDirs.has(entry.name)) yield { kind: 'excluded', path: rel, directory: true, reason: 'excluded-directory' };
        else yield* walk(rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (++visited % 200 === 0) await new Promise((r) => setImmediate(r));
      yield await consider(rel);
    }
  }

  async function consider(rel: string): Promise<RepoEntry> {
    const base = path.posix.basename(rel).toLowerCase();
    const excluded = (reason: StoreExclusion, size?: number): RepoEntry => ({ kind: 'excluded', path: rel, directory: false, reason, size });
    if (isSecretFileName(rel)) return excluded('secret-file');
    if (LOCKFILES.has(base)) return excluded('lockfile');
    if (GENERATED_NAME.test(base)) return excluded('generated');
    const abs = path.join(root, rel);
    const { size } = await fs.stat(abs);
    const { language, category } = detectLanguage(rel);
    if (BINARY_LANGUAGES.has(language)) return excluded('binary', size);
    if (size > maxBytes) return excluded('too-large', size);
    const buf = await fs.readFile(abs);
    if (buf.subarray(0, 8000).includes(0)) return excluded('binary', size);
    const raw = buf.toString('utf8');
    if (GENERATED_HEADER.test(raw.slice(0, 1024))) return excluded('generated', size);
    if (scanForSecrets(raw).containsPrivateKey) return excluded('secret-content', size);
    const masked = maskSecrets(raw);
    return {
      kind: 'file',
      path: rel,
      size,
      language: category === 'unknown' ? 'text' : language,
      lines: countLines(raw),
      content: masked.text,
      maskedLines: masked.lines,
    };
  }

  yield* walk('');
}
