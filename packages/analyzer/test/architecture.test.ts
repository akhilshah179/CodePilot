import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { detectArchitecture } from '../src/architecture/detect.ts';
import { snippet, stripComments } from '../src/architecture/text.ts';
import type { Architecture, ArchitectureFacts } from '../src/architecture/types.ts';
import { analyzeRepositoryWithFacts, type DependencyGraph } from '../src/index.ts';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');

async function load(name: string): Promise<{ root: string; graph: DependencyGraph; facts: ArchitectureFacts; arch: Architecture }> {
  const root = path.join(FIXTURES, name);
  const { graph, facts } = await analyzeRepositoryWithFacts(root, { repository: { name } });
  return { root, graph, facts, arch: detectArchitecture({ facts, graph }) };
}

const ids = (a: Architecture) => a.nodes.map((n) => n.id).sort();
const edge = (a: Architecture, source: string, target: string) => a.edges.find((e) => e.source === source && e.target === target);
/** A flow by its route title; user-action flows are titled `<action> → <route>`. */
const flow = (a: Architecture, title: string) => a.flows.find((f) => f.title === title || f.title.endsWith(` → ${title}`));
const shape = (f: NonNullable<ReturnType<typeof flow>>) => f.steps.map((s) => `${s.lane}/${s.kind}`);

/** Every claim cites evidence that exists, and every code line quoted as evidence is really on that line. */
function expectTraceable(root: string, arch: Architecture) {
  const cited = [...arch.nodes.flatMap((n) => [...n.evidence, ...n.badges.flatMap((b) => b.evidence)]), ...arch.edges.flatMap((e) => e.evidence), ...arch.flows.flatMap((f) => f.steps.flatMap((s) => s.evidence)), ...arch.summary.risks.flatMap((r) => r.evidence), ...arch.summary.strengths.flatMap((r) => r.evidence)];
  for (const id of cited) expect(arch.evidence[id], `evidence ${id}`).toBeDefined();
  for (const n of arch.nodes) expect(n.evidence.length, `node ${n.id}`).toBeGreaterThan(0);
  for (const e of arch.edges) expect(e.evidence.length, `edge ${e.source}->${e.target}`).toBeGreaterThan(0);
  for (const ev of Object.values(arch.evidence)) {
    const lines = readFileSync(path.join(root, ev.file), 'utf8').split('\n');
    if (ev.line) expect(ev.line, `${ev.file}:${ev.line}`).toBeLessThanOrEqual(lines.length);
    if (ev.line && ev.snippet && ['import', 'call', 'client-init', 'http-call', 'auth'].includes(ev.kind)) {
      expect(ev.snippet, `${ev.kind} ${ev.file}:${ev.line}`).toBe(snippet(lines[ev.line - 1]));
    }
  }
}

