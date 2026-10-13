import { Command, CornerDownLeft, Search } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { searchPaths } from '../../lib/search.ts';

export interface PaletteItem {
  id: string;
  label: string;
  /** Secondary text (path, type, hint). */
  detail?: string;
  icon?: ReactNode;
  /** Text matched by search (defaults to the label); file items use their path. */
  key?: string;
  group: string;
  run(): void;
}

interface Props {
  /** Searchable entities (files, technologies, routes…). */
  items: PaletteItem[];
  /** Commands, matched by label. */
  actions?: PaletteItem[];
  placeholder?: string;
  emptyHint?: string;
  onClose(): void;
}

function Highlighted({ text, matches }: { text: string; matches: number[] }) {
  const set = new Set(matches);
  return <>{[...text].map((ch, i) => (set.has(i) ? <mark key={i}>{ch}</mark> : <span key={i}>{ch}</span>))}</>;
}

/** Command palette (`/`, Ctrl/⌘K): search entities by name, path or directory, and run commands. */
export function SearchDialog({ items, actions = [], placeholder = 'Search files, technologies and commands…', emptyHint, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const hits = useMemo(() => {
    const q = query.trim();
    const found = q ? searchPaths(items, (x) => x.key ?? x.label, q, 40).map((h) => ({ item: h.item, matches: [] as number[] })) : [];
    const acts = (q ? searchPaths(actions, (a) => a.label, q, 8) : actions.slice(0, 8).map((item) => ({ item, matches: [] as number[] }))).map((h) => ({ item: h.item, matches: h.matches }));
    return [...found, ...acts];
  }, [items, actions, query]);

  useEffect(() => {
    inputRef.current?.focus();
    const prev = document.activeElement as HTMLElement | null;
    return () => prev?.focus?.();
  }, []);
  useEffect(() => setActive(0), [query]);

  const pick = (k: number) => {
    const hit = hits[k];
    if (!hit) return;
    onClose();
    hit.item.run();
  };

  let lastGroup = '';
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog search-dialog glass" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="search-row">
          <Search size={16} aria-hidden="true" />
          <input
            ref={inputRef}
            className="input search-input"
            placeholder={placeholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            role="combobox"
            aria-expanded={hits.length > 0}
            aria-controls={listId}
            aria-activedescendant={hits[active] ? `${listId}-${active}` : undefined}
            aria-autocomplete="list"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(hits.length - 1, a + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                pick(active);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              }
            }}
          />
          <kbd>esc</kbd>
        </div>
        <ul className="search-results" id={listId} role="listbox" aria-label="Results">
          {hits.map((h, k) => {
            const header = h.item.group !== lastGroup ? h.item.group : null;
            lastGroup = h.item.group;
            return (
              <li key={`${h.item.group}:${h.item.id}`} role="presentation">
                {header && <div className="search-group">{header}</div>}
                <div
                  id={`${listId}-${k}`}
                  role="option"
                  aria-selected={k === active}
                  className="search-option"
                  onMouseEnter={() => setActive(k)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(k);
                  }}
                >
                  {h.item.icon ?? <Command size={13} aria-hidden="true" />}
                  <span className="search-label">{h.matches.length && h.item.group === 'Commands' ? <Highlighted text={h.item.label} matches={h.matches} /> : h.item.label}</span>
                  {h.item.detail && <span className="mono faint search-detail">{h.item.detail}</span>}
                  {k === active && <CornerDownLeft size={12} className="faint" aria-hidden="true" />}
                </div>
              </li>
            );
          })}
          {query && hits.length === 0 && <li className="empty faint">Nothing matches “{query}”.</li>}
          {!query && emptyHint && <li className="empty faint">{emptyHint}</li>}
        </ul>
      </div>
    </div>
  );
}
