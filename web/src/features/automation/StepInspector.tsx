import { ArrowDown, ArrowUp, Cpu, ExternalLink, Layers, Network, X } from 'lucide-react';
import { ConfidenceBadge, EvidenceItem } from '../../components/ui.tsx';
import { data, type DataSource, type Evidence, type Flow, type FlowStep } from '../../lib/api.ts';
import type { FileOpener } from '../../lib/fileLinks.ts';
import { useAsync } from '../../lib/hooks.ts';
import { STAGE_LABELS } from './flowGraph.ts';

interface Props {
  src: DataSource;
  flow: Flow;
  index: number;
  evidence: Record<string, Evidence>;
  opener: FileOpener;
  onClose(): void;
  onStep(i: number): void;
  onWireframe?(path: string): void;
  onArchitecture?(target: { flow?: string; focus?: string; tech?: string }): void;
  onIntelligence?(tech: string): void;
}

const MODE_TEXT: Record<FlowStep['mode'], string> = {
  sync: 'Synchronous — the caller waits for it',
  async: 'Asynchronous — does not block the user response',
  'cache-hit': 'Cache hit branch',
  'cache-miss': 'Cache miss branch',
  publish: 'Publishes to a queue — the caller continues',
  consume: 'Consumed by a worker in the background',
  unknown: 'Unknown — the code does not show how this is called',
};

/** Nothing here is filled in by guesswork: a field the code does not show reads “Not shown in code”. */
function Field({ label, value, mono = false }: { label: string; value?: string | null; mono?: boolean }) {
  return (
    <div className="si-field">
      <dt>{label}</dt>
      <dd className={value ? (mono ? 'mono' : '') : 'faint'}>{value || 'Not shown in code'}</dd>
    </div>
  );
}

/**
 * One step of a traced flow: where it lives, what calls it and what it calls, what goes in and
 * out, how it runs, and the repository evidence behind it — with links into every other view.
 */
