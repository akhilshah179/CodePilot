import path from 'node:path';
import picomatch from 'picomatch';
import { dirOf, joinRel, type RepoFs } from './repoFs.ts';

export interface PathMapping {
  pattern: string;
  targets: string[];
}

export interface TsConfigInfo {
  /** Repo-relative path of the config file. */
  file: string;
  /** Repo-relative directory that `paths` substitutions are relative to. */
  pathsBase?: string;
  /** Repo-relative baseUrl directory, if configured. */
  baseUrl?: string;
  /** Config that declared `paths` (for evidence). */
  pathsDeclaredIn?: string;
  paths: PathMapping[];
  includes: (p: string) => boolean;
  references: string[];
  /** `files: []` with references: a solution-style config that owns no files itself. */
  solutionOnly: boolean;
}

interface RawConfig {
  extends?: string | string[];
  compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
  include?: string[];
  exclude?: string[];
  files?: string[];
  references?: { path: string }[];
}

const DEFAULT_EXCLUDE = ['**/node_modules/**', '**/bower_components/**', '**/jspm_packages/**'];

export class TsConfigIndex {
  private readonly loaded = new Map<string, TsConfigInfo | null>();
  private readonly forDir = new Map<string, TsConfigInfo | null>();
  readonly warnings: string[] = [];

  constructor(private readonly fs: RepoFs) {}

  /** The config whose compilation includes `file`, searching upward like the TypeScript language service. */
  configFor(file: string): TsConfigInfo | null {
    let dir = dirOf(file);
    for (;;) {
      for (const name of ['tsconfig.json', 'jsconfig.json']) {
        const candidate = dir ? `${dir}/${name}` : name;
        if (!this.fs.isFile(candidate)) continue;
        const cfg = this.load(candidate);
        if (!cfg) continue;
        if (!cfg.solutionOnly && cfg.includes(file)) return cfg;
        for (const ref of cfg.references) {
          const refCfg = this.load(ref);
          if (refCfg && refCfg.includes(file)) return refCfg;
        }
      }
      if (!dir) return null;
      dir = dirOf(dir);
    }
  }

  load(file: string, seen = new Set<string>()): TsConfigInfo | null {
    if (this.loaded.has(file)) return this.loaded.get(file)!;
    if (seen.has(file)) {
      this.warnings.push(`Circular "extends" in ${file}`);
      return null;
    }
    seen.add(file);
    const raw = this.fs.json<RawConfig>(file);
    if (!raw) {
      this.warnings.push(`Could not parse ${file}; its path aliases were not applied.`);
      this.loaded.set(file, null);
      return null;
    }
    const dir = dirOf(file);

    // Merge `extends` chain (later entries override earlier ones, the config itself overrides all).
    let baseUrl: string | undefined;
    let paths: Record<string, string[]> | undefined;
    let pathsDeclaredIn: string | undefined;
    let pathsBase: string | undefined;
    let include: { patterns: string[]; dir: string } | undefined;
    let exclude: { patterns: string[]; dir: string } | undefined;
    let files: { list: string[]; dir: string } | undefined;

    const parents = raw.extends === undefined ? [] : Array.isArray(raw.extends) ? raw.extends : [raw.extends];
    for (const ext of parents) {
      const parentFile = this.resolveExtends(dir, ext);
      if (!parentFile) {
        this.warnings.push(`${file} extends "${ext}", which is not in the repository; options inherited from it were not applied.`);
        continue;
      }
      const parent = this.load(parentFile, seen);
      if (!parent) continue;
      if (parent.baseUrl !== undefined) baseUrl = parent.baseUrl;
      if (parent.paths.length) {
        paths = Object.fromEntries(parent.paths.map((m) => [m.pattern, m.targets]));
        pathsDeclaredIn = parent.pathsDeclaredIn;
        pathsBase = parent.pathsBase;
      }
      const parentRaw = this.fs.json<RawConfig>(parentFile);
      const parentDir = dirOf(parentFile);
      if (parentRaw?.include) include = { patterns: parentRaw.include, dir: parentDir };
      if (parentRaw?.exclude) exclude = { patterns: parentRaw.exclude, dir: parentDir };
      if (parentRaw?.files) files = { list: parentRaw.files, dir: parentDir };
    }

    const co = raw.compilerOptions ?? {};
    if (co.baseUrl !== undefined) baseUrl = joinRel(dir, co.baseUrl);
    if (co.paths) {
      paths = co.paths;
      pathsDeclaredIn = file;
      pathsBase = undefined;
    }
    // `paths` are relative to baseUrl when set, otherwise to the config that declared them.
    if (paths) pathsBase = baseUrl ?? pathsBase ?? dirOf(pathsDeclaredIn ?? file);
    if (raw.include) include = { patterns: raw.include, dir };
    if (raw.exclude) exclude = { patterns: raw.exclude, dir };
    if (raw.files) files = { list: raw.files, dir };

    const references = (raw.references ?? [])
      .map((r) => {
        const target = joinRel(dir, r.path);
        if (this.fs.isFile(target)) return target;
        const inDir = target ? `${target}/tsconfig.json` : 'tsconfig.json';
        return this.fs.isFile(inDir) ? inDir : undefined;
      })
      .filter((x): x is string => !!x);

    const solutionOnly = !!files && files.list.length === 0 && !include && references.length > 0;
    const info: TsConfigInfo = {
      file,
      baseUrl,
      pathsBase,
      pathsDeclaredIn,
      paths: Object.entries(paths ?? {}).map(([pattern, targets]) => ({ pattern, targets })),
      includes: buildIncludeMatcher(dir, include, exclude, files),
      references,
      solutionOnly,
    };
    this.loaded.set(file, info);
    return info;
  }