describe('architecture: Next.js + PostgreSQL (Prisma), Stripe, NextAuth', () => {
  let ctx: Awaited<ReturnType<typeof load>>;
  beforeAll(async () => {
    ctx = await load('arch-next-pg');
  });

  it('detects exactly the technologies the code uses', () => {
    expect(ids(ctx.arch)).toEqual(
      ['app:shop-web', 'client:shop-web', 'tool:nextauth', 'tool:nextjs', 'tool:nextjs-middleware', 'tool:oauth-github', 'tool:postgresql', 'tool:prisma', 'tool:react', 'tool:stripe'].sort(),
    );
    // Declared-only dev tools are not architecture; nothing is invented from common pairings.
    expect(ids(ctx.arch)).not.toContain('tool:redis');
    expect(ids(ctx.arch)).not.toContain('tool:vercel');
  });

  it('ties PostgreSQL to the Prisma datasource and draws evidence-backed connections', () => {
    const pg = ctx.arch.nodes.find((n) => n.id === 'tool:postgresql')!;
    expect(pg.confidence).toBe('confirmed');
    expect(pg.evidence.map((id) => ctx.arch.evidence[id]).some((e) => e.file === 'prisma/schema.prisma' && e.line === 2)).toBe(true);
    expect(edge(ctx.arch, 'app:shop-web', 'tool:postgresql')?.labels).toContain('SQL');
    expect(edge(ctx.arch, 'tool:stripe', 'app:shop-web')?.labels).toEqual(['webhook']);
    expect(edge(ctx.arch, 'app:shop-web', 'tool:stripe')?.labels).toContain('API call');
    expect(edge(ctx.arch, 'app:shop-web', 'tool:oauth-github')?.labels).toEqual(['OAuth']);
    expect(edge(ctx.arch, 'client:shop-web', 'app:shop-web')?.labels).toContain('REST');
    expect(ctx.arch.nodes.find((n) => n.id === 'tool:nextjs-middleware')!.badges.map((b) => b.text)).toContain('auth boundary');
  });

  it('traces the checkout request from the button to Stripe and the database', () => {
    const f = flow(ctx.arch, 'POST /api/orders')!;
    expect(f).toBeDefined();
    const nodes = f.steps.map((s) => s.node);
    // The user action is the real button: <button onClick={pay}>{done ? 'Paid' : 'Pay'}</button>.
    expect(f.action).toMatchObject({ label: 'Click “Pay”', kind: 'click', component: 'Checkout', file: 'components/Checkout.tsx', line: 10 });
    expect(f.steps[0]).toMatchObject({ lane: 'frontend', kind: 'action', file: 'components/Checkout.tsx', line: 10 });
    expect(f.steps[1]).toMatchObject({ kind: 'handler', label: 'pay()', line: 6 });
    expect(f.steps[2]).toMatchObject({ kind: 'client', file: 'components/Checkout.tsx', line: 7 });
    expect(f.steps.find((s) => s.kind === 'route')).toMatchObject({ transport: 'Fetch POST /api/orders', file: 'app/api/orders/route.ts', line: 9 });
    expect(nodes.indexOf('tool:nextjs-middleware')).toBeLessThan(nodes.indexOf('app:shop-web'));
    expect(nodes.indexOf('tool:stripe')).toBeLessThan(nodes.lastIndexOf('tool:postgresql'));
    expect(f.steps.find((s) => s.node === 'tool:stripe')).toMatchObject({ file: 'services/orders.ts', line: 9, lane: 'external', kind: 'external' });
    expect(f.steps.find((s) => s.kind === 'middleware' && s.label === 'Auth guard')).toMatchObject({ file: 'app/api/orders/route.ts', line: 10 });
    // The response path back to the UI: the handler's return, the fetch resolving, the state update.
    expect(shape(f).slice(-3)).toEqual(['backend/response', 'frontend/resolve', 'frontend/state']);
    expect(f.steps.at(-1)).toMatchObject({ label: 'State · setDone', line: 8 });
    expect(f.lanes).toEqual(['frontend', 'backend', 'external']);
    expect(f.steps.every((s) => s.latencyMs === undefined)).toBe(true);
  });

  it('keeps every claim traceable to a real line', () => expectTraceable(ctx.root, ctx.arch));
});

