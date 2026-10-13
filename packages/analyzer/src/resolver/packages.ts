import picomatch from 'picomatch';
import { dirOf, joinRel, type RepoFs } from './repoFs.ts';

export interface PackageJson {
  name?: string;
  main?: string;
  module?: string;
  source?: string;
  types?: string;
  typings?: string;
  bin?: string | Record<string, string>;
  exports?: unknown;
  imports?: Record<string, unknown>;
  scripts?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export interface WorkspacePackage {
  name: string;
  dir: string;
  manifest: PackageJson;
}

/**
 * Condition names accepted when reading `exports`/`imports`. Targets are tried in the
 * object's own key order (Node semantics) and the first one that exists in the
 * repository wins; nothing is inferred beyond what the manifest declares.
 */
const CONDITIONS = new Set(['source', 'development', 'import', 'module', 'require', 'node', 'browser', 'default', 'types']);

export interface ConditionalTarget {
  target: string;
  condition: string;
}

export function packageNameOf(specifier: string): { name: string; subpath: string } | null {
  const m = /^(@[^/]+\/[^/]+|[^/@.][^/]*)(\/.*)?$/.exec(specifier);
  if (!m) return null;
  return { name: m[1], subpath: m[2] ? '.' + m[2] : '.' };
}

const VALID_NAME = /^(?:@[a-z0-9-][a-z0-9-._]*\/)?[a-z0-9-][a-z0-9-._]*$/i;
export function isValidPackageName(name: string): boolean {
  return VALID_NAME.test(name);
}

export class PackageIndex {
  /** package.json files keyed by their directory. */
  readonly manifests = new Map<string, PackageJson>();
  readonly workspaces = new Map<string, WorkspacePackage>();

  constructor(private readonly fs: RepoFs) {
    for (const f of fs.files) {
      if (f === 'package.json' || f.endsWith('/package.json')) {
        const pkg = fs.json<PackageJson>(f);
        if (pkg) this.manifests.set(dirOf(f), pkg);
      }
    }
    this.discoverWorkspaces();
  }

  private discoverWorkspaces() {
    const patterns: string[] = [];
    const root = this.manifests.get('');
    const ws = root?.workspaces;
    if (Array.isArray(ws)) patterns.push(...ws);
    else if (ws && Array.isArray(ws.packages)) patterns.push(...ws.packages);
    patterns.push(...parsePnpmWorkspace(this.fs.text('pnpm-workspace.yaml')));
    const lerna = this.fs.json<{ packages?: string[] }>('lerna.json');
    if (lerna?.packages) patterns.push(...lerna.packages);

    const positive = patterns.filter((p) => !p.startsWith('!')).map(normalizeGlob);
    const negative = patterns.filter((p) => p.startsWith('!')).map((p) => normalizeGlob(p.slice(1)));
    const isMember = positive.length ? picomatch(positive) : () => false;
    const isExcluded = negative.length ? picomatch(negative) : () => false;

    // The root package can always be imported by its own name (self-reference).
    if (root?.name) this.workspaces.set(root.name, { name: root.name, dir: '', manifest: root });
    for (const [dir, manifest] of this.manifests) {
      if (!dir || !manifest.name) continue;
      if (isMember(dir) && !isExcluded(dir)) this.workspaces.set(manifest.name, { name: manifest.name, dir, manifest });
    }
  }

  /** Nearest package.json at or above `dir`. */
  nearest(dir: string): { dir: string; manifest: PackageJson } | null {
    let d = dir;
    for (;;) {
      const m = this.manifests.get(d);
      if (m) return { dir: d, manifest: m };
      if (!d) return null;
      d = dirOf(d);
    }
  }
}

function normalizeGlob(p: string): string {
  return p.replace(/^\.\//, '').replace(/\/+$/, '');
}

/** Minimal reader for the `packages:` list in pnpm-workspace.yaml. */
export function parsePnpmWorkspace(text: string | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  let inPackages = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '');
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const m = /^\s*-\s*['"]?([^'"]+?)['"]?\s*$/.exec(line);
      if (m) out.push(m[1]);
      else if (/^\S/.test(line)) inPackages = false;
    }
  }
  return out;
}

/** Candidate targets from an `exports`/`imports` value, in manifest order. */
export function conditionalTargets(value: unknown, condition = 'default'): ConditionalTarget[] {
  if (typeof value === 'string') return [{ target: value, condition }];
  if (Array.isArray(value)) return value.flatMap((v) => conditionalTargets(v, condition));
  if (value && typeof value === 'object') {
    const out: ConditionalTarget[] = [];
    for (const [key, v] of Object.entries(value)) {
      if (CONDITIONS.has(key)) out.push(...conditionalTargets(v, key));
    }
    return out;
  }
  return []; // null means "explicitly not exported"
}

/**
 * Look up `subpath` ('.' or './x') in an exports/imports map.
 * Returns undefined when the map does not export the subpath.
 */
export function lookupSubpath(map: unknown, subpath: string): { key: string; targets: ConditionalTarget[] } | undefined {
  let entries: Record<string, unknown>;
  if (typeof map === 'string' || Array.isArray(map)) entries = { '.': map };
  else if (map && typeof map === 'object') {
    const keys = Object.keys(map);
    const isSubpathMap = keys.some((k) => k.startsWith('.') || k.startsWith('#'));
    entries = isSubpathMap ? (map as Record<string, unknown>) : { '.': map };
  } else return undefined;

  if (subpath in entries) return { key: subpath, targets: conditionalTargets(entries[subpath]) };

  let best: { key: string; star: string; prefixLen: number } | undefined;
  for (const key of Object.keys(entries)) {
    const i = key.indexOf('*');
    if (i < 0) continue;
    const prefix = key.slice(0, i);
    const suffix = key.slice(i + 1);
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= prefix.length + suffix.length) {
      if (!best || prefix.length > best.prefixLen) {
        best = { key, star: subpath.slice(prefix.length, subpath.length - suffix.length), prefixLen: prefix.length };
      }
    }
  }
  if (!best) return undefined;
  const star = best.star;
  return {
    key: best.key,
    targets: conditionalTargets(entries[best.key]).map((t) => ({ ...t, target: t.target.split('*').join(star) })),
  };
}

export function manifestEntryFields(pkg: PackageJson): ConditionalTarget[] {
  const out: ConditionalTarget[] = [];
  for (const field of ['source', 'module', 'main', 'types', 'typings'] as const) {
    const v = pkg[field];
    if (typeof v === 'string') out.push({ target: v, condition: field });
  }
  return out;
}

export { joinRel };
