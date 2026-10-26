import { CATALOG_BY_ID } from './catalog.ts';
import type { DetectorContext as Detector } from './context.ts';
import { opLabel, opText } from './ops.ts';
import { stableId } from './evidence.ts';
import { bestRoutes, FileGraph, routeMatches, type Hop } from './graph.ts';
import { clientLabel, transportLabel } from './transport.ts';
import type { CallFact, Confidence, Flow, FlowIndex, FlowLane, FlowStage, FlowStep, FlowStepMode, HttpCallFact, MiddlewareFact, RouteFact, SymbolFact, SymbolRef, UiTriggerFact } from './types.ts';

/**
 * Playable scenarios, generated only from traceable code paths:
 *   client call site → route handler → functions it references → data/cache/queue/external calls
 *   → (queue) consumer → its calls.
 *
 * Tracing follows the project names each function body references (JS/TS and Python), falling
 * back to file imports for other languages. Where the next hop cannot be determined — a URL
 * built at runtime, a broker that is not declared — the flow stops with an explicit
 * "target unknown" step instead of guessing.
 */

/** A region of code to scan: a function body (with its references) or a whole module (refs undefined). */
interface Scope {
  file: string;
  start: number;
  end: number;
  refs?: SymbolRef[];
  name?: string;
}

interface ScopeHop {
  source: string;
  line: number;
  target: string;
  targetLine: number;
  name?: string;
}

const MAX_DEPTH = 4;
const MAX_STEPS = 24;
/** Every API route gets a flow (the catalog); user actions sort first. */
const MAX_FLOWS = 150;

export interface Site {
  file: string;
  line: number;
  node: string;
  mode: FlowStepMode;
  explanation: string;
  evidence: string[];
  call?: CallFact;
  http?: HttpCallFact;
  /** For publish/enqueue sites: consumers to continue into. */
  consumers?: { app: string; file: string; line: number; name?: string; evidence: string }[];
  /** For HTTP calls into another app's route. */
  crossRoute?: { app: string; route: RouteFact };
}

