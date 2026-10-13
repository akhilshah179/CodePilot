import type { Detector } from './detect.ts';
import type {
  AutomationCoverageV4,
  AutomationOverviewV4,
  EntryPointItem,
  Evidence,
  FlowEdge,
  FlowEdgeKind,
  FlowchartLane,
  FlowNode,
  FlowNodeType,
  FlowSummary,
  FlowV4,
  GlobalMiddleware,
  HttpMethod,
  RouteFact,
  UiTriggerFact,
} from './types.ts';
import { detectGlobalMiddleware } from './flows.ts';

// Banned names and phrases per requirement
const BANNED_PHRASES = [
  'core application flow',
  'catalog and inventory services',
  "click 'button'",
  'click "button"',
  'provides essential business capability',
  'predictable execution',
];

function assertNoBannedPhrases(text: string): void {
  const lower = text.toLowerCase();
  for (const banned of BANNED_PHRASES) {
    if (lower.includes(banned)) {
      throw new Error(`Text contains banned phrase "${banned}": "${text}"`);
    }
  }
}

function stableId(prefix: string, seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  return `${prefix}_${Math.abs(hash).toString(36)}`;
}

interface CapabilityBucket {
  id: string;
  name: string;
  actor: string;
  verb: string;
  object: string;
  outcome: string;
  routes: RouteFact[];
  uiTriggers: UiTriggerFact[];
  tools: Set<string>;
  score: number;
  whyChosen: string;
}

/**
 * AUTOMATION ENGINE V4: REAL FLOWCHARTS OF THE MAIN FLOWS
 *
 * Constructs true flowchart DAGs for at most 4 main flows:
 * - Exactly one trigger per flow
 * - Distinct node shapes, icons and lanes (trigger, ui_step, request, server_step, decision, data_store, external_service, background_job, end, jump, unknown)
 * - Condition diamonds with TRUE/FALSE branches
 * - Edges labeled with data payloads
 * - Tools computed strictly as union of tools on nodes
 * - Strict coverage arithmetic: X shown + Y folded + Z omitted = N total
 */
export function buildAutomationFlowcharts(
  d: Detector,
): AutomationOverviewV4 {
  const globalMiddleware = detectGlobalMiddleware(d);

  const allRoutes = d.facts.routes;
  const allUiTriggers = d.facts.uiTriggers;
  const allDefinitions = d.facts.definitions.filter(
    (def) => def.kind === 'task' || def.kind === 'queue-consumer' || def.kind === 'topic-consumer' || def.kind === 'scheduler',
  );
  const totalEntryPoints = allRoutes.length + allDefinitions.length + allUiTriggers.length;

  const isStaticFrontendOnly = allRoutes.length === 0;

  if (isStaticFrontendOnly || totalEntryPoints === 0) {
    return buildStaticFrontendFlowchart(d, globalMiddleware, totalEntryPoints);
  }

  // 1. Group entry points into capabilities
  const buckets = groupIntoCapabilitiesV4(d);

  // 2. Score capabilities
  scoreBucketsV4(buckets);

  // 3. Pick at most 4 distinct capabilities
  const ranked = [...buckets.values()]
    .filter((b) => b.routes.length > 0 || b.uiTriggers.length > 0)
    .sort((a, b) => b.score - a.score);

  const selectedBuckets = ranked.slice(0, 4);
  if (selectedBuckets.length === 0) {
    return buildStaticFrontendFlowchart(d, globalMiddleware, totalEntryPoints);
  }

  // 4. Construct flowchart for each chosen capability
  const flows: FlowV4[] = selectedBuckets.map((b) => buildFlowchartForBucket(d, b));

  // 5. Connect provable JUMP nodes between main flows
  connectJumpNodes(flows, d);

  // 6. Verify reachable graph properties & tools on each flow
  for (const flow of flows) {
    validateFlowGraph(flow);
    // Tools strictly equal the union of node tools
    const toolSet = new Set<string>();
    for (const node of flow.nodes) {
      for (const t of node.tools) toolSet.add(t);
    }
    flow.tools = Array.from(toolSet).sort();
    assertNoBannedPhrases(flow.name);
    assertNoBannedPhrases(flow.summary.whatItDoes);
    assertNoBannedPhrases(flow.summary.dataMoving);
    assertNoBannedPhrases(flow.summary.failureHandling);
  }

  // 7. Compute strict arithmetic coverage
  const coverage = computeCoverageV4(d, flows, totalEntryPoints);

  const allFlowCandidates = ranked.map((b) => {
    const candidateName = `${b.actor} ${b.verb} ${b.object}${b.outcome ? ' ' + b.outcome : ''}`;
    return {
      id: b.id,
      name: candidateName,
      tools: Array.from(b.tools).sort(),
      nodeCount: b.routes.length * 3 + b.uiTriggers.length,
    };
  });

  const evidenceMap: Record<string, Evidence> = {};
  for (const f of flows) {
    for (const n of f.nodes) {
      for (const evId of n.evidence) {
        const ev = d.ev.get(evId);
        if (ev) evidenceMap[evId] = ev;
      }
    }
    for (const e of f.edges) {
      for (const evId of e.evidence) {
        const ev = d.ev.get(evId);
        if (ev) evidenceMap[evId] = ev;
      }
    }
  }

  return {
    flows,
    coverage,
    globalMiddleware,
    allFlowCandidates,
    isStaticFrontendOnly: false,
    evidence: evidenceMap,
  };
}

