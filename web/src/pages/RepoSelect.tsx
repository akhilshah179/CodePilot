import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { AppHeader } from '../components/AppHeader.tsx';
import { ErrorNotice, Steps } from '../components/ui.tsx';
import { api, authUrls, type Repo } from '../lib/api.ts';
import { num, relativeTime } from '../lib/format.ts';
import { useAsync, useDebounced, useDocumentTitle } from '../lib/hooks.ts';

function RepoAction({ repo }: { repo: Repo }) {
  const navigate = useNavigate();
  const p = repo.project;
  if (p?.lastStatus === 'running' || p?.lastStatus === 'queued') {
    return (
      <Link className="btn btn-sm" to={`/projects/${p.id}/analysis`}>
        View progress
      </Link>
    );
  }
  if (p?.analyzedAt) {
    return (
      <Link className="btn btn-sm btn-primary" to={`/projects/${p.id}`} aria-label={`Open ${repo.fullName}`}>
        Open
      </Link>
    );
  }
  return (
    <button className="btn btn-sm" onClick={() => navigate(`/onboarding/confirm/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`)} aria-label={`Import ${repo.fullName}`}>
      Import
    </button>
  );
}

export function RepoSelect() {
  useDocumentTitle('Select a repository');
  const me = useAsync(() => api.me(), []);
  const [query, setQuery] = useState('');
  const [owner, setOwner] = useState('');
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const forceRefresh = useRef(false);
  const q = useDebounced(query.trim(), 200);
  const connected = !!me.data?.github;
  const repos = useAsync(
    () => {
      // Only an explicit Refresh bypasses the server's short-lived repository cache.
      const force = forceRefresh.current;
      forceRefresh.current = false;
      return connected ? api.repos({ q, owner, page, perPage: 25, refresh: force }) : Promise.resolve(undefined);
    },
    [connected, q, owner, page, refresh],
  );
  useEffect(() => setPage(1), [q, owner]);

  if (me.data && !me.data.user) return <Navigate to="/signin?next=/onboarding/repos" replace />;
  const list = repos.data;

  return (
    <>
      <AppHeader me={me.data} />
      <main className="onboarding">
        <Steps current={2} />
        <div className="onboarding-head">
          <div>
            <h1>Select a repository</h1>
            <p className="muted">Repositories you own, collaborate on, or can access through an organization.</p>
          </div>
          <Link className="btn btn-sm btn-ghost" to="/sample">
            See a sample project
          </Link>
        </div>

        {me.data && !connected && (
          <div className="notice">
            <div>
              <p>
                <strong>Connect GitHub to access your repositories.</strong>
              </p>
              <p className="muted small">You are signed in with Google. That identifies you, but only GitHub can grant access to repositories.</p>
            </div>
            <a className="btn btn-primary" href={authUrls.github('/onboarding/repos', 'connect')}>
              Connect GitHub
            </a>
          </div>
        )}

        {connected && (
          <>
            <div className="repo-controls">
              <input className="input" type="search" placeholder="Search repositories" aria-label="Search repositories" value={query} onChange={(e) => setQuery(e.target.value)} />
              <select className="select" aria-label="Filter by owner or organization" value={owner} onChange={(e) => setOwner(e.target.value)}>
                <option value="">All owners</option>
                {list?.owners.map((o) => (
                  <option key={o.login} value={o.login}>
                    {o.login} {o.type === 'Organization' ? '(org)' : ''} · {o.count}
                  </option>
                ))}
              </select>
              <button className="btn" onClick={() => {
                  forceRefresh.current = true;
                  setRefresh((r) => r + 1);
                }} disabled={repos.loading} title="Fetch the list from GitHub again">
                Refresh
              </button>
            </div>

            {repos.error && <ErrorNotice error={repos.error} onRetry={repos.reload} />}

            <div className="repo-table" role="region" aria-label="Repositories" aria-busy={repos.loading}>
              <div className="repo-row repo-row-head" aria-hidden="true">
                <span>Repository</span>
                <span>Language</span>
                <span>Visibility</span>
                <span>Updated</span>
                <span>Status</span>
                <span />
              </div>
              <ul>
                {list?.repos.map((r) => (
                  <li key={r.id} className="repo-row">
                    <span className="repo-name">
                      <span className="mono faint">{r.owner}/</span>
                      <strong className="mono">{r.name}</strong>
                      {r.archived && <span className="tag">archived</span>}
                      {r.fork && <span className="tag">fork</span>}
                      {r.description && <span className="repo-desc small faint">{r.description}</span>}
                    </span>
                    <span className="small">{r.language ?? <span className="faint">—</span>}</span>
                    <span>
                      <span className={`tag${r.private ? '' : ' tag-accent'}`}>{r.private ? 'Private' : 'Public'}</span>
                    </span>
                    <span className="small muted">
                      <time dateTime={r.updatedAt}>{relativeTime(r.updatedAt)}</time>
                    </span>
                    <span className="small">
                      {r.project?.analyzedAt ? (
                        <span className="status-ok">Analyzed {relativeTime(r.project.analyzedAt)}</span>
                      ) : r.project?.lastStatus === 'failed' ? (
                        <span className="status-risk">Last analysis failed</span>
                      ) : r.project ? (
                        <span className="muted">Imported</span>
                      ) : (
                        <span className="faint">Not imported</span>
                      )}
                    </span>
                    <span className="repo-action">
                      <RepoAction repo={r} />
                    </span>
                  </li>
                ))}
                {list && list.repos.length === 0 && <li className="repo-empty faint">{q || owner ? 'No repositories match these filters.' : 'No repositories found for this GitHub account.'}</li>}
                {!list && repos.loading && <li className="repo-empty faint">Loading repositories from GitHub…</li>}
              </ul>
            </div>

            {list && (
              <nav className="pager" aria-label="Pagination">
                <span className="small faint">
                  {num(list.total)} repositories{list.truncated ? ' (first 3,000 shown)' : ''} · fetched {relativeTime(list.fetchedAt)}
                </span>
                <div className="spacer" />
                <button className="btn btn-sm" disabled={list.page <= 1} onClick={() => setPage(list.page - 1)}>
                  Previous
                </button>
                <span className="small mono" aria-current="page">
                  {list.page} / {list.pages}
                </span>
                <button className="btn btn-sm" disabled={list.page >= list.pages} onClick={() => setPage(list.page + 1)}>
                  Next
                </button>
              </nav>
            )}
          </>
        )}
      </main>
    </>
  );
}
