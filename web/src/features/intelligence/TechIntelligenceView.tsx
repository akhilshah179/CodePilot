import { ArrowDownLeft, ArrowUpRight, CircleDot, Cpu, ExternalLink, Layers, Play, Search, X } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ConfidenceBadge, ErrorNotice, EvidenceItem } from '../../components/ui.tsx';
import { data, type DataSource, type IntelConfidence, type Project, type TechIntel } from '../../lib/api.ts';
import { fileOpener } from '../../lib/fileLinks.ts';
import { basename } from '../../lib/format.ts';
import { useAsync, useMediaQuery, usePrefersReducedMotion } from '../../lib/hooks.ts';
import { CategoryIcon } from '../architecture/CategoryIcon.tsx';
import { FocusedGraph } from './FocusedGraph.tsx';

interface Props {
  src: DataSource;
  project: Project;
  focusTech?: string;
  onWireframe?(path: string): void;
  onArchitecture?(target: { tech?: string; flow?: string }): void;
  /** Open the Automation Engine on one flow, or on every flow matching a query. */
  onAutomation?(target: { flow?: string; q?: string }): void;
}

const CATEGORY_LABEL: Record<string, string> = {
  frontend: 'Frontend',
  framework: 'Framework',
  runtime: 'Runtime',
  database: 'Database',
  cache: 'Cache',
  search: 'Search',
  storage: 'Storage',
  queue: 'Queue',
  worker: 'Worker',
  orm: 'ORM',
  auth: 'Auth',
  payments: 'Payments',
  email: 'Email',
  messaging: 'Messaging',
  ai: 'AI',
  observability: 'Observability',
  'http-client': 'HTTP client',
  api: 'API',
  cloud: 'Cloud',
  container: 'Container',
  orchestration: 'Orchestration',
  iac: 'Infrastructure as code',
  ci: 'CI/CD',
  hosting: 'Hosting',
  proxy: 'Gateway / proxy',
  realtime: 'Realtime',
  analytics: 'Analytics',
  service: 'External service',
  application: 'Application',
  library: 'Library',
};

const CONF_RANK: Record<IntelConfidence, number> = { confirmed: 0, strong: 1, possible: 2, unknown: 3 };
const CONF_MEANING: Record<IntelConfidence, string> = {
  confirmed: 'Directly supported by code.',
  strong: 'Strongly supported by several pieces of evidence.',
  possible: 'Reasonable, but not sufficiently proven.',
  unknown: 'Insufficient evidence to say.',
};

