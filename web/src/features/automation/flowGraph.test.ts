import { describe, expect, it } from 'vitest';
import type { Flow, FlowStep } from '../../lib/api.ts';
import { buildFlowGraph, entityKey, flowChanges, flowMatches } from './flowGraph.ts';

const step = (i: number, s: Partial<FlowStep>): FlowStep => ({ step: i, node: 'app:api', file: 'server/src/index.ts', mode: 'sync', explanation: '', evidence: [], ...s });

const create: Flow = {
  id: 'f1',
  title: 'Click “Create note” → POST /api/notes',
  name: 'Click “Create note”',
  trigger: { kind: 'route', method: 'POST', path: '/api/notes' },
  confidence: 'confirmed',
  truncated: false,
  notes: [],
  steps: [
    step(1, { stage: 'user', kind: 'action', label: 'Click “Create note”', file: 'web/src/NewNote.tsx', line: 12 }),
    step(2, { stage: 'backend', kind: 'route', label: 'POST /api/notes', transport: 'Fetch POST /api/notes', line: 18 }),
    step(3, { stage: 'backend', kind: 'middleware', label: 'CSRF check', line: 9 }),
    step(4, { stage: 'data', kind: 'data', label: 'PostgreSQL · pool.query()', tool: 'tool:postgresql', file: 'server/src/notes.ts', line: 11 }),
    step(5, { stage: 'response', kind: 'response', label: 'JSON response { id }', transport: 'JSON response', line: 20 }),
  ],
  index: { routes: ['POST /api/notes'], components: ['NewNote'], functions: ['createNote'], files: ['web/src/NewNote.tsx'], technologies: [{ id: 'tool:postgresql', name: 'PostgreSQL', category: 'database' }], categories: ['database'] },
};

const refresh: Flow = {
  id: 'f2',
  title: 'POST /api/refresh',
  trigger: { kind: 'route', method: 'POST', path: '/api/refresh' },
  confidence: 'confirmed',
  truncated: true,
  notes: [],
  steps: [
    step(1, { stage: 'backend', kind: 'route', label: 'POST /api/refresh', line: 30 }),
    step(2, { stage: 'backend', kind: 'middleware', label: 'CSRF check', line: 9 }),
    step(3, { stage: 'tools', kind: 'queue', label: 'Redis · enqueue', tool: 'tool:redis', mode: 'publish', line: 33 }),
    step(4, { stage: 'response', kind: 'response', label: 'JSON response { queued }', line: 34 }),
    step(5, { stage: 'services', kind: 'worker', label: 'refresh_price()', branch: 'async', mode: 'consume', file: 'worker.py', line: 5 }),
    step(6, { stage: 'external', kind: 'unknown', label: 'Unknown', branch: 'async', mode: 'unknown', file: 'worker.py', line: 9 }),
  ],
  index: { routes: ['POST /api/refresh'], components: [], functions: ['refresh_price'], files: ['worker.py'], technologies: [{ id: 'tool:redis', name: 'Redis', category: 'cache' }], categories: ['cache', 'queue', 'external'] },
};

describe('automation flow graph', () => {
  it('merges shared entities and keeps one technology node per tool', () => {
    const g = buildFlowGraph([create, refresh]);
    const csrf = g.nodes.filter((n) => n.label === 'CSRF check');
    expect(csrf).toHaveLength(1);
    expect([...csrf[0].flows]).toEqual(['f1', 'f2']);
    expect(entityKey(create.steps[3])).toBe('tool|tool:postgresql');
    expect(g.nodes.find((n) => n.key === 'tool|tool:postgresql')?.label).toBe('PostgreSQL');
    // Every step of every flow maps to a node.
    expect(g.path.get('f2')).toHaveLength(refresh.steps.length);
  });

  it('lays out stage columns in pipeline order, only for stages that occur', () => {
    const g = buildFlowGraph([create, refresh]);
    expect(g.columns.map((c) => c.stage)).toEqual(['user', 'backend', 'services', 'tools', 'data', 'external', 'response']);
    const xs = g.columns.map((c) => c.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  });

  it('hangs background work off the enqueue, not off the response before it', () => {
    const g = buildFlowGraph([refresh]);
    const into = g.pathEdges.get('f2')![4]!;
    const e = g.edges.find((x) => x.key === into)!;
    expect(e.from).toBe('tool|tool:redis');
    expect(e.async).toBe(true);
    // The route receives the request from the client transport; the response edge is marked as the way back.
    const g1 = buildFlowGraph([create]);
    expect(g1.edges.find((x) => x.to === g1.path.get('f1')![1])?.label).toBe('Fetch POST /api/notes');
  });

  it('searches flows by technology, route, component and category', () => {
    expect(flowMatches(refresh, 'redis')).toBe(true);
    expect(flowMatches(create, 'redis')).toBe(false);
    expect(flowMatches(create, 'NewNote')).toBe(true);
    expect(flowMatches(create, 'post notes')).toBe(true);
    expect(flowMatches(refresh, 'queue')).toBe(true);
  });

  it('compares snapshots: new, changed, unchanged and removed flows', () => {
    const changed = { ...create, steps: create.steps.slice(0, 3) };
    const { byId, removed } = flowChanges([changed, { ...refresh, id: 'f3' }], [create, refresh]);
    expect(byId.get('f1')).toBe('changed');
    expect(byId.get('f3')).toBe('new');
    expect(removed.map((f) => f.id)).toEqual(['f2']);
    expect(flowChanges([create], [create]).byId.get('f1')).toBe('same');
    expect(flowChanges([create], null).byId.size).toBe(0);
  });

  it('connects branching journey steps using parentStepIndex to render parallel operations from page initialization', () => {
    const branchingJourney: Flow = {
      id: 'journey_branching',
      title: 'Analysis Page Load',
      trigger: { kind: 'route', method: 'GET', path: '/api/projects/1' },
      confidence: 'confirmed',
      truncated: false,
      notes: [],
      steps: [
        step(1, { stage: 'user', kind: 'action', label: 'User visits Analysis', file: 'web/src/Analysis.tsx', line: 10 }),
        step(2, { stage: 'frontend', kind: 'handler', label: 'Page Initialization', file: 'web/src/Analysis.tsx', line: 12 }),
        // Branch 1: GET /api/me
        step(3, { stage: 'transport', kind: 'client', label: 'api.me()', file: 'web/src/api.ts', line: 20, parentStepIndex: 1 }),
        step(4, { stage: 'response', kind: 'response', label: 'User Response', file: 'server/src/auth.ts', line: 15 }),
        // Branch 2: GET /api/projects/:id
        step(5, { stage: 'transport', kind: 'client', label: 'api.project(id)', file: 'web/src/api.ts', line: 25, parentStepIndex: 1 }),
        step(6, { stage: 'response', kind: 'response', label: 'Project Response', file: 'server/src/projects.ts', line: 30 }),
      ],
    };

    const g = buildFlowGraph([branchingJourney]);
    const edges = g.edges;
    // Step 2 is Page Initialization (index 1)
    const pageInitKey = g.path.get('journey_branching')![1];
    const branch1Key = g.path.get('journey_branching')![2];
    const branch2Key = g.path.get('journey_branching')![4];

    // Both branch 1 (step 3) and branch 2 (step 5) originate from Page Initialization!
    expect(edges.find((e) => e.from === pageInitKey && e.to === branch1Key)).toBeDefined();
    expect(edges.find((e) => e.from === pageInitKey && e.to === branch2Key)).toBeDefined();
  });
});

