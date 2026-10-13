import { CATALOG_BY_ID, toolsForPackage } from './catalog.ts';
import type { DetectorContext as Detector } from './context.ts';
import { callSite, httpSite } from './flows.ts';
import { opText } from './ops.ts';
import type { Architecture, ArchNode, CallFact, HttpCallFact, IntelConfidence, OpKind, SystemNode, TechIntel, TechStatement } from './types.ts';

/*
 * Technology intelligence: every technology explained in the context of this repository.
 *
 * Each statement is assembled from evidence the detector already holds — operations on bound
 * clients, call sites and the functions they sit in, routes, request flows, architecture
 * connections, package scripts and configuration. Nothing is inferred from what a technology is
 * "usually" used for: when the code does not show a purpose, the explanation says so.
 */

export const UNDETERMINED = 'Purpose could not be confidently determined from the available source.';

/** What an operation shows the technology being used for, as a noun phrase. */
const PURPOSE: Partial<Record<OpKind, string>> = {
  sql: 'storing and querying data',
  query: 'storing and querying data',
  'cache-read': 'caching',
  'cache-write': 'caching',
  'cache-delete': 'caching',
  publish: 'publishing messages',
  enqueue: 'queueing background jobs',
  consume: 'consuming queued messages',
  'object-read': 'file / object storage',
  'object-write': 'file / object storage',
  http: 'calling an external API',
  rpc: 'remote procedure calls',
  auth: 'authentication',
  payment: 'payments',
  email: 'sending email',
  ai: 'calling an AI model API',
  search: 'search',
  send: 'sending messages',
  webhook: 'verifying incoming webhooks',
};

/** Verb phrase for an operation, for sentences like "X reads and writes Redis". */
const VERB: Partial<Record<OpKind, string>> = {
  sql: 'runs SQL on',
  query: 'queries',
  'cache-read': 'reads from',
  'cache-write': 'writes to',
  'cache-delete': 'deletes keys in',
  publish: 'publishes to',
  enqueue: 'enqueues jobs on',
  consume: 'consumes from',
  'object-read': 'reads objects from',
  'object-write': 'writes objects to',
  http: 'calls',
  auth: 'checks authentication with',
  payment: 'calls',
  email: 'sends email through',
  ai: 'calls',
  search: 'searches',
  send: 'sends messages through',
  webhook: 'verifies webhooks with',
};

const list = (items: string[], max = 3) => (items.length <= max ? items.join(', ').replace(/, ([^,]*)$/, ' and $1') : `${items.slice(0, max).join(', ')} and ${items.length - max} more`);
const where = (file: string, line?: number) => `${file}${line ? `:${line}` : ''}`;

