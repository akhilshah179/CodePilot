import { AppError, githubAuthExpired } from './errors.ts';

export interface RepoSummary {
  id: number;
  name: string;
  owner: string;
  ownerType: 'User' | 'Organization';
  fullName: string;
  private: boolean;
  language: string | null;
  description: string | null;
  updatedAt: string;
  pushedAt: string | null;
  defaultBranch: string;
  htmlUrl: string;
  sizeKb: number;
  archived: boolean;
  fork: boolean;
}

export interface BranchSummary {
  name: string;
  protected: boolean;
  isDefault: boolean;
  commitSha: string;
}

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string;
}

interface RawRepo {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string; type: 'User' | 'Organization' };
  private: boolean;
  language: string | null;
  description: string | null;
  updated_at: string;
  pushed_at: string | null;
  default_branch: string;
  html_url: string;
  size: number;
  archived: boolean;
  fork: boolean;
}

const MAX_REPO_PAGES = 30;

export class GitHubClient {
  constructor(
    private readonly apiUrl: string,
    private readonly token: string,
  ) {}

  private async request(pathOrUrl: string): Promise<Response> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : this.apiUrl + pathOrUrl;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'CodePilot',
        },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new AppError('upstream', 'Could not reach GitHub. Check your connection and try again.', 502);
    }
    if (res.ok) return res;
    if (res.status === 401) throw githubAuthExpired();
    if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset') ?? 0) * 1000;
      const when = reset ? new Date(reset).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }) : 'a few minutes';
      throw new AppError('github_rate_limited', `GitHub API rate limit reached. Try again after ${when}.`, 429);
    }
    if (res.status === 403) {
      throw new AppError(
        'github_forbidden',
        'GitHub denied access. If this repository belongs to an organization, an owner may need to approve CodePilot under the organization’s third-party access settings.',
        403,
        { label: 'Review GitHub access', href: 'https://github.com/settings/applications' },
      );
    }
    if (res.status === 404) throw new AppError('repo_not_found', 'Repository not found, or CodePilot does not have access to it.', 404);
    throw new AppError('upstream', `GitHub returned an unexpected error (${res.status}). Try again shortly.`, 502);
  }

  async user(): Promise<GitHubUser> {
    return (await this.request('/user')).json() as Promise<GitHubUser>;
  }

  async primaryEmail(): Promise<string | null> {
    try {
      const emails = (await (await this.request('/user/emails')).json()) as { email: string; primary: boolean; verified: boolean }[];
      return emails.find((e) => e.primary && e.verified)?.email ?? null;
    } catch {
      return null;
    }
  }

  /** All repositories the user can access (owned, collaborator, organization member), most recently updated first. */
  async listRepos(): Promise<{ repos: RepoSummary[]; truncated: boolean }> {
    const base = '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member';
    const first = await this.request(`${base}&page=1`);
    const pages: RawRepo[][] = [(await first.json()) as RawRepo[]];
    const last = /[?&]page=(\d+)>; rel="last"/.exec(first.headers.get('link') ?? '');
    const lastPage = last ? Number(last[1]) : 1;
    const upTo = Math.min(lastPage, MAX_REPO_PAGES);
    for (let start = 2; start <= upTo; start += 5) {
      const batch = [];
      for (let p = start; p < start + 5 && p <= upTo; p++) batch.push(this.request(`${base}&page=${p}`).then((r) => r.json() as Promise<RawRepo[]>));
      pages.push(...(await Promise.all(batch)));
    }
    const seen = new Set<number>();
    const repos: RepoSummary[] = [];
    for (const r of pages.flat()) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      repos.push(toSummary(r));
    }
    return { repos, truncated: lastPage > MAX_REPO_PAGES };
  }

  async repo(owner: string, repo: string): Promise<RepoSummary> {
    return toSummary((await (await this.request(`/repos/${enc(owner)}/${enc(repo)}`)).json()) as RawRepo);
  }

  async branches(owner: string, repo: string, defaultBranch: string): Promise<BranchSummary[]> {
    const out: BranchSummary[] = [];
    for (let page = 1; page <= 10; page++) {
      const res = await this.request(`/repos/${enc(owner)}/${enc(repo)}/branches?per_page=100&page=${page}`);
      const list = (await res.json()) as { name: string; protected: boolean; commit: { sha: string } }[];
      for (const b of list) out.push({ name: b.name, protected: b.protected, isDefault: b.name === defaultBranch, commitSha: b.commit.sha });
      if (!/rel="next"/.test(res.headers.get('link') ?? '')) break;
    }
    out.sort((a, b) => (a.isDefault ? -1 : b.isDefault ? 1 : a.name.localeCompare(b.name)));
    return out;
  }
}

const enc = encodeURIComponent;

function toSummary(r: RawRepo): RepoSummary {
  return {
    id: r.id,
    name: r.name,
    owner: r.owner.login,
    ownerType: r.owner.type,
    fullName: r.full_name,
    private: r.private,
    language: r.language,
    description: r.description,
    updatedAt: r.updated_at,
    pushedAt: r.pushed_at,
    defaultBranch: r.default_branch,
    htmlUrl: r.html_url,
    sizeKb: r.size,
    archived: r.archived,
    fork: r.fork,
  };
}