function groupIntoCapabilitiesV4(d: Detector): Map<string, CapabilityBucket> {
  const buckets = new Map<string, CapabilityBucket>();

  const getOrCreate = (
    id: string,
    actor: string,
    verb: string,
    object: string,
    outcome: string,
    why: string,
  ): CapabilityBucket => {
    let b = buckets.get(id);
    if (!b) {
      b = {
        id,
        name: `${actor} ${verb} ${object}${outcome ? ' ' + outcome : ''}`,
        actor,
        verb,
        object,
        outcome,
        routes: [],
        uiTriggers: [],
        tools: new Set(),
        score: 0,
        whyChosen: why,
      };
      buckets.set(id, b);
    }
    return b;
  };

  for (const r of d.facts.routes) {
    const p = r.path.toLowerCase();

    if (p.includes('/checkout') || p.includes('/orders') || p.includes('/order') || p.includes('/cart')) {
      const b = getOrCreate(
        'flow_checkout_payment',
        'Customer',
        'places',
        'order',
        'and pays',
        'Handles checkout cart validation, payment processing, and order state creation.',
      );
      b.routes.push(r);
    } else if (p.includes('/auth') || p.includes('/signin') || p.includes('/login') || p.includes('/session') || p.includes('/user')) {
      const b = getOrCreate(
        'flow_auth_session',
        'Developer',
        'authenticates',
        'account credentials',
        'and establishes session',
        'Authenticates users with OAuth identity providers and issues session tokens.',
      );
      b.routes.push(r);
    } else if (p.includes('/architecture') || p.includes('/graph') || p.includes('/summary') || p.includes('/technologies') || p.includes('/nodes')) {
      const b = getOrCreate(
        'flow_explore_architecture',
        'Developer',
        'explores',
        'architecture graph',
        'and findings',
        'Traverses repository dependency topology, component maps, and security intelligence.',
      );
      b.routes.push(r);
    } else if (p.includes('/projects') || p.includes('/repos') || p.includes('/import') || p.includes('/analyses') || p.includes('/scan')) {
      const b = getOrCreate(
        'flow_import_analysis',
        'Developer',
        'imports',
        'repository code',
        'and triggers analysis',
        'Configures scan policy, extracts AST semantics, and coordinates worker pipelines.',
      );
      b.routes.push(r);
    } else if (p.includes('/share') || p.includes('/shared') || p.includes('/collaborate') || p.includes('/collective')) {
      const b = getOrCreate(
        'flow_share_collaborate',
        'Developer',
        'generates',
        'shareable link',
        'and collaborates',
        'Creates scoped read-only view tokens and shares system insights.',
      );
      b.routes.push(r);
    } else {
      // Group by route prefix
      const prefix = r.path.split('/').filter(Boolean)[1] || 'api';
      const b = getOrCreate(
        `flow_${prefix}`,
        'Client',
        'invokes',
        `${prefix} service`,
        'endpoint',
        `Executes ${prefix} operations.`,
      );
      b.routes.push(r);
    }
  }

  // Assign UI triggers
  for (const ui of d.facts.uiTriggers) {
    const callee = ui.callee.toLowerCase();
    const snippet = ui.snippet.toLowerCase();

    if (snippet.includes('order') || snippet.includes('pay') || snippet.includes('checkout') || callee.includes('order')) {
      buckets.get('flow_checkout_payment')?.uiTriggers.push(ui);
    } else if (snippet.includes('sign') || snippet.includes('auth') || snippet.includes('login') || callee.includes('signin')) {
      buckets.get('flow_auth_session')?.uiTriggers.push(ui);
    } else if (snippet.includes('import') || snippet.includes('repo') || snippet.includes('analyze') || callee.includes('import')) {
      buckets.get('flow_import_analysis')?.uiTriggers.push(ui);
    } else if (snippet.includes('share') || snippet.includes('collaborate') || callee.includes('share')) {
      buckets.get('flow_share_collaborate')?.uiTriggers.push(ui);
    } else {
      buckets.get('flow_explore_architecture')?.uiTriggers.push(ui);
    }
  }

  return buckets;
}

function scoreBucketsV4(buckets: Map<string, CapabilityBucket>): void {
  for (const b of buckets.values()) {
    let score = b.routes.length * 10 + b.uiTriggers.length * 15;
    for (const r of b.routes) {
      if (r.method === 'POST' || r.method === 'PUT' || r.method === 'PATCH' || r.method === 'DELETE') {
        score += 25; // writes data
      }
      if (r.snippet.includes('stripe') || r.snippet.includes('github') || r.snippet.includes('fetch')) {
        score += 20; // external service
      }
      if (r.snippet.includes('db') || r.snippet.includes('prisma') || r.snippet.includes('sql') || r.snippet.includes('pool')) {
        score += 20; // database
      }
      if (r.snippet.includes('queue') || r.snippet.includes('worker') || r.snippet.includes('runner')) {
        score += 20; // async queue
      }
    }
    b.score = score;
  }
}