describe('architecture: FastAPI + Redis + Celery + PostgreSQL (Compose)', () => {
  let ctx: Awaited<ReturnType<typeof load>>;
  beforeAll(async () => {
    ctx = await load('arch-fastapi-celery');
  });

  it('finds the API and the worker built from the same code, attributed by what each runs', () => {
    expect(ctx.arch.nodes.find((n) => n.id === 'app:api')?.layer).toBe('application');
    expect(ctx.arch.nodes.find((n) => n.id === 'app:worker')?.layer).toBe('async');
    // The API reads and writes the cache and enqueues; the worker only takes tasks from the broker.
    expect(edge(ctx.arch, 'app:api', 'tool:redis')?.labels).toEqual(expect.arrayContaining(['cache read', 'cache write', 'enqueue']));
    expect(edge(ctx.arch, 'tool:redis', 'app:worker')?.labels).toEqual(['consume']);
    expect(edge(ctx.arch, 'app:worker', 'tool:redis')?.labels ?? []).not.toContain('cache read');
    // The worker's SQL connection is only configured, never called: it must not claim SQL.
    expect(edge(ctx.arch, 'app:worker', 'tool:postgresql')?.labels ?? []).not.toContain('SQL');
    expect(edge(ctx.arch, 'app:api', 'tool:postgresql')?.labels).toContain('SQL');
    expect(ctx.arch.nodes.find((n) => n.id === 'tool:redis')?.version?.value).toBe('7.2-alpine');
  });

  it('generates cache hit and cache miss variants from a real read → query → write path', () => {
    const miss = flow(ctx.arch, 'GET /api/products/{product_id}/price · cache miss')!;
    const hit = flow(ctx.arch, 'GET /api/products/{product_id}/price · cache hit')!;
    // route → handler → service → cache read (miss) → SQL → cache write → response
    expect(miss.steps.map((s) => s.mode)).toEqual(['sync', 'sync', 'sync', 'cache-miss', 'sync', 'sync', 'sync']);
    expect(miss.steps.map((s) => s.line)).toEqual([10, 10, 12, 12, 16, 18, 12]);
    expect(shape(miss)).toEqual(['backend/route', 'backend/handler', 'backend/service', 'backend/cache', 'backend/data', 'backend/cache', 'backend/response']);
    expect(miss.steps[3].branch).toBe('cache-miss');
    // A hit returns straight after the cache read.
    expect(hit.steps.map((s) => s.kind).slice(-2)).toEqual(['cache', 'response']);
    expect(hit.steps.at(-2)).toMatchObject({ mode: 'cache-hit', node: 'tool:redis', branch: 'cache-hit' });
  });

  it('follows the queue into the worker and stops at an outbound call whose target is configuration', () => {
    const f = flow(ctx.arch, 'POST /api/products/{product_id}/refresh')!;
    expect(f.steps.map((s) => [s.node, s.mode])).toEqual([
      ['app:api', 'sync'],
      ['app:api', 'sync'],
      ['app:api', 'sync'],
      ['tool:redis', 'publish'],
      ['app:api', 'sync'],
      ['app:worker', 'consume'],
      ['app:worker', 'unknown'],
    ]);
    // The response `{"queued": True}` is sent before the worker runs; the worker is a separate async branch.
    expect(shape(f)).toEqual(['backend/route', 'backend/middleware', 'backend/handler', 'backend/queue', 'backend/response', 'async/worker', 'async/unknown']);
    expect(f.steps[4]).toMatchObject({ label: 'JSON response { queued }', line: 18 });
    expect(f.steps.slice(5).every((s) => s.branch === 'async')).toBe(true);
    expect(f.truncated).toBe(true);
    expect(f.steps[6].explanation).toMatch(/Outbound call target unknown/);
    expect(f.notes.join(' ')).toMatch(/does not block the response/);
  });

  it('indexes the async flow by what it reaches and marks the unresolved hop unknown', () => {
    const f = flow(ctx.arch, 'POST /api/products/{product_id}/refresh')!;
    expect(f.steps.map((s) => s.stage)).toEqual(['backend', 'backend', 'backend', 'tools', 'response', 'services', 'external']);
    expect(f.steps[0].input).toBe('POST /api/products/{product_id}/refresh · params: product_id');
    expect(f.steps[3].input).toBe('Enqueue job "refresh_price" via refresh_price.delay()');
    expect(f.steps[6]).toMatchObject({ kind: 'unknown', confidence: 'unknown', fn: 'refresh_remote' });
    expect(f.index!.categories).toEqual(expect.arrayContaining(['queue', 'cache', 'external']));
    expect(f.index!.technologies.map((t) => t.id)).toEqual(['tool:redis']);
    // The cache branch is inferred from a read → query → write path: strong, not confirmed.
    const miss = flow(ctx.arch, 'GET /api/products/{product_id}/price · cache miss')!;
    expect(miss.steps[3]).toMatchObject({ stage: 'tools', confidence: 'strong' });
  });

  it('reports only evidence-backed risks', () => {
    const titles = ctx.arch.summary.risks.map((r) => r.title);
    expect(titles).toContain('Plain-text secrets in Compose files');
    expect(titles).toContain('Data stores publish ports on the host');
    expect(titles).toContain('Cache writes to Redis have no expiry or invalidation');
    expect(ctx.arch.summary.risks.find((r) => r.title.startsWith('Cache writes'))!.confidence).toBe('possible');
    expect(titles.some((t) => /credential/i.test(t))).toBe(false);
    expect(ctx.arch.summary.patterns.map((p) => p.name)).toEqual(['monolith']);
  });

  it('keeps every claim traceable to a real line', () => expectTraceable(ctx.root, ctx.arch));
});

