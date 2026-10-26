import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectArchitecture } from '../src/architecture/detect.ts';
import type { Architecture, ArchitectureFacts, Flow, FlowStep } from '../src/architecture/types.ts';
import { AUTOMATION_SCHEMA_VERSION, buildAutomation, coverageFor, isBanned, layoutFlow, layoutProblems, type AutomationResult, type MainFlow } from '../src/automation/index.ts';
import { analyzeRepositoryWithFacts, type DependencyGraph } from '../src/index.ts';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const cache = new Map<string, Promise<{ result: AutomationResult; root: string }>>();

function automation(name: string) {
  if (!cache.has(name))
    cache.set(
      name,
      (async () => {
        const root = path.join(FIXTURES, name);
        const { graph, facts } = await analyzeRepositoryWithFacts(root, { repository: { name } });
        const arch = detectArchitecture({ facts, graph });
        return { result: buildAutomation({ arch, facts, graph, projectName: name }), root };
      })(),
    );
  return cache.get(name)!;
}

const selected = (r: AutomationResult) => r.flows.filter((f) => r.selected.includes(f.key));
const byName = (r: AutomationResult, name: string) => r.flows.find((f) => f.name === name);
const texts = (f: MainFlow): string[] => {
  const x = f.explanation;
  const items = [...x.what, ...x.steps, ...x.data.inputs, ...x.data.stored, ...x.data.returned, ...x.decisions, ...x.tools, ...x.folded, ...x.confidence.unknown];
  return [f.name, f.purpose, ...f.nodes.map((n) => n.label), ...f.edges.map((e) => e.label ?? ''), ...items.map((i) => i.text)];
};

