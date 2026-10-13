import { Info, Lock, Settings2, ShieldCheck, Users } from 'lucide-react';
import { useState } from 'react';
import { ErrorNotice } from '../../components/ui.tsx';
import { api, type BenchmarkResponse, type InsightItem, type InsightsResponse, type MetricBenchmark, type Project, type ReviewedPattern, type StatCell } from '../../lib/api.ts';
import { useAsync } from '../../lib/hooks.ts';
import { ConsentDialog } from './ConsentDialog.tsx';
import { StateOfArchitectureDialog } from './StateOfArchitectureDialog.tsx';

/*
 * Collective Intelligence on the Architecture page. Two columns that never mix:
 *   THIS PROJECT     — computed from this repository's own analysis (repository evidence)
 *   COLLECTIVE DATA  — anonymized, k-anonymous statistics about other contributing projects
 */

/** A share for display; suppressed cells say so instead of showing a number. */
export const pct = (c: StatCell, minCell = 5) => (c.suppressed ? `fewer than ${minCell} projects` : `${Math.round((c.share ?? 0) * 100)}%`);

export function CollectiveBadge({ small = false }: { small?: boolean }) {
  return (
    <span className={`ci-badge${small ? ' is-small' : ''}`}>
      <Users size={small ? 11 : 13} aria-hidden="true" />
      Collective Intelligence
    </span>
  );
}

export function CollectivePanel({ project }: { project: Project }) {
  const [nonce, setNonce] = useState(0);
  const bench = useAsync(() => api.benchmark(project.id), [project.id, nonce]);
  const insights = useAsync(() => api.patternInsights(project.id), [project.id, nonce]);
  const [settings, setSettings] = useState(false);
  const [report, setReport] = useState(false);

  if (bench.error) return <div className="view-pad narrow"><ErrorNotice error={bench.error} onRetry={bench.reload} /></div>;
  if (!bench.data) return <div className="view-pad faint">Loading Collective Intelligence…</div>;
  const b = bench.data;
  const c = b.collective;

  return (
    <div className="ci">
      <header className="ci-head">
        <div>
          <CollectiveBadge />
          <h2>How this architecture compares</h2>
          <p className="small muted">
            Structural benchmarks against anonymized projects that chose to contribute. Only bucketed structure is ever shared — never code, paths or names — and statistics appear only for populations of at least {c.policy.minN} projects.
          </p>
        </div>
        <div className="ci-head-actions">
          <span className={`ci-consent ${b.consent.enabled ? 'is-on' : ''}`}>
            <ShieldCheck size={13} aria-hidden="true" />
            {project.isSample ? 'Sample project · does not contribute' : b.consent.enabled ? 'This project contributes' : 'This project does not contribute'}
          </span>
          {!project.isSample && (
            <button type="button" className="btn btn-sm" onClick={() => setSettings(true)}>
              <Settings2 size={14} /> Contribution settings
            </button>
          )}
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setReport(true)}>
            State of Architecture
          </button>
        </div>
      </header>

      <div className="ci-columns">
        <ThisProjectColumn b={b} insights={insights.data} />
        <section className="ci-collective" aria-labelledby="ci-collective-title">
          <div className="ci-col-head">
            <h3 id="ci-collective-title">
              <Users size={14} aria-hidden="true" /> Collective data
            </h3>
            <span className="small faint">anonymized · aggregate · observed</span>
          </div>
          {c.status === 'withheld' ? <Withheld b={b} /> : <Available b={b} />}
          {insights.data && c.status === 'available' && <Insights i={insights.data} />}
          {insights.data && c.status === 'withheld' && insights.data.collective.reviewedPatterns.length > 0 && <Patterns list={insights.data.collective.reviewedPatterns} />}
          <footer className="ci-privacy small">
            <Lock size={12} aria-hidden="true" />
            <span>
              {c.privacy} {c.note}
            </span>
          </footer>
        </section>
      </div>

      {settings && (
        <ConsentDialog
          project={project}
          onClose={() => setSettings(false)}
          onChanged={() => setNonce((n) => n + 1)}
        />
      )}
      {report && <StateOfArchitectureDialog onClose={() => setReport(false)} />}
    </div>
  );
}

