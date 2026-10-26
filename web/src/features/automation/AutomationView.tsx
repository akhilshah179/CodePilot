import { AlertTriangle, ArrowLeftRight, Check, ChevronDown, Info, Pencil, RefreshCw, Workflow, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ErrorNotice } from '../../components/ui.tsx';
import { api, data, type ApiError, type AutomationCoverage, type AutomationFlow, type AutomationResponse, type DataSource, type Project } from '../../lib/api.ts';
import { fileOpener } from '../../lib/fileLinks.ts';
import { useAsync, useMediaQuery, usePrefersReducedMotion } from '../../lib/hooks.ts';
import { Explanation } from './Explanation.tsx';
import { FlowChart, NODE_META } from './FlowChart.tsx';
import { NodeInspector } from './NodeInspector.tsx';

interface Props {
  src: DataSource;
  project: Project;
  /** Owned projects can rename and swap flows; share links and the sample are read-only. */
  projectId?: string;
  /** A traced lifecycle id (from Architecture or Technology Intelligence): open the main flow built from it. */
  focusFlow?: string;
  initialQuery?: string;
  onWireframe?(path: string): void;
  onArchitecture?(target: { flow?: string; focus?: string; tech?: string }): void;
  onIntelligence?(tech: string): void;
}

const CYCLE_TEXT: Record<string, string> = { access: 'Access', core: 'Core action', data: 'Data', background: 'Background', startup: 'Startup' };

/**
 * Automation: at most four main flows of the project as flowcharts. Regions, top to bottom, never
 * overlapping: summary · flow selector · canvas (toolbar, chart, overlays inside it) · explanation.
 */