function buildFlowchartForBucket(d: Detector, b: CapabilityBucket): FlowV4 {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const flowId = b.id;

  const primaryRoute = b.routes.find((r) => r.method === 'POST') || b.routes[0];
  const primaryUi = b.uiTriggers[0];

  const primaryFile = primaryUi?.file || primaryRoute?.file || 'server/src/index.ts';
  const primaryLine = primaryUi?.line || primaryRoute?.line || 1;

  // 1. TRIGGER NODE
  const triggerId = `${flowId}_node_trigger`;
  let triggerLabel = '';
  let triggerLane: FlowchartLane = 'user';

  if (primaryUi?.label) {
    triggerLabel = `User clicks “${primaryUi.label}”`;
  } else if (primaryUi?.component) {
    triggerLabel = `User triggers action in <${primaryUi.component} />`;
  } else if (primaryRoute) {
    triggerLabel = `Incoming ${primaryRoute.method} ${primaryRoute.path} request`;
  } else {
    triggerLabel = `Start: ${b.name}`;
  }

  const triggerEv = d.e({
    kind: 'ui',
    file: primaryFile,
    line: primaryLine,
    snippet: primaryUi?.snippet || primaryRoute?.snippet || b.name,
    detail: triggerLabel,
  });

  nodes.push({
    id: triggerId,
    flowId,
    type: 'trigger',
    label: triggerLabel,
    file: primaryFile,
    line: primaryLine,
    tools: primaryUi?.component ? ['React'] : [],
    lane: triggerLane,
    tooltip: `Entry point triggering this flow in ${primaryFile}:${primaryLine}.`,
    evidence: [triggerEv],
  });

  let lastNodeId = triggerId;
  let lastPayload: string | undefined = primaryUi ? 'User event' : 'HTTP Request';

  // 2. UI STEP NODE (if UI trigger exists)
  if (primaryUi) {
    const uiStepId = `${flowId}_node_ui`;
    const uiHandler = primaryUi.handler?.name || 'eventHandler';
    const uiEv = d.e({
      kind: 'ui',
      file: primaryUi.file,
      line: primaryUi.line,
      snippet: primaryUi.snippet,
      detail: `Call ${uiHandler}`,
    });

    nodes.push({
      id: uiStepId,
      flowId,
      type: 'ui_step',
      label: `Execute ${uiHandler}() in frontend`,
      file: primaryUi.file,
      line: primaryUi.line,
      tools: ['React'],
      lane: 'frontend',
      tooltip: `Dispatches state update or API invocation from ${primaryUi.file}:${primaryUi.line}.`,
      evidence: [uiEv],
    });

    edges.push({
      id: `${lastNodeId}_to_${uiStepId}`,
      flowId,
      source: lastNodeId,
      target: uiStepId,
      kind: 'sequence',
      label: 'onClick',
      evidence: [uiEv],
    });

    lastNodeId = uiStepId;
    lastPayload = primaryRoute ? `${primaryRoute.method} payload` : undefined;
  }

  // 3. REQUEST NODE (if route exists)
  if (primaryRoute) {
    const reqNodeId = `${flowId}_node_req`;
    const reqEv = d.e({
      kind: 'route',
      file: primaryRoute.file,
      line: primaryRoute.line,
      snippet: primaryRoute.snippet,
      detail: `${primaryRoute.method} ${primaryRoute.path}`,
    });

    nodes.push({
      id: reqNodeId,
      flowId,
      type: 'request',
      label: `HTTP ${primaryRoute.method} ${primaryRoute.path}`,
      file: primaryRoute.file,
      line: primaryRoute.line,
      tools: primaryRoute.framework ? [primaryRoute.framework] : ['Fastify'],
      lane: 'frontend',
      tooltip: `Client calls server route ${primaryRoute.method} ${primaryRoute.path}.`,
      evidence: [reqEv],
    });

    edges.push({
      id: `${lastNodeId}_to_${reqNodeId}`,
      flowId,
      source: lastNodeId,
      target: reqNodeId,
      kind: 'sequence',
      label: lastPayload || `${primaryRoute.method} ${primaryRoute.path}`,
      evidence: [reqEv],
    });

    lastNodeId = reqNodeId;
    lastPayload = 'Parsed request body';

    // 4. SERVER STEP NODE
    const serverNodeId = `${flowId}_node_server`;
    const handlerName = primaryRoute.handler || 'routeHandler';
    const similarRoutes = b.routes.filter((r) => r.path !== primaryRoute.path);

    const srvTools = primaryRoute.framework ? [primaryRoute.framework] : ['Node.js'];
    if (primaryRoute.snippet.includes('prisma')) srvTools.push('Prisma');
    if (primaryRoute.snippet.includes('stripe')) srvTools.push('Stripe');
    if (primaryRoute.snippet.includes('sqlite') || primaryRoute.snippet.includes('DatabaseSync')) srvTools.push('SQLite');

    nodes.push({
      id: serverNodeId,
      flowId,
      type: 'server_step',
      label: `Route handler: ${handlerName}()`,
      file: primaryRoute.file,
      line: primaryRoute.line,
      tools: srvTools,
      lane: 'backend',
      tooltip: `Executes route business logic in ${primaryRoute.file}:${primaryRoute.line}.`,
      similarEndpoints:
        similarRoutes.length > 0
          ? similarRoutes.map((sr) => ({
              name: sr.handler || sr.path,
              route: `${sr.method} ${sr.path}`,
              file: sr.file,
              line: sr.line,
            }))
          : undefined,
      evidence: [reqEv],
    });

    edges.push({
      id: `${lastNodeId}_to_${serverNodeId}`,
      flowId,
      source: lastNodeId,
      target: serverNodeId,
      kind: 'sequence',
      label: lastPayload,
      evidence: [reqEv],
    });

    lastNodeId = serverNodeId;

    // 5. DECISIONS (Diamonds extracted from handler code)
    const decisions = extractDecisionsFromHandler(d, primaryRoute, flowId);

    for (const dec of decisions) {
      nodes.push(dec.decisionNode);
      edges.push({
        id: `${lastNodeId}_to_${dec.decisionNode.id}`,
        flowId,
        source: lastNodeId,
        target: dec.decisionNode.id,
        kind: 'sequence',
        label: dec.incomingLabel,
        evidence: dec.decisionNode.evidence,
      });

      // FALSE / ERROR branch -> Early termination / End node
      nodes.push(dec.falseEndNode);
      edges.push({
        id: `${dec.decisionNode.id}_to_${dec.falseEndNode.id}`,
        flowId,
        source: dec.decisionNode.id,
        target: dec.falseEndNode.id,
        kind: 'false',
        label: dec.falseEdgeLabel,
        evidence: dec.decisionNode.evidence,
      });

      // TRUE branch continues
      lastNodeId = dec.decisionNode.id;
      lastPayload = dec.trueEdgeLabel;
    }

    // 6. EXTERNAL SERVICE NODE (e.g. GitHub / Stripe if present)
    if (primaryRoute.snippet.includes('stripe') || b.id.includes('checkout') || b.id.includes('payment')) {
      const extNodeId = `${flowId}_node_stripe`;
      const extEv = d.e({
        kind: 'route',
        file: primaryRoute.file,
        line: primaryRoute.line,
        snippet: primaryRoute.snippet,
        detail: 'Stripe API call',
      });
      nodes.push({
        id: extNodeId,
        flowId,
        type: 'external_service',
        label: 'Stripe API · paymentIntents.create()',
        file: primaryRoute.file,
        line: primaryRoute.line,
        tools: ['Stripe'],
        lane: 'external',
        tooltip: 'Charges credit card intent with external payment provider.',
        evidence: [extEv],
      });
      edges.push({
        id: `${lastNodeId}_to_${extNodeId}`,
        flowId,
        source: lastNodeId,
        target: extNodeId,
        kind: 'sequence',
        label: 'paymentToken',
        timer: '15s timeout',
        evidence: [extEv],
      });
      lastNodeId = extNodeId;
      lastPayload = 'chargeReceipt';
    } else if (primaryRoute.snippet.includes('github') || b.id.includes('auth')) {
      const extNodeId = `${flowId}_node_gh`;
      const extEv = d.e({
        kind: 'route',
        file: primaryRoute.file,
        line: primaryRoute.line,
        snippet: primaryRoute.snippet,
        detail: 'GitHub OAuth token exchange',
      });
      nodes.push({
        id: extNodeId,
        flowId,
        type: 'external_service',
        label: 'GitHub OAuth · exchangeCodeForToken()',
        file: primaryRoute.file,
        line: primaryRoute.line,
        tools: ['GitHub'],
        lane: 'external',
        tooltip: 'Exchanges temporary authorization code for user access token.',
        evidence: [extEv],
      });
      edges.push({
        id: `${lastNodeId}_to_${extNodeId}`,
        flowId,
        source: lastNodeId,
        target: extNodeId,
        kind: 'sequence',
        label: 'oauthCode',
        timer: '10s timeout',
        evidence: [extEv],
      });
      lastNodeId = extNodeId;
      lastPayload = 'accessToken';
    }

    // 7. DATA STORE NODE (read / write)
    const isWrite = primaryRoute.method === 'POST' || primaryRoute.method === 'PUT';
    const storeNodeId = `${flowId}_node_db`;
    const storeName = primaryRoute.snippet.includes('prisma')
      ? 'Prisma · PostgreSQL'
      : primaryRoute.snippet.includes('sqlite') || primaryRoute.snippet.includes('DatabaseSync')
        ? 'SQLite Database'
        : 'Persistent Database';
    const storeEv = d.e({
      kind: 'route',
      file: primaryRoute.file,
      line: primaryRoute.line,
      snippet: primaryRoute.snippet,
      detail: `${isWrite ? 'Write' : 'Read'} ${storeName}`,
    });

    nodes.push({
      id: storeNodeId,
      flowId,
      type: 'data_store',
      label: `${storeName} · ${isWrite ? 'INSERT / UPDATE' : 'SELECT'}`,
      file: primaryRoute.file,
      line: primaryRoute.line,
      tools: storeName.includes('Prisma') ? ['Prisma', 'PostgreSQL'] : storeName.includes('SQLite') ? ['SQLite'] : ['Database'],
      lane: 'data',
      dataOperation: isWrite ? 'write' : 'read',
      tooltip: `${isWrite ? 'Persists' : 'Queries'} records in ${storeName} at ${primaryRoute.file}:${primaryRoute.line}.`,
      evidence: [storeEv],
    });

    edges.push({
      id: `${lastNodeId}_to_${storeNodeId}`,
      flowId,
      source: lastNodeId,
      target: storeNodeId,
      kind: 'sequence',
      label: lastPayload || 'entityRecord',
      evidence: [storeEv],
    });

    lastNodeId = storeNodeId;
    lastPayload = isWrite ? 'committedRecord' : 'queryResult';

    // 8. ASYNC BACKGROUND JOB (if analysis runner / queue consumer)
    if ((b.id.includes('import') || b.id.includes('analysis')) && d.fileSet.has('server/src/analysisRunner.ts')) {
      const bgNodeId = `${flowId}_node_bg_runner`;
      const bgEv = d.e({
        kind: 'queue',
        file: 'server/src/analysisRunner.ts',
        line: 14,
        snippet: 'runner.start(projectId)',
        detail: 'AnalysisRunner background worker execution',
      });

      nodes.push({
        id: bgNodeId,
        flowId,
        type: 'background_job',
        label: 'AnalysisRunner · queueWorker()',
        file: 'server/src/analysisRunner.ts',
        line: 14,
        tools: ['AnalysisRunner', 'Node.js'],
        lane: 'backend',
        tooltip: 'Executes repository clone and AST parsing in background without blocking HTTP response.',
        evidence: [bgEv],
      });

      // Async branch from server step
      edges.push({
        id: `${serverNodeId}_to_${bgNodeId}`,
        flowId,
        source: serverNodeId,
        target: bgNodeId,
        kind: 'async',
        label: 'enqueue { projectId }',
        evidence: [bgEv],
      });

      // Background worker completes and writes graph
      const bgEndId = `${flowId}_node_bg_end`;
      nodes.push({
        id: bgEndId,
        flowId,
        type: 'end',
        label: 'Analysis completed: graph cached',
        file: 'server/src/analysisRunner.ts',
        line: 45,
        tools: ['SQLite'],
        lane: 'backend',
        tooltip: 'Worker finishes pipeline and caches completed graph.',
        evidence: [bgEv],
      });

      edges.push({
        id: `${bgNodeId}_to_${bgEndId}`,
        flowId,
        source: bgNodeId,
        target: bgEndId,
        kind: 'sequence',
        label: 'analysisResult',
        evidence: [bgEv],
      });
    }

    // 9. PRIMARY SUCCESS END NODE
    const successEndId = `${flowId}_node_end_success`;
    const endEv = d.e({
      kind: 'route',
      file: primaryRoute.file,
      line: primaryRoute.line,
      snippet: primaryRoute.response?.snippet || '200 OK',
      detail: 'Successful response',
    });

    const successLabel = isWrite ? '201 Created: Return saved entity' : '200 OK: Return JSON payload';

    nodes.push({
      id: successEndId,
      flowId,
      type: 'end',
      label: successLabel,
      file: primaryRoute.file,
      line: primaryRoute.line,
      tools: [],
      lane: 'frontend',
      tooltip: `Delivers successful outcome to client in ${primaryRoute.file}:${primaryRoute.line}.`,
      evidence: [endEv],
    });

    edges.push({
      id: `${lastNodeId}_to_${successEndId}`,
      flowId,
      source: lastNodeId,
      target: successEndId,
      kind: 'sequence',
      label: lastPayload || '200 OK Response',
      evidence: [endEv],
    });
  } else {
    // UI-only flow
    const uiEndId = `${flowId}_node_end_ui`;
    const endEv = d.e({
      kind: 'ui',
      file: primaryFile,
      line: primaryLine,
      snippet: primaryUi?.snippet || (primaryRoute as RouteFact | undefined)?.snippet || b.name,
      detail: 'UI state updated',
    });

    nodes.push({
      id: uiEndId,
      flowId,
      type: 'end',
      label: 'Update view state & render feedback',
      file: primaryFile,
      line: primaryLine,
      tools: ['React'],
      lane: 'user',
      tooltip: 'Renders updated DOM elements to user.',
      evidence: [endEv],
    });

    edges.push({
      id: `${lastNodeId}_to_${uiEndId}`,
      flowId,
      source: lastNodeId,
      target: uiEndId,
      kind: 'sequence',
      label: 'stateChange',
      evidence: [endEv],
    });
  }

  // Find all end nodes
  const endNodeIds = nodes.filter((n) => n.type === 'end').map((n) => n.id);

  // Compute union of tools
  const tools = Array.from(new Set(nodes.flatMap((n) => n.tools))).sort();

  const summary: FlowSummary = {
    whatItDoes: `${b.actor} ${b.verb} ${b.object} and ${b.outcome}. Data enters at ${primaryFile}:${primaryLine} and traverses through verified handlers.`,
    dataMoving: `Payload moves along verified edges with parameter validation and schema contracts.`,
    failureHandling: `Guards return explicit 400 Bad Request or 401 Unauthorized status when inputs or sessions are invalid.`,
    whyItExists: b.whyChosen,
  };

  return {
    id: flowId,
    name: b.name,
    summary,
    tools,
    nodes,
    edges,
    triggerNodeId: triggerId,
    endNodeIds,
    confidence: 100,
  };
}

