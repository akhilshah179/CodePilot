import type { CodeEntry } from '../../lib/api.ts';

/*
 * The explorer's model: a folder tree built from the snapshot's entries (stored files and the
 * entries that were not stored), sorted folders-first, flattened to the visible rows for a
 * virtualized list.
 */

export interface TreeNode {
  name: string;
  /** Path without a trailing slash. */
  path: string;
  dir: boolean;
  children: TreeNode[];
  entry?: CodeEntry;
  /** Why this entry was not stored (files, and directories that were never entered). */
  reason?: string;
  /** Stored files under this folder. */
  files: number;
}

export interface Row {
  node: TreeNode;
  depth: number;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function buildTree(entries: CodeEntry[]): TreeNode {
  const root: TreeNode = { name: '', path: '', dir: true, children: [], files: 0 };
  const dirs = new Map<string, TreeNode>([['', root]]);
  const dirFor = (path: string): TreeNode => {
    const hit = dirs.get(path);
    if (hit) return hit;
    const cut = path.lastIndexOf('/');
    const parent = dirFor(cut < 0 ? '' : path.slice(0, cut));
    const node: TreeNode = { name: path.slice(cut + 1), path, dir: true, children: [], files: 0 };
    parent.children.push(node);
    dirs.set(path, node);
    return node;
  };
  for (const e of entries) {
    const isDir = e.p.endsWith('/');
    const path = isDir ? e.p.slice(0, -1) : e.p;
    const cut = path.lastIndexOf('/');
    const parent = dirFor(cut < 0 ? '' : path.slice(0, cut));
    if (isDir) {
      // A directory that was not entered: a leaf that cannot be expanded.
      const node = dirFor(path);
      node.entry = e;
      node.reason = e.r;
      continue;
    }
    parent.children.push({ name: path.slice(cut + 1), path, dir: false, children: [], entry: e, reason: e.r, files: 0 });
  }
  const finish = (n: TreeNode): number => {
    n.children.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : collator.compare(a.name, b.name)));
    n.files = n.children.reduce((sum, c) => sum + (c.dir ? finish(c) : c.reason ? 0 : 1), 0);
    return n.files;
  };
  finish(root);
  return root;
}

/** Visible rows: expanded folders' children, or with a filter every match and its folders. */
export function flatten(root: TreeNode, expanded: Set<string>, filter = ''): Row[] {
  const rows: Row[] = [];
  const f = filter.trim().toLowerCase();
  if (!f) {
    const walk = (n: TreeNode, depth: number) => {
      for (const c of n.children) {
        rows.push({ node: c, depth });
        if (c.dir && !c.reason && expanded.has(c.path)) walk(c, depth + 1);
      }
    };
    walk(root, 0);
    return rows;
  }
  const memo = new Map<TreeNode, boolean>();
  const matches = (n: TreeNode): boolean => {
    let v = memo.get(n);
    if (v === undefined) {
      v = n.path.toLowerCase().includes(f) || (n.dir && n.children.some(matches));
      memo.set(n, v);
    }
    return v;
  };
  const walk = (n: TreeNode, depth: number) => {
    for (const c of n.children) {
      if (!matches(c)) continue;
      rows.push({ node: c, depth });
      // A folder whose own name matches shows only what matches inside it too.
      if (c.dir && !c.reason) walk(c, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}

/** Folders containing `path`, for revealing a file. */
export function ancestors(path: string): string[] {
  const parts = path.split('/');
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
}

export type FileIconKind = 'code' | 'json' | 'markup' | 'style' | 'doc' | 'config' | 'image' | 'lock' | 'binary' | 'text' | 'test';

export function fileIconKind(path: string, language: string | undefined, reason?: string): FileIconKind {
  if (reason === 'secret-file' || reason === 'secret-content') return 'lock';
  if (reason === 'binary') return /\.(png|jpe?g|gif|webp|avif|ico|svg)$/i.test(path) ? 'image' : 'binary';
  if (/\.(test|spec)\.[jt]sx?$/.test(path)) return 'test';
  switch (language) {
    case 'json':
      return 'json';
    case 'html':
    case 'xml':
    case 'svg':
    case 'vue':
    case 'svelte':
    case 'astro':
      return 'markup';
    case 'css':
    case 'scss':
    case 'less':
      return 'style';
    case 'markdown':
    case 'mdx':
      return 'doc';
    case 'yaml':
    case 'toml':
    case 'ini':
    case 'dockerfile':
    case 'makefile':
    case 'properties':
    case 'conf':
    case 'hcl':
    case 'go-mod':
    case 'pip-requirements':
      return 'config';
    case 'text':
    case undefined:
      return 'text';
    default:
      return 'code';
  }
}

/** Human-readable byte size. */
export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** "src/a.ts:12", "src/a.ts:12-20" or "src/a.ts" → path and line range. */
export function parseLocation(s: string): { path: string; from?: number; to?: number } {
  const m = /^(.*?):(\d+)(?:-(\d+))?$/.exec(s.trim());
  if (!m) return { path: s.trim() };
  const from = Number(m[2]);
  const to = m[3] ? Math.max(from, Number(m[3])) : from;
  return { path: m[1], from, to };
}

/** The `line` URL parameter: "12" or "12-20". */
export function parseLines(s: string | null | undefined): { from: number; to: number } | null {
  const m = s ? /^(\d+)(?:-(\d+))?$/.exec(s) : null;
  if (!m) return null;
  const from = Math.max(1, Number(m[1]));
  return { from, to: m[2] ? Math.max(from, Number(m[2])) : from };
}