export function buildTechnologyIntel(d: Detector, arch: Architecture): TechIntel[] {
  const { facts } = d;
  const system = arch.system;
  const byId = new Map(arch.nodes.map((n) => [n.id, n]));
  // System component (handler / service module) that owns each file.
  const ownerOfFile = new Map<string, SystemNode>();
  for (const n of system.nodes) if (n.kind === 'handler' || n.kind === 'service') for (const f of n.files) ownerOfFile.set(f.path, n);
  const symbolsByFile = new Map<string, typeof facts.symbols>();
  for (const s of facts.symbols) {
    if (s.name === 'default') continue;
    if (!symbolsByFile.has(s.file)) symbolsByFile.set(s.file, []);
    symbolsByFile.get(s.file)!.push(s);
  }
  const enclosing = (file: string, line: number) =>
    (symbolsByFile.get(file) ?? []).filter((s) => s.line <= line && s.end >= line).sort((a, b) => a.end - a.line - (b.end - b.line))[0];
  const appName = (file: string) => d.appsOf(file).map((a) => d.nodes.get(a)?.name ?? a)[0];
  const component = (file: string) => {
    const o = ownerOfFile.get(file);
    return o ? `${o.name} (${o.kind === 'service' ? 'service' : 'route handlers'})` : file.slice(file.lastIndexOf('/') + 1);
  };

  /** Call sites and HTTP calls that land on a node, resolved the same way the diagram resolves them. */
  const sitesFor = (id: string, catalogId?: string) => {
    const calls: CallFact[] = [];
    const http: HttpCallFact[] = [];
    for (const c of facts.calls) {
      const apps = d.appsOf(c.file);
      const hit = (apps.length ? apps : ['']).some((a) => callSite(d, c, a)?.node === id) || (catalogId !== undefined && c.tool === catalogId && byId.get(id)?.display === 'chip');
      if (hit) calls.push(c);
    }
    for (const h of facts.httpCalls) {
      const apps = d.appsOf(h.file);
      if (apps.some((a) => httpSite(d, h, a)?.node === id)) http.push(h);
    }
    return { calls, http };
  };

  const out: TechIntel[] = [];
  for (const n of arch.nodes) {
    if (n.kind === 'app' || n.id.startsWith('client:')) continue;
    const catalogId = n.id.startsWith('tool:') ? n.id.slice(5) : undefined;
    const catalog = catalogId ? CATALOG_BY_ID.get(catalogId) : undefined;
    const { calls, http } = sitesFor(n.id, catalogId);
    const evidence = new Set<string>(n.evidence);

    // Operations and the functions that perform them.
    const ops = new Map<OpKind, number>();
    for (const c of calls) ops.set(c.op, (ops.get(c.op) ?? 0) + 1);
    if (http.length) ops.set('http', (ops.get('http') ?? 0) + http.length);
    const fnMap = new Map<string, TechIntel['functions'][number]>();
    const callEv: string[] = [];
    for (const c of calls) {
      const ev = d.callEvidence(c);
      callEv.push(ev);
      evidence.add(ev);
      const s = enclosing(c.file, c.line);
      const key = s ? `${s.file}#${s.name}` : `${c.file}#${c.line}`;
      const f = fnMap.get(key) ?? { file: c.file, line: s?.line ?? c.line, name: s?.name ?? '(module scope)', calls: [] };
      if (!f.calls.includes(`${c.callee}()`)) f.calls.push(`${c.callee}()`);
      fnMap.set(key, f);
    }
    for (const h of http) {
      const site = d.appsOf(h.file).map((a) => httpSite(d, h, a)).find(Boolean);
      for (const ev of site?.evidence ?? []) {
        callEv.push(ev);
        evidence.add(ev);
      }
      const s = enclosing(h.file, h.line);
      const key = s ? `${s.file}#${s.name}` : `${h.file}#${h.line}`;
      const f = fnMap.get(key) ?? { file: h.file, line: s?.line ?? h.line, name: s?.name ?? '(module scope)', calls: [] };
      const label = `${h.client} ${h.method ?? ''} ${h.url ?? ''}`.replace(/\s+/g, ' ').trim();
      if (!f.calls.includes(label)) f.calls.push(label);
      fnMap.set(key, f);
    }
    const functions = [...fnMap.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));

    // Clients, scripts and configuration.
    const clients = catalogId ? facts.clients.filter((c) => c.tool === catalogId).map((c) => ({ name: c.name, file: c.file, line: c.line })) : [];
    for (const c of catalogId ? facts.clients.filter((x) => x.tool === catalogId) : []) evidence.add(d.e({ kind: 'client-init', file: c.file, line: c.line, snippet: c.snippet, detail: `Creates a ${n.name} client "${c.name}"` }));
    const bins = (catalog?.npm ?? []).filter((p) => !p.endsWith('/') && !p.endsWith('*')).map((p) => p.split('/').pop()!);
    const scripts: TechIntel['scripts'] = [];
    if (bins.length) {
      for (const m of facts.manifests) {
        for (const s of m.scripts) {
          if (!bins.some((b) => new RegExp(`(^|[\\s&;|(])${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(s.command))) continue;
          scripts.push({ name: s.name, command: s.command, file: m.file, line: s.line });
          evidence.add(d.e({ kind: 'manifest', file: m.file, line: s.line, snippet: `"${s.name}": "${s.command}"`, detail: `Script "${s.name}" runs ${n.name}` }));
        }
      }
    }
    const configs = catalogId ? facts.configs.filter((c) => c.tool === catalogId || c.via === catalogId) : [];

    // Routes: served by it (frameworks) or reached through it (traced flows).
    const routes: TechIntel['routes'] = [];
    const seenRoute = new Set<string>();
    const addRoute = (r: { method: TechIntel['routes'][number]['method']; path: string; file: string; line: number }, via: 'framework' | 'flow') => {
      const key = `${r.method} ${r.path}`;
      if (seenRoute.has(key)) return;
      seenRoute.add(key);
      routes.push({ ...r, via });
    };
    if (catalogId) for (const r of facts.routes) if (r.framework === catalogId && r.kind !== 'page' && d.appsOf(r.file).length) addRoute(r, 'framework');
    const flows = arch.flows.filter((f) => f.steps.some((s) => s.tool === n.id || s.node === n.id));
    for (const f of flows) {
      const route = f.steps.find((s) => s.kind === 'route');
      if (f.trigger.kind === 'route' && f.trigger.method && f.trigger.path && route) addRoute({ method: f.trigger.method, path: f.trigger.path, file: route.file, line: route.line ?? 0 }, 'flow');
    }

    // Architecture connections.
    const connections: TechIntel['connections'] = arch.edges
      .filter((e) => e.source === n.id || e.target === n.id)
      .map((e) => {
        const out = e.source === n.id;
        const other = out ? e.target : e.source;
        return { direction: out ? ('out' as const) : ('in' as const), id: other, name: byId.get(other)?.name ?? other, labels: e.labels, confidence: e.confidence, evidence: e.evidence.slice(0, 3) };
      });

    // System components that are it, or (for libraries) the applications that host it.
    const sys = new Set<string>(system.nodes.filter((s) => s.arch === n.id).map((s) => s.id));
    if (!sys.size) {
      for (const host of n.hosts ?? []) {
        for (const s of system.nodes) if (s.arch === host) sys.add(s.id);
        const group = system.groups.find((g) => g.app === host);
        for (const id of group?.nodes ?? []) if (system.nodes.find((s) => s.id === id)?.kind === 'handler') sys.add(id);
      }
    }

    // Who uses it.
    const usedBy = new Set<string>();
    for (const h of n.hosts ?? []) usedBy.add(byId.get(h)?.name ?? h);
    for (const c of connections) if (c.direction === 'in') usedBy.add(c.name);
    for (const f of functions) {
      const o = ownerOfFile.get(f.file);
      if (o) usedBy.add(o.name);
    }

    const { role, why } = explain(n, {
      ops,
      calls,
      http,
      functions,
      clients,
      scripts,
      configs: configs.map((c) => ({ file: c.file, line: c.line, envVar: c.envVar })),
      routes,
      component,
      appName,
      callEv,
      evidence: [...evidence],
      d,
    });

    out.push({
      id: n.id,
      name: n.name,
      kind: n.kind,
      category: n.category,
      version: n.version?.value,
      confidence: n.confidence,
      general: n.description ?? catalog?.description,
      role,
      why,
      usedBy: [...usedBy].sort(),
      files: n.files.map((f) => ({ path: f.path, lines: f.lines.slice(0, 12), uses: [...new Set(f.uses)] })),
      functions,
      routes: routes.slice(0, 60),
      operations: [...ops].map(([op, count]) => ({ op, label: opText(op), count })).sort((a, b) => b.count - a.count),
      clients,
      scripts,
      connections,
      flows: flows.map((f) => ({ id: f.id, title: f.title })),
      system: [...sys],
      graph: focusedGraph(system, sys),
      evidence: [...evidence],
    });
  }
  out.push(...libraries(d, arch, ownerOfFile));
  return out.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1));
}

/**
 * Dependencies outside the technology catalog, from the import graph: which files import which of
 * their exports, and which package scripts run them. Their purpose is never stated beyond that.
 */
function libraries(d: Detector, arch: Architecture, ownerOfFile: Map<string, SystemNode>): TechIntel[] {
  const covered = new Set(arch.nodes.filter((n) => n.id.startsWith('tool:')).map((n) => n.id.slice(5)));
  const declared = new Map<string, { file: string; line: number; spec: string; dev: boolean }>();
  for (const m of d.facts.manifests) {
    if (m.ecosystem !== 'npm') continue;
    for (const dep of m.dependencies) if (!declared.has(dep.name)) declared.set(dep.name, { file: m.file, line: dep.line, spec: dep.spec, dev: dep.dev });
  }
  const imports = new Map<string, { file: string; line: number; symbols: string[]; typeOnly: boolean }[]>();
  for (const e of d.graph.edges) {
    if (!e.external || !e.target.startsWith('ext:') || e.resolution === 'node builtin' || !d.fileSet.has(e.source)) continue;
    if (!d.appsOf(e.source).length) continue;
    const pkg = e.target.slice(4);
    if (!imports.has(pkg)) imports.set(pkg, []);
    imports.get(pkg)!.push({ file: e.source, line: e.line, symbols: e.symbols, typeOnly: e.typeOnly });
  }
  const out: TechIntel[] = [];
  for (const [pkg, dep] of declared) {
    // Catalogued technologies are explained above; workspace packages are this repository's own code.
    const tools = toolsForPackage('npm', pkg);
    if (tools.some((t) => covered.has(t.id)) || pkg.startsWith('@types/') || d.facts.manifests.some((m) => m.name === pkg)) continue;
    const uses = (imports.get(pkg) ?? []).filter((u) => !u.typeOnly);
    const bin = pkg.split('/').pop()!;
    const scripts = d.facts.manifests.flatMap((m) =>
      m.scripts.filter((sc) => new RegExp(`(^|[\\s&;|(])${bin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(sc.command)).map((sc) => ({ name: sc.name, command: sc.command, file: m.file, line: sc.line })),
    );
    if (!uses.length && !scripts.length) continue;
    const manifestEv = d.e({ kind: 'manifest', file: dep.file, line: dep.line, detail: `Declares ${pkg}${dep.spec ? ` ${dep.spec}` : ''}${dep.dev ? ' (dev)' : ''}` });
    const byFile = new Map<string, { lines: number[]; symbols: Set<string> }>();
    for (const u of uses) {
      const f = byFile.get(u.file) ?? { lines: [], symbols: new Set<string>() };
      f.lines.push(u.line);
      for (const sym of u.symbols) f.symbols.add(sym === 'default' ? `default export` : sym === '*' ? 'namespace' : sym);
      byFile.set(u.file, f);
    }
    const importEv = [...byFile].slice(0, 4).map(([file, f]) => d.e({ kind: 'import', file, line: f.lines[0], detail: `Imports ${[...f.symbols].slice(0, 4).join(', ') || pkg} from ${pkg}` }));
    const scriptEv = scripts.map((sc) => d.e({ kind: 'manifest', file: sc.file, line: sc.line, snippet: `"${sc.name}": "${sc.command}"`, detail: `Script "${sc.name}" runs ${pkg}` }));
    const symbols = [...new Set([...byFile.values()].flatMap((f) => [...f.symbols]))].filter((x) => x !== 'default export' && x !== 'namespace');
    const apps = [...new Set([...byFile.keys()].flatMap((f) => d.appsOf(f).map((a) => d.nodes.get(a)?.name ?? a)))];
    const names = [...byFile.keys()].map((f) => f.slice(f.lastIndexOf('/') + 1));
    const roleParts: string[] = [];
    if (byFile.size) roleParts.push(`Imported in ${byFile.size} file${byFile.size === 1 ? '' : 's'}${apps.length ? ` of ${list(apps)}` : ''} (${list(names)})${symbols.length ? `, which use its ${list(symbols.map((x) => `\`${x}\``), 5)} export${symbols.length === 1 ? '' : 's'}` : ''}`);
    const mw = d.facts.middleware.find((m) => m.name === pkg && d.appsOf(m.file).length);
    const mwEv = mw ? d.e({ kind: 'middleware', file: mw.file, line: mw.line, snippet: mw.snippet, detail: `${mw.name}${mw.note ? ` — ${mw.note}` : ''}` }) : undefined;
    if (mw) roleParts.push(`registered as request middleware in ${d.appsOf(mw.file).map((a) => d.nodes.get(a)?.name ?? a)[0]} (${mw.file}:${mw.line})`);
    if (scripts.length) roleParts.push(`run by the ${list(scripts.map((sc) => `"${sc.name}"`))} script${scripts.length === 1 ? '' : 's'} (${scripts[0].file})`);
    const seeds = new Set<string>();
    for (const f of byFile.keys()) {
      const o = ownerOfFile.get(f);
      if (o) seeds.add(o.id);
      else for (const a of d.appsOf(f)) for (const sn of arch.system.nodes) if (sn.arch === a || sn.arch === `client:${a.slice(4)}`) seeds.add(sn.id);
    }
    const usedBy = new Set<string>(apps);
    for (const f of byFile.keys()) {
      const o = ownerOfFile.get(f);
      if (o) usedBy.add(o.name);
    }
    const role = roleParts.join('; ');
    out.push({
      id: `lib:${pkg}`,
      name: pkg,
      kind: 'library',
      category: 'library',
      version: dep.spec || undefined,
      confidence: 'confirmed',
      general: undefined,
      role: { text: `${role.charAt(0).toUpperCase()}${role.slice(1)}.`, confidence: 'confirmed', evidence: [...importEv, ...scriptEv].slice(0, 6) },
      why: mw
        ? {
            text: `Registered as request middleware (${mw.kind === 'plugin' ? '`register`' : '`use`'} at ${mw.file}:${mw.line}), so it runs on requests to ${d.appsOf(mw.file).map((a) => d.nodes.get(a)?.name ?? a)[0]}${mw.note ? `: "${mw.note}"` : ''}.${mw.purpose !== 'other' && !mw.note ? ` Its name suggests ${mw.purpose} handling; the code does not state more.` : ''}`,
            confidence: mw.note ? 'confirmed' : 'strong',
            evidence: [mwEv!],
          }
        : {
        text: scripts.length && !byFile.size ? `Used as the tool behind ${list(scripts.map((sc) => `"${sc.name}"`))}: the package scripts invoke it. Beyond that, ${UNDETERMINED.charAt(0).toLowerCase()}${UNDETERMINED.slice(1)}` : `${UNDETERMINED} The code imports ${symbols.length ? `its ${list(symbols.map((x) => `\`${x}\``), 4)} export${symbols.length === 1 ? '' : 's'}` : 'it'}, and CodePilot does not describe libraries outside its catalog beyond what the imports show.`,
        confidence: scripts.length && !byFile.size ? 'strong' : 'unknown',
        evidence: [...importEv.slice(0, 2), ...scriptEv.slice(0, 2)],
          },
      usedBy: [...usedBy].sort(),
      files: [...byFile].map(([path, f]) => ({ path, lines: f.lines.slice(0, 12), uses: ['import'] })),
      functions: [],
      routes: [],
      operations: [],
      clients: [],
      scripts,
      connections: [],
      flows: [],
      system: [...seeds],
      graph: focusedGraph(arch.system, seeds),
      evidence: [manifestEv, ...importEv, ...scriptEv, ...(mwEv ? [mwEv] : [])],
    });
  }
  return out;
}

interface ExplainInput {
  ops: Map<OpKind, number>;
  calls: CallFact[];
  http: HttpCallFact[];
  functions: TechIntel['functions'];
  clients: TechIntel['clients'];
  scripts: TechIntel['scripts'];
  configs: { file: string; line: number; envVar?: string }[];
  routes: TechIntel['routes'];
  component(file: string): string;
  appName(file: string): string | undefined;
  callEv: string[];
  evidence: string[];
  d: Detector;
}

/**
 * The project-specific role ("what it does here") and purpose ("why it is used here"), each built
 * only from what the code shows, with a confidence that reflects how direct that evidence is.
 */
function explain(n: ArchNode, x: ExplainInput): { role: TechStatement; why: TechStatement } {
  const s = (text: string, confidence: IntelConfidence, evidence: string[]): TechStatement => ({ text, confidence, evidence: [...new Set(evidence)].slice(0, 6) });
  // The same evidence entry the rest of the architecture cites for a route (with its source line).
  const routeEv = (r: { method: string; path: string; file: string; line: number }) => {
    const fact = x.d.facts.routes.find((f) => f.file === r.file && f.line === r.line);
    return x.d.e({ kind: 'route', file: r.file, line: r.line, snippet: fact?.snippet, detail: `${r.method} ${r.path}` });
  };
  const importFiles = n.files.filter((f) => f.uses.includes('import'));
  const apps = [...new Set(n.files.map((f) => x.appName(f.path)).filter((a): a is string => !!a))];
  const manifestEv = n.evidence.filter((id) => x.d.ev.get(id)?.kind === 'manifest' || x.d.ev.get(id)?.kind === 'lockfile');
  const importEv = n.evidence.filter((id) => x.d.ev.get(id)?.kind === 'import');

  // 1. Operations the code performs on it: the strongest evidence of purpose.
  if (x.ops.size) {
    const byComponent = new Map<string, Set<OpKind>>();
    for (const c of x.calls) {
      const who = x.component(c.file);
      if (!byComponent.has(who)) byComponent.set(who, new Set());
      byComponent.get(who)!.add(c.op);
    }
    for (const h of x.http) {
      const who = x.component(h.file);
      if (!byComponent.has(who)) byComponent.set(who, new Set());
      byComponent.get(who)!.add('http');
    }
    const clientText =
      x.clients.length === 1
        ? ` through the \`${x.clients[0].name}\` client created at ${where(x.clients[0].file, x.clients[0].line)}`
        : x.clients.length > 1
          ? ` through its clients ${list(x.clients.map((c) => `\`${c.name}\` (${where(c.file, c.line)})`))}`
          : '';
    const sentences = [...byComponent].slice(0, 3).map(([who, ops]) => {
      const verbs = [...ops].map((o) => VERB[o] ?? opText(o).toLowerCase()).filter((v, i, a) => a.indexOf(v) === i);
      const count = x.calls.filter((c) => x.component(c.file) === who).length + x.http.filter((h) => x.component(h.file) === who).length;
      return `${who} ${list(verbs)} ${n.name} (${count} call${count === 1 ? '' : 's'})`;
    });
    const more = byComponent.size > 3 ? `, and ${byComponent.size - 3} more components` : '';
    const opSummary = [...x.ops].map(([op, c]) => `${c} × ${opText(op).toLowerCase()}`).join(', ');
    const role = s(`${sentences.join('; ')}${more}${clientText}. Operations found: ${opSummary}.`, 'confirmed', x.callEv);

    // Each purpose with the components whose operations show it: "caching (pricing reads from and writes to it)".
    const purposeParts: string[] = [];
    const seenPurpose = new Set<string>();
    for (const op of x.ops.keys()) {
      const purpose = PURPOSE[op];
      if (!purpose || seenPurpose.has(purpose)) continue;
      seenPurpose.add(purpose);
      const opsForPurpose = [...x.ops.keys()].filter((o) => PURPOSE[o] === purpose);
      const who = [...byComponent].filter(([, ops]) => opsForPurpose.some((o) => ops.has(o))).map(([w]) => w.replace(/ \(.*\)$/, ''));
      const verbs = [...new Set(opsForPurpose.map((o) => VERB[o] ?? 'uses'))];
      purposeParts.push(`${purpose} (${list(who)} ${list(verbs)} it)`);
    }
    if (n.kind === 'host') {
      // An external host: the call is proven, its business purpose only as far as the URL shows it.
      const h = x.http[0];
      const path = h?.url ? (/^https?:\/\/[^/]+(\/[^?]*)/.exec(h.url)?.[1] ?? h.url) : undefined;
      const fn = x.functions[0];
      return {
        role,
        why: s(
          `The analyzed code calls this host${fn ? ` from ${fn.name}()` : ''}${h ? ` with ${h.client}${h.method ? ` ${h.method}` : ''}${path ? ` ${path}` : ''}` : ''}${h ? ` (${where(h.file, h.line)})` : ''}. What the call is for is not stated in the code beyond that request, so the reason is not asserted.`,
          'possible',
          x.callEv,
        ),
      };
    }
    return {
      role,
      why: s(`Used for ${list(purposeParts, 4)}${clientText} — as the analyzed code shows at the call sites listed below.`, 'confirmed', x.callEv),
    };
  }

  // 2. A framework that serves routes.
  const served = x.routes.filter((r) => r.via === 'framework');
  if (served.length) {
    const first = served[0];
    const app = x.appName(first.file) ?? 'the application';
    return {
      role: s(`Serves ${served.length} HTTP route${served.length === 1 ? '' : 's'} in ${app}, e.g. ${first.method} ${first.path} (${where(first.file, first.line)}).`, 'confirmed', [
        ...importEv.slice(0, 2),
        ...served.slice(0, 3).map(routeEv),
      ]),
      why: s(`Used as ${app}'s web framework: the routes in the analyzed code are registered on its application object.`, 'confirmed', served.slice(0, 3).map(routeEv)),
    };
  }

  // 3. A tool its package scripts run (build tools, test runners, CLIs).
  if (x.scripts.length) {
    const sc = x.scripts;
    const scriptEv = x.evidence.filter((id) => x.d.ev.get(id)?.detail.startsWith('Script '));
    const names = list(sc.map((p) => `"${p.name}"`));
    return {
      role: s(`Run by the ${names} script${sc.length === 1 ? '' : 's'} (${list(sc.map((p) => `\`${p.command}\``), 2)} in ${sc[0].file})${importFiles.length ? ` and imported in ${importFiles.length} file${importFiles.length === 1 ? '' : 's'}` : ''}.`, 'confirmed', [...scriptEv, ...importEv.slice(0, 2)]),
      why: s(`Used as the tool behind ${names}: the package scripts invoke it directly. Beyond those scripts the code does not state a reason.`, 'confirmed', scriptEv),
    };
  }

  // 4. Imported, but no operation CodePilot recognises.
  if (importFiles.length) {
    const sample = importFiles.slice(0, 3).map((f) => f.path.slice(f.path.lastIndexOf('/') + 1));
    const role = s(`Imported in ${importFiles.length} file${importFiles.length === 1 ? '' : 's'}${apps.length ? ` of ${list(apps)}` : ''} (${list(sample)}).`, 'confirmed', importEv);
    if (n.category === 'frontend' && importFiles.some((f) => /\.(tsx|jsx|vue|svelte)$/.test(f.path))) {
      return { role, why: s(`Most likely the UI library of ${list(apps) || 'the frontend'}: it is imported by component files (${list(sample)}). No other purpose is visible in the code.`, 'strong', importEv) };
    }
    return { role, why: s(`${UNDETERMINED} The code imports it, but no call CodePilot recognises was found.`, 'unknown', importEv) };
  }

  // 5. Configured only.
  if (x.configs.length) {
    const c = x.configs[0];
    const ev = x.evidence.filter((id) => x.d.ev.get(id)?.kind === 'config' || x.d.ev.get(id)?.kind === 'env');
    return {
      role: s(`Configured at ${where(c.file, c.line)}${c.envVar ? ` (from ${c.envVar})` : ''}; no code operations on it were found.`, 'possible', ev.length ? ev : n.evidence),
      why: s(UNDETERMINED, 'unknown', []),
    };
  }

  // 6. Infrastructure, gateways and services known from configuration: what they build, host or route to.
  const outgoing = x.d ? [...x.d.edges.values()].filter((e) => e.source === n.id) : [];
  if (outgoing.length && (n.layer === 'delivery' || n.kind === 'container' || n.layer === 'edge')) {
    const byLabel = new Map<string, string[]>();
    const ev: string[] = [];
    for (const e of outgoing) {
      const label = [...e.labels].find((l) => l !== 'depends on') ?? 'uses';
      if (!byLabel.has(label)) byLabel.set(label, []);
      byLabel.get(label)!.push(x.d.nodes.get(e.target)?.name ?? e.target);
      ev.push(...[...e.evidence].slice(0, 2));
    }
    // Third person for the role ("builds api"), infinitive for the purpose ("used to build api").
    const third = (l: string) => (l === 'proxy' ? 'routes requests to' : l === 'auth' ? 'checks authentication for requests to' : l);
    const base = (l: string) => (l === 'proxy' ? 'route requests to' : l === 'auth' ? 'check authentication for requests to' : l.replace(/s$/, ''));
    const parts = [...byLabel].map(([l, targets]) => `${third(l)} ${list(targets)}`);
    const baseParts = [...byLabel].map(([l, targets]) => `${base(l)} ${list(targets)}`);
    const files = [...new Set(n.files.map((f) => f.path))];
    return {
      role: s(`${parts.join('; ').replace(/^./, (c) => c.toUpperCase())}${files.length ? ` (${list(files)})` : ''}.`, n.confidence, ev.length ? ev : n.evidence),
      why: s(`Used to ${baseParts.join(' and ')}, as its configuration${files.length ? ` in ${list(files)}` : ''} shows. The code does not state a reason beyond that.`, n.confidence, ev.length ? ev : n.evidence),
    };
  }
  if (n.layer === 'delivery' || n.kind === 'container' || n.layer === 'edge' || n.layer === 'async' || n.layer === 'data') {
    return { role: s(`${n.role || 'Configured'}${n.files.length ? ` (${list([...new Set(n.files.map((f) => f.path))])})` : ''}.`, n.confidence, n.evidence), why: s(UNDETERMINED, 'unknown', []) };
  }

  // 7. Declared only.
  return {
    role: s(`Declared as a dependency${n.version ? ` (${n.version.value}, ${n.version.source})` : ''}; no import, call or configuration was found in the analyzed files.`, 'possible', manifestEv.length ? manifestEv : n.evidence),
    why: s(UNDETERMINED, 'unknown', []),
  };
}

/** A small neighbourhood of the system map: what reaches the technology (up to 3 hops) and what it reaches (2). */
function focusedGraph(system: Architecture['system'], seeds: Set<string>): TechIntel['graph'] {
  const byId = new Map(system.nodes.map((n) => [n.id, n]));
  const keep = new Set<string>(seeds);
  const LIMIT = 14;
  let frontier = [...seeds];
  for (let depth = 0; depth < 3 && frontier.length && keep.size < LIMIT; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const l of system.links) {
        if (l.target !== id || keep.has(l.source) || keep.size >= LIMIT) continue;
        keep.add(l.source);
        next.push(l.source);
      }
    }
    frontier = next;
  }
  frontier = [...seeds];
  for (let depth = 0; depth < 2 && frontier.length && keep.size < LIMIT + 4; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const l of system.links) {
        if (l.source !== id || keep.has(l.target) || keep.size >= LIMIT + 4) continue;
        keep.add(l.target);
        next.push(l.target);
      }
    }
    frontier = next;
  }
  const nodes = [...keep].map((id) => byId.get(id)).filter((n): n is SystemNode => !!n).map((n) => ({ id: n.id, name: n.name, kind: n.kind, layer: n.layer, focus: seeds.has(n.id) }));
  const links = system.links.filter((l) => keep.has(l.source) && keep.has(l.target)).map((l) => ({ source: l.source, target: l.target, label: l.label, async: l.async }));
  return { nodes, links };
}
