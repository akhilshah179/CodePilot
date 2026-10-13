import { builtinModules } from 'node:module';
import { dirOf, joinRel, RepoFs } from './repoFs.ts';
import { matchPaths, TsConfigIndex } from './tsconfig.ts';
import {
  isValidPackageName,
  lookupSubpath,
  manifestEntryFields,
  packageNameOf,
  PackageIndex,
  type ConditionalTarget,
} from './packages.ts';

export { RepoFs } from './repoFs.ts';
export { PackageIndex, type PackageJson } from './packages.ts';

export type Resolution =
  | { status: 'file'; target: string; via: string }
  | { status: 'external'; packageName: string; builtin: boolean; via: string }
  | { status: 'unresolved'; key: string; reason: string };

const TS_FIRST = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json'];
const JS_FIRST = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.json', '.d.ts'];
/** TypeScript's rule for ESM-style specifiers: `./a.js` may refer to `./a.ts` source. */
const JS_TO_TS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

const BUILTINS = new Set(builtinModules.filter((m) => !m.startsWith('_')));

interface FileHit {
  path: string;
  how: string;
}

export class ModuleResolver {
  readonly tsconfigs: TsConfigIndex;
  readonly packages: PackageIndex;
  private readonly cache = new Map<string, Resolution>();

  constructor(readonly fs: RepoFs) {
    this.tsconfigs = new TsConfigIndex(fs);
    this.packages = new PackageIndex(fs);
  }

  get warnings(): string[] {
    return this.tsconfigs.warnings;
  }

  resolve(fromFile: string, specifier: string): Resolution {
    const tsFirst = /\.(m|c)?tsx?$|\.vue$|\.svelte$/.test(fromFile);
    const cfg = specifier.startsWith('.') ? null : this.tsconfigs.configFor(fromFile);
    const key = `${dirOf(fromFile)}\0${specifier}\0${tsFirst}\0${cfg?.file ?? ''}`;
    let r = this.cache.get(key);
    if (!r) {
      r = this.resolveUncached(fromFile, specifier, tsFirst, 0);
      this.cache.set(key, r);
    }
    return r;
  }

