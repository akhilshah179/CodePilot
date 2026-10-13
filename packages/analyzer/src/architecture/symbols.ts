import type { ArchitectureFacts, SymbolFact, SymbolRef } from './types.ts';

/** A region of code: a function body with the project code it references, or a whole module (refs undefined). */
export interface Scope {
  file: string;
  start: number;
  end: number;
  refs?: SymbolRef[];
  name?: string;
}

/**
 * Index over top-level definitions and their references (JS/TS and Python), shared by flow
 * tracing and by per-process attribution of call sites.
 */
export class SymbolIndex {
  readonly byFile = new Map<string, SymbolFact[]>();
  private readonly reexports = new Map<string, Map<string, string>>();

  constructor(facts: ArchitectureFacts, jsEdges: { source: string; target: string; symbols: string[]; resolved: boolean; external: boolean }[]) {
    for (const s of facts.symbols) {
      if (!this.byFile.has(s.file)) this.byFile.set(s.file, []);
      this.byFile.get(s.file)!.push(s);
    }
    for (const i of facts.internalImports) for (const sym of i.symbols) this.alias(i.source, sym, i.target);
    for (const e of jsEdges) {
      if (!e.resolved || e.external) continue;
      for (const sym of e.symbols) if (sym !== '*' && sym !== 'default') this.alias(e.source, sym, e.target);
    }
  }

  private alias(file: string, symbol: string, from: string) {
    if (!this.reexports.has(file)) this.reexports.set(file, new Map());
    if (!this.reexports.get(file)!.has(symbol)) this.reexports.get(file)!.set(symbol, from);
  }

  has(file: string): boolean {
    return this.byFile.has(file);
  }

  /** Definition of `name` in `file`, following re-exports (`from .deps import X` in `__init__.py`). */
  find(file: string, name: string | undefined, hops = 0): SymbolFact | undefined {
    if (!name) return undefined;
    const hit = this.byFile.get(file)?.find((x) => x.name === name);
    if (hit) return hit;
    const from = this.reexports.get(file)?.get(name);
    return from && hops < 2 ? this.find(from, name, hops + 1) : undefined;
  }

  /** Innermost top-level definition containing `line`. */
  enclosing(file: string, line: number): SymbolFact | undefined {
    return (this.byFile.get(file) ?? []).filter((x) => x.name !== 'default' && x.line <= line && x.end >= line).sort((a, b) => a.end - a.line - (b.end - b.line))[0];
  }

  scopeOf(def: SymbolFact): Scope {
    return { file: def.file, start: def.line, end: def.end, refs: def.refs, name: def.name };
  }

  /** Module-level code of a file: lines outside any definition, plus what assignments reference. */
  moduleScope(file: string): Scope[] {
    const defs = this.byFile.get(file);
    if (!defs) return [{ file, start: 1, end: Number.MAX_SAFE_INTEGER }];
    // Assignments (`app = FastAPI()`, `celery_app = Celery(...)`) run at import time; functions and classes do not.
    return defs.filter((d) => !/^[A-Z]/.test(d.name) || d.end === d.line).map((d) => this.scopeOf(d)).filter((s) => s.end - s.start < 3);
  }

  /** All scopes reachable from `roots` through references, limited to files `allow` accepts. */
  reach(roots: Scope[], allow: (file: string) => boolean, maxDepth = 8): Scope[] {
    const out: Scope[] = [];
    const seen = new Set<string>();
    let frontier = roots.map((s) => ({ s, depth: 0 }));
    for (const r of roots) seen.add(`${r.file}#${r.start}`);
    while (frontier.length) {
      const next: { s: Scope; depth: number }[] = [];
      for (const { s, depth } of frontier) {
        out.push(s);
        if (depth >= maxDepth || !s.refs) continue;
        for (const ref of s.refs) {
          const def = this.find(ref.file, ref.symbol);
          if (!def || !allow(def.file)) continue;
          const key = `${def.file}#${def.line}`;
          if (seen.has(key)) continue;
          seen.add(key);
          next.push({ s: this.scopeOf(def), depth: depth + 1 });
        }
      }
      frontier = next;
    }
    return out;
  }
}
