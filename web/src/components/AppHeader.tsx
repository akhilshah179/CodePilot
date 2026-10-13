import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { api, type Me } from '../lib/api.ts';
import { Logo } from './ui.tsx';

export function AppHeader({ me, children }: { me?: Me | null; children?: ReactNode }) {
  const navigate = useNavigate();
  return (
    <header className="app-header">
      <Logo to={me?.user ? '/onboarding/repos' : '/'} />
      {children}
      <div className="spacer" />
      {me?.user ? (
        <div className="header-user">
          {me.github?.login && <span className="mono faint header-login">@{me.github.login}</span>}
          {me.user.avatarUrl && <img className="avatar" src={me.user.avatarUrl} alt="" referrerPolicy="no-referrer" />}
          <button
            className="btn btn-sm btn-ghost"
            onClick={async () => {
              await api.logout().catch(() => {});
              navigate('/');
            }}
          >
            Sign out
          </button>
        </div>
      ) : me === null ? (
        <a className="btn btn-sm" href="/signin">
          Sign in
        </a>
      ) : null}
    </header>
  );
}
