import type { ReactNode } from 'react';
import { FILE_NODE_TYPES } from '@codepilot/analyzer/types';
import { TYPE_LABELS } from '@codepilot/analyzer/shapes';
import { ErrorNotice, ShapeIcon, Stat } from '../../components/ui.tsx';
import { api } from '../../lib/api.ts';
import { num, plural } from '../../lib/format.ts';
import { useAsync } from '../../lib/hooks.ts';

interface Props {
  projectId: string;
  onFocus(nodeId: string): void;
  onCycle(members: string[]): void;
}

function FileButton({ id, onFocus, suffix }: { id: string; onFocus(id: string): void; suffix?: ReactNode }) {
  return (
    <button className="file-row" onClick={() => onFocus(id)} title={`Show ${id} in the wireframe`}>
      <span className="mono path-text">{id}</span>
      {suffix}
    </button>
  );
}

export function SummaryView({ projectId, onFocus, onCycle }: Props) {
  const { data, error, reload } = useAsync(() => api.summary(projectId), [projectId]);
  if (error) return <div className="view-pad"><ErrorNotice error={error} onRetry={reload} /></div>;
  if (!data) return <div className="view-pad faint">Loading summary…</div>;
  const { summary: s, scan } = data;
  const maxType = Math.max(1, ...FILE_NODE_TYPES.map((t) => s.countsByType[t]));
  const excludedTotal = Object.values(scan.excluded).reduce((a, b) => a + b, 0);

  return (
    <div className="summary view-pad">
      <section className="stats" aria-label="Totals">
        <Stat label="Files in graph" value={num(s.totals.files)} hint={`${num(s.totals.analyzedFiles)} parsed for imports`} />
        <Stat label="File-to-file dependencies" value={num(s.totals.dependencies)} hint="resolved, unique pairs" />
        <Stat label="External packages" value={num(s.totals.externalPackages)} hint={`${num(s.totals.externalImports)} import statements`} />
        <Stat label="Unresolved imports" value={num(s.totals.unresolvedImports)} hint={s.totals.unresolvedImports ? 'shown, never guessed' : 'every import resolved'} />
        <Stat label="Circular chains" value={num(s.cycles.length)} />
        <Stat label="Orphan files" value={num(s.orphans.length)} />
      </section>

      <div className="summary-grid">
        <section className="panel">
          <h2>Files by type</h2>
          <ul className="type-bars">
            {FILE_NODE_TYPES.filter((t) => s.countsByType[t]).map((t) => (
              <li key={t}>
                <span className="type-name">
                  <ShapeIcon type={t} size={12} /> {TYPE_LABELS[t]}
                </span>
                <span className="bar" aria-hidden="true">
                  <span style={{ width: `${(s.countsByType[t] / maxType) * 100}%` }} />
                </span>
                <span className="mono">{s.countsByType[t]}</span>
              </li>
            ))}
          </ul>
          {data.frameworks.length > 0 && (
            <p className="small muted panel-foot">
              Frameworks declared in package.json: {data.frameworks.join(', ')}
            </p>
          )}
        </section>

        <section className="panel">
          <h2>Most depended-on</h2>
          <p className="panel-sub faint">Files imported by the most other files.</p>
          <ol className="ranked">
            {s.mostDependedOn.map((r) => (
              <li key={r.id}>
                <FileButton id={r.id} onFocus={onFocus} suffix={<span className="mono con-count">{r.count}</span>} />
              </li>
            ))}
            {!s.mostDependedOn.length && <li className="faint small">No file is imported by another file.</li>}
          </ol>
        </section>

        <section className="panel">
          <h2>Most dependencies</h2>
          <p className="panel-sub faint">Files that import the most other files.</p>
          <ol className="ranked">
            {s.mostDependencies.map((r) => (
              <li key={r.id}>
                <FileButton id={r.id} onFocus={onFocus} suffix={<span className="mono dep-count">{r.count}</span>} />
              </li>
            ))}
            {!s.mostDependencies.length && <li className="faint small">No file imports another file.</li>}
          </ol>
        </section>

        <section className="panel">
          <h2>Circular dependencies</h2>
          <p className="panel-sub faint">Each chain is one real loop of imports, with the line of every hop.</p>
          {s.cycles.length === 0 ? (
            <p className="small muted">No circular imports found.</p>
          ) : (
            <ul className="cycles">
              {s.cycles.map((c, i) => (
                <li key={i}>
                  <button className="cycle" onClick={() => onCycle(c.members)}>
                    <span className="cycle-head">
                      <span className="tag tag-risk">{plural(c.members.length, 'file')}</span>
                      {c.typeOnly && <span className="tag">type-only</span>}
                    </span>
                    <span className="chain mono">
                      {c.chain.map((hop, k) => (
                        <span key={k}>
                          {hop.source}
                          <span className="faint">:{hop.line}</span>
                          <span className="dep-arrow"> → </span>
                        </span>
                      ))}
                      {c.chain[0]?.source}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <h2>Entry points</h2>
          <p className="panel-sub faint">Where execution starts, with the evidence that says so.</p>
          <ul className="ranked">
            {s.entryPoints.map((e) => (
              <li key={e.id}>
                <FileButton id={e.id} onFocus={onFocus} />
                <span className="faint small reasons">{e.reasons.join(' · ')}</span>
              </li>
            ))}
            {!s.entryPoints.length && <li className="faint small">No entry point could be identified from manifests, HTML or framework conventions.</li>}
          </ul>
        </section>

        <section className="panel">
          <h2>Orphan files</h2>
          <p className="panel-sub faint">Parsed source files that nothing imports and that are not entry points.</p>
          <ul className="ranked">
            {s.orphans.map((o) => (
              <li key={o.id}>
                <FileButton id={o.id} onFocus={onFocus} suffix={o.hasDependencies ? <span className="faint small">imports others</span> : <span className="faint small">isolated</span>} />
              </li>
            ))}
            {!s.orphans.length && <li className="faint small">Every parsed file is reachable.</li>}
          </ul>
        </section>

        {data.unresolved.total > 0 && (
          <section className="panel panel-wide">
            <h2>Unresolved imports</h2>
            <p className="panel-sub faint">These imports could not be matched to a file. CodePilot shows them instead of guessing.</p>
            <ul className="unresolved-list">
              {data.unresolved.items.map((u, i) => (
                <li key={i}>
                  <button className="file-row" onClick={() => onFocus(u.source)}>
                    <span className="mono path-text">
                      {u.source}
                      <span className="faint">:{u.line}</span>
                    </span>
                    <code className="spec">'{u.specifier}'</code>
                  </button>
                  <span className="small muted">{u.reason}</span>
                </li>
              ))}
            </ul>
            {data.unresolved.total > data.unresolved.items.length && <p className="faint small">Showing {data.unresolved.items.length} of {num(data.unresolved.total)}.</p>}
          </section>
        )}

        <section className="panel panel-wide">
          <h2>Scan scope</h2>
          <p className="small muted">
            {num(scan.filesScanned)} files scanned. {num(excludedTotal)} paths excluded
            {excludedTotal ? ': ' : '.'}
            {Object.entries(scan.excluded)
              .filter(([, c]) => c)
              .map(([reason, c]) => `${c} ${reason.replace(/-/g, ' ')}`)
              .join(', ')}
            {scan.excludedDirectories.length ? ` (${scan.excludedDirectories.join(', ')})` : ''}.
          </p>
          {data.warnings.length > 0 && (
            <ul className="warnings">
              {data.warnings.map((w) => (
                <li key={w} className="small muted">
                  {w}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