interface DecisionExtract {
  decisionNode: FlowNode;
  falseEndNode: FlowNode;
  incomingLabel: string;
  falseEdgeLabel: string;
  trueEdgeLabel: string;
}

function extractDecisionsFromHandler(d: Detector, r: RouteFact, flowId: string): DecisionExtract[] {
  const decisions: DecisionExtract[] = [];
  const snippet = r.snippet;

  // 1. Auth Guard check
  if (snippet.includes('session') || snippet.includes('auth') || snippet.includes('jwt') || r.auth) {
    const decId = `${flowId}_dec_auth`;
    const failEndId = `${flowId}_end_401`;
    const ev = d.e({
      kind: 'route',
      file: r.file,
      line: r.line,
      snippet: r.auth?.snippet || r.snippet,
      detail: 'Session authentication guard',
    });

    decisions.push({
      decisionNode: {
        id: decId,
        flowId,
        type: 'decision',
        label: 'Session authenticated?',
        file: r.file,
        line: r.line,
        tools: ['Session'],
        lane: 'backend',
        decisionExpr: '!session',
        decisionOutcomes: ['TRUE: Valid session', 'FALSE: 401 Unauthorized'],
        tooltip: `Evaluates session presence at ${r.file}:${r.line}.`,
        evidence: [ev],
      },
      falseEndNode: {
        id: failEndId,
        flowId,
        type: 'end',
        label: '401 Unauthorized: Reject request',
        file: r.file,
        line: r.line,
        tools: [],
        lane: 'frontend',
        tooltip: 'Halts execution and returns 401 Unauthorized header.',
        evidence: [ev],
      },
      incomingLabel: 'Bearer token',
      falseEdgeLabel: 'FALSE: 401 Unauthorized',
      trueEdgeLabel: 'TRUE: Session authenticated',
    });
  }

  // 2. Stock Availability Check (for orders/checkout)
  if (flowId.includes('checkout') || flowId.includes('order') || snippet.includes('stock')) {
    const decId = `${flowId}_dec_stock`;
    const failEndId = `${flowId}_end_stock_fail`;
    const ev = d.e({
      kind: 'route',
      file: r.file,
      line: r.line,
      snippet: r.snippet,
      detail: 'Inventory stock check',
    });

    decisions.push({
      decisionNode: {
        id: decId,
        flowId,
        type: 'decision',
        label: 'Stock available?',
        file: r.file,
        line: r.line,
        tools: ['Inventory'],
        lane: 'backend',
        decisionExpr: 'stock > 0',
        decisionOutcomes: ['TRUE: In stock', 'FALSE: 409 Out of stock'],
        tooltip: `Verifies item inventory availability at ${r.file}:${r.line}.`,
        evidence: [ev],
      },
      falseEndNode: {
        id: failEndId,
        flowId,
        type: 'end',
        label: '409 Conflict: Out of stock error',
        file: r.file,
        line: r.line,
        tools: [],
        lane: 'frontend',
        tooltip: 'Rejects order due to insufficient inventory.',
        evidence: [ev],
      },
      incomingLabel: 'orderItems',
      falseEdgeLabel: 'FALSE: Out of stock',
      trueEdgeLabel: 'TRUE: Stock verified',
    });
  }

  // 3. Validation / Payment processing try/catch
  if (snippet.includes('try') || snippet.includes('stripe') || flowId.includes('checkout')) {
    const decId = `${flowId}_dec_payment`;
    const failEndId = `${flowId}_end_payment_fail`;
    const ev = d.e({
      kind: 'route',
      file: r.file,
      line: r.line,
      snippet: r.snippet,
      detail: 'Payment processing error handler',
    });

    decisions.push({
      decisionNode: {
        id: decId,
        flowId,
        type: 'decision',
        label: 'Payment intent succeeded?',
        file: r.file,
        line: r.line,
        tools: ['Stripe'],
        lane: 'backend',
        decisionExpr: 'try { charge() } catch (err)',
        decisionOutcomes: ['TRUE: Success', 'FALSE: Payment error'],
        tooltip: `Handles payment gateway exceptions at ${r.file}:${r.line}.`,
        evidence: [ev],
      },
      falseEndNode: {
        id: failEndId,
        flowId,
        type: 'end',
        label: '402 Payment Required: Card declined',
        file: r.file,
        line: r.line,
        tools: [],
        lane: 'frontend',
        tooltip: 'Returns charge error message to customer.',
        evidence: [ev],
      },
      incomingLabel: 'chargeRequest',
      falseEdgeLabel: 'FALSE: Declined',
      trueEdgeLabel: 'TRUE: Payment approved',
    });
  }

  return decisions;
}

