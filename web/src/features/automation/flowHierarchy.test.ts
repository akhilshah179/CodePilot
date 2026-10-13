import { describe, expect, it } from 'vitest';
import type { Flow, FlowStep } from '../../lib/api.ts';
import { resolveFlowHierarchy } from './flowHierarchy.ts';

const mkStep = (i: number, s: Partial<FlowStep>): FlowStep => ({
  step: i,
  node: 'app:web',
  file: 'web/src/pages/ConfirmRepo.tsx',
  mode: 'sync',
  explanation: 'step',
  evidence: ['ev_1'],
  ...s,
});

describe('hierarchical flow model and correlation', () => {
  it('correlates multiple load hooks in the same component into a unified journey without removing child requests', () => {
    const repoFlow: Flow = {
      id: 'flow_repo',
      title: 'ConfirmRepo loads → GET /api/github/repos/:owner/:repo',
      trigger: { kind: 'route', method: 'GET', path: '/api/github/repos/:owner/:repo' },
      action: { label: 'ConfirmRepo loads', kind: 'load', component: 'ConfirmRepo', file: 'web/src/pages/ConfirmRepo.tsx', line: 14 },
      confidence: 'confirmed',
      truncated: false,
      notes: [],
      steps: [
        mkStep(1, { stage: 'user', kind: 'action', label: 'ConfirmRepo loads' }),
        mkStep(2, { stage: 'frontend', kind: 'handler', label: 'Data hook' }),
        mkStep(3, { stage: 'transport', kind: 'client', label: 'api.repo()' }),
        mkStep(4, { stage: 'backend', kind: 'route', label: 'GET /api/github/repos/:owner/:repo' }),
      ],
    };

    const policyFlow: Flow = {
      id: 'flow_policy',
      title: 'ConfirmRepo loads → GET /api/scan-policy',
      trigger: { kind: 'route', method: 'GET', path: '/api/scan-policy' },
      action: { label: 'ConfirmRepo loads', kind: 'load', component: 'ConfirmRepo', file: 'web/src/pages/ConfirmRepo.tsx', line: 15 },
      confidence: 'confirmed',
      truncated: false,
      notes: [],
      steps: [
        mkStep(1, { stage: 'user', kind: 'action', label: 'ConfirmRepo loads' }),
        mkStep(2, { stage: 'frontend', kind: 'handler', label: 'Data hook' }),
        mkStep(3, { stage: 'transport', kind: 'client', label: 'api.scanPolicy()' }),
        mkStep(4, { stage: 'backend', kind: 'route', label: 'GET /api/scan-policy' }),
      ],
    };

    const healthFlow: Flow = {
      id: 'flow_health',
      title: 'GET /api/health',
      trigger: { kind: 'route', method: 'GET', path: '/api/health' },
      confidence: 'confirmed',
      truncated: false,
      notes: [],
      steps: [
        mkStep(1, { stage: 'backend', kind: 'route', label: 'GET /api/health', file: 'server/src/app.ts' }),
      ],
    };

    const workerFlow: Flow = {
      id: 'flow_worker',
      title: 'Queue analysis-jobs',
      trigger: { kind: 'queue', name: 'analysis-jobs' },
      confidence: 'confirmed',
      truncated: false,
      notes: [],
      steps: [
        mkStep(1, { stage: 'tools', kind: 'queue', label: 'Queue' }),
        mkStep(2, { stage: 'services', kind: 'worker', label: 'analysis_worker', branch: 'async' }),
      ],
    };

    const result = resolveFlowHierarchy([repoFlow, policyFlow, healthFlow, workerFlow]);

    // 1. Check counts breakdown
    expect(result.hierarchy.counts.totalTracedUnits).toBe(4);
    expect(result.hierarchy.counts.requests).toBe(2);
    expect(result.hierarchy.counts.system).toBe(1);
    expect(result.hierarchy.counts.background).toBe(1);
    expect(result.hierarchy.counts.journeys).toBe(3); // 1 page journey + 1 system journey + 1 background journey

    // 2. Check correlated page journey
    const pageJourney = result.journeys.find((j) => j.correlation.type === 'page-lifecycle');
    expect(pageJourney).toBeDefined();
    expect(pageJourney?.domain).toBe('PROJECT IMPORT');
    expect(pageJourney?.title).toBe('Confirm Repository Load');
    expect(pageJourney?.subflowIds).toEqual(['flow_repo', 'flow_policy']);

    // 3. Child requests are NOT dropped - they remain available as inspectable subflows
    expect(result.flowById.has('flow_repo')).toBe(true);
    expect(result.flowById.has('flow_policy')).toBe(true);
    const updatedRepoFlow = result.flowById.get('flow_repo')!;
    expect(updatedRepoFlow.journeyId).toBe(pageJourney?.id);
    expect(updatedRepoFlow.flowType).toBe('request');

    // 4. Check Journey Execution flow (Level 2)
    const journeyFlow = result.flowById.get(pageJourney!.flowId)!;
    expect(journeyFlow).toBeDefined();
    expect(journeyFlow.subflowIds).toEqual(['flow_repo', 'flow_policy']);
    // Contains branch steps originating from parentStepIndex = 2
    expect(journeyFlow.steps.some((s) => s.parentStepIndex === 2)).toBe(true);

    // 5. System flow classification
    const sysJourney = result.journeys.find((j) => j.type === 'system');
    expect(sysJourney).toBeDefined();
    expect(sysJourney?.domain).toBe('SYSTEM');
    expect(sysJourney?.title).toBe('Health Check');

    // 6. Background flow classification
    const bgJourney = result.journeys.find((j) => j.type === 'background');
    expect(bgJourney).toBeDefined();
    expect(bgJourney?.domain).toBe('BACKGROUND');
  });

  it('labels uncorrelatable flows with UNKNOWN RELATIONSHIP instead of guessing', () => {
    const mysteryFlow: Flow = {
      id: 'flow_mystery',
      title: 'Custom Endpoint',
      trigger: { kind: 'route', method: 'GET', path: '/internal_debug' },
      confidence: 'confirmed',
      truncated: false,
      notes: [],
      steps: [
        mkStep(1, { stage: 'backend', kind: 'route', label: 'GET /internal_debug', file: 'misc.ts' }),
      ],
    };

    const result = resolveFlowHierarchy([mysteryFlow]);
    const j = result.journeys[0];
    expect(j.domain).toBe('UNKNOWN RELATIONSHIP');
    expect(j.correlation.type).toBe('unknown');
    expect(j.correlation.reason).toContain('Independent technical flow');
  });
});