/** First sentence of a statement, for the matrix. */
const lead = (text: string) => {
  // A sentence ends at "." or ";" followed by a capitalised word (not "e.g." or a file extension).
  const m = /^(.+?(?<!\be\.g|\bi\.e)[.;])(?=\s+[A-Z(]|$)/.exec(text);
  return (m ? m[1] : text).replace(/;$/, '.');
};

/**
 * Technology Intelligence: every technology in the repository explained from its evidence — what
 * it does here, why the code shows it is used, where, through which components, routes and flows.
 */
export function TechIntelligenceView({ src, project, focusTech, onWireframe, onArchitecture, onAutomation }: Props) {
  const res = useAsync(() => data.intelligence(src), [src.base]);
  const [selected, setSelected] = useState<string | null>(focusTech ?? null);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<'all' | 'catalog' | 'library'>('all');
  const [category, setCategory] = useState<string | null>(null);
  const small = useMediaQuery('(max-width: 900px)');
  const opener = fileOpener(project, res.data?.snapshot.commitSha ?? null);
  const techs = useMemo(() => res.data?.technologies ?? [], [res.data]);

  useEffect(() => {
    if (focusTech && techs.some((t) => t.id === focusTech)) setSelected(focusTech);
  }, [focusTech, techs]);

  const categories = useMemo(() => [...new Set(techs.map((t) => CATEGORY_LABEL[t.category] ?? t.category))].sort(), [techs]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return techs
      .filter((t) => (scope === 'all' ? true : scope === 'library' ? t.kind === 'library' : t.kind !== 'library'))
      .filter((t) => !category || (CATEGORY_LABEL[t.category] ?? t.category) === category)
      .filter((t) => !q || `${t.name} ${t.category} ${t.role.text} ${t.usedBy.join(' ')} ${t.files.map((f) => f.path).join(' ')}`.toLowerCase().includes(q))
      .sort((a, b) => (a.kind === 'library' ? 1 : 0) - (b.kind === 'library' ? 1 : 0) || CONF_RANK[a.why.confidence] - CONF_RANK[b.why.confidence] || a.name.localeCompare(b.name));
  }, [techs, query, scope, category]);

  if (res.error) {
    const unavailable = res.error.body.code === 'architecture_unavailable';
    return (
      <div className="view-pad narrow">
        <ErrorNotice error={unavailable ? { message: res.error.body.message } : res.error} onRetry={unavailable ? undefined : res.reload} />
      </div>
    );
  }
  if (!res.data) return <div className="view-pad faint">Loading technology intelligence…</div>;

  const snap = res.data.snapshot;
  const current = selected ? techs.find((t) => t.id === selected) : undefined;
  const counts = { confirmed: 0, strong: 0, possible: 0, unknown: 0 } as Record<IntelConfidence, number>;
  for (const t of techs) counts[t.why.confidence]++;

  return (
    <div className={`intel${current ? ' with-inspector' : ''}`}>
      <div className="intel-main">
        <header className="intel-head">
          <div>
            <h2>Technology Intelligence</h2>
            <p className="small muted">
              {techs.length} technologies explained from this repository’s code ·{' '}
              <span className="mono">
                {snap.commitSha ? `commit ${snap.commitSha.slice(0, 7)}` : 'analysis snapshot'} · generated {new Date(snap.generatedAt).toLocaleString()}
              </span>
            </p>
          </div>
          <dl className="intel-counts" aria-label="Purpose confidence">
            {(['confirmed', 'strong', 'possible', 'unknown'] as const).map((c) => (
              <div key={c} title={CONF_MEANING[c]}>
                <dt>
                  <ConfidenceBadge level={c} compact />
                </dt>
                <dd className="mono">{counts[c]}</dd>
              </div>
            ))}
          </dl>
        </header>
        <p className="intel-rule faint small">
          Each explanation is built only from evidence in this snapshot — manifests, imports, clients, calls, routes, request flows and configuration. When the code does not prove why a technology is used,
          it says so. Explanations are regenerated whenever the repository is re-analyzed.
        </p>

        <div className="tm-toolbar intel-toolbar">
          <label className="tm-search">
            <Search size={14} aria-hidden="true" />
            <input type="search" placeholder="Filter by name, role, component or file…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter technologies" />
          </label>
          <div className="segmented" role="group" aria-label="Scope">
            {(
              [
                ['all', 'All'],
                ['catalog', 'Technologies'],
                ['library', 'Libraries'],
              ] as const
            ).map(([k, label]) => (
              <button key={k} type="button" aria-pressed={scope === k} onClick={() => setScope(k)}>
                {label}
              </button>
            ))}
          </div>
          <div className="tm-cats" role="group" aria-label="Category">
            {categories.map((c) => (
              <button key={c} type="button" aria-pressed={category === c} onClick={() => setCategory(category === c ? null : c)}>
                {c}
              </button>
            ))}
          </div>
        </div>

        <div className="tm-scroll intel-scroll">
          <table className="tm-table intel-table">
            <thead>
              <tr>
                <th scope="col">Technology</th>
                <th scope="col">Category</th>
                <th scope="col">Version</th>
                <th scope="col">Role in this project</th>
                <th scope="col">Used by</th>
                <th scope="col" title="How well the code proves why it is used">
                  Confidence
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => (
                <tr key={t.id} className={t.id === selected ? 'is-highlight' : undefined} onClick={() => setSelected(t.id === selected ? null : t.id)}>
                  <th scope="row">
                    <button type="button" className="tm-name link-btn" aria-pressed={t.id === selected} onClick={(e) => (e.stopPropagation(), setSelected(t.id === selected ? null : t.id))}>
                      <span className="tm-icon">{t.kind === 'library' ? <Cpu size={13} /> : <CategoryIcon category={t.category as Exclude<TechIntel['category'], 'library'>} size={14} />}</span>
                      {t.name}
                    </button>
                  </th>
                  <td className="faint">{CATEGORY_LABEL[t.category] ?? t.category}</td>
                  <td className="mono">{t.version ?? <span className="faint">—</span>}</td>
                  <td className="tm-role">{lead(t.role.text)}</td>
                  <td>{t.usedBy.length ? t.usedBy.slice(0, 3).join(', ') + (t.usedBy.length > 3 ? ` +${t.usedBy.length - 3}` : '') : <span className="faint">—</span>}</td>
                  <td>
                    <ConfidenceBadge level={t.why.confidence} compact />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!shown.length && <p className="faint tm-empty">No technology matches.</p>}
        </div>
      </div>

      {current && (
        <TechInspector
          key={current.id}
          tech={current}
          evidence={res.data.evidence}
          opener={opener}
          small={small}
          onClose={() => setSelected(null)}
          onWireframe={onWireframe}
          onArchitecture={onArchitecture}
          onAutomation={onAutomation}
        />
      )}
    </div>
  );
}

