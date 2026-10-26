import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthStore } from '../auth/store.ts';
import type { Config } from '../config.ts';
import { CollectiveService } from '../collective/service.ts';
import { AppError } from '../errors.ts';
import type { ProjectsApi } from './projects.ts';

type Q = { Querystring: { analysisId?: string } };

export function registerCollectiveRoutes(app: FastifyInstance, config: Config, auth: AuthStore, projects: ProjectsApi, service: CollectiveService) {
  // Consent: owners only, explicit boolean, logged.
  app.post<{ Params: { id: string }; Body: { enabled?: unknown } }>('/api/projects/:id/collective-intelligence/consent', async (request) => {
    const user = auth.requireUser(request);
    const project = projects.getProject(request, request.params.id, 'consent:manage');
    if (typeof request.body?.enabled !== 'boolean') throw new AppError('bad_request', 'Body must be { "enabled": true | false }.', 400);
    const res = service.setConsent(project, user.id, request.body.enabled);
    return { ...res, status: service.status(project.id, project.user_id === null) };
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/collective-intelligence/status', async (request) => {
    const project = projects.getProject(request, request.params.id, 'project:view');
    return service.status(project.id, project.user_id === null);
  });

  app.get<{ Params: { id: string } } & Q>('/api/projects/:id/benchmark', async (request) => service.benchmark(projects.completedGraph(request, request.params.id, 'project:view')));

  app.get<{ Params: { id: string } } & Q>('/api/projects/:id/pattern-insights', async (request) => service.insights(projects.completedGraph(request, request.params.id, 'project:view')));

  app.post<{ Params: { id: string; nodeId: string }; Body: { month?: unknown; source?: unknown; description?: unknown } } & Q>('/api/projects/:id/graph/nodes/:nodeId/incident-tag', async (request, reply) => {
    const user = auth.requireUser(request);
    const ctx = projects.completedGraph(request, request.params.id, 'flows:edit');
    const b = request.body ?? {};
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    reply.status(201);
    return service.tagIncident(ctx, request.params.nodeId, { month: str(b.month), source: str(b.source), description: str(b.description) }, user.id);
  });

  // Aggregate-only, k-anonymous: readable without an account.
  app.get('/api/collective-intelligence/state-of-architecture', async () => service.stateOfArchitecture());
  app.get('/api/collective-intelligence/schema', async () => ({ ...CollectiveService.schema(), policy: service.policy }));

  // Human review of discovered patterns.
  const requireReviewer = (request: FastifyRequest) => {
    const user = auth.requireUser(request);
    const logins = auth.accounts(user.id).map((a) => a.login).filter(Boolean) as string[];
    if (!config.collective.reviewers.some((r) => r === user.id || logins.includes(r))) throw new AppError('forbidden', 'Only Collective Intelligence reviewers can do this.', 403);
    return user;
  };
  app.get('/api/collective-intelligence/review', async (request) => {
    requireReviewer(request);
    return service.reviewQueue();
  });
  app.post<{ Params: { patternId: string }; Body: { decision?: unknown; claim?: unknown; note?: unknown } }>('/api/collective-intelligence/review/:patternId', async (request) => {
    requireReviewer(request);
    const { decision, claim = 'correlation', note } = request.body ?? {};
    if (decision !== 'approved' && decision !== 'rejected') throw new AppError('bad_request', 'decision must be "approved" or "rejected".', 400);
    if (claim !== 'correlation' && claim !== 'causal') throw new AppError('bad_request', 'claim must be "correlation" or "causal".', 400);
    return service.review(request.params.patternId, decision, claim, typeof note === 'string' ? note.slice(0, 2000) : null);
  });
  app.post('/api/collective-intelligence/discovery/run', async (request) => {
    requireReviewer(request);
    service.reaggregate();
    return service.discover();
  });
}