export function buildFlows(d: Detector): Flow[] {
  const { facts } = d;
  const callsByFile = group(facts.calls, (c) => c.file);
  const httpByFile = group(facts.httpCalls, (h) => h.file);
  const flows: Flow[] = [];
  const seen = new Set<string>();
  const routeEvidence = (r: RouteFact) => d.e({ kind: 'route', file: r.file, line: r.line, snippet: r.snippet, detail: `${r.method} ${r.path}` });

  const edgeId = (a: string, b: string) => d.edges.get(`${a}->${b}`)?.id ?? d.edges.get(`${b}->${a}`)?.id;

  /** Data-moving sites in `file` for `app`, optionally limited to a line range. */
  const sitesIn = (file: string, app: string, range?: [number, number]): Site[] => {
    const inRange = (line: number) => !range || (line >= range[0] && line <= range[1]);
    const out: Site[] = [];
    for (const c of callsByFile.get(file) ?? []) {
      if (!inRange(c.line) || c.op === 'consume') continue;
      const s = callSite(d, c, app);
      if (s) out.push(s);
    }
    for (const h of httpByFile.get(file) ?? []) {
      if (!inRange(h.line)) continue;
      const s = httpSite(d, h, app);
      if (s) out.push(s);
    }
    return out.sort((a, b) => a.line - b.line);
  };

  const symbolsByFile = group(facts.symbols, (x) => x.file);
  const asyncDefs = facts.definitions.filter((x) => x.kind === 'task' || x.kind === 'queue-consumer' || x.kind === 'topic-consumer');
  const reexports = new Map<string, Map<string, string>>(); // file → symbol → file it comes from
  for (const i of facts.internalImports) for (const sym of i.symbols) {
    if (!reexports.has(i.source)) reexports.set(i.source, new Map());
    reexports.get(i.source)!.set(sym, i.target);
  }
  for (const e of d.graph.edges) if (e.resolved && !e.external) for (const sym of e.symbols) {
    if (sym === '*' || sym === 'default') continue;
    if (!reexports.has(e.source)) reexports.set(e.source, new Map());
    if (!reexports.get(e.source)!.has(sym)) reexports.get(e.source)!.set(sym, e.target);
  }
  const findDef = (file: string, name: string | undefined, hops = 0): SymbolFact | undefined => {
    if (!name) return undefined;
    const hit = symbolsByFile.get(file)?.find((x) => x.name === name);
    if (hit) return hit;
    const from = reexports.get(file)?.get(name);
    return from && hops < 2 ? findDef(from, name, hops + 1) : undefined;
  };
  const enclosing = (file: string, line: number): SymbolFact | undefined =>
    (symbolsByFile.get(file) ?? []).filter((x) => x.name !== 'default' && x.line <= line && x.end >= line).sort((a, b) => a.end - a.line - (b.end - b.line))[0];
  /** The scope a route's handler runs in. */
  const routeScope = (r: RouteFact): Scope => ({ file: r.file, start: r.bodyStart ?? r.line, end: r.bodyEnd ?? Number.MAX_SAFE_INTEGER, refs: r.refs ?? (symbolsByFile.has(r.file) ? [] : undefined), name: r.handler });

  /**
   * Sites reachable from `start` within `app`. Within a scope, calls and references are taken in
   * line order and each reference is expanded where it occurs (depth-first), which follows the
   * order the code is written in — e.g. a FastAPI dependency in the signature before the body.
   */
  const trace = (start: Scope, app: string, maxDepth: number) => {
    const allow = (f: string) => d.appsOf(f).includes(app);
    const result: { scope: Scope; chain: ScopeHop[]; sites: Site[] }[] = [];
    const visited = new Set<string>([`${start.file}#${start.start}`]);
    const visit = (scope: Scope, chain: ScopeHop[], depth: number) => {
      const sites = sitesIn(scope.file, app, [scope.start, scope.end]);
      type Event = { line: number; site?: Site; next?: { scope: Scope; hop: ScopeHop } };
      const events: Event[] = sites.map((site) => ({ line: site.line, site }));
      if (depth < maxDepth) {
        if (scope.refs) {
          for (const ref of scope.refs) {
            const def = findDef(ref.file, ref.symbol);
            if (!def || !allow(def.file)) continue;
            // Referencing a task (`refresh_price.delay()`) queues it; its body runs in a worker, not here.
            if (asyncDefs.some((x) => x.file === def.file && x.line >= def.line && x.line <= def.end)) continue;
            events.push({ line: ref.line, next: { scope: { file: def.file, start: def.line, end: def.end, refs: def.refs, name: def.name }, hop: { source: scope.file, line: ref.line, target: def.file, targetLine: def.line, name: def.name } } });
          }
        } else {
          // No symbol facts for this language: follow file imports, whole modules at a time.
          for (const hop of d.fileGraph.out.get(scope.file) ?? []) {
            if (!allow(hop.target)) continue;
            events.push({ line: hop.line, next: { scope: { file: hop.target, start: 1, end: Number.MAX_SAFE_INTEGER }, hop: { source: scope.file, line: hop.line, target: hop.target, targetLine: 1 } } });
          }
        }
      }
      events.sort((a, b) => a.line - b.line || (a.site ? -1 : 1));
      for (const ev of events) {
        if (ev.site) {
          const last = result.at(-1);
          if (last && last.scope === scope) last.sites.push(ev.site);
          else result.push({ scope, chain, sites: [ev.site] });
        } else if (ev.next) {
          const key = `${ev.next.scope.file}#${ev.next.scope.start}`;
          if (visited.has(key)) continue;
          visited.add(key);
          visit(ev.next.scope, [...chain, ev.next.hop], depth + 1);
        }
      }
    };
    visit(start, [], 0);
    return result;
  };

  const build = (opts: {
    title: string;
    trigger: Flow['trigger'];
    first: FlowStep[];
    app: string;
    scope: Scope;
    variant?: 'cache-hit' | 'cache-miss';
    notes: string[];
    /** Keep the flow even when the handler makes no traced data calls (a client call reaches it). */
    allowEmpty?: boolean;
  }): Flow | null => {
    const steps: FlowStep[] = [...opts.first];
    let truncated = false;
    const traced = trace(opts.scope, opts.app, MAX_DEPTH);
    let sites = traced.flatMap((t) => t.sites.map((s) => ({ s, chain: t.chain })));
    if (!sites.length && !opts.allowEmpty) return null;

    if (opts.variant) {
      const cacheReads = sites.filter((x) => x.s.call?.op === 'cache-read');
      if (opts.variant === 'cache-hit') sites = cacheReads.slice(0, 1);
      else {
        const firstRead = cacheReads[0];
        sites = sites.filter((x) => x !== firstRead);
        sites.unshift(firstRead);
      }
    }

    const addedHops = new Set<string>();
    let prevNode = steps.at(-1)?.node ?? opts.app;
    const push = (step: Omit<FlowStep, 'step' | 'edge'>) => {
      if (steps.length >= MAX_STEPS) {
        truncated = true;
        return false;
      }
      const edge = step.node !== prevNode ? edgeId(prevNode, step.node) : undefined;
      steps.push({ ...step, step: steps.length + 1, edge });
      if (step.node !== opts.app || step.mode !== 'sync') prevNode = step.node;
      return true;
    };

    for (const { s, chain } of sites) {
      for (const hop of chain) {
        const key = `${hop.source}:${hop.line}->${hop.target}:${hop.targetLine}`;
        if (addedHops.has(key)) continue;
        addedHops.add(key);
        prevNode = opts.app;
        const what = hop.name ? `${hop.name}${/^[A-Z]/.test(hop.name) ? '' : '()'}` : hop.target;
        const where = hop.target === hop.source ? `${hop.target}:${hop.targetLine}` : `${hop.target}:${hop.targetLine}`;
        const ev = d.e({ kind: 'import', file: hop.source, line: hop.line, detail: hop.name ? `References ${hop.name} (defined at ${where})` : `Imports ${hop.target}` });
        if (!push({ node: opts.app, file: hop.source, line: hop.line, mode: 'sync', explanation: hop.name ? `Uses ${what}, defined in ${where} (referenced at ${hop.source}:${hop.line}).` : `Calls into ${hop.target} (imported at ${hop.source}:${hop.line}).`, evidence: [ev], kind: 'service', lane: laneOfApp(d, opts.app), label: hop.name ? what : hop.target.slice(hop.target.lastIndexOf('/') + 1), fn: hop.name, input: hop.name ? `called at ${hop.source}:${hop.line}` : undefined, output: hop.name ? `defined at ${hop.target}:${hop.targetLine}` : undefined })) break;
      }
      let mode = s.mode;
      let explanation = s.explanation;
      if (opts.variant && s.call?.op === 'cache-read') {
        mode = opts.variant;
        explanation = opts.variant === 'cache-hit' ? `${s.explanation} On a hit, the cached value is returned without further calls.` : `${s.explanation} On a miss, the handler continues to the calls below.`;
      }
      prevNode = opts.app;
      if (!push({ node: s.node, file: s.file, line: s.line, mode, explanation, evidence: s.evidence, ...siteMeta(d, s, opts.app, mode) })) break;
      if (s.mode === 'unknown') truncated = true;
      for (const consumer of s.consumers ?? []) {
        const workerName = d.nodes.get(consumer.app)?.name ?? consumer.app;
        if (!push({ node: consumer.app, file: consumer.file, line: consumer.line, mode: 'consume', explanation: `${workerName} picks up ${consumer.name ? `"${consumer.name}"` : 'the message'} (${consumer.file}:${consumer.line}). This runs in the background and does not block the response.`, evidence: [consumer.evidence], lane: 'async', kind: 'worker', branch: 'async', label: `${workerName} consumes${consumer.name ? ` ${consumer.name}` : ''}`, tool: consumer.app })) break;
        const def = enclosing(consumer.file, consumer.line);
        const cScope: Scope = def ? { file: def.file, start: def.line, end: def.end, refs: def.refs, name: def.name } : { file: consumer.file, start: consumer.line, end: consumer.line + 200, refs: symbolsByFile.has(consumer.file) ? [] : undefined };
        for (const t of trace(cScope, consumer.app, 3)) {
          for (const cs of t.sites) {
            if (cs.call?.op === 'consume') continue;
            prevNode = consumer.app;
            const mode2: FlowStepMode = cs.mode === 'sync' ? 'async' : cs.mode;
            if (!push({ node: cs.node, file: cs.file, line: cs.line, mode: mode2, explanation: `${cs.explanation} (in the worker)`, evidence: cs.evidence, ...siteMeta(d, cs, consumer.app, mode2), lane: 'async', branch: 'async' })) break;
            if (cs.mode === 'unknown') truncated = true;
          }
        }
      }
      if (s.crossRoute) {
        const r = s.crossRoute.route;
        if (!push({ node: s.crossRoute.app, file: r.file, line: r.line, mode: 'sync', explanation: `Handled by ${r.method} ${r.path} in ${d.nodes.get(s.crossRoute.app)?.name} (${r.file}:${r.line}).`, evidence: [routeEvidence(r)], lane: 'backend', kind: 'route', label: `${r.method} ${r.path}`, transport: s.http ? transportLabel(s.http) : undefined })) break;
        for (const t of trace(routeScope(r), s.crossRoute.app, 2)) {
          for (const cs of t.sites) {
            prevNode = s.crossRoute.app;
            if (!push({ node: cs.node, file: cs.file, line: cs.line, mode: cs.mode, explanation: cs.explanation, evidence: cs.evidence, ...siteMeta(d, cs, s.crossRoute.app, cs.mode) })) break;
          }
        }
      }
    }

    const nodesInFlow = new Set(steps.map((s) => s.node));
    const onlyInRouteFile = steps.every((s) => s.file === opts.scope.file || s.mode === 'consume' || steps[0] === s);
    const confidence: Confidence = opts.variant ? 'strong' : onlyInRouteFile ? 'confirmed' : 'strong';
    const notes = [...opts.notes];
    if (!onlyInRouteFile) notes.push(opts.scope.refs ? `Steps follow the functions each body references (up to ${MAX_DEPTH} levels), in the order they are written. They show code the request can reach; runtime order and branches are not proven.` : `Steps follow file imports from ${opts.scope.file} (up to ${MAX_DEPTH} hops); in this language CodePilot does not resolve individual functions, so whole modules are included.`);
    if (truncated && steps.some((s) => s.mode === 'unknown')) notes.push('Tracing stopped at an outbound call whose target is not written in the code.');
    if (steps.length >= MAX_STEPS) notes.push(`Showing the first ${MAX_STEPS} steps.`);
    const flow: Flow = { id: stableId('flow_', `${opts.title}|${opts.variant ?? ''}|${opts.scope.file}`), title: opts.title, trigger: opts.trigger, variant: opts.variant, confidence, steps, truncated, notes };
    void nodesInFlow;
    return flow;
  };

  // --- Route-triggered flows -----------------------------------------------------------------------------------------------
  const clientCalls = facts.httpCalls.filter((h) => h.url?.startsWith('/'));
  for (const app of d.apps) {
    for (const r of d.routesByApp.get(app.id) ?? []) {
      const title = r.kind === 'action' ? `Server action ${r.handler ?? r.path.slice(7)}` : r.kind === 'page' ? `Page ${r.path}` : `${r.method} ${r.path}`;
      const key = `${app.id}|${title}|${r.file}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const first: FlowStep[] = [];
      // A client call site that targets this route, if the code has one.
      const caller = r.kind === 'api'
        ? clientCalls
            .filter((h) => {
              if (!routeMatches(r.path, h.url!) || (h.method && r.method !== 'ANY' && h.method !== r.method)) return false;
              // The call must pick this route over any other declared route.
              if (!bestRoutes(facts.routes.filter((x) => x.kind !== 'page' && (!h.method || x.method === 'ANY' || x.method === h.method)), h.url!).includes(r)) return false;
              const from = d.appsOf(h.file);
              return from.length ? from.some((a) => a !== app.id || d.isUiFile(h.file, app)) : d.nodes.has('client:browser') && d.nodes.get('client:browser')!.files.has(h.file);
            })
            .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line))[0]
        : undefined;
      if (caller) {
        const fromApp = d.appsOf(caller.file)[0];
        const fromInfo = fromApp ? d.appById(fromApp) : undefined;
        const clientNode = !fromApp ? 'client:browser' : fromInfo && d.isUiFile(caller.file, fromInfo) ? `client:${fromApp.slice(4)}` : fromApp;
        const node = d.nodes.has(clientNode) ? clientNode : fromApp;
        const ev = d.e({ kind: 'http-call', file: caller.file, line: caller.line, snippet: caller.snippet, detail: `${caller.client} ${caller.method ?? ''} ${caller.url}`.replace(/\s+/g, ' ') });
        first.push({ step: 1, node, file: caller.file, line: caller.line, mode: 'sync', explanation: `${d.nodes.get(node)?.name ?? node} requests ${caller.url} (${caller.file}:${caller.line}).`, evidence: [ev] });
      } else if (r.kind === 'page' || r.kind === 'action') {
        const client = `client:${app.id.slice(4)}`;
        if (d.nodes.has(client)) first.push({ step: 1, node: client, file: r.file, line: r.line, mode: 'sync', explanation: r.kind === 'page' ? `The browser requests ${r.path}.` : `A form or component invokes the server action.`, evidence: [routeEvidence(r)], lane: 'frontend', kind: 'action', label: r.kind === 'page' ? `Browser navigates to ${r.path}` : 'Form or component invokes the action', transport: r.kind === 'page' ? `GET ${r.path}` : 'POST (server action)' });
      }
      const mw = d.edges.get(`tool:nextjs-middleware->${app.id}`);
      if (mw && r.framework === 'nextjs') {
        const ev = [...mw.evidence][0];
        const e = d.ev.get(ev);
        first.push({ step: first.length + 1, node: 'tool:nextjs-middleware', file: e?.file ?? r.file, line: e?.line, mode: 'sync', explanation: `Next.js middleware runs first (${e?.file}).`, evidence: [ev], edge: first.length ? d.edges.get(`${first[0].node}->tool:nextjs-middleware`)?.id : undefined });
      }
      const handlerText = r.kind === 'page' ? `${app.name} renders page ${r.path} (${r.file}).` : `${app.name} handles ${r.kind === 'action' ? `server action ${r.handler}` : `${r.method} ${r.path}`}${r.handler && r.kind !== 'action' ? ` in ${r.handler}()` : ''} (${r.file}:${r.line}).${r.auth ? ` Auth check: ${r.auth.snippet}` : ''}`;
      first.push({ step: first.length + 1, node: app.id, file: r.file, line: r.line, mode: 'sync', explanation: handlerText, evidence: [routeEvidence(r)], edge: first.length ? d.edges.get(`${first.at(-1)!.node}->${app.id}`)?.id : undefined });
      const notes: string[] = [];
      if (first.length) {
        const routeStep = first.at(-1)!;
        routeStep.lane = 'backend';
        routeStep.kind = 'route';
        routeStep.label = r.kind === 'action' ? `Server action ${r.handler ?? ''}`.trim() : `${r.method} ${r.path}`;
        if (caller) routeStep.transport = transportLabel(caller);
        const params = [...r.path.matchAll(/[:{<[]\.{0,3}([A-Za-z_]\w*)/g)].map((m) => m[1]);
        routeStep.input = `${r.method} ${r.path}${params.length ? ` · params: ${params.join(', ')}` : ''}`;
        const callerStep = caller ? first[0] : undefined;
        if (callerStep) {
          const fromUi = callerStep.node.startsWith('client:') || d.nodes.get(callerStep.node)?.layer === 'clients';
          callerStep.lane = fromUi ? 'frontend' : 'backend';
          callerStep.kind = 'client';
          callerStep.label = caller!.fn ? `${caller!.owner ? `${caller!.owner}.` : ''}${caller!.fn}()` : clientLabel(caller!.client);
          callerStep.output = transportLabel(caller!);
        }
        for (const s of first) if (s.node === 'tool:nextjs-middleware') Object.assign(s, { lane: 'backend', kind: 'middleware', label: 'Next.js middleware' });
      }
      const base = { title, trigger: { kind: 'route' as const, method: r.method, path: r.path }, first, app: app.id, scope: routeScope(r), notes, allowEmpty: !!caller || r.kind !== 'page' };
      const decorate = (f: Flow) => withLifecycle(d, f, { app: app.id, route: r, caller, routeEvidence: routeEvidence(r) });
      const flow = build(base);
      if (!flow) continue;
      // Cache hit / miss variants: a cache read, a data call and a cache write on the same path.
      const ops = flow.steps.map((s) => ({ s, call: facts.calls.find((c) => c.file === s.file && c.line === s.line) }));
      const read = ops.find((o) => o.call?.op === 'cache-read');
      const write = ops.find((o) => o.call?.op === 'cache-write');
      const data = ops.find((o) => o.call && (o.call.op === 'sql' || o.call.op === 'query' || o.call.op === 'http' || o.call.op === 'ai' || o.call.op === 'search'));
      if (read && write && data && read.s.step < write.s.step) {
        const hit = build({ ...base, title: `${title} · cache hit`, variant: 'cache-hit', notes: [...notes, 'Hit/miss branches are inferred from a cache read, a data call and a cache write on the same traced path; the branch condition itself is not traced.'] });
        const miss = build({ ...base, title: `${title} · cache miss`, variant: 'cache-miss', notes: [...notes, 'Hit/miss branches are inferred from a cache read, a data call and a cache write on the same traced path; the branch condition itself is not traced.'] });
        if (hit) flows.push(decorate(hit));
        if (miss) flows.push(decorate(miss));
      } else {
        flows.push(decorate(flow));
      }
    }
  }

  // --- Queue-triggered flows: consumers, whether or not a route reaches them ----------------------------------------------------
  for (const def of facts.definitions) {
    if (!(def.kind === 'task' || def.kind === 'queue-consumer' || def.kind === 'topic-consumer')) continue;
    // Tasks and consumers run in worker processes when the code is shared with a server.
    const owners = d.appsOf(def.file);
    const workers = owners.filter((a) => d.appById(a)?.kind === 'worker');
    for (const appId of workers.length ? workers : owners) {
      const tool = def.tool ? CATALOG_BY_ID.get(def.tool) : undefined;
      const title = def.kind === 'task' ? `Task ${def.name ?? '(unnamed)'}` : def.kind === 'topic-consumer' ? `Topic ${def.name ?? '(unnamed)'}` : `Queue ${def.name ?? '(unnamed)'}`;
      const key = `${appId}|${title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const ev = d.e({ kind: 'queue', file: def.file, line: def.line, snippet: def.snippet, detail: `${tool?.name ?? 'Queue'} ${def.kind.replace('-', ' ')}${def.name ? ` "${def.name}"` : ''}` });
      const broker = [...d.edges.values()].find((e) => e.target === appId && e.labels.has('consume'))?.source;
      const first: FlowStep[] = [];
      if (broker) first.push({ step: 1, node: broker, file: def.file, line: def.line, mode: 'consume', explanation: `A message for ${def.name ? `"${def.name}"` : 'this consumer'} is taken from ${d.nodes.get(broker)?.name}.`, evidence: [ev] });
      first.push({ step: first.length + 1, node: appId, file: def.file, line: def.line, mode: 'async', explanation: `${d.nodes.get(appId)?.name} runs ${def.kind === 'task' ? `task ${def.name}` : `the consumer`} (${def.file}:${def.line}).`, evidence: [ev], edge: broker ? d.edges.get(`${broker}->${appId}`)?.id : undefined });
      const encl = enclosing(def.file, def.line);
      const scope: Scope = encl ? { file: encl.file, start: encl.line, end: encl.end, refs: encl.refs, name: encl.name } : { file: def.file, start: def.line, end: def.line + 200, refs: symbolsByFile.has(def.file) ? [] : undefined };
      const flow = build({ title, trigger: { kind: 'queue', name: def.name }, first, app: appId, scope, notes: ['Only calls inside the consumer and the code it references are shown.'] });
      if (flow) flows.push(flow);
    }
  }

  // --- Scheduled jobs -----------------------------------------------------------------------------------------------------------------------
  for (const def of facts.definitions.filter((x) => x.kind === 'scheduler')) {
    for (const appId of d.appsOf(def.file)) {
      const title = `Scheduled job in ${def.file.split('/').pop()}`;
      const key = `${appId}|${title}|${def.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const ev = d.e({ kind: 'config', file: def.file, line: def.line, snippet: def.snippet, detail: 'Schedule definition' });
      const encl = enclosing(def.file, def.line);
      const scope: Scope = encl ? { file: encl.file, start: encl.line, end: encl.end, refs: encl.refs, name: encl.name } : { file: def.file, start: 1, end: Number.MAX_SAFE_INTEGER, refs: symbolsByFile.has(def.file) ? [] : undefined };
      const flow = build({ title, trigger: { kind: 'schedule', name: def.snippet }, first: [{ step: 1, node: appId, file: def.file, line: def.line, mode: 'async', explanation: `A schedule triggers work (${def.file}:${def.line}).`, evidence: [ev] }], app: appId, scope, notes: ['The schedule definition is shown; the work it triggers is followed through the code it references.'] });
      if (flow) flows.push(flow);
    }
  }

  // Richest flows first; drop duplicates with identical step sequences.
  const unique = new Map<string, Flow>();
  for (const f of flows) {
    const sig = `${f.variant ?? ''}|${f.steps.map((s) => `${s.node}@${s.file}:${s.line}`).join('>')}`;
    if (!unique.has(sig)) unique.set(sig, f);
  }
  // User actions traced from the UI first, then the richest flows.
  return [...unique.values()]
    .sort((a, b) => (b.action ? 1 : 0) - (a.action ? 1 : 0) || new Set(b.steps.map((s) => s.node)).size - new Set(a.steps.map((s) => s.node)).size || (a.title < b.title ? -1 : 1))
    .slice(0, MAX_FLOWS)
    .map((f) => {
      // Queue and schedule flows run in workers; any step still without a lane gets its app's lane.
      const steps = f.steps.map((s, i) => {
        const n = d.nodes.get(s.node);
        const lane: FlowLane = s.lane ?? (s.mode === 'consume' || s.mode === 'async' || n?.layer === 'async' ? 'async' : n?.layer === 'external' ? 'external' : 'backend');
        const kind: FlowStep['kind'] = s.kind ?? (s.mode === 'consume' && n?.kind !== 'app' ? 'queue' : n?.category === 'queue' ? 'queue' : n?.kind === 'app' ? (lane === 'async' ? 'worker' : 'handler') : 'service');
        const route = kind === 'route' || kind === 'handler' ? facts.routes.find((r) => r.file === s.file && (r.line === s.line || r.bodyStart === s.line)) : undefined;
        const fn = route?.handler ?? enclosing(s.file, s.line ?? 0)?.name;
        const step: FlowStep = { ...s, step: i + 1, lane, kind, label: s.label ?? n?.name ?? s.node, fn: s.fn ?? fn };
        step.stage = stageOf(step, d);
        step.confidence = step.kind === 'unknown' ? 'unknown' : step.kind === 'service' || step.branch === 'cache-hit' || step.branch === 'cache-miss' ? 'strong' : 'confirmed';
        return step;
      });
      const order: FlowLane[] = ['frontend', 'backend', 'external', 'async'];
      return { ...f, steps, lanes: f.lanes ?? order.filter((l) => steps.some((s) => s.lane === l)), name: f.action?.label ?? f.title, index: indexOf(d, f, steps) };
    });
}

/** The argument text of the first call to `name(` in a line, with nested parentheses kept whole. */
function callArgs(line: string, name: string): string | undefined {
  const at = line.search(new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`));
  if (at < 0) return undefined;
  const open = line.indexOf('(', at);
  let depth = 0;
  for (let i = open; i < line.length; i++) {
    if (line[i] === '(') depth++;
    else if (line[i] === ')' && --depth === 0) return line.slice(open + 1, i).trim() || undefined;
  }
  return undefined;
}

/** Pipeline stage of a step: user → frontend → transport → backend → services → tools → data → external → response. */
function stageOf(s: FlowStep, d: Detector): FlowStage {
  switch (s.kind) {
    case 'action':
      return 'user';
    case 'client':
      return s.lane === 'frontend' ? 'transport' : 'services';
    case 'handler':
      return s.lane === 'frontend' ? 'frontend' : 'backend';
    case 'resolve':
    case 'state':
      return 'frontend';
    case 'route':
    case 'middleware':
      return 'backend';
    case 'service':
    case 'worker':
      return 'services';
    case 'cache':
    case 'queue':
      return 'tools';
    case 'data':
      return 'data';
    case 'external':
    case 'unknown':
      return 'external';
    case 'response':
      return 'response';
    default: {
      const n = d.nodes.get(s.node);
      return n?.layer === 'data' ? 'data' : n?.layer === 'external' ? 'external' : 'backend';
    }
  }
}

const CATEGORY_GROUP: Record<string, string> = { database: 'database', orm: 'database', search: 'database', storage: 'storage', cache: 'cache', queue: 'queue', worker: 'queue', auth: 'auth', payments: 'external', email: 'external', ai: 'external', service: 'external', messaging: 'external', cloud: 'external' };

/** Everything a flow touches, for the flow library's search. */
function indexOf(d: Detector, f: Flow, steps: FlowStep[]): FlowIndex {
  const routes = new Set<string>();
  if (f.trigger.kind === 'route' && f.trigger.method && f.trigger.path) routes.add(`${f.trigger.method} ${f.trigger.path}`);
  for (const s of steps) if (s.kind === 'route' && s.label) routes.add(s.label);
  const components = new Set<string>();
  if (f.action?.component) components.add(f.action.component);
  const functions = new Set<string>();
  for (const s of steps) if (s.fn && s.fn !== 'default') functions.add(s.fn);
  const techs = new Map<string, { id: string; name: string; category: string }>();
  const categories = new Set<string>();
  for (const s of steps) {
    const id = s.tool ?? s.node;
    const n = d.nodes.get(id);
    if (!n || n.kind === 'app' || id.startsWith('client:')) continue;
    techs.set(id, { id, name: n.name, category: n.category });
    const g = CATEGORY_GROUP[n.category] ?? (n.kind === 'host' || n.layer === 'external' ? 'external' : undefined);
    if (g) categories.add(g);
  }
  // What a step does, not only what the technology usually is: Redis as a broker is a queue here.
  for (const s of steps) {
    if (s.kind === 'queue' || s.kind === 'worker') categories.add('queue');
    else if (s.kind === 'cache') categories.add('cache');
    else if (s.kind === 'data') categories.add('database');
  }
  if (steps.some((s) => s.kind === 'unknown')) categories.add('external');
  if (steps.some((s) => s.kind === 'middleware' && /auth|guard/i.test(s.label ?? ''))) categories.add('auth');
  return { routes: [...routes], components: [...components], functions: [...functions], files: [...new Set(steps.map((s) => s.file))], technologies: [...techs.values()], categories: [...categories].sort() };
}

function group<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(it);
  }
  return m;
}

