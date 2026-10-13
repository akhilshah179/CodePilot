export * from './types.ts';
export { CATALOG, CATALOG_BY_ID } from './catalog.ts';
export { extractArchitectureFacts, type ExtractInput } from './extract.ts';
export { detectArchitecture, type DetectInput } from './detect.ts';
export { layoutDiagram, nodeHeight, visibleEdges, NODE_W, type Diagram, type DiagramNode, type DiagramEdge, type DiagramLane } from './layout.ts';
export { CATEGORY_ICONS, LAYER_TINTS, LAYER_ACCENTS } from './icons.ts';
export { buildFlows, buildHierarchicalFlows, classifyFlowType, detectDomain, buildAutomationOverview, buildHeroFlow, buildCapabilityGroups, detectNearDuplicates, detectGlobalMiddleware, rankFlows, computeTraceCoverage } from './flows.ts';
export { buildMainFlows } from './mainFlows.ts';
export { buildAutomationFlowcharts } from './flowchart.ts';
