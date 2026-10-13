import { useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { Logo, Steps } from '../components/ui.tsx';
import { api, ApiError, authUrls } from '../lib/api.ts';
import { useAsync, useDocumentTitle } from '../lib/hooks.ts';

const ERRORS: Record<string, string> = {
  github_not_configured: 'GitHub sign-in is not configured on this server. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET, then restart the server.',
  google_not_configured: 'Google sign-in is not configured on this server. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then restart the server.',
  github_denied: 'GitHub authorization was cancelled. CodePilot needs it to list and read your repositories.',
  oauth_state: 'That sign-in link expired or was already used. Start again.',
  oauth_failed: 'Sign-in did not complete. Try again.',
  github_linked_elsewhere: 'That GitHub account is already connected to a different CodePilot user. Sign in with GitHub directly instead.',
};

function GitHubMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

export function SignIn() {
  useDocumentTitle('Sign in');
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = params.get('next') ?? '/onboarding/repos';
  const error = params.get('error');
  const providers = useAsync(() => api.providers(), []);
  const me = useAsync(() => api.me(), []);
  const [devError, setDevError] = useState<string | null>(null);
  const [devBusy, setDevBusy] = useState(false);

  if (me.data?.user && !error) return <Navigate to={next} replace />;
  const p = providers.data;

  return (
    <div className="auth-page">
      <header className="auth-header">
        <Logo />
      </header>
      <main className="auth-main">
        <Steps current={1} />
        <h1>Sign in to CodePilot</h1>
        <p className="muted">Sign in, then choose a GitHub repository to map.</p>

        {error && (
          <div className="notice notice-risk" role="alert">
            <p>{ERRORS[error] ?? 'Sign-in did not complete. Try again.'}</p>
          </div>
        )}

        <div className="auth-buttons">
          <a
            className="btn btn-lg btn-primary"
            href={p?.github ? authUrls.github(next) : undefined}
            aria-disabled={p && !p.github ? 'true' : undefined}
            onClick={(e) => p && !p.github && e.preventDefault()}
          >
            <GitHubMark /> Continue with GitHub
          </a>
          <a
            className="btn btn-lg"
            href={p?.google ? authUrls.google(next) : undefined}
            aria-disabled={p && !p.google ? 'true' : undefined}
            onClick={(e) => p && !p.google && e.preventDefault()}
          >
            <GoogleMark /> Continue with Google
          </a>
          {p && !p.github && <p className="small faint">GitHub OAuth is not configured on this server (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET).</p>}
          {p && !p.google && <p className="small faint">Google sign-in is not configured on this server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).</p>}
          {p?.dev && (
            <div className="dev-signin">
              <button
                className="btn"
                disabled={devBusy}
                onClick={async () => {
                  setDevBusy(true);
                  setDevError(null);
                  try {
                    await api.devSignIn();
                    navigate(next);
                  } catch (e) {
                    setDevError((e as ApiError).message);
                  } finally {
                    setDevBusy(false);
                  }
                }}
              >
                {devBusy ? 'Signing in…' : 'Development sign-in (DEV_GITHUB_TOKEN)'}
              </button>
              <p className="small faint">Local development only: uses the token from the server environment. Disabled in production.</p>
              {devError && <p className="small" role="alert">{devError}</p>}
            </div>
          )}
        </div>

        <hr className="hairline" />
        <dl className="auth-facts">
          <div>
            <dt>GitHub</dt>
            <dd>
              Lists your repositories and reads the branch you choose. GitHub OAuth apps have no read-only scope for private code, so CodePilot requests <code>repo</code> — it only ever
              reads.
            </dd>
          </div>
          <div>
            <dt>Google</dt>
            <dd>Identifies you only. It does not grant access to any repository; you will be asked to connect GitHub next.</dd>
          </div>
        </dl>
        <p className="small faint">
          Just looking? <Link to="/sample">Open the sample project</Link>.
        </p>
      </main>
    </div>
  );
}
