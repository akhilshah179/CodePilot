import type { FastifyInstance } from 'fastify';
import type { AuthStore } from '../auth/store.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db.ts';
import { GitHubClient, type RepoSummary } from '../github.ts';

interface CacheEntry {
  at: number;
  repos: RepoSummary[];
  truncated: boolean;
}

const CACHE_TTL_MS = 5 * 60_000;

export function registerGitHubRoutes(app: FastifyInstance, config: Config, db: Db, auth: AuthStore) {
  const cache = new Map<string, CacheEntry>();

  async function reposFor(userId: string, refresh: boolean): Promise<CacheEntry> {
    const hit = cache.get(userId);
    if (hit && !refresh && Date.now() - hit.at < CACHE_TTL_MS) return hit;
    const gh = new GitHubClient(config.github.apiUrl, auth.githubToken(userId));
    const { repos, truncated } = await gh.listRepos();
    const entry = { at: Date.now(), repos, truncated };
    cache.set(userId, entry);
    return entry;
  }

  app.get<{ Querystring: { q?: string; owner?: string; page?: string; perPage?: string; refresh?: string } }>('/api/github/repos', async (request) => {
    const user = auth.requireUser(request);
    const { repos, truncated, at } = await reposFor(user.id, request.query.refresh === '1');

    const owners = new Map<string, { login: string; type: string; count: number }>();
    for (const r of repos) {
      const o = owners.get(r.owner) ?? { login: r.owner, type: r.ownerType, count: 0 };
      o.count++;
      owners.set(r.owner, o);
    }

    const q = (request.query.q ?? '').trim().toLowerCase();
    const owner = request.query.owner;
    const filtered = repos.filter(
      (r) => (!owner || r.owner === owner) && (!q || r.fullName.toLowerCase().includes(q) || (r.description ?? '').toLowerCase().includes(q)),
    );
    const perPage = Math.min(Math.max(Number(request.query.perPage) || 30, 5), 100);
    const pages = Math.max(1, Math.ceil(filtered.length / perPage));
    const page = Math.min(Math.max(Number(request.query.page) || 1, 1), pages);
    const slice = filtered.slice((page - 1) * perPage, page * perPage);

    // Imported / analyzed status for this user's projects.
    const rows = db
      .prepare(
        `SELECT p.id, p.full_name, p.branch,
                (SELECT status FROM analyses a WHERE a.project_id = p.id ORDER BY a.created_at DESC LIMIT 1) AS last_status,
                (SELECT finished_at FROM analyses a WHERE a.project_id = p.id AND a.status = 'complete' ORDER BY a.created_at DESC LIMIT 1) AS analyzed_at
         FROM projects p WHERE p.user_id = ?`,
      )
      .all(user.id) as { id: string; full_name: string; branch: string; last_status: string | null; analyzed_at: string | null }[];
    const byName = new Map(rows.map((r) => [r.full_name.toLowerCase(), r]));

    return {
      repos: slice.map((r) => {
        const p = byName.get(r.fullName.toLowerCase());
        return { ...r, project: p ? { id: p.id, branch: p.branch, lastStatus: p.last_status, analyzedAt: p.analyzed_at } : null };
      }),
      total: filtered.length,
      page,
      pages,
      perPage,
      owners: [...owners.values()].sort((a, b) => (a.type === b.type ? a.login.localeCompare(b.login) : a.type === 'User' ? -1 : 1)),
      truncated,
      fetchedAt: new Date(at).toISOString(),
    };
  });

  app.get<{ Params: { owner: string; repo: string } }>('/api/github/repos/:owner/:repo', async (request) => {
    const user = auth.requireUser(request);
    const gh = new GitHubClient(config.github.apiUrl, auth.githubToken(user.id));
    const repo = await gh.repo(request.params.owner, request.params.repo);
    const branches = await gh.branches(repo.owner, repo.name, repo.defaultBranch);
    return { repo, branches };
  });
}
