import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthStore } from '../auth/store.ts';
import type { Config } from '../config.ts';
import { randomId, sha256 } from '../crypto.ts';
import { now, type Db } from '../db.ts';
import { AppError } from '../errors.ts';
import type { ArchitectureHandlers } from './architecture.ts';
import { projectJson, type ProjectsApi } from './projects.ts';

type Kind = 'wireframe' | 'architecture';

interface ShareRow {
  id: string;
  token_hash: string;
  project_id: string;
  analysis_id: string;
  kind: Kind;
  created_at: string;
  revoked_at: string | null;
}

/**
 * Read-only share links. A link is pinned to the analysis it was created from, grants access to
 * one view (wireframe or architecture) only, and can be revoked. Only a hash of the token is stored.
 */
export function registerShareRoutes(app: FastifyInstance, config: Config, db: Db, auth: AuthStore, projects: ProjectsApi, arch: ArchitectureHandlers) {
  app.post<{ Params: { id: string }; Body: { kind?: string } }>('/api/projects/:id/shares', async (request) => {
    const project = projects.getProject(request, request.params.id);
    if (project.user_id !== null) auth.requireUser(request);
    const kind = request.body?.kind;
    if (kind !== 'wireframe' && kind !== 'architecture') throw new AppError('bad_request', 'kind must be wireframe or architecture.', 400);
    const analysis = db.prepare("SELECT id, commit_sha FROM analyses WHERE project_id = ? AND status = 'complete' ORDER BY created_at DESC LIMIT 1").get(project.id) as { id: string; commit_sha: string | null } | undefined;
    if (!analysis) throw new AppError('not_found', 'This project has no completed analysis to share.', 404);
    const token = randomId(24);
    const id = randomId(9);
    const user = auth.userFromRequest(request);
    db.prepare('INSERT INTO shares (id, token_hash, project_id, analysis_id, kind, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, sha256(token), project.id, analysis.id, kind, user?.id ?? null, now());
    return { id, kind, token, url: `${config.appOrigin}/share/${token}`, embedUrl: `${config.appOrigin}/embed/${token}`, commitSha: analysis.commit_sha, createdAt: now() };
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/shares', async (request) => {
    const project = projects.getProject(request, request.params.id);
    const rows = db.prepare('SELECT * FROM shares WHERE project_id = ? AND revoked_at IS NULL ORDER BY created_at DESC').all(project.id) as unknown as ShareRow[];
    return { shares: rows.map((r) => ({ id: r.id, kind: r.kind, createdAt: r.created_at, analysisId: r.analysis_id })) };
  });

  app.delete<{ Params: { id: string; shareId: string } }>('/api/projects/:id/shares/:shareId', async (request) => {
    const project = projects.getProject(request, request.params.id);
    if (project.user_id !== null) auth.requireUser(request);
    const res = db.prepare('UPDATE shares SET revoked_at = ? WHERE id = ? AND project_id = ? AND revoked_at IS NULL').run(now(), request.params.shareId, project.id);
    if (!res.changes) throw new AppError('not_found', 'Share link not found.', 404);
    return { ok: true };
  });

  // --- Public, read-only endpoints -------------------------------------------------------------
  const resolve = (token: string, kind?: Kind) => {
    const row = db.prepare('SELECT * FROM shares WHERE token_hash = ? AND revoked_at IS NULL').get(sha256(token)) as ShareRow | undefined;
    if (!row || (kind && row.kind !== kind)) throw new AppError('not_found', 'This link is invalid or has been revoked.', 404);
    return { row, ctx: projects.contextFor(row.project_id, row.analysis_id) };
  };

  type R = FastifyRequest<{ Params: { token: string; nodeId?: string; toolId?: string }; Querystring: Record<string, string | undefined> }>;
  app.get('/api/shared/:token', async (r: R) => {
    const { row, ctx } = resolve(r.params.token);
    return { kind: row.kind, ...projects.graphMeta(ctx.project, ctx.analysis), project: { ...projectJson(ctx.project), isSample: true } };
  });
  app.get('/api/shared/:token/graph', async (r: R) => projects.handlers.graph(resolve(r.params.token, 'wireframe').ctx, r.query));
  app.get('/api/shared/:token/graph/layout', async (r: R) => projects.handlers.layout(resolve(r.params.token, 'wireframe').ctx, r.query));
  app.get('/api/shared/:token/graph/summary', async (r: R) => projects.handlers.summary(resolve(r.params.token, 'wireframe').ctx));
  app.get('/api/shared/:token/graph/nodes/:nodeId', async (r: R) => projects.handlers.node(resolve(r.params.token, 'wireframe').ctx, r.params.nodeId!));
  app.get('/api/shared/:token/graph/export', async (r: R, reply: FastifyReply) => projects.handlers.exportGraph(resolve(r.params.token, 'wireframe').ctx, r.query, reply));
  app.get('/api/shared/:token/architecture', async (r: R) => arch.overview(resolve(r.params.token, 'architecture').ctx));
  app.get('/api/shared/:token/architecture/tools/:toolId', async (r: R) => arch.tool(resolve(r.params.token, 'architecture').ctx, r.params.toolId!));
  app.get('/api/shared/:token/architecture/flows', async (r: R) => arch.flows(resolve(r.params.token, 'architecture').ctx));
  app.get('/api/shared/:token/architecture/summary', async (r: R) => arch.summary(resolve(r.params.token, 'architecture').ctx));
  app.get('/api/shared/:token/architecture/intelligence', async (r: R) => arch.intelligence(resolve(r.params.token, 'architecture').ctx));
  app.get('/api/shared/:token/architecture/export', async (r: R, reply: FastifyReply) => arch.exportArchitecture(resolve(r.params.token, 'architecture').ctx, r.query, reply));
  app.get('/api/shared/:token/automation/main-flows', async (r: R) => arch.mainFlows(resolve(r.params.token, 'architecture').ctx));
}
