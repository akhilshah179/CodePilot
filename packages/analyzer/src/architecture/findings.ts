import { CATALOG_BY_ID, imageTag } from './catalog.ts';
import type { DetectorContext as Detector } from './context.ts';
import { stableId } from './evidence.ts';
import type { Architecture, ArchitectureSummary, Confidence, Finding, PatternName } from './types.ts';

/**
 * Architecture summary. A pattern, strength or risk is only reported when specific evidence
 * supports it; generic advice ("add monitoring") is never generated.
 */
export function buildFindings(d: Detector, arch: Architecture): ArchitectureSummary {
  const { facts, graph } = d;
  const patterns: ArchitectureSummary['patterns'] = [];
  const strengths: Finding[] = [];
  const risks: Finding[] = [];
  const finding = (list: Finding[], f: Omit<Finding, 'id'>) => list.push({ id: stableId('find_', f.title + f.evidence.join()), ...f });
  const nodeName = (id: string) => arch.nodes.find((n) => n.id === id)?.name ?? id;

  // --- Patterns -------------------------------------------------------------------------------------------------
  // A process that runs a third-party tool from a shared image (e.g. a monitoring UI) has no code of its own here.
  const hasOwnCode = (a: (typeof d.apps)[number]) => !!a.closure?.size || d.apps.filter((o) => o.root === a.root).length === 1;
  const services = d.apps.filter((a) => (a.kind === 'service' || a.kind === 'function') && hasOwnCode(a));
  const workers = d.apps.filter((a) => a.kind === 'worker');
  const clients = d.apps.filter((a) => a.kind === 'client');
  const appEv = (apps: typeof d.apps) => apps.flatMap((a) => a.evidence.slice(0, 1));
  const interService = arch.edges.filter((e) => {
    const s = d.appById(e.source);
    const t = d.appById(e.target);
    return s && t && s.kind !== 'client' && t.kind !== 'client' && s.id !== t.id && e.overlays.includes('dataflow') && (e.labels.includes('REST') || e.labels.includes('gRPC') || e.labels.includes('HTTP'));
  });
  const pubsub = arch.edges.filter((e) => e.async && (e.labels.includes('publish') || e.labels.includes('pub/sub')));
  const consumes = arch.edges.filter((e) => e.labels.includes('consume') && ['kafka', 'rabbitmq', 'sqs', 'sns', 'gcp-pubsub', 'nats', 'redis'].some((t) => e.source.startsWith(`tool:${t}`)));

  if (services.length >= 2) {
    const roots = new Set(services.map((s) => s.root));
    const brokerShared = pubsub.length > 0 && consumes.length > 0;
    if (roots.size >= 2 && (interService.length || brokerShared)) {
      patterns.push({
        name: 'microservices',
        confidence: interService.some((e) => e.confidence === 'confirmed') || brokerShared ? 'confirmed' : 'strong',
        reason: `${services.length} separately built services (${services.map((s) => s.name).join(', ')}) that ${interService.length ? `call each other over HTTP (${interService.length} connection${interService.length === 1 ? '' : 's'})` : 'exchange messages through a broker'}.`,
        evidence: [...appEv(services), ...interService.flatMap((e) => e.evidence.slice(0, 1)), ...pubsub.flatMap((e) => e.evidence.slice(0, 1))].slice(0, 12),
      });
    } else {
      patterns.push({
        name: 'multi-service',
        confidence: 'confirmed',
        reason: `${services.length} services are built and run separately (${services.map((s) => s.name).join(', ')}); no direct calls between them were found in the code.`,
        evidence: appEv(services).slice(0, 12),
      });
    }
  } else if (services.length === 1) {
    const s = services[0];
    const workspaces = facts.manifests.filter((m) => m.ecosystem === 'npm' && m.dir !== s.root && !d.apps.some((a) => a.root === m.dir));
    const importedPkgs = workspaces.filter((m) => graph.edges.some((e) => e.resolved && !e.external && e.target.startsWith(m.dir + '/') && (s.root === '' || e.source.startsWith(s.root + '/'))));
    if (importedPkgs.length >= 2) {
      patterns.push({
        name: 'modular monolith',
        confidence: 'confirmed',
        reason: `One deployable service ("${s.name}") composed of ${importedPkgs.length} internal packages it imports (${importedPkgs.map((m) => m.name ?? m.dir).slice(0, 4).join(', ')}).`,
        evidence: [...s.evidence.slice(0, 1), ...importedPkgs.slice(0, 6).map((m) => d.e({ kind: 'manifest', file: m.file, line: 1, detail: `Workspace package ${m.name ?? m.dir}` }))],
      });
    } else {
      patterns.push({
        name: 'monolith',
        confidence: 'confirmed',
        reason: `A single deployable service ("${s.name}")${workers.length ? ` with ${workers.length} background worker${workers.length === 1 ? '' : 's'} from the same codebase` : ''}${clients.length ? ` and ${clients.length} separate frontend${clients.length === 1 ? '' : 's'}` : ''}.`,
        evidence: [...s.evidence.slice(0, 2), ...appEv(workers)].slice(0, 8),
      });
    }
  } else if (!services.length && clients.length) {
    patterns.push({ name: 'static frontend', confidence: 'confirmed', reason: `Only frontend applications were found (${clients.map((c) => c.name).join(', ')}); no server code is part of this repository.`, evidence: appEv(clients) });
  }
  if (pubsub.length && consumes.length) {
    patterns.push({
      name: 'event-driven',
      confidence: 'confirmed',
      reason: `Components publish messages (${pubsub.length} producer connection${pubsub.length === 1 ? '' : 's'}) that other components consume (${consumes.length}).`,
      evidence: [...pubsub, ...consumes].flatMap((e) => e.evidence.slice(0, 1)).slice(0, 10),
    });
  }
  const lambda = arch.nodes.find((n) => n.id === 'tool:aws-lambda' || n.id === 'tool:cloud-run' || n.id === 'tool:cloudflare-workers');
  const fnApps = d.apps.filter((a) => a.kind === 'function');
  if (fnApps.length || lambda) {
    patterns.push({ name: 'serverless', confidence: 'confirmed', reason: fnApps.length ? `Functions are declared in serverless configuration (${fnApps.map((a) => a.name).join(', ')}).` : `Code is deployed to ${lambda!.name}.`, evidence: [...appEv(fnApps), ...(lambda?.evidence.slice(0, 2) ?? [])] });
  }

  // --- Strengths ------------------------------------------------------------------------------------------------------
  const enqueueEdges = arch.edges.filter((e) => e.labels.includes('enqueue'));
  if (enqueueEdges.length && workers.length) {
    finding(strengths, {
      code: 'async-background-work', title: 'Background work runs outside the request path',
      detail: `${enqueueEdges.length} component${enqueueEdges.length === 1 ? '' : 's'} hand work to ${workers.map((w) => w.name).join(', ')} through a queue instead of doing it while a request waits.`,
      confidence: 'confirmed',
      evidence: enqueueEdges.flatMap((e) => e.evidence.slice(0, 2)).slice(0, 8),
      nodes: [...new Set([...enqueueEdges.map((e) => e.target), ...workers.map((w) => w.id)])],
    });
  }
  const cacheFlows = arch.flows.filter((f) => f.variant === 'cache-miss');
  if (cacheFlows.length) {
    finding(strengths, {
      code: 'read-cache', title: 'Reads are cached in front of slower calls',
      detail: `${cacheFlows.length} request path${cacheFlows.length === 1 ? '' : 's'} read a cache, fall back to a data call, and write the result back (${cacheFlows.slice(0, 3).map((f) => f.title.replace(' · cache miss', '')).join(', ')}).`,
      confidence: 'strong',
      evidence: cacheFlows.flatMap((f) => f.steps.filter((s) => s.mode === 'cache-miss').flatMap((s) => s.evidence)).slice(0, 6),
      nodes: [...new Set(cacheFlows.flatMap((f) => f.steps.map((s) => s.node)))],
    });
  }
  const testSteps = [...d.ev.all.values()].filter((e) => e.kind === 'ci' && /runs tests/.test(e.detail));
  if (testSteps.length) {
    finding(strengths, { code: 'ci-tests', title: 'CI runs the test suite', detail: `Tests run in CI (${testSteps.slice(0, 2).map((e) => `${e.file}:${e.line}`).join(', ')}).`, confidence: 'confirmed', evidence: testSteps.map((e) => e.id).slice(0, 6), nodes: arch.nodes.filter((n) => n.category === 'ci').map((n) => n.id) });
  }
  const healthchecks = facts.infra.compose.flatMap((cf) => cf.services.filter((s) => s.healthcheck).map((s) => d.e({ kind: 'compose', file: cf.file, line: s.healthcheck, detail: `Healthcheck for "${s.name}"` })));
  const dfHealth = facts.infra.dockerfiles.filter((x) => x.healthcheck).map((x) => d.e({ kind: 'dockerfile', file: x.file, line: x.healthcheck, detail: 'Container healthcheck' }));
  if (healthchecks.length + dfHealth.length) {
    finding(strengths, { code: 'container-healthchecks', title: 'Containers declare health checks', detail: `${healthchecks.length + dfHealth.length} health check${healthchecks.length + dfHealth.length === 1 ? '' : 's'} let the orchestrator detect unhealthy containers.`, confidence: 'confirmed', evidence: [...healthchecks, ...dfHealth].slice(0, 8), nodes: [] });
  }
  const migrations = [...d.fileSet].filter((f) => /(?:^|\/)(?:migrations|alembic\/versions|prisma\/migrations|db\/migrate)\//.test(f));
  if (migrations.length) {
    const dirs = [...new Set(migrations.map((f) => f.replace(/(migrations|versions|migrate)\/.*$/, '$1')))];
    finding(strengths, { code: 'versioned-migrations', title: 'Schema changes are versioned as migrations', detail: `${migrations.length} migration file${migrations.length === 1 ? '' : 's'} in ${dirs.slice(0, 3).join(', ')}.`, confidence: 'confirmed', evidence: dirs.slice(0, 4).map((dir) => d.e({ kind: 'graph', file: migrations.find((f) => f.startsWith(dir))!, detail: `Migrations directory ${dir}` })), nodes: [] });
  }
  const routes = facts.routes.filter((r) => r.kind === 'api');
  const guarded = routes.filter((r) => r.auth);
  if (guarded.length) {
    finding(strengths, { code: 'route-auth-checks', title: 'Auth checks are visible on routes', detail: `${guarded.length} of ${routes.length} API routes show an auth guard or dependency in their definition.`, confidence: 'confirmed', evidence: guarded.slice(0, 8).map((r) => d.e({ kind: 'auth', file: r.file, line: r.auth!.line, snippet: r.auth!.snippet, detail: `Auth check on ${r.method} ${r.path}` })), nodes: [...new Set(guarded.flatMap((r) => d.appsOf(r.file)))] });
  }
  const analyzedFiles = graph.summary.totals.analyzedFiles;
  if (analyzedFiles >= 20 && graph.summary.cycles.filter((c) => !c.typeOnly).length === 0) {
    finding(strengths, { code: 'no-import-cycles', title: 'No circular imports', detail: `None of the ${analyzedFiles} parsed files import each other in a cycle.`, confidence: 'confirmed', evidence: [d.e({ kind: 'graph', file: graph.nodes.find((n) => n.analyzed)?.id ?? '.', detail: `Dependency graph of ${analyzedFiles} parsed files has no runtime import cycle` })], nodes: [] });
  }

  // --- Risks ------------------------------------------------------------------------------------------------------------------
  const codeSecrets = facts.secrets.filter((s) => s.kind === 'credential-pattern');
  if (codeSecrets.length) {
    const files = [...new Set(codeSecrets.map((s) => s.file))];
    finding(risks, {
      code: 'credentials-in-source', title: 'Credential-like values in source code',
      detail: `${codeSecrets.length} value${codeSecrets.length === 1 ? '' : 's'} in ${files.length} file${files.length === 1 ? '' : 's'} match known credential formats (API keys, tokens). Values are not stored by CodePilot; rotate them if they are real.`,
      confidence: 'confirmed',
      severity: 'high',
      evidence: codeSecrets.slice(0, 10).map((s) => d.e({ kind: 'secret', file: s.file, line: s.line, snippet: '‹credential-shaped value redacted›', detail: 'Credential-shaped value in source (value not stored)' })),
      nodes: [...new Set(files.flatMap((f) => d.appsOf(f)))],
    });
  }
  const plain = facts.infra.compose.flatMap((cf) => cf.services.flatMap((s) => s.environment.filter((e) => e.secret).map((e) => ({ cf, s, e }))));
  if (plain.length) {
    finding(risks, {
      code: 'compose-plaintext-secrets', title: 'Plain-text secrets in Compose files',
      detail: `${plain.length} secret-named variable${plain.length === 1 ? ' is' : 's are'} set to literal values (${[...new Set(plain.map((p) => p.e.key))].slice(0, 4).join(', ')}). Fine for local development; make sure these files are not used in production.`,
      confidence: 'confirmed',
      severity: 'medium',
      evidence: plain.slice(0, 10).map((p) => d.e({ kind: 'secret', file: p.cf.file, line: p.e.line, snippet: `${p.e.key}: ‹redacted›`, detail: `${p.e.key} is set to a literal value in ${p.cf.file}` })),
      nodes: [...new Set(plain.map((p) => d.serviceNode.get(p.s.name)).filter((x): x is string => !!x))],
    });
  }
  const publishedStores = facts.infra.compose.flatMap((cf) =>
    cf.services.flatMap((s) => {
      const id = d.serviceNode.get(s.name);
      const n = id ? arch.nodes.find((x) => x.id === id) : undefined;
      if (!n || !['database', 'cache', 'queue', 'search'].includes(n.category)) return [];
      return s.ports.filter((p) => p.published && !/^127\.0\.0\.1/.test(p.published)).map((p) => ({ cf, s, p, id: id! }));
    }),
  );
  if (publishedStores.length) {
    finding(risks, {
      code: 'datastore-host-ports', title: 'Data stores publish ports on the host',
      detail: `${[...new Set(publishedStores.map((x) => x.s.name))].join(', ')} ${publishedStores.length === 1 ? 'publishes a port' : 'publish ports'} to the host network, reachable from outside the Compose network unless a firewall blocks it.`,
      confidence: 'confirmed',
      severity: 'medium',
      evidence: publishedStores.map((x) => d.e({ kind: 'port', file: x.cf.file, line: x.p.line, snippet: `${x.p.published}:${x.p.target}`, detail: `"${x.s.name}" publishes container port ${x.p.target} on host port ${x.p.published}` })),
      nodes: [...new Set(publishedStores.map((x) => x.id))],
    });
  }
  // Shared single instances: a data/async node several components depend on, with no replicas declared.
  for (const n of arch.nodes) {
    if (!['data', 'async'].includes(n.layer) || n.kind === 'app' || n.display !== 'node') continue;
    const dependents = new Set(arch.edges.filter((e) => e.overlays.includes('dataflow') && ((e.target === n.id && !e.labels.includes('consume')) || (e.source === n.id && e.labels.includes('consume')))).map((e) => (e.target === n.id ? e.source : e.target)));
    const apps = [...dependents].filter((id) => d.appById(id));
    if (apps.length < 2) continue;
    if (n.badges.some((b) => /replicas/.test(b.text))) continue;
    const declared = n.evidence.some((id) => /compose|kubernetes|terraform|helm/.test(d.ev.get(id)?.kind ?? ''));
    const roles = n.role.toLowerCase();
    const dual = /broker|job storage/.test(roles) && /read|write|cache/.test(roles);
    finding(risks, {
      code: 'shared-single-point-of-failure', title: `${n.name} is a shared single point of failure`,
      detail: `${apps.map(nodeName).join(', ')} all depend on ${n.name}${dual ? ', which serves as both cache and job broker' : ''}${declared ? '; no replicas are declared for it' : ''}. If it is unavailable, all of them are affected.`,
      confidence: declared ? 'confirmed' : 'strong',
      severity: dual || apps.length >= 3 ? 'medium' : 'low',
      evidence: arch.edges.filter((e) => (e.target === n.id || e.source === n.id) && apps.some((a) => a === e.source || a === e.target)).flatMap((e) => e.evidence.slice(0, 1)).slice(0, 8),
      nodes: [n.id, ...apps],
    });
  }
  // Cache writes without expiry and without invalidation.
  const cacheTools = new Set(facts.calls.filter((c) => c.op === 'cache-write').map((c) => c.tool));
  for (const tool of cacheTools) {
    const writes = facts.calls.filter((c) => c.tool === tool && c.op === 'cache-write' && !/incr|expire|lpush|rpush|sadd|zadd|hset/i.test(c.callee.split('.').pop() ?? ''));
    const noTtl = writes.filter((c) => c.arg !== 'ttl');
    const deletes = facts.calls.filter((c) => c.tool === tool && c.op === 'cache-delete');
    const expires = facts.calls.filter((c) => c.tool === tool && /expire/i.test(c.callee));
    if (noTtl.length && noTtl.length === writes.length && !deletes.length && !expires.length) {
      finding(risks, {
        code: 'cache-no-expiry', title: `Cache writes to ${CATALOG_BY_ID.get(tool)?.name} have no expiry or invalidation`,
        detail: `${noTtl.length} write${noTtl.length === 1 ? '' : 's'} set values without an expiry argument, and no delete or expire call was found in the analyzed code, so cached values may go stale.`,
        confidence: 'possible',
        severity: 'low',
        evidence: noTtl.slice(0, 6).map((c) => d.callEvidence(c)),
        nodes: [`tool:${tool}`],
      });
    }
  }
  // Slow external work on the request path when no queue exists.
  const hasQueue = arch.nodes.some((n) => n.category === 'queue' || n.category === 'worker');
  if (!hasQueue) {
    const slow = arch.flows.filter((f) => f.trigger.kind === 'route' && f.steps.some((s) => {
      const n = arch.nodes.find((x) => x.id === s.node);
      return n && (n.category === 'ai' || n.category === 'email' || n.category === 'messaging' || n.kind === 'host') && s.mode === 'sync';
    }));
    if (slow.length) {
      finding(risks, {
        code: 'sync-external-calls-no-queue', title: 'Requests wait on external calls, with no queue in the system',
        detail: `${slow.length} request path${slow.length === 1 ? '' : 's'} (${slow.slice(0, 3).map((f) => f.title).join(', ')}) call external services synchronously; there is no job queue to move slow work off the request path.`,
        confidence: 'possible',
        severity: 'low',
        evidence: slow.flatMap((f) => f.steps.filter((s) => arch.nodes.find((x) => x.id === s.node)?.layer === 'external').flatMap((s) => s.evidence)).slice(0, 6),
        nodes: [...new Set(slow.flatMap((f) => f.steps.map((s) => s.node)))],
      });
    }
  }
  const cycles = graph.summary.cycles.filter((c) => !c.typeOnly);
  if (cycles.length) {
    finding(risks, {
      code: 'import-cycles', title: `${cycles.length} circular import chain${cycles.length === 1 ? '' : 's'}`,
      detail: `Files that import each other in a loop are harder to change and can fail at load time. Largest: ${cycles[0].members.length} files (${cycles[0].members.slice(0, 3).join(', ')}${cycles[0].members.length > 3 ? '…' : ''}).`,
      confidence: 'confirmed',
      severity: cycles.some((c) => c.members.length > 3) ? 'medium' : 'low',
      evidence: cycles.slice(0, 3).flatMap((c) => c.chain.slice(0, 3).map((h) => d.e({ kind: 'graph', file: h.source, line: h.line, detail: `${h.source} imports ${h.target} (part of a cycle)` }))),
      nodes: [...new Set(cycles.flatMap((c) => c.members.flatMap((m) => d.appsOf(m))))],
    });
  }
  const latest = [
    ...facts.infra.compose.flatMap((cf) => cf.services.filter((s) => s.image && (!imageTag(s.image) || imageTag(s.image) === 'latest')).map((s) => d.e({ kind: 'compose', file: cf.file, line: s.imageLine, snippet: `image: ${s.image}`, detail: `"${s.name}" uses an unpinned image tag` }))),
    ...facts.infra.dockerfiles.flatMap((df) => df.stages.filter((st) => !/\$/.test(st.image) && st.image !== 'scratch' && !df.stages.some((o) => o.alias === st.image) && (!imageTag(st.image) || imageTag(st.image) === 'latest')).map((st) => d.e({ kind: 'dockerfile', file: df.file, line: st.line, snippet: `FROM ${st.image}`, detail: 'Base image without a pinned tag' }))),
  ];
  if (latest.length) {
    finding(risks, { code: 'unpinned-image-tags', title: 'Unpinned container image tags', detail: `${latest.length} image${latest.length === 1 ? '' : 's'} use no tag or "latest", so builds can change without a code change.`, confidence: 'confirmed', severity: 'low', evidence: latest.slice(0, 8), nodes: [] });
  }

  // --- Limitations ----------------------------------------------------------------------------------------------------------
  const limitations = [...d.limitations];
  const shallow = Object.entries(facts.languages).filter(([l]) => !['typescript', 'tsx', 'javascript', 'jsx', 'vue', 'svelte', 'astro', 'python', 'go'].includes(l));
  if (shallow.length) limitations.push(`${shallow.map(([l, n]) => `${l} (${n} files)`).join(', ')}: imports, routes and client calls are read, but modules are not linked to each other, so flows do not follow calls across files in these languages.`);
  const unassigned = [...d.fileSet].filter((f) => /\.(?:[cm]?[jt]sx?|py|go|rb|java|kt|php|rs|cs)$/.test(f) && !/(?:^|\/)__init__\.py$/.test(f) && !d.appsOf(f).length);
  if (unassigned.length && d.apps.length) limitations.push(`${unassigned.length} source file${unassigned.length === 1 ? ' is' : 's are'} not part of any detected application (scripts, tests or unused modules).`);
  if (facts.infra.kubernetes.length === 0 && [...d.fileSet].some((f) => /\/templates\/[^/]+\.ya?ml$/.test(f))) limitations.push('Helm templates are not rendered, so Kubernetes objects defined only in templates are not shown.');

  const confidenceOrder: Record<Confidence, number> = { confirmed: 0, strong: 1, possible: 2 };
  const sevOrder = { high: 0, medium: 1, low: 2, info: 3 } as const;
  risks.sort((a, b) => sevOrder[a.severity ?? 'info'] - sevOrder[b.severity ?? 'info'] || confidenceOrder[a.confidence] - confidenceOrder[b.confidence]);
  const orderedPatterns = patterns.sort((a, b) => confidenceOrder[a.confidence] - confidenceOrder[b.confidence]) as { name: PatternName; confidence: Confidence; reason: string; evidence: string[] }[];

  return {
    patterns: orderedPatterns,
    strengths,
    risks,
    totals: {
      tools: arch.nodes.filter((n) => n.kind !== 'app').length,
      apps: arch.nodes.filter((n) => n.kind === 'app').length,
      edges: arch.edges.length,
      flows: arch.flows.length,
      evidence: [...d.ev.all.keys()].length,
    },
    limitations,
  };
}