export function callSite(d: Detector, c: CallFact, app: string): Site | null {
  const tool = CATALOG_BY_ID.get(c.tool);
  if (!tool) return null;
  const ev = d.callEvidence(c);
  const where = `${c.file}:${c.line}`;
  if (c.op === 'http') return null; // covered by HTTP call sites (with URL detail)
  if (tool.category === 'orm') {
    const backend = d.ormBackend(tool.id);
    const node = backend ? d.targetFor(backend.tool, app) : 'tool:sql-database';
    if (!d.nodes.has(node)) return null;
    return { file: c.file, line: c.line, node, mode: 'sync', explanation: `${c.callee}() — SQL via ${tool.name} (${where}).`, evidence: [ev], call: c };
  }
  if (tool.id === 'celery' && c.op === 'enqueue') {
    const brokerEdge = [...d.edges.values()].find((e) => e.source === app && e.labels.has('enqueue'));
    const node = brokerEdge?.target ?? app;
    const consumers = d.facts.definitions
      .filter((x) => x.kind === 'task' && x.tool === 'celery' && (x.name === c.arg || x.name?.endsWith('.' + c.arg)))
      .flatMap((x) => d.appsOf(x.file).filter((a) => d.appById(a)?.kind === 'worker' || d.apps.length === 1).map((a) => ({ app: a, file: x.file, line: x.line, name: x.name, evidence: d.e({ kind: 'queue', file: x.file, line: x.line, snippet: x.snippet, detail: `Celery task "${x.name}"` }) })));
    return {
      file: c.file,
      line: c.line,
      node,
      mode: 'publish',
      explanation: `Enqueues Celery task "${c.arg}" with ${c.callee}() (${where})${brokerEdge ? ` on ${d.nodes.get(node)?.name}` : '; the broker is not declared in the analyzed files'}.`,
      evidence: [ev],
      call: c,
      consumers,
    };
  }
  if (tool.id === 'bullmq' && c.op === 'enqueue') {
    const node = d.targetFor('redis', app);
    if (!d.nodes.has(node)) return null;
    const consumers = d.facts.definitions
      .filter((x) => x.tool === 'bullmq' && x.kind === 'queue-consumer' && x.name && x.name === c.arg)
      .flatMap((x) => d.appsOf(x.file).map((a) => ({ app: a, file: x.file, line: x.line, name: x.name, evidence: d.e({ kind: 'queue', file: x.file, line: x.line, snippet: x.snippet, detail: `BullMQ worker for "${x.name}"` }) })));
    return { file: c.file, line: c.line, node, mode: 'publish', explanation: `Adds a job to queue "${c.arg ?? '?'}" with ${c.callee}() (${where}).`, evidence: [ev], call: c, consumers };
  }
  if ((tool.display ?? 'node') === 'chip') {
    if (c.op === 'auth') return { file: c.file, line: c.line, node: app, mode: 'sync', explanation: `Auth check: ${c.callee}() (${where}).`, evidence: [ev], call: c };
    return null;
  }
  const node = d.targetFor(tool.id, app);
  if (!d.nodes.has(node)) return null;
  const mode: FlowStepMode = c.op === 'publish' || c.op === 'enqueue' ? 'publish' : c.op === 'consume' ? 'consume' : 'sync';
  let consumers: Site['consumers'];
  if ((c.op === 'publish' || c.op === 'enqueue') && c.arg) {
    consumers = d.facts.calls
      .filter((x) => x.tool === c.tool && x.op === 'consume' && x.arg === c.arg)
      .flatMap((x) => d.appsOf(x.file).map((a) => ({ app: a, file: x.file, line: x.line, name: x.arg, evidence: d.callEvidence(x) })));
  }
  const label = opLabel(c.op, tool.id);
  const ttl = c.op === 'cache-write' ? (c.arg === 'ttl' ? ' with an expiry' : ' (no expiry argument on this line)') : '';
  return { file: c.file, line: c.line, node, mode, explanation: `${opText(c.op)} on ${d.nodes.get(node)?.name}: ${c.callee}()${ttl}${c.arg && c.arg !== 'ttl' ? ` — ${c.arg}` : ''} (${where}). [${label}]`, evidence: [ev], call: c, consumers };
}

