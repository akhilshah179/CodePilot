import { Lock, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { ErrorNotice } from '../../components/ui.tsx';
import { api } from '../../lib/api.ts';
import { useAsync } from '../../lib/hooks.ts';
import { CollectiveBadge, pct } from './CollectivePanel.tsx';

/** The aggregate "State of Architecture" report — withheld entirely below the minimum population. */
export function StateOfArchitectureDialog({ onClose }: { onClose(): void }) {
  const res = useAsync(() => api.stateOfArchitecture(), []);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  const r = res.data;

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog ci-dialog glass" role="dialog" aria-modal="true" aria-labelledby="soa-title">
        <header>
          <h2 id="soa-title">State of Architecture</h2>
          <button ref={closeRef} className="tool-btn" aria-label="Close" onClick={onClose}>
            <X size={14} />
          </button>
        </header>
        <CollectiveBadge small />
        {res.error && <ErrorNotice error={res.error} onRetry={res.reload} />}
        {!r ? (
          <p className="faint">Loading…</p>
        ) : r.status === 'withheld' ? (
          <div className="ci-withheld">
            <p>
              <strong>Not published yet.</strong> {r.population.n} project{r.population.n === 1 ? '' : 's'} contribute today; the report is produced once at least {r.policy.minN} do, so no figure can describe a handful of projects.
            </p>
          </div>
        ) : (
          <>
            <p className="ci-n">
              Across <strong className="mono">{r.population.n}</strong> contributing projects {r.computedMonth ? <span className="small faint">· computed {r.computedMonth}</span> : null}
            </p>
            {r.sections.map((s) => (
              <section key={s.id} className="soa-section">
                <h3>{s.title}</h3>
                <ul>
                  {s.items.map((it) => (
                    <li key={it.trait}>
                      <span>{it.label}</span>
                      <span className="soa-bar" aria-hidden="true">
                        <span style={{ width: it.suppressed ? '2%' : `${Math.round((it.share ?? 0) * 100)}%` }} />
                      </span>
                      <span className="mono">{pct(it, r.policy.minCell)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {(r.metrics ?? []).map((m) => (
              <section key={m.metric} className="soa-section">
                <h3>
                  {m.label} <span className="ci-nchip mono">N = {m.n}</span>
                </h3>
                <p className="small faint">{m.definition}</p>
                <p className="mono small">{m.distribution.map((d) => `${d.bucket}: ${d.suppressed ? `<${r.policy.minCell}` : pct(d)}`).join(' · ')}</p>
              </section>
            ))}
          </>
        )}
        {r && (
          <p className="ci-privacy small">
            <Lock size={12} aria-hidden="true" />
            <span>
              {r.population.definition} {r.note}
            </span>
          </p>
        )}
      </div>
    </div>
  );
}