  private resolveUncached(fromFile: string, rawSpecifier: string, tsFirst: boolean, depth: number): Resolution {
    // Bundler loader prefixes (`raw-loader!./x`) and query suffixes (`./x.svg?react`) don't change the file.
    // A leading `#` is a package.json subpath import, so only `?` queries are stripped.
    const specifier = rawSpecifier.slice(rawSpecifier.lastIndexOf('!') + 1).replace(/\?.*$/, '');
    const fromDir = dirOf(fromFile);

    if (!specifier) return { status: 'unresolved', key: rawSpecifier, reason: 'Empty module specifier.' };

    if (specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..') {
      const base = joinRel(fromDir, specifier);
      if (base.startsWith('..')) return { status: 'unresolved', key: specifier, reason: 'Relative path points outside the repository.' };
      const hit = this.resolveFileOrDir(base, tsFirst);
      if (hit) return { status: 'file', target: hit.path, via: `relative${hit.how}` };
      return { status: 'unresolved', key: base || '.', reason: this.notFoundReason(base, tsFirst) };
    }

    if (specifier.startsWith('/')) {
      return { status: 'unresolved', key: specifier, reason: 'Absolute import path — its root depends on bundler configuration, so it is not resolved.' };
    }

    if (specifier.startsWith('#')) return this.resolvePackageImports(fromFile, specifier, tsFirst, depth);

    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(specifier);
    if (scheme) {
      const s = scheme[1].toLowerCase();
      if (s === 'node') {
        // node:fs/promises and fs/promises both belong to the `node:fs` module node.
        const name = specifier.slice(5).split('/')[0];
        return { status: 'external', packageName: `node:${name}`, builtin: true, via: 'node builtin' };
      }
      if (s === 'bun' || s === 'deno') return { status: 'external', packageName: specifier, builtin: true, via: `${s} builtin` };
      if (s === 'http' || s === 'https') return { status: 'external', packageName: specifier, builtin: false, via: 'URL import' };
      if (s === 'npm' || s === 'jsr') {
        const name = packageNameOf(specifier.slice(s.length + 1).replace(/@[^/@]+$/, ''))?.name ?? specifier;
        return { status: 'external', packageName: name, builtin: false, via: `${s}: specifier` };
      }
      return { status: 'unresolved', key: specifier, reason: `"${s}:" is a virtual module provided by a build tool, not a file in the repository.` };
    }

    // tsconfig/jsconfig `paths`.
    const cfg = this.tsconfigs.configFor(fromFile);
    if (cfg && cfg.paths.length && cfg.pathsBase !== undefined) {
      const m = matchPaths(cfg.paths, specifier);
      if (m) {
        const tried: string[] = [];
        for (const t of m.mapping.targets) {
          const base = joinRel(cfg.pathsBase, t.split('*').join(m.star));
          tried.push(base);
          const hit = this.resolveFileOrDir(base, tsFirst);
          if (hit) return { status: 'file', target: hit.path, via: `tsconfig paths "${m.mapping.pattern}" (${cfg.pathsDeclaredIn})${hit.how}` };
        }
        return {
          status: 'unresolved',
          key: specifier,
          reason: `Matches path alias "${m.mapping.pattern}" in ${cfg.pathsDeclaredIn}, but no file exists at ${tried.join(', ')}.`,
        };
      }
    }

    const pkg = packageNameOf(specifier);

    if (pkg && (BUILTINS.has(pkg.name) || BUILTINS.has(specifier))) {
      return { status: 'external', packageName: `node:${pkg.name}`, builtin: true, via: 'node builtin' };
    }

    // baseUrl lets bare specifiers refer to files (e.g. baseUrl "src" + import "lib/x").
    if (cfg?.baseUrl !== undefined) {
      const hit = this.resolveFileOrDir(joinRel(cfg.baseUrl, specifier), tsFirst);
      if (hit) return { status: 'file', target: hit.path, via: `baseUrl (${cfg.file})${hit.how}` };
    }

    if (pkg) {
      const ws = this.packages.workspaces.get(pkg.name);
      if (ws) return this.resolveWorkspace(ws.name, ws.dir, ws.manifest, pkg.subpath, tsFirst);
      if (isValidPackageName(pkg.name)) return { status: 'external', packageName: pkg.name, builtin: false, via: 'package' };
    }

    return {
      status: 'unresolved',
      key: specifier,
      reason: 'Looks like a path alias, but no matching tsconfig/jsconfig "paths" or package.json "imports" entry was found.',
    };
  }

  private resolveWorkspace(name: string, dir: string, manifest: import('./packages.ts').PackageJson, subpath: string, tsFirst: boolean): Resolution {
    let targets: ConditionalTarget[];
    let how: string;
    if (manifest.exports !== undefined) {
      const found = lookupSubpath(manifest.exports, subpath);
      if (!found) {
        return { status: 'unresolved', key: name + subpath.slice(1), reason: `Workspace package "${name}" does not export "${subpath}".` };
      }
      targets = found.targets;
      how = `exports "${found.key}"`;
    } else if (subpath === '.') {
      targets = manifestEntryFields(manifest);
      how = 'manifest';
      if (!targets.length) {
        const hit = this.resolveFileOrDir(dir, tsFirst, false);
        if (hit) return { status: 'file', target: hit.path, via: `workspace package ${name}${hit.how}` };
      }
    } else {
      const hit = this.resolveFileOrDir(joinRel(dir, subpath), tsFirst);
      if (hit) return { status: 'file', target: hit.path, via: `workspace package ${name} subpath${hit.how}` };
      return { status: 'unresolved', key: name + subpath.slice(1), reason: `No file for subpath "${subpath}" in workspace package "${name}" (${dir || 'root'}).` };
    }
    for (const t of targets) {
      const hit = this.resolveFileOrDir(joinRel(dir, t.target), tsFirst);
      if (hit) return { status: 'file', target: hit.path, via: `workspace package ${name} (${how}, ${t.condition})${hit.how}` };
    }
    const listed = targets.map((t) => t.target).join(', ') || '(none)';
    return {
      status: 'unresolved',
      key: name + (subpath === '.' ? '' : subpath.slice(1)),
      reason: `Workspace package "${name}" points to ${listed}, which is not in the repository (build output is not analyzed).`,
    };
  }

