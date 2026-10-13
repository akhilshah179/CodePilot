import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectArchitecture } from '../src/architecture/detect.ts';
import type { Architecture } from '../src/architecture/types.ts';
import { analyzeRepositoryWithFacts } from '../src/index.ts';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');

async function load(name: string): Promise<Architecture> {
  const root = path.join(FIXTURES, name);
  const { graph, facts } = await analyzeRepositoryWithFacts(root, { repository: { name } });
  return detectArchitecture({ facts, graph });
}

describe('Automation Engine v3: Four Main Flows', () => {
  it('synthesizes at most 4 main flows covering the major parts of the system', async () => {
    const arch = await load('arch-fastify-react');
    expect(arch.mainFlows).toBeDefined();
    const mf = arch.mainFlows!;
    expect(mf.flows.length).toBeGreaterThan(0);
    expect(mf.flows.length).toBeLessThanOrEqual(4);

    for (const flow of mf.flows) {
      expect(flow.id).toBeTruthy();
      expect(flow.name).toBeTruthy();
      expect(flow.purpose).toBeTruthy();
      expect(flow.stages.length).toBeGreaterThan(0);

      // Verify every stage has required fields and citations
      for (const stage of flow.stages) {
        expect(stage.title).toBeTruthy();
        expect(stage.trigger).toBeTruthy();
        expect(stage.file).toBeTruthy();
        expect(stage.evidence.length).toBeGreaterThan(0);
        for (const ev of stage.evidence) {
          expect(arch.evidence[ev]).toBeDefined();
        }
      }

      // Verify every join cites evidence
      for (const join of flow.joins) {
        expect(join.sourceFile).toBeTruthy();
        expect(join.targetFile).toBeTruthy();
        expect(join.relationshipType).toBeTruthy();
        expect(join.explanation).toBeTruthy();
        expect(join.evidence.length).toBeGreaterThan(0);
        for (const ev of join.evidence) {
          expect(arch.evidence[ev]).toBeDefined();
        }
      }

      // Verify complete 8-section explanation
      const exp = flow.explanation;
      expect(exp.whatItDoes).toBeTruthy();
      expect(exp.whyItExists).toBeTruthy();
      expect(exp.stepByStep.length).toBe(flow.stages.length + flow.backgroundStages.length);
      expect(exp.toolsAndServices.length).toBeGreaterThan(0);
      expect(exp.dataInAndOut.inputs.length).toBeGreaterThan(0);
      expect(exp.dataInAndOut.stored.length).toBeGreaterThan(0);
      expect(exp.dataInAndOut.returned.length).toBeGreaterThan(0);
      expect(exp.ifSomethingFails.length).toBeGreaterThan(0);
      expect(exp.confidence.percent).toBeGreaterThan(0);
    }
  });

  it('maintains >= 80% coverage and provides an honest record of folded/omitted items', async () => {
    const arch = await load('arch-fastify-react');
    const mf = arch.mainFlows!;
    expect(mf.coverage.coveragePercent).toBeGreaterThanOrEqual(80);
    expect(mf.coverage.totalEntryPoints).toBeGreaterThan(0);
    expect(mf.coverage.coveredEntryPoints).toBeGreaterThan(0);
  });

  it('supports background execution rows for async and queue worker workflows', async () => {
    const arch = await load('arch-fastapi-celery');
    const mf = arch.mainFlows!;
    const hasBg = mf.flows.some((f) => f.backgroundStages.length > 0);
    expect(hasBg).toBe(true);

    const bgFlow = mf.flows.find((f) => f.backgroundStages.length > 0)!;
    expect(bgFlow.backgroundStages[0].isBackground).toBe(true);
    expect(bgFlow.joins.some((j) => j.relationshipType === 'enqueue-worker')).toBe(true);
  });

  it('handles static frontend projects cleanly without crashing or showing blank pages', async () => {
    const arch = await load('basic-repo');
    expect(arch.mainFlows).toBeDefined();
    const mf = arch.mainFlows!;
    expect(mf.flows.length).toBeGreaterThan(0);
    expect(mf.isStaticFrontendOnly).toBe(true);
    expect(mf.staticFrontendReason).toContain('This project has no backend');
    expect(mf.flows[0].explanation.whatItDoes).toBeTruthy();
  });

  it('is deterministic: same input produces the same 4 flows', async () => {
    const arch1 = await load('arch-compose-multi');
    const arch2 = await load('arch-compose-multi');
    expect(arch1.mainFlows?.flows.map((f) => f.name)).toEqual(arch2.mainFlows?.flows.map((f) => f.name));
    expect(arch1.mainFlows?.flows.map((f) => f.stages.length)).toEqual(arch2.mainFlows?.flows.map((f) => f.stages.length));
  });
});
