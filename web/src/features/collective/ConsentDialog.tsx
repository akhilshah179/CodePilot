import { ChevronDown, Users, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ErrorNotice } from '../../components/ui.tsx';
import { api, type ApiError, type CollectiveSchema, type Project } from '../../lib/api.ts';
import { relativeTime } from '../../lib/format.ts';
import { useAsync } from '../../lib/hooks.ts';

/** Project setting: contribute anonymized structure to Collective Intelligence. Off unless switched on. */
export function ConsentDialog({ project, onClose, onChanged }: { project: Project; onClose(): void; onChanged?(): void }) {
  const status = useAsync(() => api.collectiveStatus(project.id), [project.id]);
  const [schema, setSchema] = useState<CollectiveSchema | null>(null);
  const [showSchema, setShowSchema] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  useEffect(() => {
    if (showSchema && !schema) api.collectiveSchema().then(setSchema, (e) => setError(e as ApiError));
  }, [showSchema, schema]);

  const s = status.data;
  const toggle = async () => {
    if (!s) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.setCollectiveConsent(project.id, !s.enabled);
      status.reload();
      const d = r.effect.deactivated as { fingerprints: number; outcomes: number } | undefined;
      setMessage(
        r.enabled
          ? r.effect.contributed
            ? 'Contribution is on. The anonymized fingerprint of the latest snapshot was added; future analyses update it.'
            : 'Contribution is on. A fingerprint will be added when this project has a completed analysis.'
          : `Contribution is off. ${d ? `${d.fingerprints} fingerprint${d.fingerprints === 1 ? '' : 's'} and ${d.outcomes} outcome${d.outcomes === 1 ? '' : 's'} were marked inactive and removed from every aggregate.` : ''} Nothing new will be extracted.`,
      );
      onChanged?.();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog ci-dialog glass" role="dialog" aria-modal="true" aria-labelledby="ci-consent-title">
        <header>
          <h2 id="ci-consent-title">
            <Users size={16} /> Collective Intelligence
          </h2>
          <button ref={closeRef} className="tool-btn" aria-label="Close" onClick={onClose}>
            <X size={14} />
          </button>
        </header>
        {error && <ErrorNotice error={error} />}
        {!s ? (
          <p className="faint">Loading…</p>
        ) : (
          <>
            <div className="ci-switch-row">
              <button type="button" role="switch" aria-checked={s.enabled} className={`ci-switch${s.enabled ? ' is-on' : ''}`} onClick={toggle} disabled={busy || !s.canChange} aria-labelledby="ci-switch-label">
                <span className="ci-switch-knob" />
                <span className="ci-switch-state mono">{s.enabled ? 'ON' : 'OFF'}</span>
              </button>
              <label id="ci-switch-label" className="ci-switch-label">
                Contribute anonymized patterns to Collective Intelligence
              </label>
            </div>
            {message && (
              <p className="ci-message small" role="status">
                {message}
              </p>
            )}

            <div className="ci-explain">
              <section>
                <h3>What is shared?</h3>
                <p>Only bucketed structure of the latest snapshot: size and type ranges, dependency topology (density, fan-out, fan-in, cycles), architecture layers and pattern, technology categories (database, cache… never product names), category-to-category relationships and structural risk codes — plus the month. Linked by a pseudonym, never by project, user or repository.</p>
              </section>
              <section>
                <h3>What is never shared?</h3>
                <p>Source code, file contents, file paths and names, repository and organization names, function, class or variable names, comments, commit messages or hashes, environment variables, secrets, IP addresses, exact file or line counts, and incident descriptions.</p>
              </section>
              <section>
                <h3>What do I get?</h3>
                <p>Benchmarks of this architecture against similar projects, how common its structural traits are, and reviewed statistical patterns — once enough projects contribute (at least {s.policy.minN} per population). Benchmarks are available whether or not you contribute.</p>
              </section>
              <section>
                <h3>Can I revoke this?</h3>
                <p>Any time. Switching off stops extraction immediately. {s.retention}</p>
              </section>
            </div>

            <button type="button" className="link-btn ci-schema-toggle" aria-expanded={showSchema} onClick={() => setShowSchema((v) => !v)}>
              <ChevronDown size={13} className={showSchema ? 'is-open' : ''} /> Complete schema and privacy rules
            </button>
            {showSchema && schema && (
              <div className="ci-schema">
                <p className="small muted">
                  Schema version {schema.version}. Every field and value is enumerated; the server rejects any fingerprint containing anything else. Statistics require N ≥ {schema.policy.minN}; any cell under {schema.policy.minCell} projects is suppressed.
                </p>
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Field</th>
                      <th scope="col">Meaning</th>
                      <th scope="col">Allowed values</th>
                    </tr>
                  </thead>
                  <tbody>
                    {schema.fields.map((f) => (
                      <tr key={f.field}>
                        <td className="mono">{f.field}</td>
                        <td>{f.meaning}</td>
                        <td className="mono small">{f.values ? (f.values.length > 12 ? `${f.values.slice(0, 12).join(', ')} … (${f.values.length})` : f.values.join(', ')) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <h4>Never collected</h4>
                <ul>
                  {schema.never.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </div>
            )}

            {s.contributed.length > 0 && (
              <section className="ci-contributed">
                <h3>What this project has shared</h3>
                <ul>
                  {s.contributed.map((f, i) => (
                    <li key={i}>
                      <span className={`ci-state ${f.active ? (f.current ? 'is-current' : 'is-history') : 'is-inactive'}`}>{f.active ? (f.current ? 'counted' : 'superseded') : 'inactive'}</span>
                      <span className="mono">{f.month}</span>
                      <details>
                        <summary className="small">Exact stored fingerprint</summary>
                        <pre className="mono">{JSON.stringify(f.fingerprint, null, 2)}</pre>
                      </details>
                    </li>
                  ))}
                </ul>
                {s.outcomes.length > 0 && (
                  <p className="small muted">
                    Incident outcomes: {s.outcomes.map((o) => `${o.element} (${o.month}${o.active ? '' : ', inactive'})`).join(', ')}
                  </p>
                )}
              </section>
            )}

            {s.history.length > 0 && (
              <section className="ci-history">
                <h3>Consent history</h3>
                <ol>
                  {s.history.map((h, i) => (
                    <li key={i}>
                      <span className={`ci-state ${h.action === 'granted' ? 'is-current' : 'is-inactive'}`}>{h.action}</span>
                      <span className="small">
                        {h.by ?? 'A user'} · {relativeTime(h.at)} · schema v{h.schemaVersion}
                      </span>
                    </li>
                  ))}
                </ol>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
