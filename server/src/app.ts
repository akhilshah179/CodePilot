import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import compress from '@fastify/compress';
import fastifyStatic from '@fastify/static';
import { SCAN_POLICY } from '@codepilot/analyzer';
import { registerAuthRoutes } from './auth/routes.ts';
import { AuthStore } from './auth/store.ts';
import type { Config } from './config.ts';
import { now, openDb, type Db } from './db.ts';
import { AppError } from './errors.ts';
import { ArchitectureStore } from './architectureStore.ts';
import { GraphStore } from './graphStore.ts';
import { AnalysisRunner } from './jobs/runner.ts';
import { registerGitHubRoutes } from './routes/github.ts';
import { registerArchitectureRoutes } from './routes/architecture.ts';
import { registerProjectRoutes, SAMPLE_PROJECT_ID } from './routes/projects.ts';
import { registerShareRoutes } from './routes/shares.ts';
import { registerCollectiveRoutes } from './routes/collective.ts';
import { CollectiveService } from './collective/service.ts';
import { CollectiveStore } from './collective/store.ts';

export interface AppContext {
  app: FastifyInstance;
  db: Db;
  runner: AnalysisRunner;
  graphs: GraphStore;
  architectures: ArchitectureStore;
  auth: AuthStore;
  collective: CollectiveService;
}

const CSP =
  "default-src 'self'; img-src 'self' data: https://avatars.githubusercontent.com https://*.googleusercontent.com; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

/** Directories of this repository that are not part of the sample's product code. */
const SAMPLE_IGNORE = ['legacy', 'packages/analyzer/test/fixtures', 'scripts', '.data', '.claude', 'graphify-out'];

export async function buildApp(config: Config, opts: { dbFile?: string; collectiveDbFile?: string; logger?: boolean } = {}): Promise<AppContext> {
  const app = Fastify({
    logger: opts.logger === false ? false : {
      level: config.production ? 'info' : 'debug',
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      serializers: {
        // OAuth callbacks carry single-use codes in the query string; never log query strings.
        req: (req) => ({ method: req.method, url: req.url.split('?')[0] }),
      },
    },
    trustProxy: config.production,
    bodyLimit: 64 * 1024,
  });
  const db = openDb(config.dataDir, opts.dbFile);
  const auth = new AuthStore(db, config);
  const graphs = new GraphStore(db);
  const architectures = new ArchitectureStore(db, app.log);
  const runner = new AnalysisRunner(db, config, auth, graphs, app.log, architectures);
  runner.recoverInterrupted();
  // Collective Intelligence: an isolated database, fed only through consent-checked fingerprints.
  const collectiveStore = new CollectiveStore(config.dataDir, opts.collectiveDbFile ?? (opts.dbFile === ':memory:' ? ':memory:' : config.collective.dbFile));
  const collective = new CollectiveService(db, collectiveStore, config.tokenKey, { minN: config.collective.minN, minCell: config.collective.minCell }, graphs, architectures, app.log);
  runner.onComplete = (projectId, analysisId) => void collective.contribute(projectId, analysisId);
  architectures.onComputed = (projectId, analysisId) => void collective.contribute(projectId, analysisId);
  collective.reaggregate();
  // Periodic aggregation and pattern discovery; discovered patterns wait for human review.
  const periodic = setInterval(() => {
    try {
      collective.reaggregate();
      collective.discover();
    } catch (err) {
      app.log.warn({ err }, 'collective aggregation failed');
    }
  }, 6 * 60 * 60_000);
  periodic.unref();

  await app.register(cookie);
  await app.register(compress, { global: true, threshold: 2048, encodings: ['br', 'gzip'] });

  app.addHook('onRequest', async (request) => {
    // CSRF: state-changing API calls must come from the app's own origin.
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.url.startsWith('/api/')) {
      const origin = request.headers.origin;
      if (origin && origin !== config.appOrigin) throw new AppError('bad_request', 'Cross-origin request rejected.', 403);
    }
  });

  app.addHook('onSend', async (request, reply, payload) => {
    // Embeds of shared, read-only views may be framed by other sites; everything else may not.
    const embed = request.url.startsWith('/embed/');
    if (String(reply.getHeader('content-type') ?? '').startsWith('text/html')) reply.header('Content-Security-Policy', embed ? CSP.replace("frame-ancestors 'none'", 'frame-ancestors *') : CSP);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (!embed) reply.header('X-Frame-Options', 'DENY');
    return payload;
  });

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send(err.toJSON());
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ code: 'bad_request', message: (err as Error).message });
    request.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ code: 'internal', message: 'Something went wrong on our side. Try again.' });
  });

  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/scan-policy', async () => SCAN_POLICY);

  registerAuthRoutes(app, config, auth);
  registerGitHubRoutes(app, config, db, auth);
  const projects = registerProjectRoutes(app, config, db, auth, runner, graphs);
  const archHandlers = registerArchitectureRoutes(app, projects, architectures);
  registerShareRoutes(app, config, db, auth, projects, archHandlers);
  registerCollectiveRoutes(app, config, auth, projects, collective);

  if (config.production && config.webDist && existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) {
        return reply.sendFile('index.html');
      }
      return reply.status(404).send({ code: 'not_found', message: 'Not found.' });
    });
  }

  app.addHook('onClose', async () => {
    clearInterval(periodic);
    await runner.shutdown();
    db.close();
    collectiveStore.close();
  });

  return { app, db, runner, graphs, architectures, auth, collective };
}

/** The public sample is a live analysis of this repository's own source code. */
export function startSampleAnalysis(ctx: AppContext, config: Config): string | undefined {
  if (!config.sampleRoot) return undefined;
  const ts = now();
  ctx.db.prepare("DELETE FROM analyses WHERE project_id = ? AND status <> 'running'").run(SAMPLE_PROJECT_ID);
  ctx.db
    .prepare(
      `INSERT INTO projects (id, user_id, owner, repo, full_name, is_private, default_branch, branch, html_url, created_at, updated_at)
       VALUES (?, NULL, 'codepilot', 'codepilot', 'codepilot/codepilot', 0, 'main', 'main', NULL, ?, ?)
       ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
    )
    .run(SAMPLE_PROJECT_ID, ts, ts);
  return ctx.runner.start(SAMPLE_PROJECT_ID, { kind: 'local', root: config.sampleRoot, ignore: SAMPLE_IGNORE, name: 'codepilot', branch: 'main' });
}
