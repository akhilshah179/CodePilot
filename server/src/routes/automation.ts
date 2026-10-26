import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthStore } from '../auth/store.ts';
import type { AutomationStore } from '../automationStore.ts';
import { AppError } from '../errors.ts';
import type { ProjectsApi } from './projects.ts';

type Q = { Querystring: { analysisId?: string } };

export function registerAutomationRoutes(app: FastifyInstance, auth: AuthStore, projects: ProjectsApi, store: AutomationStore) {
  const owned = (request: FastifyRequest<Q & { Params: { id: string } }>) => {
    auth.requireUser(request);
    return projects.completedGraph(request, request.params.id, 'flows:edit');
  };

  app.get<{ Params: { id: string } } & Q>('/api/projects/:id/automation/flows', async (request) => store.view(projects.completedGraph(request, request.params.id)));
  app.get<{ Params: { id: string } } & Q>('/api/projects/:id/automation/coverage', async (request) => store.coverage(projects.completedGraph(request, request.params.id)));

  app.post<{ Params: { id: string; fid: string }; Body: { key?: unknown } } & Q>('/api/projects/:id/automation/flows/:fid/replace', async (request) => {
    const ctx = owned(request);
    if (typeof request.body?.key !== 'string') throw new AppError('bad_request', 'Body must be { "key": "<flow key>" }.', 400);
    return store.replace(ctx, request.params.fid, request.body.key);
  });

  app.patch<{ Params: { id: string; fid: string }; Body: { name?: unknown } } & Q>('/api/projects/:id/automation/flows/:fid', async (request) => {
    const ctx = owned(request);
    const name = request.body?.name;
    if (name !== null && typeof name !== 'string') throw new AppError('bad_request', 'Body must be { "name": string | null }.', 400);
    return store.rename(ctx, request.params.fid, name);
  });
}