describe('architecture: multi-service Compose (Node, Python, Kafka, nginx)', () => {
  let ctx: Awaited<ReturnType<typeof load>>;
  beforeAll(async () => {
    ctx = await load('arch-compose-multi');
  });

  it('wires services through Compose hostnames, proxies and topics', () => {
    expect(edge(ctx.arch, 'tool:nginx', 'app:orders')?.labels).toContain('proxy');
    const rest = edge(ctx.arch, 'app:orders', 'app:inventory')!;
    expect(rest.labels).toContain('REST');
    expect(rest.confidence).toBe('confirmed');
    expect(edge(ctx.arch, 'app:orders', 'tool:kafka')?.labels).toContain('publish');
    expect(edge(ctx.arch, 'tool:kafka', 'app:notifier')?.labels).toEqual(['consume']);
    expect(edge(ctx.arch, 'app:notifier', 'tool:smtp')?.labels).toEqual(['email']);
    // inventory declares a Kafka client but never uses it: no data-flow edge is drawn.
    expect(edge(ctx.arch, 'app:inventory', 'tool:kafka')).toBeUndefined();
    expect(ctx.arch.nodes.find((n) => n.id === 'app:notifier')?.layer).toBe('async');
  });

  it('recognizes microservices and event-driven communication from the evidence', () => {
    expect(ctx.arch.summary.patterns.map((p) => p.name).sort()).toEqual(['event-driven', 'microservices']);
  });

  it('traces a request across services and through the topic to the consumer', () => {
    const f = flow(ctx.arch, 'POST /orders')!;
    expect(f.steps.map((s) => s.node)).toEqual(['app:orders', 'app:orders', 'app:orders', 'app:inventory', 'app:inventory', 'tool:kafka', 'app:orders', 'app:notifier', 'tool:smtp']);
    expect(shape(f)).toEqual(['backend/route', 'backend/middleware', 'backend/handler', 'backend/client', 'backend/route', 'backend/queue', 'backend/response', 'async/worker', 'async/external']);
    expect(f.steps[1]).toMatchObject({ label: 'express.json', file: 'orders/src/server.js', line: 5 });
    expect(f.steps[4]).toMatchObject({ file: 'inventory/app.py', line: 7 });
    expect(f.steps[8].mode).toBe('async');
    // A service-to-service call has no UI action.
    expect(f.action).toBeUndefined();
    expect(flow(ctx.arch, 'GET /stock/<sku>')!.action).toBeUndefined();
  });

  it('keeps every claim traceable to a real line', () => expectTraceable(ctx.root, ctx.arch));
});