  private resolvePackageImports(fromFile: string, specifier: string, tsFirst: boolean, depth: number): Resolution {
    const owner = this.packages.nearest(dirOf(fromFile));
    const imports = owner?.manifest.imports;
    if (!owner || !imports) {
      return { status: 'unresolved', key: specifier, reason: 'Subpath import (#…) but the nearest package.json has no "imports" field.' };
    }
    const found = lookupSubpath(imports, specifier);
    if (!found) return { status: 'unresolved', key: specifier, reason: `"${specifier}" is not declared in ${owner.dir ? owner.dir + '/' : ''}package.json "imports".` };
    for (const t of found.targets) {
      if (t.target.startsWith('./')) {
        const hit = this.resolveFileOrDir(joinRel(owner.dir, t.target), tsFirst);
        if (hit) return { status: 'file', target: hit.path, via: `package.json imports "${found.key}" (${t.condition})${hit.how}` };
      } else if (depth < 4) {
        const r = this.resolveUncached(fromFile, t.target, tsFirst, depth + 1);
        if (r.status !== 'unresolved') return r;
      }
    }
    return { status: 'unresolved', key: specifier, reason: `package.json "imports" maps "${specifier}" to ${found.targets.map((t) => t.target).join(', ')}, which does not exist.` };
  }

  /** Resolve a repo-relative path as a file (exact, TS source for .js, extensions) or a directory (package.json, index). */
  resolveFileOrDir(base: string, tsFirst: boolean, allowDirManifest = true): FileHit | null {
    if (base && this.fs.isFile(base)) return { path: base, how: '' };
    const ext = /\.[cm]?jsx?$/.exec(base)?.[0];
    if (ext) {
      for (const tsExt of JS_TO_TS[ext] ?? []) {
        const candidate = base.slice(0, -ext.length) + tsExt;
        if (this.fs.isFile(candidate)) return { path: candidate, how: ` (TypeScript source for ${ext})` };
      }
    }
    const exts = tsFirst ? TS_FIRST : JS_FIRST;
    if (base) {
      for (const e of exts) {
        if (this.fs.isFile(base + e)) return { path: base + e, how: ` (extension ${e})` };
      }
    }
    if (this.fs.isDir(base)) {
      const manifestPath = base ? `${base}/package.json` : 'package.json';
      if (allowDirManifest && base && this.fs.isFile(manifestPath)) {
        const m = this.fs.json<import('./packages.ts').PackageJson>(manifestPath);
        for (const t of m ? manifestEntryFields(m) : []) {
          const hit = this.resolveFileOrDir(joinRel(base, t.target), tsFirst, false);
          if (hit) return { path: hit.path, how: ` (directory package.json "${t.condition}")` };
        }
      }
      for (const e of exts) {
        const candidate = base ? `${base}/index${e}` : `index${e}`;
        if (this.fs.isFile(candidate)) return { path: candidate, how: ` (index file index${e})` };
      }
    }
    return null;
  }

  private notFoundReason(base: string, tsFirst: boolean): string {
    const candidates = [base, ...(tsFirst ? TS_FIRST : JS_FIRST).map((e) => base + e)];
    for (const c of candidates) {
      const ex = this.fs.exclusionOf(c);
      if (ex) return `Target ${c} is ${ex}.`;
    }
    return `No file found at ${base || '.'} (tried the path as written, known extensions and index files).`;
  }
}