export function AutomationView({ src, project, projectId, focusFlow, initialQuery, onWireframe, onArchitecture, onIntelligence }: Props) {
  const res = useAsync(() => data.automation(src), [src.base]);
  const [override, setOverride] = useState<AutomationResponse | null>(null);
  const view = override ?? res.data;
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [mobileChart, setMobileChart] = useState(false);
  const [mutError, setMutError] = useState<ApiError | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  const reduced = usePrefersReducedMotion();
  const phone = useMediaQuery('(max-width: 600px)');
  const canEdit = !!projectId && !src.readOnly && !project.isSample;

  useEffect(() => setOverride(null), [res.data]);
  // Pick the flow to open: one built from a linked lifecycle, one matching a query, else the first.
  useEffect(() => {
    if (!view?.flows.length) return;
    if (activeKey && view.flows.some((f) => f.key === activeKey)) return;
    const q = initialQuery?.toLowerCase();
    const linked = (focusFlow && view.flows.find((f) => f.sourceFlowIds.includes(focusFlow))) || (q && view.flows.find((f) => `${f.name} ${f.tools.map((t) => t.name).join(' ')} ${f.purpose}`.toLowerCase().includes(q)));
    setActiveKey((linked || view.flows[0]).key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);
  useEffect(() => setSelected(null), [activeKey]);

  if (res.error) {
    const unavailable = res.error.body.code === 'architecture_unavailable';
    return (
      <div className="view-pad narrow">
        <ErrorNotice error={unavailable ? { message: res.error.body.message } : res.error} onRetry={unavailable ? undefined : res.reload} />
        {!unavailable && <p className="small faint au-details">{res.error.body.code}: {res.error.body.message}</p>}
      </div>
    );
  }
  if (!view) return <div className="view-pad faint">Building the main flows…</div>;

  const active = view.flows.find((f) => f.key === activeKey) ?? view.flows[0];
  const opener = fileOpener(project, view.snapshot.commitSha);
  const snapshotKey = `${view.snapshot.analysisId}:${view.snapshot.commitSha ?? ''}`;
  const mutate = async (fn: () => Promise<AutomationResponse>) => {
    setMutError(null);
    try {
      setOverride(await fn());
    } catch (e) {
      setMutError(e as ApiError);
    }
  };

  const node = active && selected ? active.nodes.find((n) => n.id === selected) : undefined;
  const inspector = node && active && (
    <NodeInspector
      flow={active}
      node={node}
      opener={opener}
      onClose={() => setSelected(null)}
      onSelect={setSelected}
      onFocusBranch={() => setFocusNonce((n) => n + 1)}
      onWireframe={onWireframe}
      onArchitecture={onArchitecture}
      onIntelligence={onIntelligence}
      onJump={(k) => setActiveKey(k)}
    />
  );

  return (
    <div className="au">
      <Summary view={view} src={src} />
      {view.regenerated && (
        <p className="au-notice small" role="status">
          <RefreshCw size={13} /> These flows were rebuilt for the current engine version.
        </p>
      )}
      {view.latestAnalysis && (
        <div className="au-notice is-warn small" role="alert">
          <AlertTriangle size={14} /> The latest analysis failed{view.latestAnalysis.error.message ? `: ${view.latestAnalysis.error.message}` : ''}. Showing the previous snapshot ({view.snapshot.branch}
          {view.snapshot.commitSha ? ` @ ${view.snapshot.commitSha.slice(0, 7)}` : ''}).
        </div>
      )}
      <Diagnostics view={view} />
      {mutError && <ErrorNotice error={mutError} />}

      {!view.flows.length ? (
        <div className="au-empty">
          <Workflow size={22} aria-hidden="true" />
          <h3>Nothing to show yet</h3>
          <p>{view.diagnostics.notes[0] ?? 'No source files were found in this snapshot, so no flow can be built.'}</p>
        </div>
      ) : (
        <>
          <FlowCards
            view={view}
            activeKey={active.key}
            canEdit={canEdit}
            onPick={setActiveKey}
            onRename={(f, name) => mutate(() => api.renameFlow(projectId!, f.id, name))}
            onSwap={(f, key) => mutate(async () => {
              const r = await api.replaceFlow(projectId!, f.id, key);
              setActiveKey(key);
              return r;
            })}
          />
          {phone && !mobileChart ? (
            <section className="au-steplist" aria-label={`Steps of ${active.name}`}>
              <div className="au-steplist-head">
                <h3>{active.name}</h3>
                <button type="button" className="btn btn-sm" onClick={() => setMobileChart(true)}>
                  Open flowchart
                </button>
              </div>
              <ol>
                {[...active.nodes]
                  .filter((n) => n.type !== 'group')
                  .sort((a, b) => a.order - b.order)
                  .map((n) => {
                    const meta = NODE_META[n.type];
                    const Icon = meta.icon;
                    return (
                      <li key={n.id} className={`t-${n.type}`}>
                        <span className="au-step-kind">
                          <Icon size={13} aria-hidden="true" /> {meta.label}
                        </span>
                        <span className="au-step-label">{n.label}</span>
                        <span className="mono small faint">
                          {n.file}
                          {n.line ? `:${n.line}` : ''}
                        </span>
                      </li>
                    );
                  })}
              </ol>
            </section>
          ) : (
            <>
              {phone && (
                <button type="button" className="btn btn-sm au-back-list" onClick={() => setMobileChart(false)}>
                  Back to step list
                </button>
              )}
              <FlowChart key={`${active.id}:${snapshotKey}`} flow={active} snapshotKey={snapshotKey} selected={selected} onSelect={setSelected} reduced={reduced} inspector={inspector} focusRequest={focusNonce} />
            </>
          )}
          <Explanation flow={active} selected={selected} onSelect={(id) => (setSelected(id), phone && setMobileChart(true))} />
        </>
      )}
    </div>
  );
}

function Summary({ view, src }: { view: AutomationResponse; src: DataSource }) {
  const [open, setOpen] = useState(false);
  const cov = useAsync<AutomationCoverage | null>(() => (open ? data.automationCoverage(src) : Promise.resolve(null)), [open, src.base, view]);
  const c = view.coverage;
  const n = view.flows.length;
  return (
    <header className="au-summary">
      <p>
        <strong>{view.project.name}</strong>
        <span className="au-dot">·</span>
        {n} main flow{n === 1 ? '' : 's'}
        <span className="au-dot">·</span>
        covers {c.shown + c.folded} of {c.total} entry point{c.total === 1 ? '' : 's'}
        <span className="au-dot">·</span>
        <span className="faint">{view.projectTypeLabel}</span>
        <button type="button" className="link-btn small au-cov-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {c.shown} shown, {c.folded} folded, {c.omitted} omitted <ChevronDown size={12} className={open ? 'is-open' : ''} />
        </button>
      </p>
      {open && (
        <div className="au-coverage">
          {!cov.data ? (
            <p className="small faint">Loading…</p>
          ) : (
            (['shown', 'folded', 'omitted'] as const).map((k) => (
              <section key={k}>
                <h4>
                  {k === 'shown' ? 'Shown as main flows' : k === 'folded' ? 'Folded into a main flow' : 'Not shown'} <span className="mono faint">{cov.data![k].length}</span>
                </h4>
                <ul>
                  {cov.data![k].map((e) => (
                    <li key={e.key}>
                      <span>{e.label}</span>
                      <span className="mono small faint">
                        {e.file}
                        {e.line ? `:${e.line}` : ''}
                        {e.reason ? ` · ${e.reason}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      )}
    </header>
  );
}

function Diagnostics({ view }: { view: AutomationResponse }) {
  const d = view.diagnostics;
  const sparse = view.status !== 'ok' || d.traceCoverage < 50 || d.rejected.length > 0;
  if (!sparse) return null;
  return (
    <div className={`au-diag small${view.status === 'partial' ? ' is-warn' : ''}`} role="note">
      <Info size={13} aria-hidden="true" />
      <span>
        {d.fallback ? `${d.fallback.reason} ` : ''}
        {view.status === 'partial' ? 'No flow passed validation; the best partial flows are shown. ' : ''}
        Entry points found: {d.entryPoints} · flows built: {d.flowsBuilt} · rejected: {d.rejected.length} · trace coverage: {d.traceCoverage}%.
        {d.rejected.length > 0 && <> Rejected: {d.rejected.slice(0, 3).map((r) => `${r.name} (${r.reasons[0]})`).join('; ')}.</>}
        {d.notes.map((n) => ` ${n}`)}
      </span>
    </div>
  );
}

function FlowCards({ view, activeKey, canEdit, onPick, onRename, onSwap }: { view: AutomationResponse; activeKey: string; canEdit: boolean; onPick(key: string): void; onRename(f: AutomationFlow, name: string | null): void; onSwap(f: AutomationFlow, key: string): void }) {
  return (
    <div className="au-cards" role="tablist" aria-label="Main flows">
      {view.flows.map((f) => (
        <FlowCard key={f.key} f={f} active={f.key === activeKey} canEdit={canEdit} candidates={view.candidates.filter((c) => !c.selected)} onPick={() => onPick(f.key)} onRename={(name) => onRename(f, name)} onSwap={(k) => onSwap(f, k)} />
      ))}
    </div>
  );
}

function FlowCard({ f, active, canEdit, candidates, onPick, onRename, onSwap }: { f: AutomationFlow; active: boolean; canEdit: boolean; candidates: AutomationResponse['candidates']; onPick(): void; onRename(name: string | null): void; onSwap(key: string): void }) {
  const [editing, setEditing] = useState(false);
  const [swapping, setSwapping] = useState(false);
  const [name, setName] = useState(f.name);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setName(f.name), [f.name]);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  const steps = f.nodes.filter((n) => n.type !== 'group').length;
  const tools = useMemo(() => f.tools.slice(0, 4), [f.tools]);
  return (
    <div className={`au-card${active ? ' is-active' : ''}`}>
      <button type="button" role="tab" aria-selected={active} className="au-card-main" onClick={onPick}>
        <span className="au-card-top">
          <span className={`au-cycle c-${f.cycle}`}>{CYCLE_TEXT[f.cycle] ?? f.cycle}</span>
          <span className={`au-conf ${f.confidence.percent >= 90 ? 'is-full' : f.confidence.percent >= 60 ? 'is-mostly' : 'is-partial'}`} title={`${f.confidence.percent}% of steps fully traced`}>
            {f.partial ? 'Partially traced' : f.confidence.label} · {f.confidence.percent}%
          </span>
        </span>
        {editing ? null : <span className="au-card-name">{f.name}</span>}
        <span className="au-card-purpose">{f.purpose}</span>
        <span className="au-card-meta">
          <span className="mono">{steps} steps</span>
          {tools.map((t) => (
            <span key={t.id} className="au-tool">
              {t.name}
            </span>
          ))}
        </span>
      </button>
      {editing && (
        <form
          className="au-rename"
          onSubmit={(e) => {
            e.preventDefault();
            setEditing(false);
            onRename(name.trim() && name.trim() !== f.generatedName ? name.trim() : null);
          }}
        >
          <input ref={input} className="input input-sm" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-label="Flow name" onKeyDown={(e) => e.key === 'Escape' && setEditing(false)} />
          <button type="submit" className="icon-btn" aria-label="Save name">
            <Check size={14} />
          </button>
          <button type="button" className="icon-btn" aria-label="Cancel" onClick={() => setEditing(false)}>
            <X size={14} />
          </button>
        </form>
      )}
      {canEdit && !editing && (
        <div className="au-card-tools">
          <button type="button" className="icon-btn" aria-label={`Rename ${f.name}`} title="Rename" onClick={() => setEditing(true)}>
            <Pencil size={13} />
          </button>
          <button type="button" className="icon-btn" aria-label={`Swap ${f.name} for another flow`} title="Swap" aria-expanded={swapping} onClick={() => setSwapping(!swapping)} disabled={!candidates.length}>
            <ArrowLeftRight size={13} />
          </button>
          {f.renamed && (
            <button type="button" className="link-btn small" onClick={() => onRename(null)}>
              Reset name
            </button>
          )}
        </div>
      )}
      {swapping && (
        <div className="au-swap" role="menu" aria-label="Replace with">
          <p className="small faint">Replace with a ranked flow:</p>
          {candidates.map((c) => (
            <button
              key={c.key}
              role="menuitem"
              type="button"
              onClick={() => {
                setSwapping(false);
                onSwap(c.key);
              }}
            >
              <span>{c.name}</span>
              <span className="small faint">
                {CYCLE_TEXT[c.cycle] ?? c.cycle} · {c.steps} steps · {c.confidence.percent}%
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
