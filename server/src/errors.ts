export interface ErrorAction {
  label: string;
  href: string;
}

export type ErrorCode =
  | 'unauthenticated'
  | 'github_not_connected'
  | 'github_auth_expired'
  | 'github_rate_limited'
  | 'github_forbidden'
  | 'repo_not_found'
  | 'branch_not_found'
  | 'repo_too_large'
  | 'clone_failed'
  | 'clone_timeout'
  | 'analysis_failed'
  | 'interrupted'
  | 'not_found'
  | 'forbidden'
  | 'bad_request'
  | 'oauth_not_configured'
  | 'oauth_failed'
  | 'architecture_unavailable'
  | 'upstream'
  | 'repo_empty'
  | 'rate_limited';

/** Errors carry an actionable, user-facing message; internals are logged, not returned. */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status = 400,
    readonly action?: ErrorAction,
  ) {
    super(message);
  }

  toJSON() {
    return { code: this.code, message: this.message, action: this.action };
  }
}

export const reconnectGitHub: ErrorAction = { label: 'Reconnect GitHub', href: '/api/auth/github/start?intent=connect' };

export const githubAuthExpired = () =>
  new AppError('github_auth_expired', 'GitHub access expired. Reconnect GitHub to continue.', 401, reconnectGitHub);

export const githubNotConnected = () =>
  new AppError('github_not_connected', 'Connect GitHub to access your repositories.', 409, { label: 'Connect GitHub', href: '/api/auth/github/start?intent=connect' });