function checkFlow(f: MainFlow, root: string) {
  // Exactly one trigger, at least one end, every node reachable from the trigger.
  const triggers = f.nodes.filter((n) => n.type === 'trigger');
  expect(triggers, f.name).toHaveLength(1);
  expect(f.nodes.some((n) => n.type === 'end'), f.name).toBe(true);
  const out = new Map<string, string[]>();
  for (const e of f.edges) out.set(e.source, [...(out.get(e.source) ?? []), e.target]);
  const seen = new Set([triggers[0].id]);
  const stack = [triggers[0].id];
  while (stack.length) for (const t of out.get(stack.pop()!) ?? []) if (!seen.has(t)) (seen.add(t), stack.push(t));
  expect(f.nodes.filter((n) => !seen.has(n.id)).map((n) => n.label), f.name).toEqual([]);
  // Evidence on every node and edge, pointing at files of the repository.
  for (const n of f.nodes) {
    expect(n.evidence.length, n.label).toBeGreaterThan(0);
    for (const e of n.evidence) expect(existsSync(path.join(root, e.file)), `${n.label}: ${e.file}`).toBe(true);
  }
  for (const e of f.edges) expect(e.evidence.length, e.id).toBeGreaterThan(0);
  // Tool chips are exactly the union of the nodes' tools.
  expect(f.tools.map((t) => t.id).sort()).toEqual([...new Set(f.nodes.flatMap((n) => n.tools))].sort());
  // Backend files never sit in the frontend lane.
  for (const n of f.nodes) if (/(^|\/)(server|backend|api)\//.test(n.file) && !/(^|\/)(web|frontend|client|components|pages)\//.test(n.file)) expect(n.lane, `${n.label} ${n.file}`).not.toBe('frontend');
  // Layout: finite, distinct, no overlapping boxes — in every mode.
  for (const swimlanes of [true, false])
    for (const spacing of ['compact', 'spacious'] as const)
      for (const direction of ['LR', 'TB'] as const) {
        const layout = layoutFlow(f.nodes, f.edges, { swimlanes, spacing, direction });
        expect(layoutProblems(layout), `${f.name} ${swimlanes} ${spacing} ${direction}`).toEqual([]);
        if (f.nodes.length > 1) expect(new Set(Object.values(layout.nodes).map((p) => (direction === 'LR' ? p.x : p.y))).size).toBeGreaterThan(1);
      }
  // No banned filler anywhere.
  for (const t of texts(f)) expect(isBanned(t), t).toBe(false);
  expect(f.problems).toEqual([]);
}

const ALL = ['arch-fastify-react', 'arch-fastapi-celery', 'auto-static', 'arch-next-pg', 'arch-compose-multi', 'auto-cli', 'auto-script', 'auto-rust'];

describe('automation engine: every project yields readable, evidence-backed main flows', () => {
  for (const name of ALL)
    it(`${name}: 1–4 valid flows (or the fallback), with counts that add up`, async () => {
      const { result, root } = await automation(name);
      expect(result.schemaVersion).toBe(AUTOMATION_SCHEMA_VERSION);
      const flows = selected(result);
      expect(flows.length).toBeGreaterThanOrEqual(1);
      expect(flows.length).toBeLessThanOrEqual(4);
      for (const f of flows) checkFlow(f, root);
      const c = result.coverage;
      expect(c.shown.length + c.folded.length + c.omitted.length).toBe(c.total);
      expect(coverageFor(result, result.selected)).toEqual(c);
    });

  it('is deterministic for the same input', async () => {
    const root = path.join(FIXTURES, 'arch-next-pg');
    const a = await analyzeRepositoryWithFacts(root, { repository: { name: 'x' } });
    const b = await analyzeRepositoryWithFacts(root, { repository: { name: 'x' } });
    const ra = buildAutomation({ arch: detectArchitecture({ facts: a.facts, graph: a.graph }), facts: a.facts, graph: a.graph, projectName: 'x' });
    const rb = buildAutomation({ arch: detectArchitecture({ facts: b.facts, graph: b.graph }), facts: b.facts, graph: b.graph, projectName: 'x' });
    expect(JSON.stringify(ra)).toBe(JSON.stringify(rb));
  });
});

describe('automation engine: flows read like the code', () => {
  it('full-stack: names the main action, draws the CSRF decision with its real outcome, labels data from the code', async () => {
    const { result } = await automation('arch-fastify-react');
    expect(result.projectType).toBe('full-stack');
    const core = byName(result, 'User creates a note')!;
    expect(core.cycle).toBe('core');
    expect(selected(result).map((f) => f.cycle).sort()).toEqual(['background', 'core', 'data']);
    const decision = core.nodes.find((n) => n.type === 'decision')!;
    expect(decision.file).toBe('server/src/index.ts');
    const exit = core.edges.find((e) => e.source === decision.id && core.nodes.find((n) => n.id === e.target)?.type === 'end')!;
    expect(core.nodes.find((n) => n.id === exit.target)!.label).toBe('Throws “Cross-origin request rejected”');
    expect(core.edges.some((e) => e.label === 'title')).toBe(true);
    expect(core.tools.map((t) => t.name)).toEqual(['PostgreSQL']);
    expect(core.explanation.what[0].text).toMatch(/^User creates a note: it starts with Click “Create note” \(web\/src\/NewNote\.tsx:\d+\)\.$/);
    expect(core.explanation.steps.length).toBe(core.nodes.filter((n) => n.type !== 'group').length);
  });

  it('backend API: a cache hit returns early, background work is a separate async branch, unknowns are explicit', async () => {
    const { result } = await automation('arch-fastapi-celery');
    expect(result.projectType).toBe('backend-api');
    const price = selected(result).find((f) => f.nodes.some((n) => n.label === 'Cached?'))!;
    const cached = price.nodes.find((n) => n.label === 'Cached?')!;
    expect(price.edges.find((e) => e.source === cached.id && e.kind === 'true')?.label).toBe('Yes');
    expect(price.edges.find((e) => e.source === cached.id && e.kind === 'false')?.label).toBe('No');
    const refresh = selected(result).find((f) => f.edges.some((e) => e.kind === 'async'))!;
    expect(refresh.nodes.some((n) => n.type === 'unknown' && n.lane === 'external')).toBe(true);
    expect(refresh.confidence.percent).toBeLessThan(100);
    expect(refresh.explanation.confidence.unknown[0].text).toMatch(/target unknown|not written/i);
    expect(refresh.nodes.find((n) => n.type === 'job' && n.lane === 'background')).toBeDefined();
  });

  it('Next.js: the guard is one decision with the real 401 outcome; webhooks are named by their sender', async () => {
    const { result } = await automation('arch-next-pg');
    expect(result.projectType).toBe('nextjs');
    const pay = byName(result, 'User pays order')!;
    const signedIn = pay.nodes.filter((n) => n.label === 'Signed in?');
    expect(signedIn).toHaveLength(1);
    const exit = pay.edges.find((e) => e.source === signedIn[0].id && e.label === 'No')!;
    expect(pay.nodes.find((n) => n.id === exit.target)!.label).toBe('401 response');
    expect(pay.tools.map((t) => t.name).sort()).toEqual(['PostgreSQL', 'Stripe']);
    const hook = byName(result, 'Stripe sends a webhook event')!;
    expect(hook.cycle).toBe('background');
    expect(hook.nodes[0]).toMatchObject({ type: 'trigger', label: 'POST /api/webhooks/stripe' });
  });

  it('multi-service: the queued notification runs as an async branch into the consumer service', async () => {
    const { result } = await automation('arch-compose-multi');
    expect(result.projectType).toBe('microservices');
    const order = selected(result).find((f) => f.edges.some((e) => e.kind === 'async'))!;
    const asyncEdge = order.edges.find((e) => e.kind === 'async')!;
    expect(asyncEdge.label).toBe('order-created');
    expect(order.nodes.find((n) => n.id === asyncEdge.target)!.type).toBe('job');
  });

  it('client-only frontend: a UI event calling an external API, never a blank page', async () => {
    const { result } = await automation('auto-static');
    expect(result.projectType).toBe('static-frontend');
    expect(result.diagnostics.fallback?.kind).toBe('client');
    const f = selected(result)[0];
    expect(f.name).toBe('User searches books');
    expect(f.nodes.map((n) => n.type)).toEqual(['trigger', 'ui', 'external', 'end']);
    expect(f.nodes[2].label).toBe('GET openlibrary.org');
  });

  it('CLI, script and unsupported language: the real import chain, or an honest stop', async () => {
    const cli = (await automation('auto-cli')).result;
    expect(cli.projectType).toBe('cli');
    expect(selected(cli)[0].name).toBe('How the mkdocs-lite command runs');
    expect(selected(cli)[0].nodes.map((n) => n.label)).toEqual(['Run the mkdocs-lite command', 'Loads build.js', 'Loads render.js', 'Command finishes (end of traced chain)']);
    const script = (await automation('auto-script')).result;
    expect(script.projectType).toBe('scripts');
    expect(selected(script)[0].name).toBe('How clean_data.py runs');
    const rust = (await automation('auto-rust')).result;
    expect(rust.projectType).toBe('unsupported');
    expect(selected(rust)[0].nodes.some((n) => n.type === 'unknown' && /rust is not analyzed/.test(n.label))).toBe(true);
    expect(rust.diagnostics.notes.join(' ')).toMatch(/not traced/);
  });
});

/* ------------------------------------------------------------------ large flows */

function syntheticFlow(steps: number): { arch: Architecture; facts: ArchitectureFacts; graph: DependencyGraph } {
  const file = (i: number) => `src/mod${i}.ts`;
  const flowSteps: FlowStep[] = [
    { step: 1, node: 'app:api', file: 'src/routes.ts', line: 1, mode: 'sync', explanation: 'GET /big is handled (src/routes.ts:1).', evidence: [], kind: 'route', lane: 'backend', label: 'GET /big' },
    ...Array.from({ length: steps }, (_, i): FlowStep => ({ step: i + 2, node: 'app:api', file: file(i), line: 2, mode: 'sync', explanation: `Calls step${i}() (${file(i)}:2).`, evidence: [], kind: 'service', lane: 'backend', label: `step${i}()` })),
    { step: steps + 2, node: 'app:api', file: 'src/routes.ts', line: 3, mode: 'sync', explanation: 'Responds (src/routes.ts:3).', evidence: [], kind: 'response', lane: 'backend', label: 'JSON response' },
  ];
  const flow: Flow = { id: 'flow_big', title: 'GET /big', trigger: { kind: 'route', method: 'GET', path: '/big' }, confidence: 'confirmed', steps: flowSteps, truncated: false, notes: [] };
  const arch = { flows: [flow], nodes: [], edges: [], evidence: {}, layers: [], summary: { patterns: [], strengths: [], risks: [], totals: {}, limitations: [] } } as unknown as Architecture;
  const facts = { routes: [{ file: 'src/routes.ts', line: 1, kind: 'api', method: 'GET', path: '/big', framework: 'express', source: 'router-call', snippet: "app.get('/big')" }], definitions: [], uiTriggers: [], httpCalls: [], calls: [], symbols: [], middleware: [], manifests: [], imports: [], languages: { js: steps + 1 }, decisions: [] } as unknown as ArchitectureFacts;
  const graph = { nodes: [], edges: [], files: {}, summary: { entryPoints: [], cycles: [], countsByType: {} } } as unknown as DependencyGraph;
  return { arch, facts, graph };
}

describe('automation engine: large flows', () => {
  it('lays out a 45-step flow without overlap, every node reachable', () => {
    const r = buildAutomation({ ...syntheticFlow(45), projectName: 'big' });
    const f = selected(r)[0];
    expect(f.nodes.length).toBeGreaterThanOrEqual(45);
    const layout = layoutFlow(f.nodes, f.edges);
    expect(layoutProblems(layout)).toEqual([]);
    expect(f.problems.filter((p) => !/evidence/.test(p))).toEqual([]);
  });

  it('caps very large flows at 150 nodes with an expandable group', () => {
    const r = buildAutomation({ ...syntheticFlow(170), projectName: 'huge' });
    const f = r.flows[0];
    expect(f.nodes.length).toBeLessThanOrEqual(150);
    const more = f.nodes.find((n) => n.type === 'group' && /more steps/.test(n.label))!;
    expect(more.members!.length).toBeGreaterThan(20);
  });
});
