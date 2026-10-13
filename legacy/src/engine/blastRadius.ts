import { GraphNode, GraphEdge, ImpactAnalysisResult } from '../types';

export function calculateBlastRadius(
  targetNodeId: string,
  nodes: GraphNode[],
  edges: GraphEdge[]
): ImpactAnalysisResult {
  const targetNode = nodes.find(n => n.id === targetNodeId);
  const targetNodeLabel = targetNode ? targetNode.label : targetNodeId;

  // Direct dependents: Nodes that CALL, READ, or DEPEND ON this targetNode
  // That means edges where target === targetNodeId (upstream callers) or source === targetNodeId (downstream targets)
  const directDependents: ImpactAnalysisResult['directDependents'] = [];
  const transitiveDependents: ImpactAnalysisResult['transitiveDependents'] = [];

  const visited = new Set<string>();
  visited.add(targetNodeId);

  // 1. Direct incoming edges (who calls this node)
  const incomingEdges = edges.filter(e => e.target === targetNodeId);
  for (const edge of incomingEdges) {
    const callerNode = nodes.find(n => n.id === edge.source);
    if (callerNode) {
      directDependents.push({
        nodeId: callerNode.id,
        label: callerNode.label,
        relation: edge.relation,
        impact: `Direct caller: modifies or invokes ${targetNodeLabel} via ${edge.label}`,
        filePath: callerNode.filePath,
      });
      visited.add(callerNode.id);
    }
  }

  // 2. Direct outgoing edges (who this node relies on)
  const outgoingEdges = edges.filter(e => e.source === targetNodeId);
  for (const edge of outgoingEdges) {
    const depNode = nodes.find(n => n.id === edge.target);
    if (depNode && !visited.has(depNode.id)) {
      directDependents.push({
        nodeId: depNode.id,
        label: depNode.label,
        relation: edge.relation,
        impact: `Downstream dependency: ${targetNodeLabel} produces queries or payload for ${depNode.label}`,
        filePath: depNode.filePath,
      });
      visited.add(depNode.id);
    }
  }

  // 3. Transitive dependencies (BFS search up to depth 3)
  interface QueueItem {
    id: string;
    depth: number;
    path: string[];
  }
  const queue: QueueItem[] = directDependents.map(d => ({
    id: d.nodeId,
    depth: 1,
    path: [targetNodeLabel, d.label],
  }));

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= 3) continue;

    const nextEdges = edges.filter(e => e.target === current.id || e.source === current.id);
    for (const edge of nextEdges) {
      const neighborId = edge.target === current.id ? edge.source : edge.target;
      if (!visited.has(neighborId)) {
        visited.add(neighborId);
        const neighborNode = nodes.find(n => n.id === neighborId);
        if (neighborNode) {
          const newPath = [...current.path, neighborNode.label];
          transitiveDependents.push({
            nodeId: neighborNode.id,
            label: neighborNode.label,
            depth: current.depth + 1,
            path: newPath,
          });
          queue.push({
            id: neighborId,
            depth: current.depth + 1,
            path: newPath,
          });
        }
      }
    }
  }

  // Compute Blast Radius Score
  const totalNodesCount = Math.max(nodes.length, 1);
  const impactedCount = directDependents.length + transitiveDependents.length;
  const isDataOrGateway = targetNode?.layer === 'data' || targetNode?.layer === 'gateway';
  
  let rawScore = Math.round((impactedCount / totalNodesCount) * 100);
  if (isDataOrGateway) rawScore = Math.min(100, rawScore + 25);
  if (targetNode?.type === 'database') rawScore = Math.max(rawScore, 85);
  if (targetNode?.type === 'cache') rawScore = Math.max(rawScore, 65);

  const blastRadiusScore = Math.min(100, Math.max(15, rawScore));

  let riskLevel: ImpactAnalysisResult['riskLevel'] = 'LOW';
  if (blastRadiusScore >= 80) riskLevel = 'CRITICAL';
  else if (blastRadiusScore >= 55) riskLevel = 'HIGH';
  else if (blastRadiusScore >= 35) riskLevel = 'MEDIUM';

  const breakingRisk =
    riskLevel === 'CRITICAL'
      ? `Modifying ${targetNodeLabel} carries a critical cascading failure risk. It is a foundational backbone component for ${directDependents.length} direct services and ${transitiveDependents.length} transitive layers.`
      : riskLevel === 'HIGH'
      ? `Modifying ${targetNodeLabel} affects multiple core application workflows. Breaking changes will cause synchronous failures across ${directDependents.map(d => d.label).join(', ')}.`
      : `Modifying ${targetNodeLabel} has moderate isolated blast radius limited to immediate caller modules.`;

  const recommendedPreChecks = [
    `Run end-to-end integration tests for ${directDependents.slice(0, 3).map(d => d.label).join(', ')}`,
    `Verify API schema and contract backwards-compatibility with consumer clients`,
    `Check database schema migration locks and connection pool capacity`,
    `Review error boundary handlers and circuit breaker fallbacks`,
  ];

  return {
    targetNodeId,
    targetNodeLabel,
    blastRadiusScore,
    riskLevel,
    directDependents,
    transitiveDependents,
    breakingRisk,
    recommendedPreChecks,
  };
}
