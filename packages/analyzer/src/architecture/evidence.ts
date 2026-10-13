import type { Evidence, EvidenceRef, FileUse } from './types.ts';

/** FNV-1a, base36: stable evidence ids across regenerations of the same commit. */
export function stableId(prefix: string, text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${prefix}${(h >>> 0).toString(36)}`;
}

export class EvidenceStore {
  readonly all = new Map<string, Evidence>();

  add(ref: EvidenceRef): string {
    const id = stableId('ev_', `${ref.kind}|${ref.file}|${ref.line ?? ''}|${ref.detail}`);
    if (!this.all.has(id)) this.all.set(id, { id, ...ref });
    return id;
  }

  get(id: string): Evidence | undefined {
    return this.all.get(id);
  }

  /** "file:line", for sentences. */
  cite(id: string): string {
    const e = this.all.get(id);
    return e ? `${e.file}${e.line ? `:${e.line}` : ''}` : '';
  }

  /** Human citation of the first evidence items: "a.ts:3, b.py:7 and 4 more". */
  citeList(ids: string[], max = 2): string {
    const unique = [...new Set(ids.map((id) => this.cite(id)).filter(Boolean))];
    if (!unique.length) return '';
    const head = unique.slice(0, max).join(', ');
    return unique.length > max ? `${head} and ${unique.length - max} more` : head;
  }
}

/** Accumulates per-file usage for a node's "where used" strip. */
export class FileUses {
  private readonly map = new Map<string, { lines: Set<number>; uses: Set<string> }>();

  add(path: string, line: number | undefined, use: string) {
    let f = this.map.get(path);
    if (!f) this.map.set(path, (f = { lines: new Set(), uses: new Set() }));
    if (line) f.lines.add(line);
    f.uses.add(use);
  }

  get size() {
    return this.map.size;
  }

  has(path: string) {
    return this.map.has(path);
  }

  paths(): string[] {
    return [...this.map.keys()];
  }

  list(): FileUse[] {
    // Files with operations first, then by amount of evidence, then by path.
    const weight = (u: Set<string>) => (u.has('import') && u.size === 1 ? 0 : 1);
    return [...this.map]
      .map(([path, v]) => ({ path, lines: [...v.lines].sort((a, b) => a - b), uses: [...v.uses].sort() }))
      .sort((a, b) => weight(new Set(b.uses)) - weight(new Set(a.uses)) || b.lines.length - a.lines.length || (a.path < b.path ? -1 : 1));
  }
}