  private resolveExtends(dir: string, ext: string): string | undefined {
    if (!ext.startsWith('.') && !ext.startsWith('/')) return undefined; // package-based extends (not vendored in repo)
    const target = joinRel(dir, ext);
    if (this.fs.isFile(target)) return target;
    if (this.fs.isFile(target + '.json')) return target + '.json';
    if (this.fs.isFile(`${target}/tsconfig.json`)) return `${target}/tsconfig.json`;
    return undefined;
  }

  /** Cache helper: configs are looked up per directory for speed. */
  configForCached(file: string): TsConfigInfo | null {
    const key = file;
    if (this.forDir.has(key)) return this.forDir.get(key)!;
    const cfg = this.configFor(file);
    this.forDir.set(key, cfg);
    return cfg;
  }
}

function toGlob(dir: string, pattern: string): string {
  let p = pattern.replace(/^\.\//, '');
  const last = p.split('/').pop() ?? '';
  // TypeScript treats an include entry without wildcards or extension as a directory.
  if (!/[*?]/.test(last) && !path.posix.extname(last)) p = p.replace(/\/$/, '') + '/**/*';
  return joinRel(dir, '.') ? `${joinRel(dir, '.')}/${p}` : p;
}

function buildIncludeMatcher(
  dir: string,
  include: { patterns: string[]; dir: string } | undefined,
  exclude: { patterns: string[]; dir: string } | undefined,
  files: { list: string[]; dir: string } | undefined,
): (p: string) => boolean {
  const explicit = new Set((files?.list ?? []).map((f) => joinRel(files!.dir, f)));
  // With neither `include` nor `files`, TypeScript includes everything under the config directory.
  const includePatterns = include ? include.patterns.map((p) => toGlob(include.dir, p)) : files ? [] : [toGlob(dir, '**/*')];
  const excludePatterns = [...DEFAULT_EXCLUDE, ...(exclude ? exclude.patterns.map((p) => toGlob(exclude.dir, p)) : [])];
  const inc = includePatterns.length ? picomatch(includePatterns, { dot: true }) : () => false;
  const exc = picomatch(excludePatterns, { dot: true });
  return (p: string) => explicit.has(p) || (inc(p) && !exc(p));
}

/** TypeScript's `paths` matching: exact key first, otherwise the wildcard pattern with the longest prefix. */
export function matchPaths(mappings: PathMapping[], specifier: string): { mapping: PathMapping; star: string } | null {
  const exact = mappings.find((m) => m.pattern === specifier);
  if (exact) return { mapping: exact, star: '' };
  let best: { mapping: PathMapping; star: string; prefixLen: number } | null = null;
  for (const m of mappings) {
    const i = m.pattern.indexOf('*');
    if (i < 0) continue;
    const prefix = m.pattern.slice(0, i);
    const suffix = m.pattern.slice(i + 1);
    if (specifier.length >= prefix.length + suffix.length && specifier.startsWith(prefix) && specifier.endsWith(suffix)) {
      if (!best || prefix.length > best.prefixLen) {
        best = { mapping: m, star: specifier.slice(prefix.length, specifier.length - suffix.length), prefixLen: prefix.length };
      }
    }
  }
  return best ? { mapping: best.mapping, star: best.star } : null;
}
