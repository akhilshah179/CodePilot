import { ArrowDownUp, Crosshair, Search, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ConfidenceBadge } from '../../components/ui.tsx';
import type { ArchitectureResponse, ArchNode, Confidence } from '../../lib/api.ts';
import type { FileOpener } from '../../lib/fileLinks.ts';
import { CategoryIcon } from './CategoryIcon.tsx';
import { nodeEyebrow } from './style.ts';

type Arch = ArchitectureResponse['architecture'];
type SortKey = 'name' | 'category' | 'confidence' | 'usage';

interface Row {
  node: ArchNode;
  usedBy: string[];
  evidence?: { file: string; line?: number; detail: string };
  usage: number;
}

const CONF_RANK: Record<Confidence, number> = { confirmed: 0, strong: 1, possible: 2 };

/**
 * Every detected technology with its version, role, who uses it and the line that proves it.
 * Rows are architecture nodes — nothing here is inferred beyond what the detector recorded.
 */
export function TechMatrix({ arch, opener, highlight, onFocus, onExplain }: { arch: Arch; opener: FileOpener; highlight: string | null; onFocus(id: string): void; onExplain?(id: string): void }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'category', dir: 1 });
  const highlightRef = useRef<HTMLTableRowElement>(null);

  const rows: Row[] = useMemo(() => {
    const byId = new Map(arch.nodes.map((n) => [n.id, n]));
    return arch.nodes
      .filter((n) => n.kind !== 'app' && !n.id.startsWith('client:'))
      .map((n) => {
        const users = new Set<string>();
        for (const h of n.hosts ?? []) users.add(byId.get(h)?.name ?? h);
        for (const e of arch.edges) if (e.target === n.id && e.overlays.includes('dataflow')) users.add(byId.get(e.source)?.name ?? e.source);
        const first = n.evidence.map((id) => arch.evidence[id]).find(Boolean);
        return { node: n, usedBy: [...users].sort(), evidence: first ? { file: first.file, line: first.line, detail: first.detail } : undefined, usage: n.files.length };
      });
  }, [arch]);

  const categories = useMemo(() => [...new Set(rows.map((r) => nodeEyebrow(r.node)))].sort(), [rows]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = rows.filter((r) => (!category || nodeEyebrow(r.node) === category) && (!q || `${r.node.name} ${r.node.category} ${r.node.role} ${r.usedBy.join(' ')}`.toLowerCase().includes(q)));
    const cmp = (a: Row, b: Row) => {
      switch (sort.key) {
        case 'name':
          return a.node.name.localeCompare(b.node.name);
        case 'category':
          return nodeEyebrow(a.node).localeCompare(nodeEyebrow(b.node)) || a.node.name.localeCompare(b.node.name);
        case 'confidence':
          return CONF_RANK[a.node.confidence] - CONF_RANK[b.node.confidence] || a.node.name.localeCompare(b.node.name);
        case 'usage':
          return b.usage - a.usage || a.node.name.localeCompare(b.node.name);
      }
    };
    return [...list].sort((a, b) => cmp(a, b) * sort.dir);
  }, [rows, query, category, sort]);

  useEffect(() => {
    if (highlight) highlightRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [highlight]);

  const header = (key: SortKey, label: string) => (
    <th scope="col" aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="th-sort" onClick={() => setSort((s) => ({ key, dir: s.key === key ? ((-s.dir) as 1 | -1) : 1 }))}>
        {label} <ArrowDownUp size={11} aria-hidden="true" />
      </button>
    </th>
  );

  return (
    <div className="tech-matrix">
      <div className="tm-toolbar">
        <label className="tm-search">
          <Search size={14} aria-hidden="true" />
          <input type="search" placeholder="Filter technologies…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter technologies" />
        </label>
        <div className="tm-cats" role="group" aria-label="Category">
          <button type="button" aria-pressed={!category} onClick={() => setCategory(null)}>
            All <span className="mono faint">{rows.length}</span>
          </button>
          {categories.map((c) => (
            <button key={c} type="button" aria-pressed={category === c} onClick={() => setCategory(category === c ? null : c)}>
              {c} <span className="mono faint">{rows.filter((r) => nodeEyebrow(r.node) === c).length}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="tm-scroll">
        <table className="tm-table">
          <thead>
            <tr>
              {header('name', 'Technology')}
              {header('category', 'Category')}
              <th scope="col">Version</th>
              <th scope="col">Role</th>
              <th scope="col">Used by</th>
              {header('usage', 'Evidence')}
              {header('confidence', 'Confidence')}
              <th scope="col">
                <span className="visually-hidden">Focus</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const n = r.node;
              const href = r.evidence ? opener.href(r.evidence.file, r.evidence.line) : null;
              const hl = highlight === n.id;
              return (
                <tr key={n.id} ref={hl ? highlightRef : undefined} className={hl ? 'is-highlight' : undefined}>
                  <th scope="row">
                    <span className="tm-name">
                      <span className="tm-icon">
                        <CategoryIcon category={n.category} size={14} />
                      </span>
                      {n.name}
                    </span>
                  </th>
                  <td className="faint">{nodeEyebrow(n)}</td>
                  <td className="mono" title={n.version ? `from ${n.version.source}${n.version.line ? `:${n.version.line}` : ''}` : undefined}>
                    {n.version ? `${n.version.package ? `${n.version.package} ` : ''}${n.version.value}` : <span className="faint">—</span>}
                  </td>
                  <td className="tm-role">{n.role || <span className="faint">—</span>}</td>
                  <td>{r.usedBy.length ? r.usedBy.slice(0, 4).join(', ') + (r.usedBy.length > 4 ? ` +${r.usedBy.length - 4}` : '') : <span className="faint">—</span>}</td>
                  <td className="mono tm-ev">
                    {r.evidence ? (
                      href ? (
                        <a href={href} target="_blank" rel="noreferrer" title={r.evidence.detail}>
                          {r.evidence.file}
                          {r.evidence.line ? `:${r.evidence.line}` : ''}
                        </a>
                      ) : (
                        <span title={r.evidence.detail}>
                          {r.evidence.file}
                          {r.evidence.line ? `:${r.evidence.line}` : ''}
                        </span>
                      )
                    ) : (
                      '—'
                    )}
                    {r.usage > 1 && <span className="faint"> · {r.usage} files</span>}
                  </td>
                  <td>
                    <ConfidenceBadge level={n.confidence} compact />
                  </td>
                  <td>
                    <span className="tm-actions">
                      <button type="button" className="icon-btn" aria-label={`Show ${n.name} in the system map`} title="Show its connections in the system map" onClick={() => onFocus(n.id)}>
                        <Crosshair size={14} />
                      </button>
                      {onExplain && (
                        <button type="button" className="icon-btn" aria-label={`Explain ${n.name} in this project`} title="Explain in Technology Intelligence" onClick={() => onExplain(n.id)}>
                          <Sparkles size={14} />
                        </button>
                      )}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!shown.length && <p className="faint tm-empty">No technology matches.</p>}
      </div>
    </div>
  );
}