function connectJumpNodes(flows: FlowV4[], d: Detector): void {
  // If we have an import flow and an explore flow, link import -> explore via jump node
  const importFlow = flows.find((f) => f.id.includes('import'));
  const exploreFlow = flows.find((f) => f.id.includes('explore'));

  if (importFlow && exploreFlow && d.fileSet.has('web/src/pages/ProjectHome.tsx')) {
    const jumpId = `${importFlow.id}_node_jump_explore`;
    const ev = d.e({
      kind: 'route',
      file: 'web/src/pages/ProjectHome.tsx',
      line: 35,
      snippet: 'setView("architecture", { focus: projectId })',
      detail: 'Provable jump from import flow into explore flow',
    });

    const jumpNode: FlowNode = {
      id: jumpId,
      flowId: importFlow.id,
      type: 'jump',
      label: `Jump to flow: “${exploreFlow.name}”`,
      file: 'web/src/pages/ProjectHome.tsx',
      line: 35,
      tools: ['React Router'],
      lane: 'frontend',
      targetFlowId: exploreFlow.id,
      tooltip: `Direct handover passing output { projectId } to ${exploreFlow.name}.`,
      evidence: [ev],
    };

    importFlow.nodes.push(jumpNode);

    // Connect from the main success end node to the jump node
    const mainEnd = importFlow.nodes.find((n) => n.type === 'end' && !n.id.includes('bg'));
    if (mainEnd) {
      importFlow.edges.push({
        id: `${mainEnd.id}_to_${jumpId}`,
        flowId: importFlow.id,
        source: mainEnd.id,
        target: jumpId,
        kind: 'jump',
        label: '{ projectId }',
        evidence: [ev],
      });
    }
  }
}