export function httpSite(d: Detector, h: HttpCallFact, app: string): Site | null {
  const where = `${h.file}:${h.line}`;
  const ev = d.e({ kind: 'http-call', file: h.file, line: h.line, snippet: h.snippet, detail: `${h.client}${h.method ? ` ${h.method}` : ''} ${h.url ?? (h.envVar ? `(URL from ${h.envVar})` : '(URL computed at runtime)')}` });
  // Edges built by the detector already resolved literal hosts, Compose hosts and env-driven URLs.
  const edge = [...d.edges.values()].find((e) => (e.source === app || e.source === `client:${app.slice(4)}`) && e.evidence.has(ev));
  if (edge) {
    const target = d.nodes.get(edge.target);
    const route = h.url?.startsWith('/') ? bestRoutes(d.facts.routes.filter((r) => r.kind !== 'page' && (!h.method || r.method === 'ANY' || r.method === h.method) && d.appsOf(r.file).includes(edge.target)), h.url!)[0] : undefined;
    return {
      file: h.file,
      line: h.line,
      node: edge.target,
      mode: 'sync',
      explanation: `${h.method ?? 'HTTP'} ${h.url ?? `(${h.envVar})`} to ${target?.name} with ${h.client} (${where}).`,
      evidence: [ev],
      http: h,
      crossRoute: route && target?.kind === 'app' && edge.target !== app ? { app: edge.target, route } : undefined,
    };
  }
  if (h.url?.startsWith('/') && !h.envVar) return null; // a relative call inside the same app (e.g. SSR fetch of its own route)
  if (h.host && !/^(?:localhost|127\.)/.test(h.host)) return null;
  return {
    file: h.file,
    line: h.line,
    node: app,
    mode: 'unknown',
    explanation: `Outbound call target unknown: ${h.client}${h.method ? ` ${h.method}` : ''} ${h.envVar ? `to the URL in ${h.envVar}` : 'to a URL built at runtime'}${h.url ? ` (path ${h.url})` : ''} (${where}).`,
    evidence: [ev],
    http: h,
  };
}

