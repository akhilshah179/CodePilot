export interface SearchHit<T> {
  item: T;
  score: number;
  /** Indices in the path that matched, for highlighting. */
  matches: number[];
}

function subsequence(query: string, text: string): number[] | null {
  const out: number[] = [];
  let qi = 0;
  for (let i = 0; i < text.length && qi < query.length; i++) {
    if (text[i] === query[qi]) {
      out.push(i);
      qi++;
    }
  }
  return qi === query.length ? out : null;
}

/**
 * Rank paths for a query: exact file name, file-name prefix, file-name substring,
 * path substring, then in-order character match. Directory queries ("components/") work
 * through the path substring rule.
 */
export function searchPaths<T>(items: T[], getPath: (t: T) => string, rawQuery: string, limit = 50): SearchHit<T>[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [];
  const hits: SearchHit<T>[] = [];
  for (const item of items) {
    const path = getPath(item);
    const lower = path.toLowerCase();
    const baseStart = lower.lastIndexOf('/') + 1;
    const base = lower.slice(baseStart);
    const stem = base.replace(/\.[^.]+$/, '');
    let score = 0;
    let matches: number[] = [];
    const range = (from: number, len: number) => Array.from({ length: len }, (_, k) => from + k);
    if (base === query || stem === query) {
      score = 1000;
      matches = range(baseStart, query.length);
    } else if (base.startsWith(query)) {
      score = 800;
      matches = range(baseStart, query.length);
    } else if (base.includes(query)) {
      score = 600;
      matches = range(baseStart + base.indexOf(query), query.length);
    } else if (lower.includes(query)) {
      score = 400;
      matches = range(lower.indexOf(query), query.length);
    } else {
      const sub = subsequence(query, lower);
      if (!sub) continue;
      const spread = sub[sub.length - 1] - sub[0];
      score = 200 - Math.min(150, spread);
      matches = sub;
    }
    score -= Math.min(50, path.length / 4);
    hits.push({ item, score, matches });
  }
  hits.sort((a, b) => b.score - a.score || (getPath(a.item) < getPath(b.item) ? -1 : 1));
  return hits.slice(0, limit);
}