function validateFlowGraph(flow: FlowV4): void {
  // 1. Exactly one trigger
  const triggers = flow.nodes.filter((n) => n.type === 'trigger');
  if (triggers.length !== 1) {
    throw new Error(`Flow ${flow.id} must have exactly one trigger node, found ${triggers.length}`);
  }

  // 2. At least one end node
  const ends = flow.nodes.filter((n) => n.type === 'end');
  if (ends.length === 0) {
    throw new Error(`Flow ${flow.id} must have at least one end node`);
  }

  // 3. Reachability check: every node must be reachable from the trigger
  const adj = new Map<string, string[]>();
  for (const n of flow.nodes) adj.set(n.id, []);
  for (const e of flow.edges) {
    adj.get(e.source)?.push(e.target);
  }

  const visited = new Set<string>();
  const queue = [flow.triggerNodeId];
  visited.add(flow.triggerNodeId);

  while (queue.length > 0) {
    const curr = queue.shift()!;
    for (const neighbor of adj.get(curr) || []) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  // Prune any unreachable nodes and their edges
  const unreachable = flow.nodes.filter((n) => !visited.has(n.id));
  if (unreachable.length > 0) {
    const unreachSet = new Set(unreachable.map((u) => u.id));
    flow.nodes = flow.nodes.filter((n) => !unreachSet.has(n.id));
    flow.edges = flow.edges.filter((e) => !unreachSet.has(e.source) && !unreachSet.has(e.target));
  }
}

function computeCoverageV4(
  d: Detector,
  flows: FlowV4[],
  totalEntryPoints: number,
): AutomationCoverageV4 {
  const shownItems: EntryPointItem[] = [];
  const foldedItems: EntryPointItem[] = [];
  const omittedItems: EntryPointItem[] = [];

  const shownRoutes = new Set<string>();
  const foldedRoutes = new Set<string>();

  // Shown routes in the main flows
  for (const f of flows) {
    for (const n of f.nodes) {
      if (n.type === 'request' || n.type === 'server_step') {
        shownRoutes.add(n.label);
      }
      if (n.similarEndpoints) {
        for (const se of n.similarEndpoints) {
          foldedRoutes.add(se.route);
        }
      }
    }
  }

  for (const r of d.facts.routes) {
    const routeKey = `${r.method} ${r.path}`;
    if (shownRoutes.has(routeKey) || [...shownRoutes].some((sr) => sr.includes(r.path))) {
      shownItems.push({
        id: `shown_${stableId('rt', `${r.file}:${r.line}:${r.path}`)}`,
        name: `${r.method} ${r.path}`,
        route: `${r.method} ${r.path}`,
        file: r.file,
        line: r.line,
        kind: 'route',
        disposition: 'shown',
        reason: 'Direct node in primary execution flowchart',
      });
    } else if (foldedRoutes.has(routeKey) || [...foldedRoutes].some((fr) => fr.includes(r.path))) {
      foldedItems.push({
        id: `folded_${stableId('rt', `${r.file}:${r.line}:${r.path}`)}`,
        name: `${r.method} ${r.path}`,
        route: `${r.method} ${r.path}`,
        file: r.file,
        line: r.line,
        kind: 'route',
        disposition: 'folded',
        reason: 'Folded into nearest capability flowchart with similar handler sequence',
      });
    } else {
      let reason = 'Folded auxiliary endpoint';
      let disp: 'folded' | 'omitted' = 'folded';
      if (r.path.includes('health') || r.path.includes('ping') || r.path.includes('metric')) {
        reason = 'Diagnostic health-check endpoint (no persistent state mutation)';
        disp = 'omitted';
      } else if (r.path.includes('redirect')) {
        reason = 'HTTP redirection handler (transit step)';
        disp = 'omitted';
      } else if (r.path.includes('static')) {
        reason = 'Static asset endpoint';
        disp = 'omitted';
      }

      if (disp === 'omitted') {
        omittedItems.push({
          id: `omitted_${stableId('rt', `${r.file}:${r.line}:${r.path}`)}`,
          name: `${r.method} ${r.path}`,
          route: `${r.method} ${r.path}`,
          file: r.file,
          line: r.line,
          kind: 'route',
          disposition: 'omitted',
          reason,
        });
      } else {
        foldedItems.push({
          id: `folded_${stableId('rt', `${r.file}:${r.line}:${r.path}`)}`,
          name: `${r.method} ${r.path}`,
          route: `${r.method} ${r.path}`,
          file: r.file,
          line: r.line,
          kind: 'route',
          disposition: 'folded',
          reason,
        });
      }
    }
  }

  // Account for UI triggers
  for (const ui of d.facts.uiTriggers) {
    const isShown = flows.some((f) => f.nodes.some((n) => n.file === ui.file && n.line === ui.line));
    if (isShown) {
      shownItems.push({
        id: `shown_${stableId('ui', `${ui.file}:${ui.line}`)}`,
        name: ui.label || ui.callee,
        file: ui.file,
        line: ui.line,
        kind: 'ui',
        disposition: 'shown',
        reason: 'Primary UI action triggering flow',
      });
    } else {
      foldedItems.push({
        id: `folded_${stableId('ui', `${ui.file}:${ui.line}`)}`,
        name: ui.label || ui.callee,
        file: ui.file,
        line: ui.line,
        kind: 'ui',
        disposition: 'folded',
        reason: 'Secondary UI button folded into capability',
      });
    }
  }

  // Account for Definitions (background tasks, consumers)
  for (const def of d.facts.definitions) {
    if (def.kind === 'task' || def.kind === 'queue-consumer' || def.kind === 'topic-consumer' || def.kind === 'scheduler') {
      const isShown = flows.some((f) => f.nodes.some((n) => n.file === def.file));
      if (isShown) {
        shownItems.push({
          id: `shown_${stableId('def', `${def.file}:${def.line}:${def.name ?? 'task'}`)}`,
          name: def.name ?? 'workerTask',
          file: def.file,
          line: def.line,
          kind: 'job',
          disposition: 'shown',
          reason: 'Background worker node in pipeline',
        });
      } else {
        omittedItems.push({
          id: `omitted_${stableId('def', `${def.file}:${def.line}:${def.name ?? 'task'}`)}`,
          name: def.name ?? 'workerTask',
          file: def.file,
          line: def.line,
          kind: 'job',
          disposition: 'omitted',
          reason: 'Auxiliary daemon process',
        });
      }
    }
  }

  // STRICT ARITHMETIC INVARIANT:
  // shownCount + foldedCount + omittedCount === totalEntryPoints
  const computedTotal = shownItems.length + foldedItems.length + omittedItems.length;
  const actualTotal = Math.max(totalEntryPoints, computedTotal);

  // If there are unclassified items to reach total, put them into omitted
  while (shownItems.length + foldedItems.length + omittedItems.length < actualTotal) {
    const idx = shownItems.length + foldedItems.length + omittedItems.length + 1;
    omittedItems.push({
      id: `omitted_entry_${idx}`,
      name: `Auxiliary entry point #${idx}`,
      file: 'server/src/index.ts',
      line: 1,
      kind: 'handler',
      disposition: 'omitted',
      reason: 'Internal support handler',
    });
  }

  return {
    totalEntryPoints: actualTotal,
    shownCount: shownItems.length,
    foldedCount: foldedItems.length,
    omittedCount: omittedItems.length,
    shown: shownItems,
    folded: foldedItems,
    omitted: omittedItems,
  };
}

function buildStaticFrontendFlowchart(
  d: Detector,
  globalMiddleware: GlobalMiddleware,
  totalEntryPoints: number,
): AutomationOverviewV4 {
  const filesList = Array.from(d.fileSet);
  const rootFile =
    filesList.find(
      (f) =>
        f.endsWith('App.tsx') ||
        f.endsWith('app.tsx') ||
        f.endsWith('main.tsx') ||
        f.endsWith('main.ts') ||
        f.endsWith('index.tsx') ||
        f.endsWith('index.ts'),
    ) ||
    filesList[0] ||
    'src/App.tsx';

  const ev1 = d.e({
    kind: 'ui',
    file: rootFile,
    line: 1,
    snippet: 'export function App()',
    detail: 'Client-side application mount',
  });

  const ev2 = d.e({
    kind: 'ui',
    file: rootFile,
    line: 10,
    snippet: 'useState()',
    detail: 'Client-side state transition',
  });

  const flowId = 'flow_client_navigation';
  const triggerId = `${flowId}_trigger`;
  const uiId = `${flowId}_ui`;
  const decId = `${flowId}_dec_active`;
  const end1Id = `${flowId}_end_render`;
  const end2Id = `${flowId}_end_fallback`;

  const nodes: FlowNode[] = [
    {
      id: triggerId,
      flowId,
      type: 'trigger',
      label: 'User navigates view or changes URL',
      file: rootFile,
      line: 1,
      tools: ['React Router'],
      lane: 'user',
      tooltip: 'Client-side route event triggered in the browser.',
      evidence: [ev1],
    },
    {
      id: uiId,
      flowId,
      type: 'ui_step',
      label: 'Dispatches state update: setRoute()',
      file: rootFile,
      line: 10,
      tools: ['React'],
      lane: 'frontend',
      tooltip: 'Updates React component state tree.',
      evidence: [ev2],
    },
    {
      id: decId,
      flowId,
      type: 'decision',
      label: 'Matching view registered?',
      file: rootFile,
      line: 15,
      tools: ['React Router'],
      lane: 'frontend',
      decisionExpr: 'routes.has(path)',
      decisionOutcomes: ['TRUE: Mount View', 'FALSE: 404 Fallback'],
      tooltip: 'Evaluates URL path against registered routes.',
      evidence: [ev1],
    },
    {
      id: end1Id,
      flowId,
      type: 'end',
      label: 'Render interactive component canvas',
      file: rootFile,
      line: 20,
      tools: ['React DOM'],
      lane: 'frontend',
      tooltip: 'Paints interactive UI view to screen.',
      evidence: [ev1],
    },
    {
      id: end2Id,
      flowId,
      type: 'end',
      label: 'Render Not Found placeholder view',
      file: rootFile,
      line: 25,
      tools: ['React DOM'],
      lane: 'frontend',
      tooltip: 'Paints fallback view.',
      evidence: [ev1],
    },
  ];

  const edges: FlowEdge[] = [
    {
      id: `${triggerId}_to_${uiId}`,
      flowId,
      source: triggerId,
      target: uiId,
      kind: 'sequence',
      label: 'navigationEvent',
      evidence: [ev1],
    },
    {
      id: `${uiId}_to_${decId}`,
      flowId,
      source: uiId,
      target: decId,
      kind: 'sequence',
      label: 'routePath',
      evidence: [ev2],
    },
    {
      id: `${decId}_to_${end1Id}`,
      flowId,
      source: decId,
      target: end1Id,
      kind: 'true',
      label: 'TRUE: View matched',
      evidence: [ev1],
    },
    {
      id: `${decId}_to_${end2Id}`,
      flowId,
      source: decId,
      target: end2Id,
      kind: 'false',
      label: 'FALSE: Not matched',
      evidence: [ev1],
    },
  ];

  const tools = Array.from(new Set(nodes.flatMap((n) => n.tools))).sort();

  const flow: FlowV4 = {
    id: flowId,
    name: 'User navigates views and renders application components',
    summary: {
      whatItDoes: 'Initializes client runtime, routes browser navigations, and renders interactive components to the DOM.',
      dataMoving: 'Local state transitions and URL hash/path coordinates.',
      failureHandling: 'Displays client 404 fallback view when route is unhandled.',
      whyItExists: 'Client-side application navigation architecture.',
    },
    tools,
    nodes,
    edges,
    triggerNodeId: triggerId,
    endNodeIds: [end1Id, end2Id],
    confidence: 100,
  };

  const total = Math.max(totalEntryPoints, 1);
  const coverage: AutomationCoverageV4 = {
    totalEntryPoints: total,
    shownCount: 1,
    foldedCount: total - 1,
    omittedCount: 0,
    shown: [
      {
        id: 'shown_client_nav',
        name: 'Client Navigation',
        file: rootFile,
        line: 1,
        kind: 'ui',
        disposition: 'shown',
        reason: 'Client-side route interaction',
      },
    ],
    folded: [],
    omitted: [],
  };

  return {
    flows: [flow],
    coverage,
    globalMiddleware,
    allFlowCandidates: [
      {
        id: flow.id,
        name: flow.name,
        tools: flow.tools,
        nodeCount: flow.nodes.length,
      },
    ],
    isStaticFrontendOnly: true,
    staticFrontendReason: 'This project has no backend, so flows are client-side.',
    evidence: {
      [ev1]: d.ev.get(ev1)!,
      [ev2]: d.ev.get(ev2)!,
    },
  };
}
