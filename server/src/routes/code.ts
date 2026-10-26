import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthStore } from '../auth/store.ts';
import { SEARCH_LIMITS, validPath, type CodeStore } from '../codeStore.ts';
import { AppError } from '../errors.ts';
import type { GraphStore } from '../graphStore.ts';
import type { ProjectsApi } from './projects.ts';

/*
 * Code tab API. Every endpoint goes through the project access check first, so a project the
 * requester cannot see is a 404 everywhere (tree, file, search, outline, relations). Content is
 * returned as JSON strings — never as HTML — and is masked at import time.
 */

type Snap = { analysisId?: string; commit?: string };
type Req<Q = object> = FastifyRequest<{ Params: { id: string }; Querystring: Snap & Q }>;

import { getClientKey, type RateLimiter } from '../rateLimit.ts';

export function registerCodeRoutes(app: FastifyInstance, auth: AuthStore, projects: ProjectsApi, code: CodeStore, graphs: GraphStore, rateLimiter?: RateLimiter) {
  const ref = (request: Req) => {
    const project = projects.getProject(request, request.params.id, 'code:view');
    const { analysisId, commit } = request.query;
    if (analysisId !== undefined && typeof analysisId !== 'string') throw new AppError('bad_request', 'analysisId must be a string.', 400);
    if (commit !== undefined && (typeof commit !== 'string' || !/^[0-9a-f]{7,64}$/i.test(commit))) throw new AppError('bad_request', 'commit must be a commit SHA.', 400);
    return { project, ref: code.resolve(project.id, { analysisId, commit }) };
  };
  const pathOf = (request: Req<{ path?: string }>) => {
    const p = request.query.path;
    if (!validPath(p?.replace(/\/$/, ''))) throw new AppError('bad_request', 'path must be a repository-relative file path.', 400);
    return p!;
  };
  // Code is private to the people who can open the project; never cached by shared caches.
  const priv = (reply: FastifyReply) => reply.header('Cache-Control', 'private, no-store');

  app.get('/api/projects/:id/code', async (request: Req, reply) => {
    const { project, ref: r } = ref(request);
    priv(reply);
    const user = auth.userFromRequest(request);
    const userRole = user && project.user_id !== null ? projects.rbac.getRole(project.id, user.id) : null;
    const canRetry = userRole === 'owner' || userRole === 'admin' || userRole === 'member';
    return { ...code.tree(project.id, r), canRetry };
  });

  app.get('/api/projects/:id/code/file', async (request: Req<{ path?: string }>, reply) => {
    const r = ref(request).ref;
    priv(reply);
    return code.file(r, pathOf(request));
  });

  app.get('/api/projects/:id/code/outline', async (request: Req<{ path?: string }>, reply) => {
    const r = ref(request).ref;
    priv(reply);
    return code.outline(r, pathOf(request));
  });

  app.get('/api/projects/:id/code/relations', async (request: Req<{ path?: string }>, reply) => {
    const r = ref(request).ref;
    priv(reply);
    return code.relations(r, pathOf(request), graphs);
  });

  app.get('/api/projects/:id/code/search', async (request: Req<{ q?: string; case?: string; word?: string }>, reply) => {
    // Access first: an inaccessible project is a 404 whatever the query.
    const { project, ref: r } = ref(request);
    if (rateLimiter) {
      const user = auth.userFromRequest(request);
      rateLimiter.check(`search:${getClientKey(request, user?.id)}`, { max: 60, windowMs: 60_000 }, reply);
    }
    const query = request.query.q;
    if (typeof query !== 'string' || !query.trim()) throw new AppError('bad_request', 'Enter something to search for.', 400);
    if (query.length > SEARCH_LIMITS.query) throw new AppError('bad_request', `Search for at most ${SEARCH_LIMITS.query} characters.`, 400);
    priv(reply);
    return code.search(r, { query, caseSensitive: request.query.case === '1', wholeWord: request.query.word === '1' });
  });
}