function TechInspector({
  tech: t,
  evidence,
  opener,
  onClose,
  onWireframe,
  onArchitecture,
  onAutomation,
}: {
  tech: TechIntel;
  evidence: Record<string, import('../../lib/api.ts').Evidence>;
  opener: ReturnType<typeof fileOpener>;
  small: boolean;
  onClose(): void;
  onWireframe?(path: string): void;
  onArchitecture?(target: { tech?: string; flow?: string }): void;
  onAutomation?(target: { flow?: string; q?: string }): void;
}) {
  const reduced = usePrefersReducedMotion();
  const bodyRef = useRef<HTMLDivElement>(null);
  const ev = (ids: string[]) => ids.map((id) => evidence[id]).filter(Boolean);
  const cite = (ids: string[]) => {
    const list = ev(ids);
    if (!list.length) return null;
    return (
      <p className="intel-cite mono">
        {list.slice(0, 4).map((e, i) => {
          const href = opener.href(e.file, e.line);
          const text = `${basename(e.file)}${e.line ? `:${e.line}` : ''}`;
          return (
            <span key={e.id}>
              {i > 0 && ' · '}
              {href ? (
                <a href={href} target="_blank" rel="noreferrer" title={`${e.detail} — ${e.file}${e.line ? `:${e.line}` : ''}`}>
                  {text}
                </a>
              ) : (
                <span title={e.detail}>{text}</span>
              )}
            </span>
          );
        })}
      </p>
    );
  };
  const inMap = t.system.length > 0 && t.kind !== 'library';

  return (
    <motion.aside
      className="inspector intel-inspector glass"
      initial={reduced ? false : { opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      aria-label={`${t.name} in this project`}
    >
      <header className="si-head">
        <div>
          <p className="eyebrow">
            {CATEGORY_LABEL[t.category] ?? t.category}
            {t.version ? ` · ${t.version}` : ''}
          </p>
          <h2 className="si-name">{t.name}</h2>
        </div>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
          <X size={15} />
        </button>
      </header>

      <div className="si-body" ref={bodyRef}>
        <div className="si-actions">
          {inMap && onArchitecture && (
            <button type="button" className="btn btn-sm" onClick={() => onArchitecture({ tech: t.id })}>
              <Layers size={13} /> Show on system map
            </button>
          )}
          {t.files[0] && onWireframe && (
            <button type="button" className="btn btn-sm" onClick={() => onWireframe(t.files[0].path)}>
              <CircleDot size={13} /> Show in Wireframe
            </button>
          )}
        </div>

        <section className="intel-sec">
          <h3>1 · Overview</h3>
          {t.general ? (
            <p>
              {t.general} <span className="faint small">(general description — not specific to this project)</span>
            </p>
          ) : (
            <p className="faint">{t.kind === 'library' ? 'A dependency outside CodePilot’s technology catalog; it is described only by how this code uses it.' : 'No general description available.'}</p>
          )}
        </section>

        <section className="intel-sec">
          <h3>
            2 · What it does in this project <ConfidenceBadge level={t.role.confidence} compact />
          </h3>
          <p>{t.role.text}</p>
          {cite(t.role.evidence)}
          {t.operations.length > 0 && (
            <ul className="intel-ops">
              {t.operations.map((o) => (
                <li key={o.op}>
                  <span className="mono">{o.count}×</span> {o.label}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="intel-sec">
          <h3>
            3 · Why it is used here <ConfidenceBadge level={t.why.confidence} compact />
          </h3>
          <p>{t.why.text}</p>
          {cite(t.why.evidence)}
        </section>

        <section className="intel-sec">
          <h3>4 · Where it is used</h3>
          {t.usedBy.length > 0 && (
            <p className="small">
              <span className="faint">Used by </span>
              {t.usedBy.join(', ')}
            </p>
          )}
          {t.functions.length > 0 && (
            <>
              <h4>Functions</h4>
              <ul className="intel-list">
                {t.functions.map((f) => {
                  const href = opener.href(f.file, f.line);
                  return (
                    <li key={`${f.file}#${f.name}#${f.line}`}>
                      <span className="mono intel-fn">{f.name === '(module scope)' ? f.name : `${f.name}()`}</span>
                      <span className="faint small mono">{f.calls.slice(0, 3).join(', ')}</span>
                      {href ? (
                        <a className="mono small" href={href} target="_blank" rel="noreferrer">
                          {basename(f.file)}:{f.line}
                        </a>
                      ) : (
                        <span className="mono small">
                          {basename(f.file)}:{f.line}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {t.files.length > 0 && (
            <>
              <h4>Files · {t.files.length}</h4>
              <ul className="intel-files">
                {t.files.slice(0, 20).map((f) => {
                  const href = opener.href(f.path, f.lines[0]);
                  return (
                    <li key={f.path}>
                      {href ? (
                        <a className="mono" href={href} target="_blank" rel="noreferrer" title={opener.label}>
                          {f.path}
                          {f.lines.length ? `:${f.lines.slice(0, 3).join(',')}` : ''} <ExternalLink size={10} />
                        </a>
                      ) : (
                        <span className="mono">{f.path}</span>
                      )}
                      <span className="faint small intel-uses">{[...new Set(f.uses)].join(' · ')}</span>
                      {onWireframe && (
                        <button type="button" className="icon-btn" aria-label={`Show ${f.path} in the Wireframe`} title="Show in Wireframe" onClick={() => onWireframe(f.path)}>
                          <CircleDot size={12} />
                        </button>
                      )}
                    </li>
                  );
                })}
                {t.files.length > 20 && <li className="faint small">and {t.files.length - 20} more files</li>}
              </ul>
            </>
          )}
          {t.scripts.length > 0 && (
            <>
              <h4>Package scripts</h4>
              <ul className="intel-list">
                {t.scripts.map((sc) => (
                  <li key={`${sc.file}:${sc.name}`}>
                    <span className="mono">{sc.name}</span>
                    <span className="mono faint small">{sc.command}</span>
                    <span className="mono small">
                      {basename(sc.file)}:{sc.line}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {!t.files.length && !t.functions.length && !t.scripts.length && <p className="faint small">No file-level usage was found.</p>}
        </section>

        <section className="intel-sec">
          <h3>5 · Architecture connections</h3>
          <FocusedGraph graph={t.graph} />
          {t.connections.length > 0 ? (
            <ul className="si-conns">
              {t.connections.map((c) => (
                <li key={`${c.direction}-${c.id}`}>
                  <span className="si-conn as-row">
                    {c.direction === 'in' ? <ArrowDownLeft size={13} /> : <ArrowUpRight size={13} />}
                    <span className="si-conn-name">{c.name}</span>
                    <span className="si-conn-label mono">{c.labels.join(' · ')}</span>
                    <ConfidenceBadge level={c.confidence} compact />
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="faint small">No direct architecture connection was traced.</p>
          )}
        </section>

        <section className="intel-sec">
          <h3>6 · Request flows</h3>
          {t.flows.length ? (
            <ul className="intel-list">
              {t.flows.map((f) => (
                <li key={f.id}>
                  <button type="button" className="link-btn" onClick={() => (onAutomation ? onAutomation({ flow: f.id }) : onArchitecture?.({ flow: f.id }))} disabled={!onAutomation && !onArchitecture}>
                    <Play size={12} /> {f.title}
                  </button>
                </li>
              ))}
              {onAutomation && t.flows.length > 1 && (
                <li>
                  <button type="button" className="link-btn" onClick={() => onAutomation({ q: t.name })}>
                    All {t.flows.length} flows using {t.name} in the Automation Engine
                  </button>
                </li>
              )}
            </ul>
          ) : (
            <p className="faint small">No traced request flow reaches it.</p>
          )}
        </section>

        <section className="intel-sec">
          <h3>7 · Routes</h3>
          {t.routes.length ? (
            <ul className="si-routes">
              {t.routes.slice(0, 30).map((r) => {
                const href = opener.href(r.file, r.line);
                return (
                  <li key={`${r.method} ${r.path}`}>
                    <span className={`method mono m-${r.method.toLowerCase()}`}>{r.method}</span>
                    <span className="mono si-path">{r.path}</span>
                    <span className="tag">{r.via === 'framework' ? 'served' : 'reaches it'}</span>
                    {href ? (
                      <a className="mono faint small" href={href} target="_blank" rel="noreferrer">
                        {basename(r.file)}:{r.line}
                      </a>
                    ) : (
                      <span className="mono faint small">
                        {basename(r.file)}:{r.line}
                      </span>
                    )}
                  </li>
                );
              })}
              {t.routes.length > 30 && <li className="faint small">and {t.routes.length - 30} more routes</li>}
            </ul>
          ) : (
            <p className="faint small">No route is served by it or traced to it.</p>
          )}
        </section>

        <section className="intel-sec">
          <h3>8 · Evidence · {t.evidence.length}</h3>
          <ul className="ev-list">
            {ev(t.evidence)
              .slice(0, 12)
              .map((e) => (
                <EvidenceItem key={e.id} ev={e} href={opener.href(e.file, e.line)} />
              ))}
          </ul>
          {t.evidence.length > 12 && <p className="faint small">and {t.evidence.length - 12} more evidence lines</p>}
        </section>

        <section className="intel-sec">
          <h3>9 · Confidence</h3>
          <dl className="intel-conf">
            <div>
              <dt>Detected</dt>
              <dd>
                <ConfidenceBadge level={t.confidence} /> <span className="faint small">{CONF_MEANING[t.confidence]}</span>
              </dd>
            </div>
            <div>
              <dt>What it does here</dt>
              <dd>
                <ConfidenceBadge level={t.role.confidence} /> <span className="faint small">{CONF_MEANING[t.role.confidence]}</span>
              </dd>
            </div>
            <div>
              <dt>Why it is used</dt>
              <dd>
                <ConfidenceBadge level={t.why.confidence} /> <span className="faint small">{CONF_MEANING[t.why.confidence]}</span>
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </motion.aside>
  );
}
