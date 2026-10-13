import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { useState } from 'react';
import { ConfidenceBadge, ErrorNotice, EvidenceItem } from '../../components/ui.tsx';
import { data, type DataSource } from '../../lib/api.ts';
import type { FileOpener } from '../../lib/fileLinks.ts';
import { useAsync } from '../../lib/hooks.ts';

/** Architecture summary: pattern, strengths and risks — each one with the evidence behind it. */
export function ArchSummaryPanel({ src, opener, onFocus, onClose }: { src: DataSource; opener: FileOpener; onFocus(ids: string[]): void; onClose(): void }) {
  const { data: d, error, reload } = useAsync(() => data.archSummary(src), [src.base]);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <aside className="float-panel arch-summary glass" aria-label="Architecture summary">
      <header>
        <h2>Summary</h2>
        <button className="tool-btn" aria-label="Close summary" onClick={onClose}>
          <X size={14} />
        </button>
      </header>
      {error && <ErrorNotice error={error} onRetry={reload} />}
      {!d && !error && <p className="faint small">Loading…</p>}
      {d && (
        <>
          <section>
            <h3>Pattern</h3>
            {d.summary.patterns.length ? (
              <ul className="finding-list">
                {d.summary.patterns.map((p) => (
                  <li key={p.name}>
                    <div className="finding-head">
                      <strong className="pattern-name">{p.name}</strong>
                      <ConfidenceBadge level={p.confidence} compact />
                    </div>
                    <p className="small muted">{p.reason}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="faint small">No architecture pattern is supported by the evidence.</p>
            )}
          </section>
          {(['risks', 'strengths'] as const).map((kind) => (
            <section key={kind}>
              <h3>
                {kind === 'risks' ? 'Risks' : 'Strengths'} <span className="count">{d.summary[kind].length}</span>
              </h3>
              {d.summary[kind].length === 0 && <p className="faint small">{kind === 'risks' ? 'No evidence-backed risks found.' : 'None reported.'}</p>}
              <ul className="finding-list">
                {d.summary[kind].map((f) => (
                  <li key={f.id} className={kind === 'risks' ? `sev-${f.severity ?? 'info'}` : 'is-strength'}>
                    <button className="finding-head as-button" aria-expanded={open === f.id} onClick={() => setOpen(open === f.id ? null : f.id)}>
                      {kind === 'risks' ? <AlertTriangle size={13} /> : <CheckCircle2 size={13} />}
                      <strong>{f.title}</strong>
                      <ConfidenceBadge level={f.confidence} compact />
                    </button>
                    <p className="small muted">{f.detail}</p>
                    {open === f.id && (
                      <>
                        {f.nodes.length > 0 && (
                          <button className="btn btn-sm" onClick={() => onFocus(f.nodes)}>
                            Show on diagram
                          </button>
                        )}
                        <ul className="ev-list">
                          {f.evidence.map((id) => d.evidence[id] && <EvidenceItem key={id} ev={d.evidence[id]} href={opener.href(d.evidence[id].file, d.evidence[id].line)} />)}
                        </ul>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {d.summary.limitations.length > 0 && (
            <section>
              <h3>
                <Info size={12} /> What could not be determined
              </h3>
              <ul className="limit-list">
                {d.summary.limitations.map((l) => (
                  <li key={l} className="small muted">
                    {l}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </aside>
  );
}