// --- Request lifecycle ------------------------------------------------------------------------------------------------

function laneOfApp(d: Detector, app: string): FlowLane {
  return d.appById(app)?.kind === 'worker' ? 'async' : 'backend';
}

const DATA_CATEGORIES = new Set(['database', 'orm', 'search', 'storage']);

/** Lane, kind, label and transport for a traced site. */
function siteMeta(d: Detector, s: Site, app: string, mode: FlowStepMode): Partial<FlowStep> {
  const n = d.nodes.get(s.node);
  const branch = mode === 'cache-hit' || mode === 'cache-miss' ? mode : undefined;
  if (mode === 'unknown') return { lane: 'external', kind: 'unknown', label: 'Unknown next hop', transport: s.http ? transportLabel(s.http) : undefined, input: s.http ? `${transportLabel(s.http)}${s.http.envVar ? ` (URL from ${s.http.envVar})` : ' (URL built at runtime)'}` : undefined };
  if (s.node === app || !n) return { lane: laneOfApp(d, app), kind: s.http ? 'client' : 'service', label: s.call ? `${s.call.callee}()` : s.http ? transportLabel(s.http) : 'Service', transport: s.http ? transportLabel(s.http) : undefined };
  // A call into another application of this repository is an outgoing client request.
  if (n.kind === 'app') return { lane: laneOfApp(d, app), kind: 'client', tool: s.node, label: `→ ${n.name}`, transport: s.http ? transportLabel(s.http) : undefined };
  const kind: FlowStep['kind'] = mode === 'publish' ? 'queue' : n.category === 'cache' ? 'cache' : DATA_CATEGORIES.has(n.category) ? 'data' : 'external';
  const lane: FlowLane = kind === 'external' ? 'external' : laneOfApp(d, app);
  const transport = s.http ? transportLabel(s.http) : s.call ? `${opLabel(s.call.op, s.call.tool)} · ${s.call.callee}()` : undefined;
  const input = s.http ? transportLabel(s.http) : s.call ? `${opText(s.call.op)}${s.call.arg && s.call.arg !== 'ttl' ? ` "${s.call.arg}"` : ''} via ${s.call.callee}()` : undefined;
  return { lane, kind, branch, tool: s.node, input, label: `${n.name}${s.call ? ` · ${s.call.callee}()` : s.http?.method ? ` · ${s.http.method}` : ''}`, transport };
}