function ThisProjectColumn({ b, insights }: { b: BenchmarkResponse; insights?: InsightsResponse | null }) {
  return (
    <section className="ci-this" aria-labelledby="ci-this-title">
      <div className="ci-col-head">
        <h3 id="ci-this-title">This project</h3>
        <span className="small faint">from this repository’s analysis</span>
      </div>
      <p className="small muted">
        {b.thisProject.source} Snapshot {b.snapshot.branch}
        {b.snapshot.commitSha ? ` @ ${b.snapshot.commitSha.slice(0, 7)}` : ''}. Pattern: <strong>{b.thisProject.pattern}</strong> · size band: <strong>{b.thisProject.sizeBand}</strong>.
      </p>
      <dl className="ci-this-metrics">
        {b.thisProject.metrics.map((m) => (
          <div key={m.metric} title={m.definition}>
            <dt>{m.label}</dt>
            <dd>
              <span className="mono">{m.value}</span>
              <span className="ci-bucket mono">range {m.bucket}</span>
            </dd>
          </div>
        ))}
      </dl>
      {insights && insights.thisProject.traits.length > 0 && (
        <>
          <h4 className="ci-sub">Structural traits detected here</h4>
          <ul className="ci-traits">
            {insights.thisProject.traits.map((t) => (
              <li key={t.trait}>{t.label}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function Withheld({ b }: { b: BenchmarkResponse }) {
  const c = b.collective;
  return (
    <div className="ci-withheld">
      <p>
        <strong>Not enough contributing projects yet.</strong> Collective statistics are shown only when at least {c.policy.minN} projects match. Nothing is estimated or filled in until then.
      </p>
      <ul className="ci-considered">
        {c.considered.map((p) => (
          <li key={p.key}>
            <span>{p.definition}</span>
            <span className="mono">
              {p.n} of {c.policy.minN} needed
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Available({ b }: { b: BenchmarkResponse }) {
  const c = b.collective;
  const p = c.population!;
  return (
    <>
      <div className="ci-population">
        <p className="ci-n">
          Benchmarked against <strong className="mono">{p.n}</strong> similar projects
        </p>
        <p className="small muted">
          Population: {p.definition} {c.computedMonth ? `Aggregates computed ${c.computedMonth}.` : ''}
        </p>
      </div>
      <div className="ci-metrics">
        {c.metrics.map((m) => (
          <MetricCard key={m.metric} m={m} minCell={c.policy.minCell} />
        ))}
      </div>
    </>
  );
}

function MetricCard({ m, minCell }: { m: MetricBenchmark; minCell: number }) {
  const max = Math.max(...m.distribution.map((d) => d.share ?? 0), 0.01);
  const pos = m.position;
  // Empty ranges at either end carry no information; trim them (never this project's range).
  const keep = (d: MetricBenchmark['distribution'][number]) => d.isThisProject || d.suppressed || (d.count ?? 0) > 0;
  const first = m.distribution.findIndex(keep);
  const last = m.distribution.length - 1 - [...m.distribution].reverse().findIndex(keep);
  const shown = m.distribution.slice(Math.max(0, first), last + 1);
  return (
    <article className="ci-card">
      <header>
        <h4>{m.label}</h4>
        <span className="ci-nchip mono" title="Sample size">
          N = {m.n}
        </span>
      </header>
      <p className="small faint">
        {m.definition}
        {shown.length < m.distribution.length ? ' Empty ranges at the ends are not drawn.' : ''}
      </p>
      <ol className="ci-dist" aria-label={`${m.label} distribution across ${m.n} projects`}>
        {shown.map((d) => (
          <li key={d.bucket} className={`${d.isThisProject ? 'is-this' : ''}${d.suppressed ? ' is-suppressed' : ''}`}>
            <span className="ci-dist-bar" style={{ height: `${d.suppressed ? 12 : Math.max(2, ((d.share ?? 0) / max) * 100)}%` }} />
            <span className="ci-dist-label mono">{d.bucket}</span>
            <span className="ci-dist-val mono">{d.suppressed ? `<${minCell}` : pct(d)}</span>
          </li>
        ))}
      </ol>
      <p className="small">
        <span className="ci-this-marker" aria-hidden="true" /> This project’s range is <span className="mono">{m.thisProject.bucket}</span>. Of the similar projects, {pct(pos.lower, minCell)} are in a lower range, {pct(pos.same, minCell)} the same, {pct(pos.higher, minCell)} higher.
      </p>
    </article>
  );
}

function Tag({ kind }: { kind: 'observed' | 'correlated' | 'pattern' | 'causal' }) {
  const text = { observed: 'Observed', correlated: 'Correlated · self-reported', pattern: 'Statistical pattern', causal: 'Reviewed causal finding' }[kind];
  return <span className={`ci-tag t-${kind}`}>{text}</span>;
}

function InsightRow({ item }: { item: InsightItem }) {
  return (
    <li>
      <Tag kind={item.kind} />
      <span>{item.statement}</span>
      <span className="ci-nchip mono">N = {item.n}</span>
    </li>
  );
}

function Insights({ i }: { i: InsightsResponse }) {
  const c = i.collective;
  return (
    <>
      {c.prevalence.length > 0 && (
        <section className="ci-insights">
          <h4 className="ci-sub">How common this project’s traits are</h4>
          <ul>
            {c.prevalence.map((p) => (
              <InsightRow key={p.trait} item={p} />
            ))}
          </ul>
        </section>
      )}
      <section className="ci-insights">
        <h4 className="ci-sub">Reported incidents</h4>
        {c.outcomes.status === 'available' ? (
          <ul>
            {c.outcomes.items.map((p) => (
              <InsightRow key={p.element} item={p} />
            ))}
          </ul>
        ) : (
          <p className="small faint">
            <Info size={12} /> Too few contributing projects in this population report incidents to show anything. Incident shares appear once at least {c.policy.minCell} of them do.
          </p>
        )}
      </section>
      {c.reviewedPatterns.length > 0 && <Patterns list={c.reviewedPatterns} />}
    </>
  );
}

function Patterns({ list }: { list: ReviewedPattern[] }) {
  return (
    <section className="ci-insights">
      <h4 className="ci-sub">Reviewed statistical patterns that match this project</h4>
      <ul>
        {list.map((p) => (
          <li key={p.id}>
            <Tag kind={p.claim === 'causal' ? 'causal' : 'pattern'} />
            <span>
              {p.statement} <span className="faint small">Lift {p.lift.toFixed(2)} · χ² {p.chi2.toFixed(1)} · {p.claim === 'causal' ? `Reviewed: ${p.reviewNote}` : 'Correlation, not causation.'}</span>
            </span>
            <span className="ci-nchip mono">N = {p.n}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
