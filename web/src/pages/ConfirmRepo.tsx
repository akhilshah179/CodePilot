import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { AppHeader } from '../components/AppHeader.tsx';
import { ErrorNotice, Steps } from '../components/ui.tsx';
import { api, type ApiError } from '../lib/api.ts';
import { relativeTime } from '../lib/format.ts';
import { useAsync, useDocumentTitle } from '../lib/hooks.ts';

export function ConfirmRepo() {
  const { owner = '', repo = '' } = useParams();
  useDocumentTitle(`Import ${owner}/${repo}`);
  const navigate = useNavigate();
  const me = useAsync(() => api.me(), []);
  const details = useAsync(() => api.repo(owner, repo), [owner, repo]);
  const policy = useAsync(() => api.scanPolicy(), []);
  const [branch, setBranch] = useState('');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (details.data && !branch) setBranch(details.data.repo.defaultBranch);
  }, [details.data, branch]);

  if (me.data && !me.data.user) return <Navigate to={`/signin?next=${encodeURIComponent(`/onboarding/confirm/${owner}/${repo}`)}`} replace />;
  const r = details.data?.repo;

  const start = async () => {
    setStarting(true);
    setStartError(null);
    try {
      const res = await api.createProject(owner, repo, branch);
      navigate(`/projects/${res.projectId}/analysis?analysisId=${res.analysisId}`);
    } catch (e) {
      setStartError(e as ApiError);
      setStarting(false);
    }
  };

  return (
    <>
      <AppHeader me={me.data} />
      <main className="onboarding narrow-onboarding">
        <Steps current={3} />
        <Link to="/onboarding/repos" className="back-link small">
          ← All repositories
        </Link>
        <h1 className="mono confirm-title">
          <span className="faint">{owner}/</span>
          {repo}
        </h1>
        {r && (
          <p className="muted">
            {r.description ?? 'No description.'} <span className="faint">· {r.private ? 'Private' : 'Public'} · updated {relativeTime(r.updatedAt)}</span>
          </p>
        )}
        {details.error && <ErrorNotice error={details.error} onRetry={details.reload} />}
        {!details.data && details.loading && <p className="faint">Loading repository and branches from GitHub…</p>}

        {details.data && (
          <div className="confirm-grid">
            <section className="panel">
              <h2>Branch</h2>
              <label className="small muted" htmlFor="branch">
                Analysis runs on the latest commit of this branch.
              </label>
              <select id="branch" className="select" value={branch} onChange={(e) => setBranch(e.target.value)}>
                {details.data.branches.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                    {b.isDefault ? ' (default)' : ''}
                  </option>
                ))}
              </select>
              <p className="small faint">{details.data.branches.length} branches</p>
            </section>

            <section className="panel">
              <h2>Scanning scope</h2>
              <p className="small muted">
                CodePilot makes a shallow clone of <code>{branch || '…'}</code> into temporary storage, analyzes it, and deletes the clone. It stores paths, import statements, symbol
                names and line numbers — never file contents.
              </p>
              {policy.data && (
                <dl className="scope-list">
                  <div>
                    <dt>Excluded directories</dt>
                    <dd className="mono small">{policy.data.excludedDirectories.join('  ')}</dd>
                  </div>
                  <div>
                    <dt>Secrets — never read into the graph</dt>
                    <dd className="small">
                      <ul>
                        {policy.data.secretFiles.map((s) => (
                          <li key={s} className="mono">
                            {s}
                          </li>
                        ))}
                        {policy.data.secretContent.map((s) => (
                          <li key={s}>{s}</li>
                        ))}
                      </ul>
                    </dd>
                  </div>
                  <div>
                    <dt>Generated artifacts</dt>
                    <dd className="small">{policy.data.generated.join(' · ')}</dd>
                  </div>
                  <div>
                    <dt>Limits</dt>
                    <dd className="small">
                      Files over {Math.round(policy.data.limits.maxParseBytes / 1_000_000)} MB are listed but not parsed; up to {policy.data.limits.maxFiles.toLocaleString()} files per
                      repository.
                    </dd>
                  </div>
                </dl>
              )}
            </section>
          </div>
        )}

        {startError && <ErrorNotice error={startError} />}
        <div className="confirm-actions">
          <button className="btn btn-lg btn-primary" disabled={!branch || starting} onClick={start}>
            {starting ? 'Starting…' : 'Start analysis'}
          </button>
          <Link className="btn btn-lg btn-ghost" to="/onboarding/repos">
            Cancel
          </Link>
        </div>
      </main>
    </>
  );
}
