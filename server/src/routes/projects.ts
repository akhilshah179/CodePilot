import { Resvg } from '@resvg/resvg-js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { renderGraphSvg } from '@codepilot/analyzer/svg';
import type { AuthStore, User } from '../auth/store.ts';
import type { Config } from '../config.ts';
import { randomId } from '../crypto.ts';
import { now, type Db } from '../db.ts';
import { AppError } from '../errors.ts';
import { GitHubClient } from '../github.ts';
import { isLayout, nodeDetails, selectSubgraph, type GraphIndex, type GraphStore } from '../graphStore.ts';
import type { AnalysisEvent, AnalysisRunner } from '../jobs/runner.ts';

export interface ProjectRow {
  id: string;
  user_id: string | null;
  owner: string;
  repo: string;
  full_name: string;
  is_private: number;
  default_branch: string | null;
  branch: string;
  html_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface AnalysisRow {
  id: string;
  project_id: string;
  branch: string;
  status: 'queued' | 'running' | 'complete' | 'failed';
  stage: string;
  files_scanned: number;
  nodes_classified: number;
  edges_found: number;
  commit_sha: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export const SAMPLE_PROJECT_ID = 'sample';

export interface GraphContext {
  project: ProjectRow;
  analysis: AnalysisRow;
  index: GraphIndex;
}

type GraphQueryString = { analysisId?: string; layout?: string; types?: string; focus?: string; depth?: string; format?: string };

/** What other route modules (architecture, shares) reuse from the project API. */
export interface ProjectsApi {
  getProject(request: FastifyRequest, id: string): ProjectRow;
  completedGraph(request: FastifyRequest<{ Querystring: { analysisId?: string } }>, projectId: string): GraphContext;
  /** A specific completed analysis, without access checks (callers must have checked access). */
  contextFor(projectId: string, analysisId: string): GraphContext;
  graphMeta(project: ProjectRow, analysis: AnalysisRow): { project: ReturnType<typeof projectJson>; analysis: { id: string; branch: string; commitSha: string | null; finishedAt: string | null } };
  handlers: {
    graph(ctx: GraphContext, q: GraphQueryString): unknown;
    layout(ctx: GraphContext, q: GraphQueryString): unknown;
    summary(ctx: GraphContext): unknown;
    node(ctx: GraphContext, nodeId: string): unknown;
    exportGraph(ctx: GraphContext, q: GraphQueryString, reply: FastifyReply): Promise<unknown>;
  };
}

export function projectJson(p: ProjectRow) {
  return {
    id: p.id,
    owner: p.owner,
    repo: p.repo,
    fullName: p.full_name,
    private: !!p.is_private,
    defaultBranch: p.default_branch,
    branch: p.branch,
    htmlUrl: p.html_url,
    isSample: p.user_id === null,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

function analysisJson(a: AnalysisRow | undefined) {
  if (!a) return null;
  return {
    id: a.id,
    branch: a.branch,
    status: a.status,
    stage: a.stage,
    counters: { filesScanned: a.files_scanned, nodesClassified: a.nodes_classified, edgesFound: a.edges_found },
    commitSha: a.commit_sha,
    error: a.error_code ? { code: a.error_code, message: a.error_message } : null,
    createdAt: a.created_at,
    finishedAt: a.finished_at,
  };
}

export function registerProjectRoutes(app: FastifyInstance, config: Config, db: Db, auth: AuthStore, runner: AnalysisRunner, graphs: GraphStore): ProjectsApi {
  const getProject = (request: FastifyRequest, id: string): ProjectRow => {
    const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    if (!p) throw new AppError('not_found', 'Project not found.', 404);
    if (p.user_id !== null) {
      const user = auth.userFromRequest(request);
      // Other users' projects are indistinguishable from missing ones.
      if (!user || user.id !== p.user_id) throw new AppError('not_found', 'Project not found.', 404);
    }
    return p;
  };

  const latestAnalysis = (projectId: string, status?: string) =>
    (status
      ? db.prepare('SELECT * FROM analyses WHERE project_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1').get(projectId, status)
      : db.prepare('SELECT * FROM analyses WHERE project_id = ? ORDER BY created_at DESC LIMIT 1').get(projectId)) as AnalysisRow | undefined;

  const completedGraph = (request: FastifyRequest<{ Querystring: { analysisId?: string } }>, projectId: string) => {
    const project = getProject(request, projectId);
    const analysis = request.query.analysisId
      ? (db.prepare("SELECT * FROM analyses WHERE id = ? AND project_id = ? AND status = 'complete'").get(request.query.analysisId, projectId) as AnalysisRow | undefined)
      : latestAnalysis(projectId, 'complete');
    if (!analysis) throw new AppError('not_found', 'This project has no completed analysis yet.', 404);
    const index = graphs.load(analysis.id);
    if (!index) throw new AppError('not_found', 'Graph data for this analysis is missing. Run the analysis again.', 404);
    return { project, analysis, index };
  };

  app.get('/api/sample', async () => {
    const a = latestAnalysis(SAMPLE_PROJECT_ID);
    return { projectId: a ? SAMPLE_PROJECT_ID : null, status: a?.status ?? null };
  });

  app.get('/api/projects', async (request) => {
    const user = auth.requireUser(request);
    const rows = db.prepare('SELECT * FROM projects WHERE user_id = ? ORDER BY updated_at DESC').all(user.id) as unknown as ProjectRow[];
    return { projects: rows.map((p) => ({ ...projectJson(p), analysis: analysisJson(latestAnalysis(p.id)) })) };
  });

  app.post<{ Body: { owner?: string; repo?: string; branch?: string } }>('/api/projects', async (request) => {
    const user = auth.requireUser(request);
    const { owner, repo, branch } = request.body ?? {};
    if (typeof owner !== 'string' || typeof repo !== 'string' || typeof branch !== 'string' || !owner || !repo || !branch) {
      throw new AppError('bad_request', 'owner, repo and branch are required.', 400);
    }
    // Confirms the user can read this repository with their own GitHub authorization.
    const meta = await new GitHubClient(config.github.apiUrl, auth.githubToken(user.id)).repo(owner, repo);
    const existing = db.prepare('SELECT * FROM projects WHERE user_id = ? AND full_name = ?').get(user.id, meta.fullName) as ProjectRow | undefined;
    const ts = now();
    let projectId: string;
    if (existing) {
      projectId = existing.id;
      db.prepare('UPDATE projects SET branch = ?, default_branch = ?, is_private = ?, html_url = ?, updated_at = ? WHERE id = ?').run(
        branch,
        meta.defaultBranch,
        meta.private ? 1 : 0,
        meta.htmlUrl,
        ts,
        projectId,
      );
    } else {
      projectId = randomId(9);
      db.prepare(
        'INSERT INTO projects (id, user_id, owner, repo, full_name, is_private, default_branch, branch, html_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(projectId, user.id, meta.owner, meta.name, meta.fullName, meta.private ? 1 : 0, meta.defaultBranch, branch, meta.htmlUrl, ts, ts);
    }
    const running = db.prepare("SELECT id FROM analyses WHERE project_id = ? AND status IN ('queued', 'running')").get(projectId) as { id: string } | undefined;
    const analysisId = running?.id ?? runner.start(projectId, { kind: 'github', userId: user.id, owner: meta.owner, repo: meta.name, branch });
    return { projectId, analysisId };
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (request) => {
    const project = getProject(request, request.params.id);
    return {
      project: projectJson(project),
      analysis: analysisJson(latestAnalysis(project.id)),
      completed: analysisJson(latestAnalysis(project.id, 'complete')),
    };
  });

  /**
   * Completed analysis snapshots of a project, newest first: project → branch → commit → analysis.
   * Each keeps its own graph, architecture and flows, so older results stay viewable.
   */
  app.get<{ Params: { id: string } }>('/api/projects/:id/snapshots', async (request) => {
    const project = getProject(request, request.params.id);
    // Only snapshots whose graph is still stored can be opened.
    const rows = db
      .prepare("SELECT a.* FROM analyses a JOIN graphs g ON g.analysis_id = a.id WHERE a.project_id = ? AND a.status = 'complete' ORDER BY COALESCE(a.finished_at, a.created_at) DESC LIMIT 50")
      .all(project.id) as unknown as AnalysisRow[];
    const latest = rows[0]?.id;
    return {
      snapshots: rows.map((a) => ({ analysisId: a.id, branch: a.branch, commitSha: a.commit_sha, finishedAt: a.finished_at, current: a.id === latest })),
    };
  });

  // --- Analysis progress (Server-Sent Events) ------------------------------
  app.get<{ Params: { id: string }; Querystring: { analysisId?: string } }>('/api/projects/:id/analysis/stream', async (request, reply) => {
    const project = getProject(request, request.params.id);
    const analysis = request.query.analysisId
      ? (db.prepare('SELECT * FROM analyses WHERE id = ? AND project_id = ?').get(request.query.analysisId, project.id) as AnalysisRow | undefined)
      : latestAnalysis(project.id);
    if (!analysis) throw new AppError('not_found', 'No analysis found for this project.', 404);

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event: string, data: unknown) => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const end = () => {
      clearInterval(heartbeat);
      unsubscribe();
      if (!res.writableEnded) res.end();
    };
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
    let unsubscribe = () => {};

    const live = runner.snapshot(analysis.id);
    if (live) {
      send('snapshot', live);
      if (live.stage === 'complete') {
        send('complete', { analysisId: analysis.id, projectId: project.id });
        return end();
      }
      if (live.stage === 'failed') {
        send('failure', live.error);
        return end();
      }
      unsubscribe = runner.subscribe(analysis.id, (e: AnalysisEvent) => {
        if (e.type === 'stage') send('stage', { stage: e.stage });
        else if (e.type === 'progress') send('progress', e.counters);
        else if (e.type === 'partial') send('partial', { nodes: e.nodes, edges: e.edges });
        else if (e.type === 'complete') {
          send('complete', { analysisId: e.analysisId, projectId: e.projectId });
          end();
        } else if (e.type === 'error') {
          send('failure', e.error);
          end();
        }
      });
    } else {
      // Not running in this process: report the stored terminal state.
      const counters = { filesScanned: analysis.files_scanned, nodesClassified: analysis.nodes_classified, edgesFound: analysis.edges_found };
      send('snapshot', { analysisId: analysis.id, projectId: project.id, stage: analysis.stage, counters, partial: { nodes: [], edges: [] } });
      if (analysis.status === 'complete') send('complete', { analysisId: analysis.id, projectId: project.id });
      else send('failure', { code: analysis.error_code ?? 'interrupted', message: analysis.error_message ?? 'Analysis was interrupted by a server restart. Start it again.' });
      return end();
    }
    request.raw.on('close', end);
  });

  // --- Graph API ------------------------------------------------------------
  type GraphReq = FastifyRequest<{ Params: { id: string }; Querystring: GraphQueryString }>;

  const graphMeta = (project: ProjectRow, analysis: AnalysisRow) => ({
    project: projectJson(project),
    analysis: { id: analysis.id, branch: analysis.branch, commitSha: analysis.commit_sha, finishedAt: analysis.finished_at },
  });

  const contextFor = (projectId: string, analysisId: string): GraphContext => {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow | undefined;
    const analysis = db.prepare("SELECT * FROM analyses WHERE id = ? AND project_id = ? AND status = 'complete'").get(analysisId, projectId) as AnalysisRow | undefined;
    if (!project || !analysis) throw new AppError('not_found', 'This analysis is no longer available.', 404);
    const index = graphs.load(analysis.id);
    if (!index) throw new AppError('not_found', 'Graph data for this analysis is missing. Run the analysis again.', 404);
    return { project, analysis, index };
  };

  const typesOf = (q: GraphQueryString) => (q.types ? q.types.split(',').filter(Boolean) : undefined);

  const handlers: ProjectsApi['handlers'] = {
    graph({ project, analysis, index }, q) {
      const layout = q.layout ?? 'force';
      if (!isLayout(layout)) throw new AppError('bad_request', 'layout must be one of force, circular, layered, type, directory.', 400);
      const positions = graphs.positions(analysis.id, layout);
      const { nodes, edges } = selectSubgraph(index, { types: typesOf(q), focus: q.focus, depth: q.depth ? Number(q.depth) : undefined });
      const summary = index.graph.summary;
      return {
        ...graphMeta(project, analysis),
        layout,
        nodes: nodes.map((n) => {
          const exports = index.graph.files[n.id]?.exports ?? [];
          return { ...n, x: positions[n.id]?.[0] ?? 0, y: positions[n.id]?.[1] ?? 0, exportsPreview: exports.slice(0, 3).map((e) => e.name), exportCount: exports.length };
        }),
        edges,
        cycles: summary.cycles,
        orphans: summary.orphans.map((o) => o.id),
        entryPoints: summary.entryPoints.map((e) => e.id),
        frameworks: index.graph.frameworks,
        scan: index.graph.scan,
        warnings: index.graph.warnings,
      };
    },
    layout({ analysis }, q) {
      const layout = q.layout ?? 'force';
      if (!isLayout(layout)) throw new AppError('bad_request', 'layout must be one of force, circular, layered, type, directory.', 400);
      return { layout, positions: graphs.positions(analysis.id, layout) };
    },
    summary({ project, analysis, index }) {
      const unresolvedEdges = index.graph.edges.filter((e) => !e.resolved);
      return {
        ...graphMeta(project, analysis),
        summary: index.graph.summary,
        unresolved: {
          total: unresolvedEdges.length,
          items: unresolvedEdges.slice(0, 200).map((e) => ({ source: e.source, specifier: e.specifier, line: e.line, reason: e.unresolved_reason ?? '' })),
        },
        frameworks: index.graph.frameworks,
        scan: index.graph.scan,
        warnings: index.graph.warnings,
      };
    },
    node({ index }, nodeId) {
      const details = nodeDetails(index, nodeId);
      if (!details) throw new AppError('not_found', 'Node not found in this analysis.', 404);
      return details;
    },
    async exportGraph({ project, analysis, index }, q, reply) {
      const format = q.format ?? 'json';
      const base = `${project.full_name.replace('/', '-')}-${(analysis.commit_sha ?? analysis.id).slice(0, 7)}-graph`;
      const { nodes, edges } = selectSubgraph(index, { types: typesOf(q) });

      if (format === 'json') {
        const ids = new Set(nodes.map((n) => n.id));
        reply.header('Content-Disposition', `attachment; filename="${base}.json"`);
        return {
          repository: {
            fullName: project.full_name,
            url: project.html_url,
            branch: analysis.branch,
            commitSha: analysis.commit_sha,
            analyzedAt: analysis.finished_at,
          },
          generator: { name: 'CodePilot', graphVersion: index.graph.version },
          frameworks: index.graph.frameworks,
          nodes,
          edges,
          files: Object.fromEntries(Object.entries(index.graph.files).filter(([id]) => ids.has(id))),
          summary: index.graph.summary,
        };
      }
      if (format !== 'svg' && format !== 'png') throw new AppError('bad_request', 'format must be json, svg or png.', 400);
      const layout = isLayout(q.layout) ? q.layout : 'force';
      const svg = renderGraphSvg(nodes, edges, graphs.positions(analysis.id, layout), {
        title: project.user_id === null ? 'CodePilot (sample project)' : project.full_name,
        subtitle: `${analysis.branch}${analysis.commit_sha ? ' @ ' + analysis.commit_sha.slice(0, 7) : ''} · ${nodes.length} nodes · ${edges.length} edges · ${layout} layout`,
      });
      reply.header('Content-Disposition', `attachment; filename="${base}.${format}"`);
      if (format === 'svg') return reply.type('image/svg+xml').send(svg);
      return reply.type('image/png').send(svgToPng(svg));
    },
  };

  app.get('/api/projects/:id/graph', async (request: GraphReq) => handlers.graph(completedGraph(request, request.params.id), request.query));
  app.get('/api/projects/:id/graph/layout', async (request: GraphReq) => handlers.layout(completedGraph(request, request.params.id), request.query));
  app.get('/api/projects/:id/graph/summary', async (request: GraphReq) => handlers.summary(completedGraph(request, request.params.id)));
  app.get('/api/projects/:id/graph/nodes/:nodeId', async (request: FastifyRequest<{ Params: { id: string; nodeId: string }; Querystring: { analysisId?: string } }>) =>
    handlers.node(completedGraph(request, request.params.id), request.params.nodeId),
  );
  app.get('/api/projects/:id/graph/export', async (request: GraphReq, reply: FastifyReply) => handlers.exportGraph(completedGraph(request, request.params.id), request.query, reply));

  return { getProject, completedGraph, contextFor, graphMeta, handlers };
}

/** Render an SVG to PNG at up to 2x, capped so very large drawings stay within a sane bitmap size. */
export function svgToPng(svg: string): Buffer {
  const [w, h] = [/width="(\d+)"/, /height="(\d+)"/].map((re) => Number(re.exec(svg)?.[1] ?? 1000));
  const zoom = Math.min(2, 8000 / Math.max(w, h));
  return new Resvg(svg, { fitTo: { mode: 'zoom', value: zoom }, font: { loadSystemFonts: true, defaultFontFamily: 'Helvetica' } }).render().asPng();
}

export type { User };
