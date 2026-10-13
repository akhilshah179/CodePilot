import path from 'node:path';
import ts from 'typescript';
import type { ExcludedFile } from '../types.ts';

/**
 * Read-only view over the scanned repository used by the resolver.
 * Resolution only ever succeeds against files that actually exist in the scan.
 */
export class RepoFs {
  readonly files: Set<string>;
  readonly dirs = new Set<string>(['']);
  private readonly excludedFiles = new Map<string, string>();
  private readonly excludedDirs: string[] = [];
  private readonly jsonCache = new Map<string, unknown | null>();

  constructor(
    files: Iterable<string>,
    private readonly readText: (p: string) => string | undefined,
    excluded: ExcludedFile[] = [],
  ) {
    this.files = new Set(files);
    for (const f of this.files) {
      let d = path.posix.dirname(f);
      while (d !== '.' && !this.dirs.has(d)) {
        this.dirs.add(d);
        d = path.posix.dirname(d);
      }
    }
    for (const e of excluded) {
      if (e.reason === 'excluded-directory') this.excludedDirs.push(e.path);
      else this.excludedFiles.set(e.path, e.reason);
    }
  }

  isFile(p: string): boolean {
    return this.files.has(p);
  }

  isDir(p: string): boolean {
    return this.dirs.has(p);
  }

  /** If `p` was excluded from the scan, explain why. */
  exclusionOf(p: string): string | undefined {
    const reason = this.excludedFiles.get(p);
    if (reason) return describeExclusion(reason);
    const dir = this.excludedDirs.find((d) => p.startsWith(d));
    if (dir) return `inside excluded directory ${dir}`;
    return undefined;
  }

  text(p: string): string | undefined {
    return this.readText(p);
  }

  /** Parse JSON or JSONC (tsconfig-style comments and trailing commas). Returns null on failure. */
  json<T = Record<string, unknown>>(p: string): T | null {
    if (this.jsonCache.has(p)) return this.jsonCache.get(p) as T | null;
    const text = this.readText(p);
    let value: unknown = null;
    if (text !== undefined) {
      const res = ts.parseConfigFileTextToJson(p, text);
      value = res.error ? null : (res.config ?? null);
    }
    this.jsonCache.set(p, value);
    return value as T | null;
  }
}

function describeExclusion(reason: string): string {
  switch (reason) {
    case 'secret-file':
    case 'secret-content':
      return 'excluded because it contains secrets';
    case 'generated':
      return 'excluded as a generated artifact';
    case 'lockfile':
      return 'excluded lockfile';
    case 'symlink':
      return 'a symlink (symlinks are not followed)';
    default:
      return `excluded (${reason})`;
  }
}

export function dirOf(p: string): string {
  const d = path.posix.dirname(p);
  return d === '.' ? '' : d;
}

export function joinRel(dir: string, rel: string): string {
  const joined = path.posix.normalize(path.posix.join(dir || '.', rel));
  return joined === '.' ? '' : joined.replace(/\/$/, '');
}
