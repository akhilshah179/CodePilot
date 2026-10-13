import { useMemo } from 'react';
import { Link, useParams } from 'react-router';
import { ErrorNotice, Logo } from '../components/ui.tsx';
import { ArchitectureView } from '../features/architecture/ArchitectureView.tsx';
import { WireframeView } from '../features/project/WireframeView.tsx';
import { api, shareSource } from '../lib/api.ts';
import { relativeTime } from '../lib/format.ts';
import { useAsync, useDocumentTitle } from '../lib/hooks.ts';

/** Read-only view behind a share link (and its chrome-less embed variant). */
export function SharedView({ embed = false }: { embed?: boolean }) {
  const { token = '' } = useParams();
  const src = useMemo(() => shareSource(token), [token]);
  const meta = useAsync(() => api.shared(token), [token]);
  useDocumentTitle(meta.data ? `${meta.data.project.fullName} · shared ${meta.data.kind}` : 'Shared view');
  if (meta.error) {
    return (
      <main className="view-pad narrow">
        <Logo />
        <div style={{ marginTop: 24 }}>
          <ErrorNotice error={meta.error} />
        </div>
      </main>
    );
  }
  if (!meta.data) return <div className="view-pad faint">Loading…</div>;
  const { project, analysis, kind } = meta.data;
  return (
    <div className={`project-shell${embed ? ' is-embed' : ''}`}>
      {!embed && (
        <header className="app-header">
          <Logo />
          <div className="project-title">
            <span className="sep" aria-hidden="true">
              /
            </span>
            <h1>{project.fullName}</h1>
            <span className="tag">Read-only {kind}</span>
            <span className="mono faint project-meta">
              {analysis.branch}
              {analysis.commitSha ? ` @ ${analysis.commitSha.slice(0, 7)}` : ''} · analyzed {relativeTime(analysis.finishedAt)}
            </span>
          </div>
          <div className="spacer" />
          <Link to="/" className="btn btn-sm">
            About CodePilot
          </Link>
        </header>
      )}
      <main className="project-main" id="project-main">
        {kind === 'architecture' ? <ArchitectureView src={src} project={project} embed={embed} /> : <WireframeView src={src} project={project} embed={embed} />}
      </main>
    </div>
  );
}
