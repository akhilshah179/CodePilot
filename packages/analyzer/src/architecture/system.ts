import type { DetectorContext as Detector } from './context.ts';
import { CATALOG_BY_ID } from './catalog.ts';
import { callSite, httpSite } from './flows.ts';
import { opLabel } from './ops.ts';
import { bestRoutes } from './graph.ts';
import { clientLabel, protocolOf, transportLabel } from './transport.ts';
import { SYSTEM_LAYERS, type Architecture, type ArchNode, type Confidence, type HttpCallFact, type HttpMethod, type MiddlewareFact, type RouteFact, type SystemLayer, type SystemLink, type SystemMap, type SystemNode } from './types.ts';

/*
 * The system map: how the system works, one level finer than the architecture diagram.
 *
 *   client → transport (protocol + library) → API groups → middleware → route handlers
 *          → service modules → data stores / queues / external services
 *
 * Every component is a real file, route, call site or middleware registration; every link is a
 * call, an import or a route the code contains. Where a call's target cannot be determined, the
 * link goes to an explicit "unknown target" node rather than a guess.
 */

const MAX_GROUPS = 10;
const MAX_SERVICES = 14;
const RESPONSE_PHASES = new Set(['onSend', 'onResponse', 'preSerialization', 'after_request', 'onError', 'onTimeout']);

const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const stem = (p: string) => basename(p).replace(/\.[^.]+$/, '');

const PROTOCOL_NAME: Record<string, string> = { REST: 'REST over HTTP', SSE: 'Server-Sent Events', WebSocket: 'WebSocket', GraphQL: 'GraphQL', tRPC: 'tRPC', gRPC: 'gRPC', HTTP: 'HTTP' };

/** The key an API route is grouped under: `/api/projects/:id` → `/api/projects`. */
export function routeGroup(r: RouteFact): string {
  if (r.kind === 'action') return 'Server actions';
  if (r.path.startsWith('trpc:')) return 'tRPC';
  const seg = r.path.split('/').filter(Boolean);
  if (!seg.length) return '/';
  const n = seg[0] === 'api' || /^v\d+$/.test(seg[0]) ? Math.min(seg.length, seg[1] === 'v1' || /^v\d+$/.test(seg[1] ?? '') ? 3 : 2) : 1;
  return '/' + seg.slice(0, n).filter((s) => !s.startsWith(':') && !s.startsWith('{') && !s.startsWith('[')).join('/');
}

function layerFor(n: ArchNode): SystemLayer {
  if (n.layer === 'clients') return 'client';
  if (n.layer === 'edge') return 'transport';
  if (n.layer === 'delivery') return 'infra';
  if (n.layer === 'async') return 'async';
  if (n.layer === 'data') return 'data';
  if (n.layer === 'external') return 'external';
  return n.kind === 'app' ? 'backend' : 'services';
}

function kindFor(n: ArchNode): SystemNode['kind'] {
  if (n.layer === 'clients') return 'client';
  if (n.layer === 'edge') return 'proxy';
  if (n.layer === 'delivery') return 'infra';
  if (n.kind === 'app' && n.layer === 'async') return 'worker';
  if (n.category === 'queue') return 'queue';
  if (n.layer === 'external') return 'external';
  return 'tool';
}

