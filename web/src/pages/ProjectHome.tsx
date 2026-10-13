import { Settings2 } from 'lucide-react';
import { useMemo, useState } from 'react';

type View = 'summary' | 'wireframe' | 'architecture' | 'intelligence' | 'automation';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import { AppHeader } from '../components/AppHeader.tsx';
import { ErrorNotice } from '../components/ui.tsx';
import { SummaryView } from '../features/project/SummaryView.tsx';
import { ArchitectureView } from '../features/architecture/ArchitectureView.tsx';
import { WireframeView } from '../features/project/WireframeView.tsx';
import { TechIntelligenceView } from '../features/intelligence/TechIntelligenceView.tsx';
import { AutomationView } from '../features/automation/AutomationView.tsx';
import { ConsentDialog } from '../features/collective/ConsentDialog.tsx';
import { api, ApiError, projectSource } from '../lib/api.ts';
import { relativeTime } from '../lib/format.ts';
import { useAsync, useDocumentTitle } from '../lib/hooks.ts';

export function ProjectHome() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const rawView = params.get('view');
  const view: View = rawView === 'wireframe' || rawView === 'architecture' || rawView === 'intelligence' || rawView === 'automation' ? rawView : 'summary';
  const info = useAsync(() => api.project(id), [id]);
  const me = useAsync(() => api.me(), []);
  const [rerunError, setRerunError] = useState<ApiError | null>(null);
  const [settings, setSettings] = useState(false);
  const project = info.data?.project;
  useDocumentTitle(project ? (project.isSample ? 'Sample project' : project.fullName) : 'Project');

  // Keep the URL in sync so views are linkable.
  const src = useMemo(() => projectSource(id), [id]);
  const setView = (v: View, extra: Record<string, string> = {}) => {
    const next = new URLSearchParams({ view: v, ...extra });
    setParams(next, { replace: false });
  };

  if (info.error) {
    return (
      <>
        <AppHeader me={me.data} />
        <main className="view-pad narrow">
          <ErrorNotice error={info.error} onRetry={info.reload} />
          <p style={{ marginTop: 16 }}>
            <Link to="/onboarding/repos">Back to repositories</Link>
          </p>
        </main>
      </>
    );
  }
  if (!info.data || !project) return <div className="view-pad faint">Loading project…</div>;

  const { analysis, completed } = info.data;
  if (!completed && analysis && (analysis.status === 'queued' || analysis.status === 'running')) {
    return <Navigate to={`/projects/${id}/analysis?analysisId=${analysis.id}`} replace />;
  }

  const canRerun = !project.isSample && !!me.data?.user;
  const rerun = async () => {
    setRerunError(null);
    try {
      const r = await api.createProject(project.owner, project.repo, project.branch);
      navigate(`/projects/${r.projectId}/analysis?analysisId=${r.analysisId}`);
    } catch (e) {
      setRerunError(e as ApiError);
    }
  };

  const pinned = params.get('pin')?.split(',').filter(Boolean);

  return (
    <div className="project-shell">
      <a className="skip-link" href="#project-main">
        Skip to content
      </a>
      <AppHeader me={me.data}>
        <div className="project-title">
          <span className="sep" aria-hidden="true">
            /
          </span>
          <h1>{project.isSample ? 'CodePilot' : project.fullName}</h1>
          {project.isSample && <span className="tag tag-accent">Sample</span>}
          {completed && (
            <span className="mono faint project-meta">
              {completed.branch}
              {completed.commitSha ? ` @ ${completed.commitSha.slice(0, 7)}` : ''} · analyzed {relativeTime(completed.finishedAt)}
            </span>
          )}
        </div>
      </AppHeader>

      <nav className="view-tabs" aria-label="Project views">
        <div role="tablist" aria-label="Project views">
          <button role="tab" aria-selected={view === 'summary'} onClick={() => setView('summary')}>
            Summary
          </button>
          <button role="tab" aria-selected={view === 'wireframe'} onClick={() => setView('wireframe')}>
            Wireframe
          </button>
          <button role="tab" aria-selected={view === 'architecture'} onClick={() => setView('architecture')}>
            Architecture
          </button>
          <button role="tab" aria-selected={view === 'intelligence'} onClick={() => setView('intelligence')}>
            Technology Intelligence
          </button>
          <button role="tab" aria-selected={view === 'automation'} onClick={() => setView('automation')}>
            Automation
          </button>
        </div>
        <div className="spacer" />
        {project.isSample && (
          <span className="small faint sample-note">
            A live analysis of CodePilot’s own source code.{' '}
            <Link to="/signin">Connect your repository</Link>
          </span>
        )}
        {canRerun && (
          <button className="btn btn-sm btn-ghost" onClick={() => setSettings(true)} title="Project settings">
            <Settings2 size={14} /> Settings
          </button>
        )}
        {canRerun && (
          <button className="btn btn-sm" onClick={rerun}>
            Re-analyze
          </button>
        )}
      </nav>

      <main id="project-main" className="project-main" tabIndex={-1}>
        {rerunError && (
          <div className="view-pad">
            <ErrorNotice error={rerunError} />
          </div>
        )}
        {!completed ? (
          <div className="view-pad narrow">
            <ErrorNotice
              error={{
                message: analysis?.error?.message ?? 'This project has not been analyzed yet.',
                action: canRerun ? undefined : { label: 'Choose a repository', href: '/onboarding/repos' },
              }}
              onRetry={canRerun ? rerun : undefined}
            />
          </div>
        ) : view === 'summary' ? (
          <SummaryView
            projectId={id}
            onFocus={(nodeId) => setView('wireframe', { focus: nodeId })}
            onCycle={(members) => setView('wireframe', { pin: members.join(','), focus: members[0] })}
          />
        ) : view === 'architecture' ? (
          <ArchitectureView
            key={`${id}:${params.get('focus') ?? ''}:${params.get('tech') ?? ''}:${params.get('flow') ?? ''}`}
            src={src}
            project={project}
            focusFile={params.get('focus') ?? undefined}
            focusTech={params.get('tech') ?? undefined}
            openFlowId={params.get('flow') ?? undefined}
            onWireframe={(path) => setView('wireframe', { focus: path })}
            onIntelligence={(tech) => setView('intelligence', { tech })}
            onAutomation={(flow) => setView('automation', { flow })}
          />
        ) : view === 'automation' ? (
          <AutomationView
            key={`${id}:${params.get('flow') ?? ''}:${params.get('q') ?? ''}`}
            src={src}
            project={project}
            projectId={project.isSample ? undefined : id}
            focusFlow={params.get('flow') ?? undefined}
            initialQuery={params.get('q') ?? undefined}
            onWireframe={(path) => setView('wireframe', { focus: path })}
            onArchitecture={(t) => setView('architecture', t.flow ? { flow: t.flow } : t.tech ? { tech: t.tech } : { focus: t.focus! })}
            onIntelligence={(tech) => setView('intelligence', { tech })}
          />
        ) : view === 'intelligence' ? (
          <TechIntelligenceView
            key={`${id}:${params.get('tech') ?? ''}`}
            src={src}
            project={project}
            focusTech={params.get('tech') ?? undefined}
            onWireframe={(path) => setView('wireframe', { focus: path })}
            onArchitecture={(t) => setView('architecture', t.flow ? { flow: t.flow } : { tech: t.tech! })}
            onAutomation={(t) => setView('automation', t.flow ? { flow: t.flow } : { q: t.q! })}
          />
        ) : (
          <WireframeView
            key={`${id}:${params.get('focus') ?? ''}:${params.get('pin') ?? ''}`}
            src={src}
            project={project}
            initialFocus={params.get('focus') ?? undefined}
            initialPinned={pinned}
            onArchitecture={(path) => setView('architecture', { focus: path })}
          />
        )}
      </main>
      {settings && project && !project.isSample && <ConsentDialog project={project} onClose={() => setSettings(false)} />}
    </div>
  );
}
