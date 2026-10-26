import { useEffect, useMemo, useRef, useState } from 'react';
import type { CodeEntry } from '../../lib/api.ts';
import { searchPaths } from '../../lib/search.ts';
import { parseLocation } from './tree.ts';

/** Ctrl/⌘ + P: open a stored file by name or path, optionally at a line ("api.ts:42"). */
export function QuickOpen({ entries, onOpen, onClose }: { entries: CodeEntry[]; onOpen(path: string, line?: number): void; onClose(): void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const stored = useMemo(() => entries.filter((e) => !e.r), [entries]);
  const loc = parseLocation(query);
  const hits = useMemo(() => (loc.path ? searchPaths(stored, (e) => e.p, loc.path, 40) : stored.slice(0, 40).map((item) => ({ item, score: 0, matches: [] as number[] }))), [stored, loc.path]);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => setActive(0), [query]);

  const choose = (i: number) => {
    const h = hits[i];
    if (h) onOpen(h.item.p, loc.from);
  };

  return (
    <div className="qo-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="qo glass" role="dialog" aria-modal="true" aria-label="Go to file">
        <input
          ref={input}
          className="qo-input mono"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Go to file — name or path, add :line to jump"
          role="combobox"
          aria-expanded="true"
          aria-controls="qo-list"
          aria-activedescendant={hits[active] ? `qo-${active}` : undefined}
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(hits.length - 1, a + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              choose(active);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <ul id="qo-list" role="listbox" className="qo-list" aria-label="Matching files">
          {hits.map((h, i) => {
            const cut = h.item.p.lastIndexOf('/');
            const set = new Set(h.matches);
            const mark = (from: number, text: string) => [...text].map((c, k) => (set.has(from + k) ? <mark key={k}>{c}</mark> : <span key={k}>{c}</span>));
            return (
              <li key={h.item.p} id={`qo-${i}`} role="option" aria-selected={i === active} className={i === active ? 'is-active' : undefined} onMouseEnter={() => setActive(i)} onMouseDown={(e) => (e.preventDefault(), choose(i))}>
                <span className="qo-name">{mark(cut + 1, h.item.p.slice(cut + 1))}</span>
                <span className="qo-dir mono">{cut > 0 ? mark(0, h.item.p.slice(0, cut)) : ''}</span>
              </li>
            );
          })}
          {!hits.length && <li className="qo-none faint">No stored file matches “{loc.path}”.</li>}
        </ul>
        <p className="qo-foot small faint">
          {stored.length.toLocaleString()} stored files · ↑↓ to choose · Enter to open · Esc to close
        </p>
      </div>
    </div>
  );
}