export function buildSystemMap(d: Detector, arch: Architecture): SystemMap {
  const nodes = new Map<string, SystemNode>();
  const links = new Map<string, SystemLink>();
  const archById = new Map(arch.nodes.map((n) => [n.id, n]));
  const groups: SystemMap['groups'] = [];

  const archNode = (id: string): SystemNode | undefined => {
    const existing = nodes.get(id);
    if (existing) return existing;
    const n = archById.get(id);
    if (!n || n.display !== 'node') return undefined;
    const sn: SystemNode = {
      id,
      kind: kindFor(n),
      layer: layerFor(n),
      name: n.name,
      detail: n.role || n.category,
      arch: id,
      files: n.files.slice(0, 4).map((f) => ({ path: f.path, line: f.lines[0] })),
      evidence: n.evidence.slice(0, 4),
      confidence: n.confidence,
    };
    nodes.set(id, sn);
    return sn;
  };

  /** One link per (source, target, async); labels of the operations behind it are merged. */
  const link = (source: string, target: string, label: string, kind: SystemLink['kind'], evidence: string[], confidence: Confidence = 'confirmed', async = false, count = 1) => {
    if (source === target) return;
    const key = `${source}->${target}|${async}`;
    const l = links.get(key);
    if (l) {
      l.count += count;
      const parts = l.label.split(' · ');
      for (const p of label.split(' · ')) if (p && !parts.includes(p)) parts.push(p);
      l.label = parts.join(' · ');
      for (const e of evidence) if (l.evidence.length < 6 && !l.evidence.includes(e)) l.evidence.push(e);
      if (confidence === 'confirmed') l.confidence = 'confirmed';
      return;
    }
    links.set(key, { id: `sl_${links.size.toString(36)}`, source, target, label, kind, async, count, evidence: evidence.slice(0, 6), confidence });
  };
  /** The system node that owns a file: its route handler module or service module. */
  const fileOwner = new Map<string, string>();

  const routeEv = (r: RouteFact) => d.e({ kind: 'route', file: r.file, line: r.line, snippet: r.snippet, detail: `${r.method} ${r.path}` });

  // Clients (frontends, UI parts of full-stack apps, browser scripts).
  for (const n of arch.nodes) if (n.layer === 'clients' && n.display === 'node') archNode(n.id);

  const serverApps = d.apps.filter((a) => (d.routesByApp.get(a.id) ?? []).some((r) => r.kind !== 'page'));
  const groupOfRoute = new Map<RouteFact, string>();

  for (const app of serverApps) {
    const members: string[] = [];
    const routes = (d.routesByApp.get(app.id) ?? []).filter((r) => r.kind !== 'page');

    // API groups.
    const byGroup = new Map<string, RouteFact[]>();
    for (const r of routes) {
      const g = routeGroup(r);
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g)!.push(r);
    }
    let keys = [...byGroup.keys()].sort((a, b) => byGroup.get(b)!.length - byGroup.get(a)!.length || (a < b ? -1 : 1));
    if (keys.length > MAX_GROUPS) {
      const rest = keys.slice(MAX_GROUPS - 1);
      const merged = rest.flatMap((k) => byGroup.get(k)!);
      for (const k of rest) byGroup.delete(k);
      byGroup.set('Other routes', merged);
      keys = [...keys.slice(0, MAX_GROUPS - 1), 'Other routes'];
    }
    keys.sort((a, b) => (a < b ? -1 : 1));
    const apiId = (g: string) => `api:${app.id}:${g}`;
    for (const g of keys) {
      const rs = byGroup.get(g)!.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.method < b.method ? -1 : 1));
      for (const r of rs) groupOfRoute.set(r, apiId(g));
      const methods = [...new Set(rs.map((r) => r.method))].sort();
      nodes.set(apiId(g), {
        id: apiId(g),
        kind: 'api',
        layer: 'transport',
        name: g,
        detail: `${rs.length} route${rs.length === 1 ? '' : 's'} · ${methods.join(', ')}`,
        app: app.id,
        files: [...new Set(rs.map((r) => r.file))].slice(0, 6).map((path) => ({ path, line: rs.find((r) => r.file === path)!.line })),
        routes: rs.map((r) => ({ method: r.method, path: r.path, file: r.file, line: r.line, auth: !!r.auth })),
        evidence: rs.slice(0, 4).map(routeEv),
        confidence: 'confirmed',
      });
      members.push(apiId(g));
    }

    // Middleware registered in this app, in source order; request-phase before handlers.
    const mws = d.facts.middleware
      .filter((m) => d.appsOf(m.file).includes(app.id))
      .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
    const mwNode = (m: MiddlewareFact): string => {
      const id = `mw:${m.file}:${m.line}`;
      if (!nodes.has(id)) {
        const ev = d.e({ kind: 'middleware', file: m.file, line: m.line, snippet: m.snippet, detail: `${m.name}${m.note ? ` — ${m.note}` : ''}` });
        // A note like "CSRF: …" names the middleware; otherwise the registration does.
        const lead = m.note ? /^([A-Za-z][\w /-]{1,24}):\s/.exec(m.note)?.[1] : undefined;
        const title = lead ? `${lead} check` : m.name;
        const detail = [lead || m.name !== title ? m.name : '', m.purpose !== 'other' ? m.purpose : '', m.note && !lead ? m.note.slice(0, 60) : ''].filter(Boolean).join(' · ') || m.kind;
        nodes.set(id, { id, kind: 'middleware', layer: 'backend', name: title, detail, app: app.id, files: [{ path: m.file, line: m.line }], evidence: [ev], confidence: 'confirmed' });
        members.push(id);
      }
      return id;
    };
    const requestMw = mws.filter((m) => !(m.phase && RESPONSE_PHASES.has(m.phase))).map(mwNode);
    const responseMw = mws.filter((m) => m.phase && RESPONSE_PHASES.has(m.phase)).map(mwNode);
    const authRoutes = routes.filter((r) => r.auth);
    let authNode: string | undefined;
    if (authRoutes.length) {
      authNode = `mw:${app.id}:route-auth`;
      nodes.set(authNode, {
        id: authNode,
        kind: 'middleware',
        layer: 'backend',
        name: 'Route auth guards',
        detail: `${authRoutes.length} of ${routes.length} routes · ${authRoutes[0].auth!.snippet.slice(0, 40)}`,
        app: app.id,
        files: authRoutes.slice(0, 4).map((r) => ({ path: r.file, line: r.auth!.line })),
        evidence: authRoutes.slice(0, 4).map((r) => d.e({ kind: 'auth', file: r.file, line: r.auth!.line, snippet: r.auth!.snippet, detail: `Auth guard on ${r.method} ${r.path}` })),
        confidence: 'strong',
      });
      members.push(authNode);
    }
    for (let k = 1; k < requestMw.length; k++) link(requestMw[k - 1], requestMw[k], 'next', 'route', nodes.get(requestMw[k])!.evidence);

    // Route handlers, grouped by file.
    const handlerOf = (file: string) => `handler:${file}`;
    const routeFiles = new Map<string, RouteFact[]>();
    for (const r of routes) {
      if (!routeFiles.has(r.file)) routeFiles.set(r.file, []);
      routeFiles.get(r.file)!.push(r);
    }
    for (const [file, rs] of routeFiles) {
      const id = handlerOf(file);
      nodes.set(id, {
        id,
        kind: 'handler',
        layer: 'backend',
        name: basename(file),
        detail: `${rs.length} handler${rs.length === 1 ? '' : 's'}${rs[0].framework ? ` · ${rs[0].framework}` : ''}`,
        app: app.id,
        files: [{ path: file, line: rs[0].line }],
        routes: rs.map((r) => ({ method: r.method, path: r.path, file: r.file, line: r.line, auth: !!r.auth })),
        evidence: rs.slice(0, 3).map(routeEv),
        confidence: 'confirmed',
      });
      members.push(id);
      for (const r of rs) {
        const g = groupOfRoute.get(r)!;
        const ev = [routeEv(r)];
        if (requestMw.length) {
          link(g, requestMw[0], 'every request', 'route', ev);
          link(requestMw.at(-1)!, r.auth && authNode ? authNode : id, r.auth && authNode ? 'guarded routes' : 'routes to', 'route', ev);
        } else link(g, r.auth && authNode ? authNode : id, r.auth && authNode ? 'guarded routes' : 'routes to', 'route', ev);
        if (r.auth && authNode) link(authNode, id, 'routes to', 'route', ev, 'strong');
      }
      for (const mw of responseMw) link(id, mw, 'response', 'route', nodes.get(mw)!.evidence);
    }

    // Services: project modules the handlers reference, and modules that call data stores or APIs.
    const inApp = (f: string) => d.appsOf(f).includes(app.id);
    const refCount = new Map<string, { count: number; from: Map<string, { line: number; file: string }> }>();
    const noteRef = (from: string, file: string, line: number) => {
      if (!refCount.has(file)) refCount.set(file, { count: 0, from: new Map() });
      const e = refCount.get(file)!;
      e.count++;
      if (!e.from.has(from)) e.from.set(from, { line, file: from });
    };
    for (const r of routes) {
      for (const ref of r.refs ?? []) if (ref.file !== r.file && inApp(ref.file) && !routeFiles.has(ref.file)) noteRef(handlerOf(r.file), ref.file, ref.line);
    }
    // Second level: what those modules' definitions reference.
    const symbolsByFile = new Map<string, typeof d.facts.symbols>();
    for (const s of d.facts.symbols) {
      if (!symbolsByFile.has(s.file)) symbolsByFile.set(s.file, []);
      symbolsByFile.get(s.file)!.push(s);
    }
    for (const file of [...refCount.keys()]) {
      for (const s of symbolsByFile.get(file) ?? []) for (const ref of s.refs) if (ref.file !== file && inApp(ref.file) && !routeFiles.has(ref.file)) noteRef(`svc:${file}`, ref.file, ref.line);
    }
    const callsByFile = new Map<string, number>();
    for (const c of d.facts.calls) if (inApp(c.file) && c.op !== 'consume') callsByFile.set(c.file, (callsByFile.get(c.file) ?? 0) + 1);
    for (const h of d.facts.httpCalls) if (inApp(h.file) && !d.isUiFile(h.file, app)) callsByFile.set(h.file, (callsByFile.get(h.file) ?? 0) + 1);
    const graphType = new Map(d.graph.nodes.map((n) => [n.id, n.type]));
    const candidates = new Set<string>([...refCount.keys()].filter((f) => callsByFile.has(f) || ['service', 'api', 'action'].includes(graphType.get(f) ?? '')));
    for (const f of callsByFile.keys()) if (!routeFiles.has(f) && !d.isUiFile(f, app)) candidates.add(f);
    const services = [...candidates]
      .sort((a, b) => (refCount.get(b)?.count ?? 0) + (callsByFile.get(b) ?? 0) - ((refCount.get(a)?.count ?? 0) + (callsByFile.get(a) ?? 0)) || (a < b ? -1 : 1))
      .slice(0, MAX_SERVICES);
    for (const f of services) {
      const id = `svc:${f}`;
      const calls = callsByFile.get(f) ?? 0;
      const users = refCount.get(f)?.from.size ?? 0;
      nodes.set(id, {
        id,
        kind: 'service',
        layer: 'services',
        name: stem(f),
        detail: [calls ? `${calls} data/API call${calls === 1 ? '' : 's'}` : '', users ? `used by ${users}` : ''].filter(Boolean).join(' · ') || basename(f),
        app: app.id,
        files: [{ path: f }],
        evidence: [],
        confidence: 'confirmed',
      });
      members.push(id);
    }
    const serviceSet = new Set(services);
    for (const f of services) {
      for (const [from, at] of refCount.get(f)?.from ?? []) {
        if (from.startsWith('svc:') && !serviceSet.has(from.slice(4))) continue;
        const ev = d.e({ kind: 'import', file: at.file.replace(/^(handler|svc):/, ''), line: at.line, detail: `References ${f}` });
        link(from, `svc:${f}`, 'calls', 'call', [ev]);
        const sn = nodes.get(`svc:${f}`)!;
        if (sn.evidence.length < 3) sn.evidence.push(ev);
      }
    }

    const ownerOf = (file: string) => (routeFiles.has(file) ? handlerOf(file) : serviceSet.has(file) ? `svc:${file}` : undefined);
    for (const f of routeFiles.keys()) fileOwner.set(f, handlerOf(f));
    for (const f of services) fileOwner.set(f, `svc:${f}`);
    // Services no handler body names directly are still imported by handlers or other services.
    for (const f of services) {
      if ([...links.values()].some((l) => l.target === `svc:${f}`)) continue;
      for (const hop of d.fileGraph.in.get(f) ?? []) {
        const owner = ownerOf(hop.source);
        if (!owner || owner === `svc:${f}`) continue;
        link(owner, `svc:${f}`, 'imports', 'call', [d.e({ kind: 'import', file: hop.source, line: hop.line, detail: `Imports ${f}` })]);
      }
    }

    // Data stores, queues and external services reached from handlers and services.
    const unknownId = `unknown:${app.id}`;
    for (const c of d.facts.calls) {
      const owner = ownerOf(c.file);
      if (!owner || c.op === 'consume') continue;
      const site = callSite(d, c, app.id);
      if (!site || site.node === app.id) continue;
      if (!archNode(site.node)) continue;
      const async = site.mode === 'publish';
      // The label is this call's operation (SQL, cache read, enqueue…), with the ORM or client that makes it.
      const tool = CATALOG_BY_ID.get(c.tool);
      const op = opLabel(c.op, c.tool);
      const label = tool && tool.category === 'orm' ? `${op} · ${tool.name}` : op;
      link(owner, site.node, label, async ? 'async' : 'data', site.evidence, 'confirmed', async);
      for (const consumer of site.consumers ?? []) if (archNode(consumer.app)) link(site.node, consumer.app, 'consume', 'async', [consumer.evidence], 'confirmed', true);
    }
    for (const h of d.facts.httpCalls) {
      const owner = ownerOf(h.file);
      if (!owner) continue;
      const site = httpSite(d, h, app.id);
      if (!site) continue;
      if (site.mode === 'unknown') {
        if (!nodes.has(unknownId)) {
          nodes.set(unknownId, { id: unknownId, kind: 'external', layer: 'external', name: 'Unknown target', detail: 'URL built at runtime', app: app.id, files: [], evidence: [], confidence: 'possible' });
        }
        const u = nodes.get(unknownId)!;
        if (u.files.length < 4) u.files.push({ path: h.file, line: h.line });
        if (u.evidence.length < 4) u.evidence.push(...site.evidence);
        u.detail = `${h.envVar ? `URL from ${h.envVar}` : 'URL built at runtime'} · ${u.files.length} call site${u.files.length === 1 ? '' : 's'}`;
        link(owner, unknownId, `${clientLabel(h.client)} · target unknown`, 'call', site.evidence, 'possible');
        continue;
      }
      // Calls into another application of this repository go through its transport and API groups (below).
      if (site.node === app.id || serverApps.some((a) => a.id === site.node) || !archNode(site.node)) continue;
      link(owner, site.node, `${protocolOf(h)} · ${clientLabel(h.client)}`, 'call', site.evidence);
    }

    const info = archById.get(app.id);
    groups.push({ app: app.id, name: info?.name ?? app.name, frameworks: (info?.app?.chips ?? []).map((c) => archById.get(c)?.name ?? c), nodes: members });
  }

  // Transports: client → server calls, by protocol, into the API groups they hit.
  const transportCalls = new Map<string, { client: string; server: string; proto: string; calls: HttpCallFact[] }>();
  const connected = (a: string, b: string) => arch.edges.some((e) => e.source === a && e.target === b && e.overlays.includes('dataflow'));
  for (const h of d.facts.httpCalls) {
    if (!h.url?.startsWith('/')) continue;
    const fromApps = d.appsOf(h.file);
    let client: string | undefined;
    if (fromApps.length) {
      const info = d.appById(fromApps[0]);
      const ui = `client:${fromApps[0].slice(4)}`;
      client = info && d.isUiFile(h.file, info) && archById.has(ui) ? ui : fromApps[0];
    } else if (archById.get('client:browser')?.files.some((f) => f.path === h.file)) client = 'client:browser';
    if (!client) continue;
    for (const server of serverApps) {
      // The detector must agree the two are connected; a call inside the server itself is not transport.
      if (client === server.id || !connected(client, server.id)) continue;
      const proto = protocolOf(h);
      // A server calling another service: the call starts at its handler or service module.
      const from = serverApps.some((a) => a.id === client) ? (fileOwner.get(h.file) ?? client) : client;
      const key = `${from}|${server.id}|${proto}`;
      if (!transportCalls.has(key)) transportCalls.set(key, { client: from, server: server.id, proto, calls: [] });
      transportCalls.get(key)!.calls.push(h);
    }
  }
  for (const t of transportCalls.values()) {
    if (!nodes.has(t.client) && !archNode(t.client)) continue;
    const routes = (d.routesByApp.get(t.server) ?? []).filter((r) => r.kind !== 'page');
    const matched = t.calls
      .map((h) => ({ h, r: h.url?.startsWith('/') ? bestRoutes(routes.filter((r) => !h.method || r.method === 'ANY' || r.method === h.method), h.url)[0] : undefined }))
      .filter((x) => x.r);
    if (!matched.length) continue;
    const id = `transport:${t.client}->${t.server}:${t.proto}`;
    const libs = [...new Set(matched.map((x) => clientLabel(x.h.client)))];
    const evs = matched.slice(0, 4).map((x) => d.e({ kind: 'http-call', file: x.h.file, line: x.h.line, snippet: x.h.snippet, detail: transportLabel(x.h) }));
    nodes.set(id, { id, kind: 'transport', layer: 'transport', name: PROTOCOL_NAME[t.proto] ?? t.proto, detail: `${libs.slice(0, 2).join(', ')} · ${matched.length} call site${matched.length === 1 ? '' : 's'}`, libraries: libs, files: [...new Set(matched.map((x) => x.h.file))].slice(0, 4).map((path) => ({ path })), evidence: evs, confidence: 'confirmed' });
    link(t.client, id, libs.slice(0, 2).join(', '), 'transport', evs, 'confirmed', false, matched.length);
    for (const x of matched) {
      const g = groupOfRoute.get(x.r!);
      if (g) link(id, g, x.h.method && x.h.method !== 'ANY' ? x.h.method : t.proto, 'transport', [d.e({ kind: 'http-call', file: x.h.file, line: x.h.line, snippet: x.h.snippet, detail: transportLabel(x.h) })]);
    }
  }

  // Everything else that runs or is used: workers and their inputs, remaining data/external nodes, infrastructure.
  for (const n of arch.nodes) {
    if (n.display !== 'node' || nodes.has(n.id)) continue;
    if (n.kind === 'app' && serverApps.some((a) => a.id === n.id)) continue;
    if (n.kind === 'app' && n.layer !== 'async' && n.layer !== 'clients') continue;
    archNode(n.id);
  }
  for (const e of arch.edges) {
    const s = nodes.get(e.source);
    // Proxies and gateways in front of a server route to its API groups.
    const server = serverApps.find((a) => a.id === e.target);
    if (s && server && (s.kind === 'proxy' || s.kind === 'client') && e.overlays.includes('dataflow')) {
      const apis = [...nodes.values()].filter((n) => n.kind === 'api' && n.app === server.id);
      if (s.kind === 'proxy' || !transportCalls.size || ![...links.values()].some((l) => l.source === s.id)) for (const api of apis) link(s.id, api.id, e.labels.filter((l) => l !== 'depends on').join(' · ') || 'routes to', 'transport', e.evidence.slice(0, 3), e.confidence);
      continue;
    }
    const t = nodes.get(e.target);
    if (!s || !t) continue;
    if (s.kind === 'client' && t.kind === 'transport') continue;
    // Only edges not already expressed through components (workers, brokers, proxies, delivery).
    if ([...links.values()].some((l) => l.source === s.id && l.target === t.id)) continue;
    const isDelivery = e.overlays.includes('deployment') && !e.overlays.includes('dataflow');
    if (isDelivery) continue;
    if (s.kind === 'client' || s.kind === 'worker' || s.kind === 'queue' || s.kind === 'proxy' || t.kind === 'worker') {
      link(s.id, t.id, e.labels.join(' · '), e.async ? 'async' : 'data', e.evidence.slice(0, 3), e.confidence, e.async);
    }
  }
  // Infrastructure nodes describe what they build or deploy.
  for (const n of nodes.values()) {
    if (n.layer !== 'infra') continue;
    const targets = arch.edges.filter((e) => e.source === n.id && e.overlays.includes('deployment')).map((e) => archById.get(e.target)?.name).filter(Boolean);
    if (targets.length) n.detail = `${arch.edges.find((e) => e.source === n.id && e.overlays.includes('deployment'))?.labels[0] ?? 'builds'} ${[...new Set(targets)].slice(0, 3).join(', ')}`;
  }

  const layers = SYSTEM_LAYERS.filter((l) => [...nodes.values()].some((n) => n.layer === l));
  return { layers, nodes: [...nodes.values()], links: [...links.values()], groups };
}

export type { HttpMethod };