describe('request lifecycle: Fastify + React (hooks, client functions, UI triggers, SSE)', () => {
  let ctx: Awaited<ReturnType<typeof load>>;
  beforeAll(async () => {
    ctx = await load('arch-fastify-react');
  });

  it('extracts middleware with the code’s own description, and skips route mounts', () => {
    expect(ctx.facts.middleware.map((m) => [m.name, m.kind, m.purpose, m.line])).toEqual([
      ['@fastify/cookie', 'plugin', 'session', 6],
      ['onRequest hook', 'hook', 'security', 8],
    ]);
    expect(ctx.facts.middleware[1].note).toBe('CSRF: state-changing requests must come from our own origin.');
  });

  it('finds routes declared with type arguments and what each handler returns', () => {
    const r = (method: string, p: string) => ctx.facts.routes.find((x) => x.method === method && x.path === p)!;
    expect(r('POST', '/api/notes').response).toMatchObject({ kind: 'json', shape: '{ id, title }', line: 19 });
    expect(r('GET', '/api/notes').response).toMatchObject({ kind: 'json', shape: '{ notes }', line: 14 });
    expect(r('GET', '/api/notes/:id/events').response).toMatchObject({ kind: 'stream', line: 23 });
  });

  it('names client functions, their methods and response types, and resolves stream URLs through helpers', () => {
    const h = (line: number) => ctx.facts.httpCalls.find((x) => x.file === 'web/src/api.ts' && x.line === line)!;
    expect(h(15)).toMatchObject({ fn: 'notes', owner: 'api', method: 'GET', url: '/api/notes', responseType: '{ notes: Note[] }' });
    // The method comes from the `json()` helper: `const json = (body) => ({ method: 'POST', … })`.
    expect(h(16)).toMatchObject({ fn: 'createNote', owner: 'api', method: 'POST', url: '/api/notes', responseType: 'Note' });
    expect(ctx.facts.httpCalls.find((x) => x.file === 'web/src/NoteEvents.tsx')).toMatchObject({ client: 'EventSource', protocol: 'SSE', url: '/api/notes/:param/events' });
  });

  it('follows client functions to the UI: event, handler, component, button text and what happens next', () => {
    const t = ctx.facts.uiTriggers.find((x) => x.callee === 'api.createNote')!;
    expect(t).toMatchObject({ file: 'web/src/NewNote.tsx', line: 12, component: 'NewNote', label: 'Create note', handler: { name: 'handleCreate', line: 10 }, trigger: { kind: 'click', line: 19 } });
    expect(t.after).toEqual([expect.objectContaining({ kind: 'navigate', line: 13 })]);
    expect(ctx.facts.uiTriggers.find((x) => x.callee === 'EventSource')).toMatchObject({ component: 'NoteEvents', trigger: { kind: 'load', line: 6 } });
  });

  it('traces the user action through transport, middleware, handler, service and database, and back to the UI', () => {
    const f = flow(ctx.arch, 'POST /api/notes')!;
    expect(f.title).toBe('Click “Create note” → POST /api/notes');
    expect(shape(f)).toEqual([
      'frontend/action',
      'frontend/handler',
      'frontend/client',
      'backend/route',
      'backend/middleware',
      'backend/middleware',
      'backend/handler',
      'backend/service',
      'backend/data',
      'backend/response',
      'frontend/resolve',
      'frontend/state',
    ]);
    expect(f.steps.map((s) => s.label)).toEqual([
      'Click “Create note”',
      'handleCreate()',
      'api.createNote()',
      'POST /api/notes',
      '@fastify/cookie',
      'CSRF check',
      'Route handler',
      'createNote()',
      'PostgreSQL · pool.query()',
      'JSON response { id, title }',
      'api.createNote() resolves Note',
      'Navigate · navigate(`/notes/${note.id}`)',
    ]);
    expect(f.steps[3].transport).toBe('Fetch POST /api/notes');
    expect(f.steps[9].transport).toBe('JSON response');
  });

  it('places every step on the automation canvas with its function, inputs, outputs and confidence', () => {
    const f = flow(ctx.arch, 'POST /api/notes')!;
    expect(f.name).toBe('Click “Create note”');
    expect(f.steps.map((s) => s.stage)).toEqual(['user', 'frontend', 'transport', 'backend', 'backend', 'backend', 'backend', 'services', 'data', 'response', 'frontend', 'frontend']);
    expect(f.steps[1].fn).toBe('handleCreate');
    expect(f.steps[2]).toMatchObject({ input: 'arguments: title', output: 'Fetch POST /api/notes' });
    expect(f.steps[3].input).toBe('POST /api/notes');
    // A function reached by following references is reachable, not proven to run.
    expect(f.steps[7]).toMatchObject({ fn: 'createNote', confidence: 'strong', input: 'called at server/src/index.ts:18', output: 'defined at server/src/notes.ts:10' });
    expect(f.steps[8]).toMatchObject({ fn: 'createNote', input: 'SQL query via pool.query()', confidence: 'confirmed' });
    expect(f.steps[10].output).toBe('Note');
    expect(f.index).toMatchObject({ routes: ['POST /api/notes'], components: ['NewNote'], categories: ['database'] });
    expect(f.index!.technologies.map((t) => t.name)).toEqual(['PostgreSQL']);
    expect(f.index!.functions).toEqual(expect.arrayContaining(['handleCreate', 'createNote']));
  });

  it('shows a stream as Server-Sent Events end to end', () => {
    const f = flow(ctx.arch, 'GET /api/notes/:id/events')!;
    expect(f.action).toMatchObject({ label: 'NoteEvents loads', kind: 'load' });
    expect(f.steps.find((s) => s.kind === 'route')!.transport).toBe('EventSource GET /api/notes/:param/events');
    expect(f.steps.find((s) => s.kind === 'response')!.label).toBe('Event stream');
    expect(f.steps.at(-1)!.label).toBe('EventSource receives messages');
  });

  it('builds a system map from real components: transports by protocol, API groups, middleware chain, handlers, services', () => {
    const s = ctx.arch.system;
    expect(s.layers).toEqual(['client', 'transport', 'backend', 'services', 'data']);
    const byId = new Map(s.nodes.map((n) => [n.id, n]));
    expect(byId.get('transport:app:web->app:server:REST')).toMatchObject({ name: 'REST over HTTP', libraries: ['fetch via request()'] });
    expect(byId.get('transport:app:web->app:server:SSE')).toMatchObject({ name: 'Server-Sent Events', libraries: ['EventSource'] });
    expect(byId.get('api:app:server:/api/notes')!.routes!.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/notes', 'POST /api/notes', 'GET /api/notes/:id/events']);
    const l = (a: string, b: string) => s.links.find((x) => x.source === a && x.target === b);
    expect(l('api:app:server:/api/notes', 'mw:server/src/index.ts:6')).toBeDefined();
    expect(l('mw:server/src/index.ts:6', 'mw:server/src/index.ts:8')).toBeDefined();
    expect(byId.get('mw:server/src/index.ts:8')!.name).toBe('CSRF check');
    expect(l('mw:server/src/index.ts:8', 'handler:server/src/index.ts')).toBeDefined();
    expect(l('handler:server/src/index.ts', 'svc:server/src/notes.ts')).toBeDefined();
    expect(l('svc:server/src/notes.ts', 'tool:postgresql')).toMatchObject({ label: 'SQL', count: 2 });
    // Every link and component cites evidence that exists.
    for (const x of [...s.links.flatMap((x) => x.evidence), ...s.nodes.flatMap((n) => n.evidence)]) expect(ctx.arch.evidence[x]).toBeDefined();
  });

  it('keeps every claim traceable to a real line', () => expectTraceable(ctx.root, ctx.arch));
});

describe('architecture: system map on multi-service and worker repositories', () => {
  it('routes service-to-service calls through a transport into the callee’s API, and proxies to API groups', async () => {
    const { arch } = await load('arch-compose-multi');
    const l = (a: string, b: string) => arch.system.links.find((x) => x.source === a && x.target === b);
    expect(l('handler:orders/src/server.js', 'transport:handler:orders/src/server.js->app:inventory:REST')).toBeDefined();
    expect(l('transport:handler:orders/src/server.js->app:inventory:REST', 'api:app:inventory:/stock')).toBeDefined();
    expect(l('tool:nginx', 'api:app:orders:/orders')).toBeDefined();
    expect(l('handler:orders/src/server.js', 'tool:kafka')).toMatchObject({ async: true, label: 'publish' });
    expect(arch.system.nodes.some((n) => n.id === 'app:inventory' || n.id === 'app:orders')).toBe(false);
  });

  it('separates the async enqueue from data calls and marks targets it cannot resolve as unknown', async () => {
    const { arch } = await load('arch-fastapi-celery');
    const l = (a: string, b: string) => arch.system.links.find((x) => x.source === a && x.target === b);
    expect(l('handler:backend/app/api/products.py', 'tool:redis')).toMatchObject({ async: true, label: 'enqueue' });
    expect(l('svc:backend/app/services/pricing.py', 'tool:redis')).toMatchObject({ async: false, label: 'cache read · cache write' });
    expect(l('svc:backend/app/services/pricing.py', 'tool:postgresql')!.label).toBe('SQL · SQLAlchemy');
    expect(l('tool:redis', 'app:worker')).toMatchObject({ async: true, label: 'consume' });
    expect(arch.system.nodes.find((n) => n.id === 'unknown:app:api')).toMatchObject({ confidence: 'possible', detail: 'URL from PRICING_API_URL · 1 call site' });
  });
});

describe('technology intelligence', () => {
  const tech = (a: Architecture, id: string) => a.technologies.find((t) => t.id === id)!;
  const cited = (a: Architecture, t: Architecture['technologies'][number]) => [...t.evidence, ...t.role.evidence, ...t.why.evidence].every((id) => !!a.evidence[id]);

  it('explains Redis from the operations the code performs, per component and purpose', async () => {
    const { arch } = await load('arch-fastapi-celery');
    const t = tech(arch, 'tool:redis');
    expect(t.why.confidence).toBe('confirmed');
    expect(t.why.text).toMatch(/^Used for caching \(pricing reads from and writes to it\) and queueing background jobs \(products\.py enqueues jobs on it\) through the `cache` client created at backend\/app\/cache\.py:5/);
    expect(t.operations.map((o) => `${o.op}×${o.count}`).sort()).toEqual(['cache-read×1', 'cache-write×1', 'enqueue×1']);
    expect(t.functions.map((f) => `${f.name}@${f.file}:${f.line}`)).toEqual(['refresh@backend/app/api/products.py:15', 'get_price@backend/app/services/pricing.py:11']);
    expect(t.routes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/products/{product_id}/price', 'POST /api/products/{product_id}/refresh']);
    expect(t.flows.length).toBeGreaterThan(0);
    expect(t.graph.nodes.find((n) => n.focus)?.id).toBe('tool:redis');
    // "General" text is catalog knowledge, kept apart from the project-specific role.
    expect(t.role.text).not.toContain(t.general ?? '§');
    expect(cited(arch, t)).toBe(true);
  });

  it('describes frameworks by the routes they serve, tools by the scripts that run them, middleware by its registration', async () => {
    const { arch } = await load('arch-fastify-react');
    expect(tech(arch, 'tool:fastify').role.text).toBe('Serves 3 HTTP routes in server, e.g. GET /api/notes (server/src/index.ts:13).');
    const vite = tech(arch, 'lib:vite');
    expect(vite.scripts.map((s) => s.name)).toEqual(['dev', 'build']);
    expect(vite.why.confidence).toBe('strong');
    const cookie = tech(arch, 'lib:@fastify/cookie');
    expect(cookie.role.text).toMatch(/registered as request middleware in server \(server\/src\/index\.ts:6\)/);
    expect(tech(arch, 'tool:postgresql').why.text).toMatch(/^Used for storing and querying data \(notes runs SQL on it\) through the `pool` client created at server\/src\/notes\.ts:3/);
    for (const t of arch.technologies) expect(cited(arch, t)).toBe(true);
  });

  it('says when a purpose cannot be determined instead of inventing one', async () => {
    const { arch } = await load('arch-fastify-react');
    const router = tech(arch, 'lib:react-router');
    expect(router.role.text).toBe('Imported in 1 file of web (NewNote.tsx), which use its `useNavigate` export.');
    expect(router.why.confidence).toBe('unknown');
    expect(router.why.text.startsWith('Purpose could not be confidently determined from the available source.')).toBe(true);
    // A UI library is only "most likely" the UI library: imports alone are strong inference, not proof.
    expect(tech(arch, 'tool:react').why.confidence).toBe('strong');
    const next = await load('arch-next-pg');
    expect(tech(next.arch, 'tool:oauth-github').why.confidence).toBe('unknown');
  });

  it('describes infrastructure by what its configuration builds, hosts and routes', async () => {
    const { arch } = await load('arch-compose-multi');
    expect(tech(arch, 'tool:nginx').role.text).toBe('Routes requests to orders (gateway/nginx.conf).');
    expect(tech(arch, 'tool:docker').why.text).toMatch(/^Used to build inventory, notifier and orders/);
    expect(tech(arch, 'tool:kafka').role.text).toMatch(/through its clients `consumer` \(notifier\/index\.js:5\) and `producer` \(orders\/src\/kafka\.js:4\)/);
  });
});

describe('source text', () => {
  it('keeps regex literals intact so quotes inside them do not hide later comments', () => {
    const src = ["const q = /[\"'`]/;", "// a comment with `new EventSource(url)` in it", "const x = a / b / c; // divide"].join('\n');
    const lines = stripComments(src, 'c');
    expect(lines[0]).toBe("const q = /[\"'`]/;");
    expect(lines[1].trim()).toBe('');
    expect(lines[2]).toMatch(/^const x = a \/ b \/ c;\s*$/);
  });
});

describe('architecture: determinism and degenerate repositories', () => {
  it('produces the same architecture for the same input', async () => {
    const a = await load('arch-compose-multi');
    const b = await load('arch-compose-multi');
    expect({ ...b.arch, generatedAt: '' }).toEqual({ ...a.arch, generatedAt: '' });
  });

  it('still describes a repository with no recognizable architecture, and says why', async () => {
    const { arch } = await load('basic-repo');
    expect(arch.nodes.some((n) => n.kind === 'app')).toBe(true);
    expect(arch.layers.length).toBeGreaterThan(0);
    for (const n of arch.nodes) expect(n.evidence.length).toBeGreaterThan(0);
  });
});