export function StepInspector(p: Props) {
  const s = p.flow.steps[p.index];
  const prev = p.flow.steps[p.index - 1];
  const next = p.flow.steps[p.index + 1];
  const unknown = s.kind === 'unknown';
  const route = p.flow.trigger.kind === 'route' ? `${p.flow.trigger.method ?? ''} ${p.flow.trigger.path ?? ''}`.trim() : p.flow.trigger.name;
  const techName = s.tool ? p.flow.index?.technologies.find((t) => t.id === s.tool)?.name ?? s.tool : undefined;
  const isFile = !!s.file && !s.file.startsWith('ext:') && s.file.includes('.');
  // Blast radius: which files depend on this step's file (from the dependency graph of the same snapshot).
  const blast = useAsync(() => (isFile ? data.node(p.src, s.file) : Promise.resolve(null)), [p.src.base, s.file]);
  const dependents = blast.data ? [1, 2, 3].map((d) => blast.data!.transitive.dependents[d as 1 | 2 | 3]?.length ?? 0) : null;
  const href = p.opener.href(s.file, s.line);

  return (
    <aside className="si" aria-label={`Step ${p.index + 1}: ${s.label ?? s.node}`}>
      <header className="si-head">
        <div>
          <span className="eyebrow">
            Step {p.index + 1} of {p.flow.steps.length} · {s.stage ? STAGE_LABELS[s.stage] : s.lane}
          </span>
          <h3>{unknown ? 'UNKNOWN NEXT STEP' : s.label ?? s.node}</h3>
        </div>
        <button className="icon-btn" onClick={p.onClose} aria-label="Close step inspector">
          <X size={16} />
        </button>
      </header>

      <div className="si-body">
        <div className="si-badges">
          <ConfidenceBadge level={s.confidence ?? (unknown ? 'unknown' : 'confirmed')} />
          <span className={`tag si-mode m-${s.mode}`}>{s.branch === 'async' ? 'ASYNC · does not block' : s.mode}</span>
          {s.kind && <span className="tag">{s.kind}</span>}
        </div>

        <p className="si-explain">{s.explanation}</p>
        {unknown && <p className="si-warn small">Tracing stopped here: the code calls something whose target could not be resolved from the source. CodePilot does not guess the next hop.</p>}

        <dl className="si-grid">
          <Field label="File" value={s.file ? `${s.file}${s.line ? `:${s.line}` : ''}` : null} mono />
          <Field label="Function / component" value={s.fn} mono />
          <Field label="Route / API" value={s.kind === 'route' || s.kind === 'client' || s.kind === 'middleware' || s.kind === 'response' ? route : null} mono />
          <Field label="Technology" value={techName} />
          <Field label="Input" value={s.input} mono />
          <Field label="Output" value={s.output} mono />
          <Field label="Connection in" value={s.transport} mono />
          <Field label="Execution" value={MODE_TEXT[s.mode]} />
        </dl>

        <div className="si-nav">
          <button className="si-hop" disabled={!prev} onClick={() => p.onStep(p.index - 1)}>
            <ArrowUp size={13} />
            <span>
              <span className="faint small">Caller</span>
              <span>{prev ? prev.label ?? prev.node : 'Start of flow'}</span>
            </span>
          </button>
          <button className="si-hop" disabled={!next} onClick={() => p.onStep(p.index + 1)}>
            <ArrowDown size={13} />
            <span>
              <span className="faint small">Callee</span>
              <span>{next ? (next.kind === 'unknown' ? 'UNKNOWN NEXT STEP' : next.label ?? next.node) : 'End of flow'}</span>
            </span>
          </button>
        </div>

        <div className="si-links">
          {href && (
            <a className="btn btn-sm" href={href} target="_blank" rel="noreferrer">
              <ExternalLink size={13} /> {p.opener.label}
            </a>
          )}
          {isFile && p.onWireframe && (
            <button className="btn btn-sm" onClick={() => p.onWireframe!(s.file)}>
              <Network size={13} /> In wireframe
            </button>
          )}
          {p.onArchitecture && (
            <button className="btn btn-sm" onClick={() => p.onArchitecture!({ flow: p.flow.id })}>
              <Layers size={13} /> Request lifecycle
            </button>
          )}
          {s.tool && p.onIntelligence && (
            <button className="btn btn-sm" onClick={() => p.onIntelligence!(s.tool!)}>
              <Cpu size={13} /> Explain {techName}
            </button>
          )}
        </div>

        {isFile && (
          <section className="si-section">
            <h4>Blast radius</h4>
            {blast.error ? (
              <p className="small faint">Dependency data is not available for this file.</p>
            ) : !dependents ? (
              <p className="small faint">Loading…</p>
            ) : (
              <p className="small">
                Changing <span className="mono">{s.file.slice(s.file.lastIndexOf('/') + 1)}</span> directly affects <strong>{dependents[0]}</strong> file{dependents[0] === 1 ? '' : 's'}, <strong>{dependents[1]}</strong> more at two hops and <strong>{dependents[2]}</strong> at three.
                {p.onWireframe && (
                  <>
                    {' '}
                    <button className="link-btn" onClick={() => p.onWireframe!(s.file)}>
                      See dependents
                    </button>
                  </>
                )}
              </p>
            )}
          </section>
        )}

        <section className="si-section">
          <h4>Evidence</h4>
          {s.evidence.length ? (
            <ul className="ev-list">
              {s.evidence
                .map((id) => p.evidence[id])
                .filter(Boolean)
                .map((e) => (
                  <EvidenceItem key={e.id} ev={e} href={p.opener.href(e.file, e.line)} />
                ))}
            </ul>
          ) : (
            <p className="small faint">No separate evidence record; the step is located at the file and line above.</p>
          )}
        </section>
      </div>
    </aside>
  );
}
