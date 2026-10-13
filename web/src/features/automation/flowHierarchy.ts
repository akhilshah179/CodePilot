import {
  buildAutomationOverview,
  buildHierarchicalFlows,
  classifyFlowType,
  detectDomain,
} from '@codepilot/analyzer/architecture/flows';
import type {
  AutomationOverview,
  CapabilityGroup,
  Flow,
  FlowHierarchy,
  FlowJourney,
  FlowType,
  GlobalMiddleware,
  HeroFlow,
  TraceCoverage,
} from '../../lib/api.ts';

export const FLOW_TYPE_LABELS: Record<FlowType, string> = {
  'user-journey': 'User journey',
  request: 'Request',
  background: 'Background flow',
  system: 'System flow',
  external: 'External flow',
};

export const FLOW_TYPE_SHORT: Record<FlowType, string> = {
  'user-journey': 'Journey',
  request: 'Request',
  background: 'Worker',
  system: 'System',
  external: 'External',
};

export interface DomainGroup {
  domain: string;
  journeys: FlowJourney[];
  totalSubflows: number;
}

/**
 * Resolves or builds the complete hierarchical flow model and Automation Engine V2 intelligence.
 * If precomputed hierarchy / automation is available from the API, uses it;
 * otherwise dynamically organizes raw flows from repository evidence.
 */
export function resolveFlowHierarchy(
  flows: Flow[],
  serverHierarchy?: FlowHierarchy | null,
  serverAutomation?: AutomationOverview | null,
): {
  allFlows: Flow[];
  journeys: FlowJourney[];
  hierarchy: FlowHierarchy;
  groups: DomainGroup[];
  journeyById: Map<string, FlowJourney>;
  flowById: Map<string, Flow>;
  automation?: AutomationOverview;
  heroFlow?: HeroFlow;
  capabilities: CapabilityGroup[];
  globalMiddleware?: GlobalMiddleware;
  traceCoverage?: TraceCoverage;
} {
  let allFlows = flows;
  let hierarchy: FlowHierarchy;

  if (serverHierarchy && serverHierarchy.journeys.length > 0) {
    hierarchy = serverHierarchy;
  } else {
    // Dynamic fallback generation from repository evidence
    const computed = buildHierarchicalFlows(flows);
    allFlows = computed.flows;
    hierarchy = computed.hierarchy;
  }

  const flowById = new Map<string, Flow>();
  for (const f of allFlows) {
    flowById.set(f.id, f);
  }

  const journeyById = new Map<string, FlowJourney>();
  for (const j of hierarchy.journeys) {
    journeyById.set(j.id, j);
  }

  // Group journeys by domain in canonical order
  const journeysByDomain = new Map<string, FlowJourney[]>();
  for (const j of hierarchy.journeys) {
    if (!journeysByDomain.has(j.domain)) journeysByDomain.set(j.domain, []);
    journeysByDomain.get(j.domain)!.push(j);
  }

  const groups: DomainGroup[] = [];
  for (const d of hierarchy.domains) {
    const list = journeysByDomain.get(d) ?? [];
    if (list.length > 0) {
      const totalSubflows = list.reduce((acc, j) => acc + j.subflowIds.length, 0);
      groups.push({ domain: d, journeys: list, totalSubflows });
    }
  }

  // Any remaining domains not in canonical list
  for (const [d, list] of journeysByDomain.entries()) {
    if (!hierarchy.domains.includes(d) && list.length > 0) {
      const totalSubflows = list.reduce((acc, j) => acc + j.subflowIds.length, 0);
      groups.push({ domain: d, journeys: list, totalSubflows });
    }
  }

  const automation = serverAutomation ?? undefined;
  const heroFlow = automation?.heroFlow;
  const capabilities = automation?.capabilities ?? [];
  const globalMiddleware = automation?.globalMiddleware;
  const traceCoverage = automation?.traceCoverage;

  return {
    allFlows,
    journeys: hierarchy.journeys,
    hierarchy,
    groups,
    journeyById,
    flowById,
    automation,
    heroFlow,
    capabilities,
    globalMiddleware,
    traceCoverage,
  };
}

export function kindOfFlow(f: Flow): FlowType {
  return f.flowType ?? classifyFlowType(f);
}
