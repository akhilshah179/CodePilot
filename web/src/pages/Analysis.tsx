import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { AppHeader } from '../components/AppHeader.tsx';
import { ErrorNotice, Steps } from '../components/ui.tsx';
import { LivePreview, type PartialData } from '../features/onboarding/LivePreview.tsx';
import { api } from '../lib/api.ts';
import { num } from '../lib/format.ts';
import { prefersReducedMotion, useAsync, useDocumentTitle } from '../lib/hooks.ts';

const STAGES = [
  { id: 'queued', label: 'Queued' },
  { id: 'cloning', label: 'Cloning repository' },
  { id: 'scanning', label: 'Scanning files' },
  { id: 'parsing', label: 'Parsing imports' },
  { id: 'resolving', label: 'Resolving dependencies' },
  { id: 'building', label: 'Building graph' },
  { id: 'complete', label: 'Complete' },
] as const;

interface Counters {
  filesScanned: number;
  nodesClassified: number;
  edgesFound: number;
  clone?: { phase: string; percent: number };
}

interface Failure {
  code: string;
  message: string;
  action?: { label: string; href: string };
}

export function Analysis() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const analysisId = params.get('analysisId') ?? undefined;
  const navigate = useNavigate();
  const me = useAsync(() => api.me(), []);
  const info = useAsync(() => api.project(id), [id]);
  const [stage, setStage] = useState<string>('queued');
  const [counters, setCounters] = useState<Counters>({ filesScanned: 0, nodesClassified: 0, edgesFound: 0 });
  const [failure, setFailure] = useState<Failure | null>(null);
  const [connectionLost, setConnectionLost] = useState(false);
  const [partial, setPartial] = useState<PartialData>({ nodes: [], edges: [] });
  const [attempt, setAttempt] = useState(0);
  const partialRef = useRef<PartialData>({ nodes: [], edges: [] });
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const project = info.data?.project;
  useDocumentTitle(project ? `Analyzing ${project.fullName}` : 'Analysis');

  useEffect(() => {
    setConnectionLost(false);
    const source = new EventSource(api.streamUrl(id, analysisId), { withCredentials: true });
    let finished = false;
    const flushPartial = () => {
      flushTimer.current = null;
      setPartial({ nodes: [...partialRef.current.nodes], edges: [...partialRef.current.edges] });
    };
    const schedule = () => {
      if (!flushTimer.current) flushTimer.current = setTimeout(flushPartial, 120);
    };
    const on = (name: string, fn: (data: any) => void) => source.addEventListener(name, (e) => fn(JSON.parse((e as MessageEvent).data)));

    on('snapshot', (s) => {
      setStage(s.stage);
      setCounters(s.counters);
      partialRef.current = { nodes: [...s.partial.nodes], edges: [...s.partial.edges] };
      flushPartial();
      if (s.error) setFailure(s.error);
    });
    on('stage', (s) => setStage(s.stage));
    on('progress', (c) => setCounters(c));
    on('partial', (p: PartialData) => {
      partialRef.current.nodes.push(...p.nodes);
      partialRef.current.edges.push(...p.edges);
      schedule();
    });
    on('complete', () => {
      finished = true;
      source.close();
      setStage('complete');
      flushPartial();
      // Let the completed state register before moving on to Project Home.
      setTimeout(() => navigate(`/projects/${id}`, { replace: true }), prefersReducedMotion() ? 300 : 900);
    });
    on('failure', (f: Failure) => {
      finished = true;
      source.close();
      setFailure(f);
    });
    source.onerror = () => {
      if (finished) return;
      if (source.readyState === EventSource.CLOSED) setConnectionLost(true);
    };
    return () => {
      source.close();
      if (flushTimer.current) clearTimeout(flushTimer.current);
    };
  }, [id, analysisId, attempt, navigate]);

  const stageIndex = STAGES.findIndex((s) => s.id === stage);
  const failed = !!failure;

  return (
    <>
      <AppHeader me={me.data} />
      <main className="onboarding analysis-page">
        <Steps current={4} />
        <h1 className="mono confirm-title">
          {project ? (
            project.isSample ? (
              'CodePilot sample'
            ) : (
              <>
                <span className="faint">{project.owner}/</span>
                {project.repo}
              </>
            )
          ) : (
            ' '
          )}
        </h1>
        <p className="muted">
          {failed ? 'Analysis stopped.' : stage === 'complete' ? 'Analysis complete. Opening Project Home…' : 'Analyzing the repository. You can leave this page; the analysis keeps running.'}
        </p>

        <div className="analysis-grid">
          <section className="panel" aria-labelledby="stages-title">
            <h2 id="stages-title">Progress</h2>
            <ol className="stages">
              {STAGES.map((s, i) => {
                const state = failed && i === Math.max(stageIndex, 0) ? 'failed' : i < stageIndex || stage === 'complete' ? 'done' : i === stageIndex ? 'active' : 'pending';
                return (
                  <li key={s.id} data-state={state} aria-current={state === 'active' ? 'step' : undefined}>
                    <span className="stage-marker" aria-hidden="true" />
                    <span>{s.label}</span>
                    {s.id === 'cloning' && state === 'active' && counters.clone && (
                      <span className="mono faint small">
                        {counters.clone.phase} {counters.clone.percent}%
                      </span>
                    )}
                    <span className="visually-hidden">{state === 'done' ? '(done)' : state === 'active' ? '(in progress)' : state === 'failed' ? '(failed)' : ''}</span>
                  </li>
                );
              })}
            </ol>
            {stage === 'cloning' && counters.clone && (
              <div className="progress" role="progressbar" aria-label={`Clone: ${counters.clone.phase}`} aria-valuenow={counters.clone.percent} aria-valuemin={0} aria-valuemax={100}>
                <span style={{ width: `${counters.clone.percent}%` }} />
              </div>
            )}
          </section>

          <section className="panel counters" aria-label="Live counts" aria-live="polite" aria-atomic="false">
            <div>
              <span className="counter-value mono">{num(counters.filesScanned)}</span>
              <span className="counter-label">Files scanned</span>
            </div>
            <div>
              <span className="counter-value mono">{num(counters.nodesClassified)}</span>
              <span className="counter-label">Nodes classified</span>
            </div>
            <div>
              <span className="counter-value mono">{num(counters.edgesFound)}</span>
              <span className="counter-label">Edges found</span>
            </div>
          </section>

          <section className="panel preview-panel" aria-label="Live graph preview">
            <LivePreview data={partial} label={`${partial.nodes.length} nodes and ${partial.edges.length} edges received so far`} />
            <p className="small faint">Partial graph as it streams in — {num(partial.nodes.length)} nodes, {num(partial.edges.length)} edges.</p>
          </section>
        </div>

        {failure && (
          <ErrorNotice
            error={{
              message: failure.message,
              action: failure.action ?? (failure.code === 'branch_not_found' && project ? { label: 'Choose another branch', href: `/onboarding/confirm/${project.owner}/${project.repo}` } : undefined),
            }}
          />
        )}
        {failure && project && !project.isSample && (
          <p className="small">
            <Link to={`/onboarding/confirm/${project.owner}/${project.repo}`}>Start the analysis again</Link> · <Link to="/onboarding/repos">Back to repositories</Link>
          </p>
        )}
        {connectionLost && !failure && (
          <div className="notice notice-risk" role="alert">
            <p>Lost the connection to the progress stream. The analysis may still be running.</p>
            <button className="btn btn-sm" onClick={() => setAttempt((a) => a + 1)}>
              Reconnect
            </button>
          </div>
        )}
      </main>
    </>
  );
}
