import { Link, Navigate, useSearchParams } from 'react-router';
import { ErrorNotice, Logo } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { useAsync, useDocumentTitle } from '../lib/hooks.ts';

/** The sample project is CodePilot's own repository, analyzed by the server at startup. */
export function SampleRedirect() {
  useDocumentTitle('Sample project');
  const { data, error, reload } = useAsync(() => api.sample(), []);
  // `/sample?view=architecture` opens the sample straight into that view.
  const [params] = useSearchParams();
  const view = params.get('view');
  // Deep links into a view keep their focus: a file, a technology or a request flow.
  const keep = new URLSearchParams();
  if (view === 'wireframe' || view === 'architecture' || view === 'intelligence' || view === 'automation') {
    keep.set('view', view);
    for (const k of ['focus', 'tech', 'flow']) {
      const v = params.get(k);
      if (v) keep.set(k, v);
    }
  }
  const query = keep.size ? `?${keep.toString()}` : '';
  if (data?.projectId) {
    return <Navigate to={data.status === 'complete' ? `/projects/sample${query}` : `/projects/sample/analysis`} replace />;
  }
  return (
    <main className="view-pad narrow">
      <Logo />
      <div style={{ marginTop: 24 }}>
        {error ? <ErrorNotice error={error} onRetry={reload} /> : data ? <ErrorNotice error={{ message: 'The sample project is not available on this server.' }} /> : <p className="faint">Loading sample…</p>}
      </div>
    </main>
  );
}

export function NotFound() {
  useDocumentTitle('Not found');
  return (
    <main className="view-pad narrow">
      <Logo />
      <h1 style={{ marginTop: 32 }}>Page not found</h1>
      <p className="muted" style={{ marginTop: 8 }}>
        <Link to="/">Go to the start page</Link>
      </p>
    </main>
  );
}