/** A middleware's display name: the code's own label (`// CSRF: …` → "CSRF check") or its registration. */
function middlewareTitle(m: MiddlewareFact): string {
  const lead = m.note ? /^([A-Za-z][\w /-]{1,24}):\s/.exec(m.note)?.[1] : undefined;
  return lead ? `${lead} check` : m.name;
}

const TRIGGER_RANK: Record<UiTriggerFact['trigger']['kind'], number> = { click: 0, submit: 0, change: 1, key: 1, load: 2, call: 3 };
const RESPONSE_PHASES = new Set(['onSend', 'onResponse', 'preSerialization', 'after_request']);

/**
 * Turn a traced route flow into a request lifecycle:
 *   user action → handler → API client → (transport) → route → middleware → handler
 *   → traced services and calls → response → client resolves → state update / navigation,
 * with background work moved to its own async branch. Steps are only added for what the code
 * shows; a response whose shape is not written in the handler is labelled as such.
 */
function withLifecycle(d: Detector, flow: Flow, ctx: { app: string; route: RouteFact; caller?: HttpCallFact; routeEvidence: string }): Flow {
  const { app, route: r, caller } = ctx;
  const appName = d.nodes.get(app)?.name ?? app;
  const steps = flow.steps.map((s) => ({ ...s }));
  const routeIdx = steps.findIndex((s) => s.kind === 'route' && s.node === app);
  const callerStep = caller ? steps.find((s) => s.kind === 'client') : undefined;
  const clientNode = callerStep?.node;
  const frontend = callerStep?.lane === 'frontend';
  const notes = [...flow.notes];
  let action: Flow['action'];

  // 1. The UI action that triggers the client call, when the code shows one.
  const prefix: FlowStep[] = [];
  const triggers = caller ? d.facts.uiTriggers.filter((t) => t.target.file === caller.file && t.target.line === caller.line && !/\.test\.|\/test\//.test(t.file)) : [];
  triggers.sort((a, b) => TRIGGER_RANK[a.trigger.kind] - TRIGGER_RANK[b.trigger.kind] || (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  // UI actions only start flows whose client call is in the frontend; service-to-service calls have none.
  const t = frontend ? triggers[0] : undefined;
  if (t && clientNode) {
    const where = t.component ? ` in ${t.component}` : '';
    const label =
      t.trigger.kind === 'click' ? `Click “${t.label ?? 'button'}”`
      : t.trigger.kind === 'submit' ? `Submit “${t.label ?? 'form'}”`
      : t.trigger.kind === 'load' ? `${t.component ?? 'Component'} loads`
      : t.trigger.kind === 'change' ? `Input changes${where}`
      : t.trigger.kind === 'key' ? `Key press${where}`
      : `${t.component ?? t.file.slice(t.file.lastIndexOf('/') + 1)} calls ${t.callee}()`;
    action = { label, kind: t.trigger.kind, component: t.component, file: t.file, line: t.trigger.line };
    const actionEv = d.e({ kind: 'ui', file: t.file, line: t.trigger.line, snippet: t.trigger.snippet, detail: `${t.trigger.kind} trigger${where}` });
    prefix.push({ step: 0, node: clientNode, file: t.file, line: t.trigger.line, mode: 'sync', lane: 'frontend', kind: 'action', label, evidence: [actionEv], explanation: `${label}${where} (${t.file}:${t.trigger.line}).`, output: `${t.trigger.kind} event` });
    // What the UI passes to the client function, as written at the call site.
    const args = callArgs(t.snippet, t.callee.split('.').pop()!);
    if (callerStep && args) callerStep.input = `arguments: ${args}`;
    const callEv = d.e({ kind: 'ui', file: t.file, line: t.line, snippet: t.snippet, detail: `Calls ${t.callee}()` });
    prefix.push({
      step: 0,
      node: clientNode,
      file: t.file,
      line: t.handler?.line ?? t.line,
      mode: 'sync',
      lane: 'frontend',
      kind: 'handler',
      label: t.handler ? `${t.handler.name}()` : t.trigger.kind === 'load' ? 'Data hook' : 'Event handler',
      fn: t.handler?.name ?? t.component,
      evidence: [callEv],
      explanation: `${t.handler ? `${t.handler.name}()` : t.trigger.kind === 'load' ? 'The data-loading hook' : 'The inline event handler'} ${caller?.protocol === 'SSE' || caller?.protocol === 'WebSocket' ? `opens ${caller.protocol === 'SSE' ? 'an EventSource (Server-Sent Events)' : 'a WebSocket'}` : `calls ${t.callee}()`} (${t.file}:${t.line}).`,
    });
    if (triggers.length > 1) notes.push(`Also called from ${triggers.slice(1, 4).map((x) => `${x.file}:${x.line} (${x.trigger.kind})`).join(', ')}.`);
  } else if (caller && frontend) {
    notes.push('No UI event or data hook calling this client function was found; the lifecycle starts at the API client.');
  }

  // 2. Middleware the request passes through, then the handler itself.
  const mws = d.facts.middleware.filter((m) => d.appsOf(m.file).includes(app)).sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  const mwStep = (m: MiddlewareFact): FlowStep => ({
    step: 0,
    node: app,
    file: m.file,
    line: m.line,
    mode: 'sync',
    lane: 'backend',
    kind: 'middleware',
    label: middlewareTitle(m) + (m.phase && RESPONSE_PHASES.has(m.phase) ? ' (on response)' : ''),
    evidence: [d.e({ kind: 'middleware', file: m.file, line: m.line, snippet: m.snippet, detail: `${m.name}${m.note ? ` — ${m.note}` : ''}` })],
    explanation: `${m.name}${m.phase ? ` (${m.phase})` : ''} runs for every request in ${appName}${m.note ? `: ${m.note}` : ''} (${m.file}:${m.line}).`,
  });
  const middle: FlowStep[] = mws.filter((m) => !(m.phase && RESPONSE_PHASES.has(m.phase))).map(mwStep);
  if (r.auth) middle.push({ step: 0, node: app, file: r.file, line: r.auth.line, mode: 'sync', lane: 'backend', kind: 'middleware', label: 'Auth guard', evidence: [d.e({ kind: 'auth', file: r.file, line: r.auth.line, snippet: r.auth.snippet, detail: `Auth guard on ${r.method} ${r.path}` })], explanation: `The route declares an auth guard: ${r.auth.snippet} (${r.file}:${r.auth.line}).` });
  const bodyLine = r.bodyStart ?? r.line;
  middle.push({ step: 0, node: app, file: r.file, line: bodyLine, mode: 'sync', lane: 'backend', kind: 'handler', label: r.handler ? `${r.handler}()` : 'Route handler', evidence: [ctx.routeEvidence], explanation: `${r.handler ? `${r.handler}()` : 'The handler'} runs (${r.file}:${bodyLine}).` });

  // 3. The response, the client resolving it, and what the UI does next.
  const tail: FlowStep[] = [];
  for (const m of mws.filter((x) => x.phase && RESPONSE_PHASES.has(x.phase))) tail.push(mwStep(m));
  const resp = r.kind === 'page' ? { line: r.bodyStart ?? r.line, kind: 'render' as const, snippet: '' } : r.response;
  const respKind = resp ? { json: 'JSON response', redirect: 'Redirect', stream: 'Event stream', render: r.kind === 'page' ? 'Rendered page' : 'Rendered HTML', send: 'Response body', file: 'File', status: 'Status code' }[resp.kind] : 'Response';
  const respEv = resp && resp.snippet ? d.e({ kind: 'response', file: r.file, line: resp.line, snippet: resp.snippet, detail: `${respKind}${'shape' in resp && resp.shape ? ` ${resp.shape}` : ''}` }) : ctx.routeEvidence;
  tail.push({
    step: 0,
    node: app,
    file: r.file,
    line: resp?.line ?? r.line,
    mode: 'sync',
    lane: 'backend',
    kind: 'response',
    label: resp ? `${respKind}${resp.shape ? ` ${resp.shape}` : ''}` : 'Response (shape not determined)',
    output: resp ? `${respKind}${resp.shape ? ` ${resp.shape}` : ''}` : undefined,
    transport: resp ? respKind : 'HTTP response',
    evidence: [respEv],
    explanation: resp ? `${appName} responds with ${respKind.toLowerCase()}${resp.shape ? ` ${resp.shape}` : ''} (${r.file}:${resp.line}).` : `${appName} sends its response; the handler does not return a literal the response shape can be read from.`,
    edge: clientNode ? d.edges.get(`${clientNode}->${app}`)?.id : undefined,
  });
  if (caller && clientNode) {
    const resolveEv = d.e({ kind: 'http-call', file: caller.file, line: caller.line, snippet: caller.snippet, detail: `${caller.client} ${caller.method ?? ''} ${caller.url ?? ''}`.replace(/\s+/g, ' ') });
    const fn = callerStep?.label ?? clientLabel(caller.client);
    const streaming = caller.protocol === 'SSE' || caller.protocol === 'WebSocket';
    tail.push({
      step: 0,
      node: clientNode,
      file: caller.file,
      line: caller.line,
      mode: 'sync',
      lane: callerStep?.lane ?? 'frontend',
      kind: 'resolve',
      label: streaming ? `${fn} receives messages` : `${fn} resolves${caller.responseType ? ` ${caller.responseType}` : ''}`,
      output: caller.responseType,
      evidence: [resolveEv],
      explanation: streaming ? `The ${caller.protocol} connection stays open and delivers messages to the client (${caller.file}:${caller.line}).` : `The client receives the response${caller.responseType ? `, typed as ${caller.responseType}` : ''} (${caller.file}:${caller.line}).`,
    });
    for (const a of t?.after ?? []) {
      const label = a.kind === 'navigate' ? `Navigate · ${a.detail}` : a.kind === 'state' ? `State · ${a.detail}` : a.kind === 'reload' ? `Refetch · ${a.detail}` : 'Notification';
      tail.push({ step: 0, node: clientNode, file: t!.file, line: a.line, mode: 'sync', lane: 'frontend', kind: 'state', label, evidence: [d.e({ kind: 'ui', file: t!.file, line: a.line, snippet: a.snippet, detail: label })], explanation: `${label} (${t!.file}:${a.line}).`, output: a.detail });
    }
  }

  // Assemble: before the route, the route, middleware + handler, traced sync work, the response, then background work.
  const before = routeIdx >= 0 ? steps.slice(0, routeIdx + 1) : steps.slice(0, 1);
  const traced = routeIdx >= 0 ? steps.slice(routeIdx + 1) : steps.slice(1);
  const sync = traced.filter((s) => s.branch !== 'async');
  const background = traced.filter((s) => s.branch === 'async');
  const all = [...prefix, ...before, ...middle, ...sync, ...tail, ...background].map((s, i) => ({ ...s, step: i + 1 }));
  if (background.length) notes.push('Background work runs asynchronously after the enqueue and does not block the response.');
  const order: FlowLane[] = ['frontend', 'backend', 'external', 'async'];
  const lanes = order.filter((l) => all.some((s) => (s.lane ?? 'backend') === l));
  const title = action ? `${action.label} → ${flow.title}` : flow.title;
  return { ...flow, id: stableId('flow_', `${title}|${flow.variant ?? ''}|${r.file}`), title, steps: all, notes, action, lanes };
}
