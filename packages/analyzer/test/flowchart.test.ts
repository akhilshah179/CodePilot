import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectArchitecture } from '../src/architecture/detect.ts';
import { buildAutomationFlowcharts } from '../src/architecture/flowchart.ts';
import { analyzeRepositoryWithFacts } from '../src/index.ts';
import { FIXTURE } from './expected.ts';

const BANNED = [
  'core application flow',
  'catalog and inventory services',
  "click 'button'",
  'click "button"',
  'provides essential business capability',
  'predictable execution',
];

describe('Automation Engine v4: Real Flowcharts of Main Flows', () => {
  it('synthesizes at most 4 connected flowcharts for the main fixture with single trigger and reachability', async () => {
    const mainFixture = path.join(path.dirname(FIXTURE), 'arch-compose-multi');
    const res = await analyzeRepositoryWithFacts(mainFixture, { repository: { name: 'arch-compose-multi' } });
    const arch = detectArchitecture({ graph: res.graph, facts: res.facts });

    expect(arch.automationV4).toBeDefined();
    const ov = arch.automationV4!;

    expect(ov.flows.length).toBeGreaterThan(0);
    expect(ov.flows.length).toBeLessThanOrEqual(4);

    for (const flow of ov.flows) {
      // 1. Exactly one trigger
      const triggers = flow.nodes.filter((n) => n.type === 'trigger');
      expect(triggers).toHaveLength(1);
      expect(flow.triggerNodeId).toBe(triggers[0].id);

      // 2. At least one end node
      const ends = flow.nodes.filter((n) => n.type === 'end');
      expect(ends.length).toBeGreaterThanOrEqual(1);

      // 3. Every node is reachable from the trigger
      const adj = new Map<string, string[]>();
      for (const n of flow.nodes) adj.set(n.id, []);
      for (const e of flow.edges) {
        adj.get(e.source)?.push(e.target);
      }

      const visited = new Set<string>();
      const q = [flow.triggerNodeId];
      visited.add(flow.triggerNodeId);
      while (q.length > 0) {
        const curr = q.shift()!;
        for (const next of adj.get(curr) || []) {
          if (!visited.has(next)) {
            visited.add(next);
            q.push(next);
          }
        }
      }

      for (const n of flow.nodes) {
        expect(visited.has(n.id)).toBe(true);
      }

      // 4. No banned names or filler phrases
      const allText = `${flow.name} ${flow.summary.whatItDoes} ${flow.summary.dataMoving} ${flow.summary.failureHandling}`.toLowerCase();
      for (const banned of BANNED) {
        expect(allText).not.toContain(banned);
      }

      // 5. Tool chips equal strictly the union of tools on nodes
      const nodeTools = Array.from(new Set(flow.nodes.flatMap((n) => n.tools))).sort();
      expect(flow.tools).toEqual(nodeTools);

      // 6. Every node and edge cites clickable evidence
      for (const n of flow.nodes) {
        expect(n.evidence.length).toBeGreaterThan(0);
        expect(n.file).toBeTruthy();
        expect(n.line).toBeGreaterThan(0);
      }
      for (const e of flow.edges) {
        expect(e.evidence.length).toBeGreaterThan(0);
      }
    }

    // 7. Different flows show different tool chips when their nodes differ
    if (ov.flows.length > 1) {
      const toolSignatures = new Set(ov.flows.map((f) => f.tools.join(',')));
      expect(toolSignatures.size).toBeGreaterThan(1);
    }

    // 8. Strict coverage arithmetic: shown + folded + omitted === totalEntryPoints
    const cov = ov.coverage;
    expect(cov.shownCount + cov.foldedCount + cov.omittedCount).toBe(cov.totalEntryPoints);
    expect(cov.shown.length).toBe(cov.shownCount);
    expect(cov.folded.length).toBe(cov.foldedCount);
    expect(cov.omitted.length).toBe(cov.omittedCount);
  });

  it('detects both stock check and payment try/catch decision diamonds with correct branches', async () => {
    const nextFixture = path.join(path.dirname(FIXTURE), 'arch-next-pg');
    const res = await analyzeRepositoryWithFacts(nextFixture, { repository: { name: 'arch-next-pg' } });
    const arch = detectArchitecture({ graph: res.graph, facts: res.facts });

    const ov = arch.automationV4!;
    expect(ov).toBeDefined();

    // Find the checkout / orders flow
    const checkoutFlow = ov.flows.find((f) => f.id.includes('checkout') || f.name.toLowerCase().includes('order'));
    expect(checkoutFlow).toBeDefined();

    const decisions = checkoutFlow!.nodes.filter((n) => n.type === 'decision');
    expect(decisions.length).toBeGreaterThanOrEqual(2);

    const stockDec = decisions.find((d) => d.label.toLowerCase().includes('stock'));
    expect(stockDec).toBeDefined();
    expect(stockDec!.decisionOutcomes).toContain('TRUE: In stock');
    expect(stockDec!.decisionOutcomes).toContain('FALSE: 409 Out of stock');

    const payDec = decisions.find((d) => d.label.toLowerCase().includes('payment'));
    expect(payDec).toBeDefined();

    // Verify true and false branches lead to distinct outcomes
    const stockEdges = checkoutFlow!.edges.filter((e) => e.source === stockDec!.id);
    expect(stockEdges.some((e) => e.kind === 'false')).toBe(true);

    const payEdges = checkoutFlow!.edges.filter((e) => e.source === payDec!.id);
    expect(payEdges.some((e) => e.kind === 'false')).toBe(true);
  });

  it('handles static frontend projects cleanly with client-side flowchart and non-blank page', async () => {
    const staticFixture = path.join(path.dirname(FIXTURE), 'basic-repo');
    const res = await analyzeRepositoryWithFacts(staticFixture, { repository: { name: 'basic-repo' } });
    const arch = detectArchitecture({ graph: res.graph, facts: res.facts });

    const ov = arch.automationV4!;
    expect(ov.isStaticFrontendOnly).toBe(true);
    expect(ov.staticFrontendReason).toContain('client-side');
    expect(ov.flows).toHaveLength(1);

    const flow = ov.flows[0];
    expect(flow.triggerNodeId).toBeTruthy();
    expect(flow.nodes.length).toBeGreaterThan(2);
    expect(flow.edges.length).toBeGreaterThan(1);
    expect(flow.nodes.some((n) => n.type === 'decision')).toBe(true);
  });
});
