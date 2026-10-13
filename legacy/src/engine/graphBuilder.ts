import { GraphNode, GraphEdge, Technology, ProjectFile, NodeLayer, NodeType, RelationType } from '../types';

export interface GraphLayoutResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function buildKnowledgeGraph(
  technologies: Technology[],
  files: ProjectFile[] = []
): GraphLayoutResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeMap = new Map<string, GraphNode>();

  // Layer column coordinates
  const LAYER_X: Record<NodeLayer, number> = {
    client: 120,
    gateway: 380,
    service: 640,
    data: 900,
    external: 1140,
    infra: 640,
  };

  const layerCounters: Record<NodeLayer, number> = {
    client: 0,
    gateway: 0,
    service: 0,
    data: 0,
    external: 0,
    infra: 0,
  };

  const getLayerY = (layer: NodeLayer): number => {
    const count = layerCounters[layer];
    layerCounters[layer]++;
    return 140 + count * 140;
  };

  // 1. Create nodes based on detected technologies & project structure
  for (const tech of technologies) {
    let layer: NodeLayer = 'service';
    let type: NodeType = 'service';

    switch (tech.category) {
      case 'Frontend Framework':
        layer = 'client';
        type = 'frontend';
        break;
      case 'Backend Framework':
        layer = 'gateway';
        type = 'service';
        break;
      case 'Database':
        layer = 'data';
        type = 'database';
        break;
      case 'Cache':
        layer = 'data';
        type = 'cache';
        break;
      case 'Message Queue':
        layer = 'data';
        type = 'queue';
        break;
      case 'Authentication':
        layer = 'service';
        type = 'auth';
        break;
      case 'Payment Services':
      case 'Cloud Services':
        layer = 'external';
        type = 'cloud';
        break;
      case 'ML Framework':
        layer = 'service';
        type = 'ml';
        break;
      case 'Infrastructure':
        layer = 'infra';
        type = 'service';
        break;
      default:
        layer = 'service';
        type = 'service';
    }

    const nodeId = `node-${tech.id.replace('tech-', '')}`;
    const node: GraphNode = {
      id: nodeId,
      label: tech.name,
      type,
      layer,
      technology: `${tech.name} ${tech.version !== 'latest' && tech.version !== 'detected' ? tech.version : ''}`.trim(),
      filePath: tech.files[0] || undefined,
      description: tech.purpose,
      confidence: tech.confidence,
      evidence: tech.evidence,
      x: LAYER_X[layer],
      y: getLayerY(layer),
      metrics: {
        linesOfCode: tech.files.length * 450,
        complexity: tech.category === 'Database' || tech.category === 'Backend Framework' ? 'High' : 'Medium',
        dependencyCount: tech.connections.length,
        callers: 1,
      },
      tags: [tech.category, tech.role.split(' ')[0]],
    };

    nodes.push(node);
    nodeMap.set(nodeId, node);
  }

  // If no client or gateway exists, add clean sensible defaults
  if (!nodes.some(n => n.layer === 'client')) {
    const clientNode: GraphNode = {
      id: 'node-client-app',
      label: 'Client Web Application',
      type: 'frontend',
      layer: 'client',
      technology: 'HTML5 / JS Client',
      description: 'User browser interface and API consumer.',
      confidence: 'CONFIRMED',
      evidence: [],
      x: LAYER_X.client,
      y: 240,
      metrics: { linesOfCode: 1500, complexity: 'Low', dependencyCount: 1, callers: 0 },
      tags: ['Frontend', 'Client'],
    };
    nodes.unshift(clientNode);
    nodeMap.set(clientNode.id, clientNode);
  }

  // 2. Connect Edges based on architectural roles
  const clientNodes = nodes.filter(n => n.layer === 'client');
  const gatewayNodes = nodes.filter(n => n.layer === 'gateway');
  const serviceNodes = nodes.filter(n => n.layer === 'service');
  const dataNodes = nodes.filter(n => n.layer === 'data');
  const externalNodes = nodes.filter(n => n.layer === 'external');

  // Client -> Gateway / Service
  for (const client of clientNodes) {
    if (gatewayNodes.length > 0) {
      for (const gw of gatewayNodes) {
        edges.push({
          id: `edge-${client.id}-${gw.id}`,
          source: client.id,
          target: gw.id,
          label: 'HTTPS REST / JSON',
          relation: 'CALLS_API',
          confidence: 'CONFIRMED',
          animated: true,
          description: 'Client dispatches authenticated REST requests',
        });
      }
    } else if (serviceNodes.length > 0) {
      edges.push({
        id: `edge-${client.id}-${serviceNodes[0].id}`,
        source: client.id,
        target: serviceNodes[0].id,
        label: 'HTTP API Calls',
        relation: 'CALLS_API',
        confidence: 'CONFIRMED',
        animated: true,
      });
    }
  }

  // Gateway -> Services
  for (const gw of gatewayNodes) {
    for (const svc of serviceNodes) {
      edges.push({
        id: `edge-${gw.id}-${svc.id}`,
        source: gw.id,
        target: svc.id,
        label: svc.type === 'auth' ? 'Verify Auth / Token' : 'Route Request',
        relation: svc.type === 'auth' ? 'AUTHENTICATES_WITH' : 'CALLS',
        confidence: 'CONFIRMED',
        animated: true,
      });
    }

    // Direct Gateway -> Data (if no intermediate services)
    if (serviceNodes.length === 0) {
      for (const data of dataNodes) {
        edges.push({
          id: `edge-${gw.id}-${data.id}`,
          source: gw.id,
          target: data.id,
          label: data.type === 'cache' ? 'Cache Query' : 'SQL / ORM Query',
          relation: data.type === 'cache' ? 'CACHES_IN' : 'READS_FROM',
          confidence: 'CONFIRMED',
          animated: true,
        });
      }
    }
  }

  // Services -> Data (DB, Cache, Queue)
  for (const svc of serviceNodes) {
    for (const data of dataNodes) {
      let relation: RelationType = 'CONNECTS_TO';
      let label = 'Data Access';

      if (data.type === 'cache') {
        relation = 'CACHES_IN';
        label = 'GET / SET Key (Cache)';
      } else if (data.type === 'queue') {
        relation = 'PUBLISHES_TO';
        label = 'Publish Domain Event';
      } else if (data.type === 'database') {
        relation = 'READS_FROM';
        label = 'Query / Transaction';
      }

      edges.push({
        id: `edge-${svc.id}-${data.id}`,
        source: svc.id,
        target: data.id,
        label,
        relation,
        confidence: 'CONFIRMED',
        animated: true,
      });
    }

    // Services -> External APIs
    for (const ext of externalNodes) {
      edges.push({
        id: `edge-${svc.id}-${ext.id}`,
        source: svc.id,
        target: ext.id,
        label: ext.label.includes('Stripe') ? 'Payment Charge' : 'API Request',
        relation: 'CONNECTS_TO',
        confidence: 'STRONG_INFERENCE',
        animated: true,
      });
    }
  }

  return { nodes, edges };
}
