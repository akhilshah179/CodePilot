import type { DependencyGraph } from '../types.ts';
import type { InternalImportFact } from './types.ts';

export interface Hop {
  source: string;
  target: string;
  line: number;
}

/**
 * File-level import graph used by architecture detection: resolved JS/TS edges from the
 * dependency graph plus Python/Go/Ruby imports resolved during extraction.
 */
export class FileGraph {
  readonly out = new Map<string, Hop[]>();
  readonly in = new Map<string, Hop[]>();

  constructor(graph: DependencyGraph, internal: InternalImportFact[]) {
    const seen = new Set<string>();
    const add = (h: Hop) => {
      const key = `${h.source}\0${h.target}`;
      if (seen.has(key) || h.source === h.target) return;
      seen.add(key);
      if (!this.out.has(h.source)) this.out.set(h.source, []);
      this.out.get(h.source)!.push(h);
      if (!this.in.has(h.target)) this.in.set(h.target, []);
      this.in.get(h.target)!.push(h);
    };
    const edges = [...graph.edges].sort((a, b) => a.line - b.line);
    for (const e of edges) if (e.resolved && !e.external) add({ source: e.source, target: e.target, line: e.line });
    for (const i of [...internal].sort((a, b) => a.line - b.line)) add({ source: i.source, target: i.target, line: i.line });
  }

  /** Files reachable from `starts` by following imports. */
  closure(starts: string[], maxDepth = Infinity): Set<string> {
    const seen = new Set(starts);
    let frontier = [...starts];
    for (let d = 0; d < maxDepth && frontier.length; d++) {
      const next: string[] = [];
      for (const f of frontier) {
        for (const h of this.out.get(f) ?? []) {
          if (seen.has(h.target)) continue;
          seen.add(h.target);
          next.push(h.target);
        }
      }
      frontier = next;
    }
    return seen;
  }

  /** BFS from `start` along imports; returns depth and the hop used to reach each file. */
  reach(start: string, maxDepth: number, allow?: (file: string) => boolean): Map<string, { depth: number; via?: Hop }> {
    const out = new Map<string, { depth: number; via?: Hop }>([[start, { depth: 0 }]]);
    let frontier = [start];
    for (let d = 1; d <= maxDepth && frontier.length; d++) {
      const next: string[] = [];
      for (const f of frontier) {
        for (const h of this.out.get(f) ?? []) {
          if (out.has(h.target) || (allow && !allow(h.target))) continue;
          out.set(h.target, { depth: d, via: h });
          next.push(h.target);
        }
      }
      frontier = next;
    }
    return out;
  }

  /** Files that import any of `files`, transitively, with their distance. */
  dependents(files: Iterable<string>, maxDepth: number): Map<string, number> {
    const out = new Map<string, number>();
    let frontier = [...files];
    for (const f of frontier) out.set(f, 0);
    for (let d = 1; d <= maxDepth && frontier.length; d++) {
      const next: string[] = [];
      for (const f of frontier) {
        for (const h of this.in.get(f) ?? []) {
          if (out.has(h.source)) continue;
          out.set(h.source, d);
          next.push(h.source);
        }
      }
      frontier = next;
    }
    return out;
  }

  /** Import chain from `from` to `to`, rebuilt from a `reach` map. */
  static chain(reach: Map<string, { depth: number; via?: Hop }>, to: string): Hop[] {
    const hops: Hop[] = [];
    let cur = reach.get(to);
    while (cur?.via) {
      hops.push(cur.via);
      cur = reach.get(cur.via.source);
    }
    return hops.reverse();
  }
}

const PARAM = /^(?::\w+|\{[^}]*\}|<[^>]*>|\[[^\]]*\]|\*|:param)$/;

/** Normalize a route or call path into comparable segments. */
export function pathSegments(p: string): string[] {
  let s = p.trim();
  const u = /^[a-z]+:\/\/[^/]+(\/.*)?$/i.exec(s);
  if (u) s = u[1] ?? '/';
  s = s.replace(/[?#].*$/, '').replace(/\/+$/, '');
  return s.split('/').filter(Boolean);
}

/**
 * How specifically a call path matches a route: -1 for no match; otherwise literal and parameter
 * segments that line up score higher than a parameter matching a literal, so
 * `/users/{id}` prefers `/users/:user_id` over `/users/me`.
 */
export function routeMatchScore(route: string, call: string): number {
  if (!routeMatches(route, call)) return -1;
  const r = pathSegments(route);
  const c = pathSegments(call);
  let score = 0;
  for (let i = 0; i < Math.min(r.length, c.length); i++) {
    const rp = PARAM.test(r[i]);
    const cp = PARAM.test(c[i]);
    score += rp === cp ? 2 : 0;
  }
  return score;
}

/** Routes that best match a call (ties kept). */
export function bestRoutes<T extends { path: string }>(routes: T[], call: string): T[] {
  let best = -1;
  let out: T[] = [];
  for (const r of routes) {
    const s = routeMatchScore(r.path, call);
    if (s < 0) continue;
    if (s > best) {
      best = s;
      out = [r];
    } else if (s === best) out.push(r);
  }
  return out;
}

/** Does a call path (possibly with `:param` placeholders) hit a declared route path? */
export function routeMatches(route: string, call: string): boolean {
  if (route.startsWith('action:') || route.startsWith('trpc:')) return false;
  const r = pathSegments(route);
  const c = pathSegments(call);
  const wildcardTail = r[r.length - 1] === '*';
  if (!wildcardTail && r.length !== c.length) return false;
  if (wildcardTail && c.length < r.length - 1) return false;
  for (let i = 0; i < r.length; i++) {
    if (wildcardTail && i === r.length - 1) return true;
    if (PARAM.test(r[i]) || PARAM.test(c[i])) continue;
    if (r[i].toLowerCase() !== c[i].toLowerCase()) return false;
  }
  return true;
}
