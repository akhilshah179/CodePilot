import { TYPE_LABELS } from '@codepilot/analyzer/shapes';
import { useMemo, useState } from 'react';
import { ShapeIcon } from '../../components/ui.tsx';
import type { GraphModel, Visibility } from '../../graph/model.ts';
import type { GraphNode } from '../../lib/api.ts';
import { useDebounced } from '../../lib/hooks.ts';

interface Props {
  model: GraphModel;
  vis: Visibility;
  selected: number | null;
  onSelect(index: number): void;
  /** Classification evidence per node id (from the graph response). */
  evidence?: Map<string, GraphNode['classification_evidence']>;
}

/**
 * Table representation of the dependency graph: the fallback on small screens and the
 * accessible alternative to the canvas. Rows come from the same edges the graph draws.
 */
export function ListView({ model, vis, selected, onSelect, evidence }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const q = useDebounced(query.trim().toLowerCase(), 120);
  const rows = useMemo(
    () =>
      model.nodes
        .map((n, i) => ({ n, i }))
        .filter(({ n, i }) => vis.nodes[i] && (!q || n.path.toLowerCase().includes(q)))
        .sort((a, b) => a.n.path.localeCompare(b.n.path)),
    [model, vis, q],
  );
  const shown = rows.slice(0, 400);

  return (
    <div className="list-view">
      <div className="list-toolbar">
        <input className="input" type="search" placeholder="Filter files…" aria-label="Filter files" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="faint small" aria-live="polite">
          {rows.length.toLocaleString()} files{rows.length > shown.length ? ` · showing first ${shown.length}` : ''}
        </span>
      </div>
      <div className="table-scroll">
        <table className="node-table">
          <caption className="visually-hidden">Files in the dependency graph with their type, connections and classification evidence</caption>
          <thead>
            <tr>
              <th scope="col">File</th>
              <th scope="col">Type</th>
              <th scope="col">Imports</th>
              <th scope="col">Imported by</th>
              <th scope="col">Evidence</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(({ n, i }) => {
              const deps = model.outPairs[i].filter((pi) => vis.pairs[pi]).map((pi) => model.pairs[pi]);
              const cons = model.inPairs[i].filter((pi) => vis.pairs[pi]).map((pi) => model.pairs[pi]);
              const ev = evidence?.get(n.id)?.[0];
              const expanded = open === i;
              return [
                <tr key={n.id} data-selected={selected === i || undefined}>
                  <th scope="row">
                    <button type="button" className="node-link" onClick={() => onSelect(i)} aria-label={`Select ${n.path}`}>
                      <ShapeIcon type={n.type} size={12} />
                      <span className="mono">{n.path}</span>
                    </button>
                  </th>
                  <td>{TYPE_LABELS[n.type]}</td>
                  <td>
                    <button type="button" className="count-btn dep-count mono" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : i)}>
                      {deps.length}
                    </button>
                  </td>
                  <td>
                    <button type="button" className="count-btn con-count mono" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : i)}>
                      {cons.length}
                    </button>
                  </td>
                  <td className="small muted">{ev ? `${ev.detail}${ev.line ? ` (line ${ev.line})` : ''}` : '—'}</td>
                </tr>,
                expanded && (
                  <tr key={n.id + ':detail'} className="row-detail">
                    <td colSpan={5}>
                      <div className="list-detail">
                        <h4>
                          <span className="swatch swatch-dep" /> Imports
                        </h4>
                        {deps.length ? (
                          <ul>
                            {deps.map((p) => (
                              <li key={p.t} className="mono">
                                {model.nodes[p.t].path} <span className="faint">L{p.edges.map((e) => model.edges[e].line).join(', L')}</span>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="faint small">None</p>
                        )}
                        <h4>
                          <span className="swatch swatch-con" /> Imported by
                        </h4>
                        {cons.length ? (
                          <ul>
                            {cons.map((p) => (
                              <li key={p.s} className="mono">
                                {model.nodes[p.s].path} <span className="faint">L{p.edges.map((e) => model.edges[e].line).join(', L')}</span>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="faint small">None</p>
                        )}
                      </div>
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
