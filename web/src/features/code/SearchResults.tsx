import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import type { ApiError, CodeSearchResult } from '../../lib/api.ts';

/** Ctrl/⌘ + Shift + F results, grouped by file; a match opens its file at that line. */
export function SearchResults(props: { query: string; result: CodeSearchResult | null; loading: boolean; error: ApiError | null; onOpen(path: string, line: number): void }) {
  const { result, loading, error } = props;
  const [closed, setClosed] = useState<Set<string>>(new Set());
  if (!props.query.trim()) return <p className="cs-note small faint">Type in the search box above to search every stored file. Matches are exact text; secrets stay masked.</p>;
  if (error) return <p className="cs-note small" role="alert">{error.message}</p>;
  if (!result) return <p className="cs-note small faint">{loading ? 'Searching…' : ''}</p>;
  return (
    <div className="cs">
      <p className="cs-summary small" aria-live="polite">
        {result.matches ? (
          <>
            {result.matches.toLocaleString()} match{result.matches === 1 ? '' : 'es'} in {result.filesMatched.toLocaleString()} file{result.filesMatched === 1 ? '' : 's'}
          </>
        ) : (
          <>No matches for “{result.query}”</>
        )}
        <span className="faint"> · {result.filesSearched.toLocaleString()} files searched</span>
        {loading && <span className="faint"> · updating…</span>}
      </p>
      {result.truncated && <p className="cs-note small faint">Showing the first results only — refine the search to see more.</p>}
      <ul className="cs-files">
        {result.results.map((f) => {
          const open = !closed.has(f.path);
          const cut = f.path.lastIndexOf('/');
          return (
            <li key={f.path}>
              <button
                type="button"
                className="cs-file"
                aria-expanded={open}
                onClick={() => setClosed((c) => {
                  const n = new Set(c);
                  if (open) n.add(f.path);
                  else n.delete(f.path);
                  return n;
                })}
              >
                {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
                <span className="cs-name">{f.path.slice(cut + 1)}</span>
                <span className="cs-dir mono">{cut > 0 ? f.path.slice(0, cut) : ''}</span>
                <span className="cs-count mono">{f.total}</span>
              </button>
              {open && (
                <ul className="cs-matches">
                  {f.matches.map((m, k) => (
                    <li key={k}>
                      <button type="button" className="cs-match mono" onClick={() => props.onOpen(f.path, m.line)} title={`${f.path}:${m.line}`}>
                        <span className="cs-ln">{m.line}</span>
                        <span className="cs-text">
                          {m.offset > 0 && '…'}
                          {m.text.slice(Math.max(0, m.col - 60), m.col).trimStart()}
                          <mark>{m.text.slice(m.col, m.col + m.len)}</mark>
                          {m.text.slice(m.col + m.len)}
                        </span>
                      </button>
                    </li>
                  ))}
                  {f.total > f.matches.length && <li className="cs-more small faint">{(f.total - f.matches.length).toLocaleString()} more in this file</li>}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
