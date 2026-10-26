import { stableId } from '../architecture/evidence.ts';
import type { Architecture, ArchitectureFacts, DecisionFact, DefinitionFact, Evidence, Flow, FlowStep, MiddlewareFact, RouteFact } from '../architecture/types.ts';
import type { DependencyGraph } from '../types.ts';
import { DEFAULT_LAYOUT, layoutFlow, layoutProblems } from './layout.ts';
import { capitalize, clean, isBanned, routePhrase, verbPhrase, words } from './text.ts';
import {
  AUTOMATION_SCHEMA_VERSION,
  type AutoEdge,
  type AutoEdgeKind,
  type AutoEvidence,
  type AutoLane,
  type AutoNode,
  type AutoNodeType,
  type AutomationResult,
  type CycleType,
  type Diagnostics,
  type EntryRef,
  type ExplanationItem,
  type FlowExplanation,
  type MainFlow,
  type ProjectType,
} from './types.ts';

/*
 * Main flows ("cycles") from the traced request lifecycles:
 *   1. every entry point (route, page, server action, queue consumer, schedule) is an entry;
 *   2. entries are grouped into capabilities by resource and purpose, and stitched only where the
 *      code proves a link (an enqueue matched to its worker);
 *   3. each capability gets one flowchart built from its richest traced flow, with the decisions
 *      written in the code it runs, and its other endpoints folded into a "+N similar" node;
 *   4. up to four capabilities with distinct purposes are chosen: access, core action, data,
 *      background — never padded.
 * When nothing can be traced, a fallback flow is built from the real import chain of the entry
 * point, and the reason is stated.
 */

export interface AutomationInput {
  arch: Architecture;
  facts: ArchitectureFacts;
  graph: DependencyGraph;
  projectName: string;
}

const MAX_FLOWS = 4;
const MAX_DECISIONS = 6;
const MAX_NODES = 150;

const ACCESS = /\b(auth|oauth|login|logout|signin|signup|signout|sign in|sign up|sign out|log in|log out|register|registration|session|sessions|password|me|whoami|account|accounts|permission|permissions|sso|otp|verify|callback|token|tokens)\b/;
const BACKGROUND = /\b(webhook|webhooks|cron|schedule|scheduled|stream|events|event|sync|job|jobs|worker|workers|queue|consume|subscribe|notifications|notify|task|tasks)\b/;
const BACKEND_PATH = /(^|\/)(server|backend|api|services|workers?|functions|lambdas?|cmd)\//i;
const FRONTEND_PATH = /(^|\/)(web|frontend|client|ui|components|pages|views|public)\//i;
const CLI_PACKAGES = new Set(['commander', 'yargs', 'cac', 'meow', 'oclif', '@oclif/core', 'sade', 'clipanion', 'citty', 'click', 'typer', 'argparse', 'fire', 'docopt']);
/** Languages whose code CodePilot traces (imports, calls, routes): the JS/TS family and Python. */
const TRACED_LANGUAGES = new Set(['typescript', 'tsx', 'javascript', 'jsx', 'vue', 'svelte', 'astro', 'python']);
const MAIN_FILE = /(^|\/)(main|index|app|server|cli|run|manage|__main__|program|Program|Main)\.[\w]+$/;

interface Entry {
  ref: EntryRef;
  route?: RouteFact;
  def?: DefinitionFact;
  flows: Flow[];
  cycle: CycleType;
  mutating: boolean;
  resource: string;
  capKey: string;
}

interface Capability {
  key: string;
  cycle: CycleType;
  entries: Entry[];
}

const PROJECT_LABEL: Record<ProjectType, string> = {
  'full-stack': 'Full-stack web app',
  'backend-api': 'Backend API',
  'static-frontend': 'Client-side frontend',
  nextjs: 'Next.js app',
  microservices: 'Multi-service system',
  'event-driven': 'Event-driven system',
  cli: 'Command-line tool',
  scripts: 'Scripts / data pipeline',
  library: 'Library',
  unsupported: 'Unsupported language',
  empty: 'No source files',
};

export function buildAutomation(input: AutomationInput): AutomationResult {
  const { arch, facts, graph } = input;
  const evidence = new Map<string, Evidence>(Object.entries(arch.evidence));
  const localEv = (e: Omit<Evidence, 'id'>): string => {
    const id = stableId('aev_', `${e.kind}|${e.file}|${e.line ?? ''}|${e.detail}`);
    if (!evidence.has(id)) evidence.set(id, { ...e, id });
    return id;
  };
  const toolName = (id: string) => arch.nodes.find((n) => n.id === id)?.name ?? id.replace(/^(tool|host|app):/, '');
  const decisions = facts.decisions ?? [];
  const projectType = detectProjectType(input);

  /* ------------------------------------------------------------ entries */
  const entries: Entry[] = [];
  const seen = new Set<string>();
  for (const r of facts.routes) {
    const key = `${r.kind}|${r.method}|${r.path}|${r.file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = r.kind === 'page' ? `Page ${r.path}` : r.kind === 'action' ? `Server action ${r.handler ?? r.path}` : `${r.method} ${r.path}`;
    const mutating = r.kind === 'action' || (r.kind === 'api' && /^(POST|PUT|PATCH|DELETE)$/.test(r.method));
    entries.push({ ref: { key, label, kind: r.kind === 'api' ? 'route' : r.kind, file: r.file, line: r.line }, route: r, flows: [], cycle: 'data', mutating, resource: resourceOf(r.path, r.kind), capKey: '' });
  }
  for (const def of facts.definitions) {
    if (!['task', 'queue-consumer', 'topic-consumer', 'scheduler'].includes(def.kind)) continue;
    const key = `job|${def.kind}|${def.name ?? ''}|${def.file}:${def.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = def.kind === 'scheduler' ? `Schedule in ${base(def.file)}` : def.kind === 'task' ? `Task ${def.name ?? '(unnamed)'}` : `Consumer ${def.name ?? '(unnamed)'}`;
    entries.push({ ref: { key, label, kind: def.kind === 'scheduler' ? 'schedule' : 'queue', file: def.file, line: def.line }, def, flows: [], cycle: 'background', mutating: false, resource: def.name ?? base(def.file), capKey: '' });
  }
  // Traced lifecycles → their entry.
  for (const f of arch.flows) {
    let entry: Entry | undefined;
    if (f.trigger.kind === 'route') {
      const rs = f.steps.find((s) => s.kind === 'route');
      entry = entries.find((e) => e.route && rs && e.route.file === rs.file && e.route.line === rs.line) ?? entries.find((e) => e.route && e.route.method === f.trigger.method && e.route.path === f.trigger.path);
    } else {
      entry = entries.find((e) => e.def && f.steps.some((s) => s.file === e.def!.file && s.line === e.def!.line));
    }
    entry?.flows.push(f);
  }
  for (const e of entries) classifyEntry(e);

  /* ------------------------------------------------------------ capabilities (union-find over keys) */
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    const p = parent.get(k) ?? k;
    if (p === k) return k;
    const r = find(p);
    parent.set(k, r);
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb < ra ? ra : rb, rb < ra ? rb : ra);
  };
  for (const e of entries) parent.set(e.capKey, e.capKey);
  // Provable stitch: a traced request that enqueues work runs into the worker that consumes it.
  for (const e of entries)
    for (const f of e.flows)
      for (const s of f.steps.filter((x) => x.branch === 'async' && x.kind === 'worker'))
        for (const j of entries.filter((x) => x.def && x.def.file === s.file && x.def.line === s.line)) union(e.capKey, j.capKey);
  const caps = new Map<string, Capability>();
  for (const e of entries) {
    const k = find(e.capKey);
    if (!caps.has(k)) caps.set(k, { key: k, cycle: 'data', entries: [] });
    caps.get(k)!.entries.push(e);
  }
  for (const c of caps.values()) c.cycle = capabilityCycle(c);

  /* ------------------------------------------------------------ flowcharts */
  const ctx: ChartCtx = { arch, facts, decisions, evidence, toolName, localEv };
  const built: MainFlow[] = [];
  const rejected: Diagnostics['rejected'] = [];
  for (const c of [...caps.values()].sort((a, b) => (a.key < b.key ? -1 : 1))) {
    const traced = c.entries.filter((e) => e.flows.length);
    if (!traced.length) continue;
    const { rep, repEntry } = pickRepresentative(c, traced);
    const folded = c.entries.filter((e) => e !== repEntry && e.flows.length && !isStitched(e, rep));
    const stitched = c.entries.filter((e) => e !== repEntry && isStitched(e, rep));
    const sibling = rep.variant === 'cache-miss' ? undefined : repEntry.flows.find((f) => f.variant === 'cache-miss');
    const flow = makeMainFlow(ctx, c, sibling ?? rep, repEntry, folded, stitched);
    built.push(flow);
  }

  /* ------------------------------------------------------------ fallbacks */
  const diagnostics: Diagnostics = {
    entryPoints: entries.length,
    tracedFlows: arch.flows.length,
    capabilities: caps.size,
    flowsBuilt: 0,
    rejected,
    traceCoverage: entries.length ? Math.round((entries.filter((e) => e.flows.length).length / entries.length) * 100) : 0,
    notes: [],
  };
  // Client-side flows: UI events that call something no traced route handles (static frontends).
  if (!built.length) {
    const clientFlow = buildClientFlow(ctx, input, entries);
    if (clientFlow) {
      built.push(clientFlow.flow);
      entries.push(...clientFlow.entries);
      diagnostics.fallback = { kind: 'client', reason: 'No server routes or jobs were traced; these flows start at UI events in the client code.' };
    }
  }
  if (!built.length) {
    const f = buildEntryChainFlow(ctx, input, projectType);
    if (f) {
      built.push(f.flow);
      entries.push(f.entry);
      diagnostics.fallback = { kind: f.kind, reason: f.reason };
    }
  }

  // Validation: valid flows are candidates; if none is valid, the best ones are shown as partial.
  const valid = built.filter((f) => !f.problems.length);
  for (const f of built.filter((x) => x.problems.length)) rejected.push({ name: f.name, reasons: f.problems });
  let pool = valid;
  let status: AutomationResult['status'] = diagnostics.fallback ? 'fallback' : 'ok';
  if (!valid.length && built.length) {
    pool = built.map((f) => ({ ...f, partial: true }));
    status = 'partial';
  }
  if (!pool.length) status = 'empty';
  pool.sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : 1));
  const selected = chooseFlows(pool);
  ensureUniqueNames(pool);
  addJumps(pool, selected);
  diagnostics.flowsBuilt = built.length;
  const untraced = Object.keys(facts.languages).filter((l) => !['js', 'python'].includes(l));
  if (untraced.length && facts.routes.some((r) => /\.(go|rb|php|java|kt|rs|cs)$/.test(r.file))) diagnostics.notes.push(`Routes in ${untraced.join(', ')} are recognized, but the calls inside their handlers are not traced.`);
  if (projectType === 'unsupported') diagnostics.notes.push(`No file in a language CodePilot traces (JavaScript, TypeScript, Python) was found; ${Object.keys(facts.languages).join(', ') || 'no source'} files are listed but not traced.`);
  if (entries.length && !arch.flows.length && !diagnostics.fallback) diagnostics.notes.push('Entry points were found but none could be traced into a flow.');
  if (!entries.length && !diagnostics.fallback) diagnostics.notes.push('No routes, pages, server actions, queue consumers or schedules were recognized.');

  const result: AutomationResult = {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    projectType,
    projectTypeLabel: PROJECT_LABEL[projectType],
    status,
    flows: pool,
    selected,
    coverage: { total: 0, shown: [], folded: [], omitted: [] },
    diagnostics,
  };
  (result as AutomationResult & { entries: EntryRef[] }).entries = entries.map((e) => ({ ...e.ref, reason: e.flows.length ? undefined : 'not traced' }));
  result.coverage = coverageFor(result, selected);
  return result;
}

/** Shown, folded and omitted entry points for a selection of main flows; they always add up to the total. */
export function coverageFor(result: AutomationResult, selected: string[]): AutomationResult['coverage'] {
  const all = ((result as AutomationResult & { entries?: EntryRef[] }).entries ?? []) as EntryRef[];
  const chosen = result.flows.filter((f) => selected.includes(f.key));
  const shown = new Map<string, EntryRef>();
  const folded = new Map<string, EntryRef>();
  for (const f of chosen) {
    for (const e of f.entries.shown) shown.set(e.key, e);
    for (const e of f.entries.folded) if (!shown.has(e.key)) folded.set(e.key, e);
  }
  const omitted = all.filter((e) => !shown.has(e.key) && !folded.has(e.key)).map((e) => ({ ...e, reason: e.reason ?? 'in a flow that is not shown' }));
  return { total: all.length, shown: [...shown.values()], folded: [...folded.values()], omitted };
}

/* ================================================================== classification */

function resourceOf(path: string, kind: RouteFact['kind']): string {
  const segs = path.split('/').filter((s) => s && s !== 'api' && !/^v\d+$/.test(s));
  const isParam = (s: string) => /^[:{[<*]/.test(s);
  const first = segs.find((s) => !isParam(s));
  if (!first) return kind === 'page' ? 'home' : 'root';
  const after = segs.slice(segs.indexOf(first) + 1);
  const pi = after.findIndex(isParam);
  const sub = pi >= 0 ? after.slice(pi + 1).find((s) => !isParam(s)) : undefined;
  return sub ? `${first}/${sub}` : first;
}

function classifyEntry(e: Entry) {
  const action = e.flows.find((f) => f.action)?.action;
  const text = words([e.ref.label, e.route?.handler ?? '', e.route?.file ?? e.def?.file ?? '', action?.label ?? ''].join(' ')).join(' ');
  if (e.def) e.cycle = 'background';
  else if (ACCESS.test(text)) e.cycle = 'access';
  else if (BACKGROUND.test(words(`${e.ref.label} ${e.route?.handler ?? ''}`).join(' ')) || e.flows.some((f) => f.steps.some((s) => s.transport === 'Event stream'))) e.cycle = 'background';
  else e.cycle = e.mutating ? 'core' : 'data';
  // Reads and writes group by their top-level resource; access by the file that defines it.
  e.capKey = e.cycle === 'access' ? `access|${e.route?.file ?? ''}` : e.cycle === 'background' ? `background|${e.resource}` : `${e.resource.split('/')[0]}|${e.mutating ? 'write' : 'read'}`;
}

function capabilityCycle(c: Capability): CycleType {
  const n = c.entries.length;
  const count = (t: CycleType) => c.entries.filter((e) => e.cycle === t).length;
  if (count('access') * 2 >= n) return 'access';
  if (c.entries.some((e) => e.flows.length && e.cycle === 'core')) return 'core';
  if (count('background') * 2 >= n) return 'background';
  return c.entries.filter((e) => e.mutating).length / n >= 0.4 ? 'core' : 'data';
}

function flowRichness(f: Flow): number {
  const kinds = new Set(f.steps.map((s) => s.kind));
  return (f.action ? 20 : 0) + kinds.size * 3 + Math.min(f.steps.length, 24) + (kinds.has('data') || kinds.has('cache') ? 6 : 0) + (f.steps.some((s) => s.branch === 'async') ? 5 : 0) - f.steps.filter((s) => s.kind === 'unknown').length * 4;
}

function pickRepresentative(c: Capability, traced: Entry[]): { rep: Flow; repEntry: Entry } {
  let best: { rep: Flow; repEntry: Entry; score: number } | undefined;
  for (const e of traced)
    for (const f of e.flows) {
      if (f.variant === 'cache-hit') continue;
      const score = flowRichness(f) + (c.cycle === 'core' && e.mutating ? 15 : 0) + (c.cycle === 'data' && !e.mutating ? 5 : 0);
      if (!best || score > best.score || (score === best.score && f.title < best.rep.title)) best = { rep: f, repEntry: e, score };
    }
  if (!best) {
    const e = traced[0];
    return { rep: e.flows[0], repEntry: e };
  }
  return best;
}

/** An entry whose code already runs inside the representative flow (a stitched worker). */
function isStitched(e: Entry, rep: Flow): boolean {
  return !!e.def && rep.steps.some((s) => s.branch === 'async' && s.file === e.def!.file && s.line === e.def!.line);
}

function detectProjectType(input: AutomationInput): ProjectType {
  const { arch, facts, graph } = input;
  const files = graph.nodes.filter((n) => n.type !== 'external' && n.type !== 'unresolved');
  if (!files.length) return 'empty';
  const analyzed = files.filter((n) => n.analyzed || TRACED_LANGUAGES.has(n.language)).length;
  if (!analyzed && !facts.routes.length) return 'unsupported';
  const apps = arch.nodes.filter((n) => n.kind === 'app');
  const servers = apps.filter((n) => n.category !== 'frontend' && n.category !== 'worker');
  const ui = apps.filter((n) => n.category === 'frontend');
  const api = facts.routes.filter((r) => r.kind === 'api');
  if (facts.routes.some((r) => r.framework === 'nextjs')) return 'nextjs';
  if (servers.length >= 2) return 'microservices';
  if (api.length && (ui.length || facts.uiTriggers.length)) return 'full-stack';
  if (api.length) return 'backend-api';
  if (facts.definitions.some((d) => d.kind === 'task' || d.kind === 'queue-consumer' || d.kind === 'topic-consumer')) return 'event-driven';
  if (ui.length || files.some((n) => n.type === 'component' || n.type === 'page')) return 'static-frontend';
  if (usesCli(input)) return 'cli';
  if (files.some((n) => n.language === 'python')) return 'scripts';
  return 'library';
}

function usesCli(input: AutomationInput): boolean {
  if (input.graph.edges.some((e) => e.external && CLI_PACKAGES.has(e.target.replace(/^ext:/, '')))) return true;
  return input.facts.imports.some((i) => CLI_PACKAGES.has(i.module));
}

/* ================================================================== flowcharts */

interface ChartCtx {
  arch: Architecture;
  facts: ArchitectureFacts;
  decisions: DecisionFact[];
  evidence: Map<string, Evidence>;
  toolName(id: string): string;
  localEv(e: Omit<Evidence, 'id'>): string;
}

const base = (f: string) => f.slice(f.lastIndexOf('/') + 1);
const cite = (e: AutoEvidence) => `${e.file}${e.line ? `:${e.line}` : ''}`;

function toEvidence(ctx: ChartCtx, ids: string[], fallback: { file: string; line?: number }): AutoEvidence[] {
  const out = ids
    .map((id) => ctx.evidence.get(id))
    .filter((e): e is Evidence => !!e)
    .map((e) => ({ file: e.file, line: e.line, snippet: e.snippet, detail: e.detail }));
  return out.length ? out : [{ file: fallback.file, line: fallback.line }];
}

function stepType(s: FlowStep, first: boolean): AutoNodeType {
  if (first) return 'trigger';
  switch (s.kind) {
    case 'action':
      return 'ui';
    case 'handler':
      return s.lane === 'frontend' ? 'ui' : 'server';
    case 'client':
      return 'request';
    case 'data':
    case 'cache':
      return 'store';
    case 'queue':
    case 'worker':
      return 'job';
    case 'external':
      return 'external';
    case 'unknown':
      return 'unknown';
    case 'resolve':
    case 'state':
      return 'ui';
    default:
      return 'server';
  }
}

function laneFor(s: FlowStep, type: AutoNodeType, trigger?: Flow['trigger']): AutoLane {
  if (type === 'store') return 'data';
  if (type === 'external' || type === 'unknown') return 'external';
  if (type === 'job' || s.lane === 'async' || s.branch === 'async') return 'background';
  if (type === 'trigger' && trigger && trigger.kind !== 'route') return 'background';
  if (s.lane === 'frontend') return BACKEND_PATH.test(s.file) && !FRONTEND_PATH.test(s.file) ? 'backend' : 'frontend';
  return 'backend';
}

/** The decision question, which answer leaves the path, and the edge kinds. */
function question(d: DecisionFact): { q: string; exitLabel: string; exitKind: AutoEdgeKind; contLabel: string; contKind: AutoEdgeKind } {
  const short = d.condition.length > 42 ? `${d.condition.slice(0, 41)}…` : d.condition;
  const literal = { q: `${short}?`, exitLabel: 'True', exitKind: 'true' as const, contLabel: 'False', contKind: 'false' as const };
  if (d.via === 'try') return { q: 'Succeeds?', exitLabel: 'Throws', exitKind: 'error', contLabel: 'Succeeds', contKind: 'sequence' };
  const no = (q: string) => (d.negative ? { q, exitLabel: 'No', exitKind: 'false' as const, contLabel: 'Yes', contKind: 'true' as const } : literal);
  switch (d.kind) {
    case 'auth':
      return no(d.exit.status === 403 ? 'Allowed?' : 'Signed in?');
    case 'not-found':
      return no('Found?');
    case 'validation':
      return no('Valid input?');
    case 'limit':
      return no('Within limits?');
    case 'flag':
      return no('Enabled?');
    case 'conflict':
      return d.negative ? literal : { q: 'Already exists?', exitLabel: 'Yes', exitKind: 'true', contLabel: 'No', contKind: 'false' };
    case 'cache':
      return d.negative ? literal : { q: 'Cached?', exitLabel: 'Yes', exitKind: 'true', contLabel: 'No', contKind: 'false' };
    default:
      return literal;
  }
}

function exitText(d: DecisionFact): string {
  const x = d.exit;
  if (x.kind === 'continue') return 'Error handled, continues';
  if (x.status && x.message) return `${x.status} · ${x.message}`;
  if (x.status) return `${x.status} response`;
  if (x.kind === 'throw') return x.message ? `Throws “${x.message}”` : 'Throws an error';
  if (x.kind === 'redirect') return 'Redirects';
  if (x.kind === 'respond') return x.message ? `Responds “${x.message}”` : 'Responds early';
  return d.kind === 'cache' ? 'Returns the cached value' : 'Returns early';
}

/** The code a step runs: the route handler body, a referenced function, a middleware hook or a client function. */
function scopeOf(ctx: ChartCtx, s: FlowStep, route: RouteFact | undefined): [string, number, number] | undefined {
  let range: [string, number, number] | undefined;
  if (s.kind === 'handler' && s.lane !== 'frontend' && route && s.file === route.file) range = [route.file, route.bodyStart ?? route.line, route.bodyEnd ?? route.line + 120];
  else if (s.kind === 'service' && s.output?.startsWith('defined at ')) {
    const m = /^defined at (.+):(\d+)$/.exec(s.output);
    const sym = m ? ctx.facts.symbols.find((x) => x.file === m[1] && x.line === +m[2]) : undefined;
    if (sym) range = [sym.file, sym.line, sym.end];
  } else if (s.kind === 'middleware' && s.line) {
    // A hook's body is short and written right where it is registered; stop at the next registration.
    const same = ctx.facts.middleware.filter((m: MiddlewareFact) => m.file === s.file && m.line > s.line!).map((m) => m.line);
    range = [s.file, s.line, Math.min(s.line + 10, ...same.map((l) => l - 1))];
  } else if (s.kind === 'client' && s.line) {
    const sym = ctx.facts.symbols.filter((x) => x.file === s.file && x.line <= s.line! && x.end >= s.line!).sort((a, b) => a.end - a.line - (b.end - b.line))[0];
    if (sym && sym.end - sym.line < 60) range = [sym.file, sym.line, sym.end];
  }
  return range;
}

/** Decisions written in the code a step runs. */
function scopeDecisions(ctx: ChartCtx, s: FlowStep, route: RouteFact | undefined): DecisionFact[] {
  const range = scopeOf(ctx, s, route);
  if (!range) return [];
  const [file, from, to] = range;
  return ctx.decisions.filter(
    (d) =>
      d.file === file &&
      d.line >= from &&
      d.line <= to &&
      (d.kind !== 'condition' || d.exit.kind === 'throw' || (d.exit.kind === 'respond' && !!d.exit.status)) &&
      !(s.kind === 'middleware' && d.kind === 'condition') &&
      !(d.via === 'try' && d.swallowed && d.exit.kind === 'continue' && s.kind !== 'handler'),
  );
}

const DECISION_RANK: Record<DecisionFact['kind'], number> = { auth: 0, validation: 1, 'not-found': 2, conflict: 3, limit: 4, cache: 5, flag: 6, error: 7, condition: 8 };
const laneOfFile = (file: string, fallback: AutoLane): AutoLane => (FRONTEND_PATH.test(file) && !BACKEND_PATH.test(file) ? 'frontend' : BACKEND_PATH.test(file) ? 'backend' : fallback);

/** The decisions a flow shows: the most telling ones (guards, validation, not-found…) up to the limit, in path order. */
function allowedDecisions(ctx: ChartCtx, steps: FlowStep[], route: RouteFact | undefined): Set<string> {
  const all: { d: DecisionFact; order: number }[] = [];
  steps.forEach((s, i) => {
    const range = scopeOf(ctx, s, route);
    const large = range && range[2] - range[1] > 40;
    for (const d of scopeDecisions(ctx, s, route)) {
      // In a large scope (a class, a long module) keep only decisions next to a call this path makes.
      if (large && !steps.some((t) => t.file === d.file && t.line !== undefined && Math.abs(t.line - d.line) <= 30)) continue;
      all.push({ d, order: i * 1000 + d.line });
    }
  });
  const unique = [...new Map(all.map((x) => [`${x.d.file}:${x.d.line}`, x])).values()];
  unique.sort((a, b) => DECISION_RANK[a.d.kind] - DECISION_RANK[b.d.kind] || a.order - b.order);
  return new Set(unique.slice(0, MAX_DECISIONS).map((x) => `${x.d.file}:${x.d.line}`));
}

function makeMainFlow(ctx: ChartCtx, cap: Capability, rep: Flow, repEntry: Entry, folded: Entry[], stitched: Entry[]): MainFlow {
  const key = cap.key;
  const id = stableId('mf_', key);
  const nodes: AutoNode[] = [];
  const edges: AutoEdge[] = [];
  const byId = new Map<string, AutoNode>();
  let order = 0;
  let nodeSeq = 0;
  let edgeSeq = 0;
  const add = (n: Omit<AutoNode, 'id' | 'order'>, onMain = true): string => {
    const nid = `${id}:n${++nodeSeq}`;
    const node = { ...n, id: nid, order: onMain ? ++order : 500 + nodeSeq, label: clean(n.label, n.type === 'trigger' ? repEntry.ref.label : 'Step') };
    nodes.push(node);
    byId.set(nid, node);
    return nid;
  };
  const link = (source: string | null, target: string, kind: AutoEdgeKind, label?: string, ev?: AutoEvidence[], timer?: string) => {
    if (!source) return;
    const text = label ? clean(label) : '';
    edges.push({ id: `${id}:e${++edgeSeq}`, source, target, kind, label: text ? (text.length > 44 ? `${text.slice(0, 43)}…` : text) : undefined, timer, evidence: ev ?? byId.get(target)!.evidence.slice(0, 1) });
  };

  const route = repEntry.route;
  const main = rep.steps.filter((s) => s.branch !== 'async');
  // Without a UI action or a calling client, the flow starts at the route itself (not at middleware listed before it).
  if (!rep.action && main.length && main[0].kind === 'middleware') {
    const ri = main.findIndex((s) => s.kind === 'route');
    if (ri > 0) main.unshift(...main.splice(ri, 1));
  }
  const allowed = allowedDecisions(ctx, main, route);
  const background = rep.steps.filter((s) => s.branch === 'async');
  let tail: string | null = null;
  let next: { kind: AutoEdgeKind; label?: string } | null = null;
  const go = (target: string, label?: string, kind: AutoEdgeKind = 'sequence', ev?: AutoEvidence[], timer?: string) => {
    const k = next?.kind ?? kind;
    const l = next?.label ?? label;
    link(tail, target, k, l, ev, timer);
    next = null;
    tail = target;
  };
  interface Pending {
    d: DecisionFact;
    lane: AutoLane;
    scope: { file: string; from: number; to: number };
  }
  const pending: Pending[] = [];
  const usedDecisions = new Set<string>();
  const rejoin: { from: string; label: string; kind: AutoEdgeKind; ev: AutoEvidence[] }[] = [];
  let queueNode: string | null = null;
  let decisionCount = 0;

  const addDecision = (d: DecisionFact, lane: AutoLane) => {
    if (decisionCount >= MAX_DECISIONS || usedDecisions.has(`${d.file}:${d.line}`) || !allowed.has(`${d.file}:${d.line}`)) return;
    usedDecisions.add(`${d.file}:${d.line}`);
    decisionCount++;
    const qq = question(d);
    const ev: AutoEvidence[] = [{ file: d.file, line: d.line, snippet: d.snippet, detail: `Condition: ${d.condition}` }];
    const exitEv: AutoEvidence[] = [{ file: d.file, line: d.exit.line, snippet: d.exit.snippet, detail: exitText(d) }];
    const detail =
      d.via === 'try'
        ? `Runs code that can throw (${d.file}:${d.line}); errors are caught at line ${d.catchLine}. If it throws: ${exitText(d)} (${d.file}:${d.exit.line}).`
        : `Checks ${d.condition} (${d.file}:${d.line}). If ${qq.exitLabel.toLowerCase()}: ${exitText(d)} (${d.file}:${d.exit.line}).`;
    const dn = add({ type: 'decision', label: qq.q, detail, lane, file: d.file, line: d.line, evidence: ev, tools: [], confidence: 'confirmed', decision: { question: qq.q, condition: d.condition, kind: d.kind } });
    go(dn);
    if (d.kind === 'cache' && d.exit.kind === 'return') rejoin.push({ from: dn, label: qq.exitLabel, kind: qq.exitKind, ev: exitEv });
    else if (d.exit.kind === 'continue') rejoin.push({ from: dn, label: 'Throws, handled', kind: 'error', ev: exitEv });
    else {
      const end = add({ type: 'end', label: exitText(d), detail: `${exitText(d)} (${d.file}:${d.exit.line}).`, lane, file: d.file, line: d.exit.line, evidence: exitEv, tools: [], confidence: 'confirmed', dataOut: d.exit.message }, false);
      link(dn, end, qq.exitKind, qq.exitLabel, exitEv);
    }
    next = { kind: qq.contKind, label: qq.contLabel };
  };
  /**
   * Decisions run in code order: a pending decision is placed before the first later step of its own
   * function, or when the path leaves that function for another top-level step (middleware, route,
   * handler, response). Calls into other files from inside the function keep it pending.
   */
  const flushDecisions = (step?: FlowStep, pos?: { file: string; line: number }) => {
    pending.sort((a, b) => (a.scope.file === b.scope.file ? a.d.line - b.d.line : 0));
    const leaving = !step || ['middleware', 'route', 'handler', 'response', 'resolve', 'state'].includes(step.kind ?? '');
    for (const p of [...pending]) {
      const inScope = pos && pos.file === p.scope.file && pos.line >= p.scope.from && pos.line <= p.scope.to;
      if (leaving || (inScope && p.d.line < pos!.line)) {
        pending.splice(pending.indexOf(p), 1);
        addDecision(p.d, p.lane);
      }
    }
  };
  const resolveRejoins = (target: string) => {
    for (const r of rejoin.splice(0)) link(r.from, target, r.kind, r.label, r.ev);
  };

  // Middleware without decisions is shown as one step.
  let mwBuffer: FlowStep[] = [];
  const flushMw = () => {
    if (!mwBuffer.length) return;
    const names = mwBuffer.map((m) => m.label ?? 'middleware');
    const label = names.length === 1 ? names[0] : `Middleware: ${names.slice(0, 2).join(', ')}${names.length > 2 ? ` +${names.length - 2}` : ''}`;
    const ev = mwBuffer.flatMap((m) => toEvidence(ctx, m.evidence, m));
    const nid = add({ type: 'server', label, detail: mwBuffer.map((m) => m.explanation).join(' '), lane: 'backend', file: mwBuffer[0].file, line: mwBuffer[0].line, evidence: ev, tools: [], confidence: 'confirmed' });
    go(nid);
    mwBuffer = [];
  };

  main.forEach((s, i) => {
    const first = i === 0;
    const sd = first ? [] : scopeDecisions(ctx, s, route);
    // Decisions written before this step's call site run first.
    const pos = s.kind === 'service' && s.input?.startsWith('called at ') ? (() => {
      const m = /^called at (.+):(\d+)$/.exec(s.input!);
      return m ? { file: m[1], line: +m[2] } : undefined;
    })() : s.line ? { file: s.file, line: s.line } : undefined;
    if (!first && s.kind === 'middleware' && s.label !== 'Auth guard' && !sd.length) {
      if (!mwBuffer.length) flushDecisions(s, pos);
      mwBuffer.push(s);
      return;
    }
    flushMw();
    flushDecisions(s, pos);

    // A declared guard; skipped when the handler's own check right after it is already a decision.
    const realCheck = s.label === 'Auth guard' && route ? ctx.decisions.find((d) => d.kind === 'auth' && d.file === route.file && Math.abs(d.line - (s.line ?? 0)) <= 3 && allowed.has(`${d.file}:${d.line}`)) : undefined;
    if (s.label === 'Auth guard' && s.kind === 'middleware' && realCheck) return;
    if (s.label === 'Auth guard' && s.kind === 'middleware') {
      const ev = toEvidence(ctx, s.evidence, s);
      const dn = add({ type: 'decision', label: 'Signed in?', detail: s.explanation, lane: 'backend', file: s.file, line: s.line, evidence: ev, tools: [], confidence: 'confirmed', decision: { question: 'Signed in?', condition: ev[0].snippet ?? 'auth guard', kind: 'auth' } });
      go(dn);
      const end = add({ type: 'end', label: 'Rejected by the guard', detail: `The guard rejects the request; the response it sends is not written in this handler (${s.file}:${s.line}).`, lane: 'backend', file: s.file, line: s.line, evidence: ev, tools: [], confidence: 'strong' }, false);
      link(dn, end, 'false', 'No', ev);
      next = { kind: 'true', label: 'Yes' };
      return;
    }

    const type = stepType(s, first);
    const ev = toEvidence(ctx, s.evidence, s);
    const tools = s.tool ? [s.tool] : /^(tool|host):/.test(s.node) && (type === 'store' || type === 'external' || type === 'job') ? [s.node] : [];
    const label =
      first && rep.action ? fixActionLabel(rep.action.label, rep.action.component)
      : first && type === 'trigger' && !rep.action ? (rep.trigger.kind === 'route' ? repEntry.ref.label : rep.trigger.kind === 'queue' ? `Message for ${rep.trigger.name ?? 'the consumer'}` : 'Schedule fires')
      : s.label ?? s.node;
    const nid = add({
      type,
      label,
      detail: s.explanation,
      lane: laneFor(s, type, first ? rep.trigger : undefined),
      file: s.file,
      line: s.line,
      evidence: ev,
      tools,
      dataIn: s.input,
      dataOut: s.output,
      confidence: s.kind === 'unknown' ? 'unknown' : s.confidence === 'strong' ? 'strong' : 'confirmed',
      entryKey: s.kind === 'route' ? repEntry.ref.key : undefined,
    });
    // What moves along the edge, only when the code names it.
    const prev = tail ? byId.get(tail) : undefined;
    let edgeLabel: string | undefined;
    if (s.kind === 'route' && prev?.type === 'request') edgeLabel = /^arguments: (.+)$/.exec(prev.dataIn ?? '')?.[1];
    else if (s.kind === 'resolve') edgeLabel = /(\{[^}]*\})/.exec(prev?.dataOut ?? '')?.[1];
    else if (type === 'store' || type === 'job') edgeLabel = /"([^"]+)"/.exec(s.input ?? '')?.[1];
    const timer = /with an expiry/.test(s.explanation) ? 'expiry (TTL)' : undefined;
    go(nid, edgeLabel, 'sequence', undefined, timer);
    if (type === 'job' && s.mode === 'publish') queueNode = nid;
    if (s.kind === 'response') resolveRejoins(nid);

    // A cache read on the miss path is a decision: a hit returns early, a miss continues.
    if (s.branch === 'cache-miss' || s.mode === 'cache-miss') {
      const near = ctx.decisions.find((d) => d.kind === 'cache' && d.file === s.file && Math.abs(d.line - (s.line ?? 0)) <= 4);
      if (near) usedDecisions.add(`${near.file}:${near.line}`);
      const dev: AutoEvidence[] = near ? [{ file: near.file, line: near.line, snippet: near.snippet, detail: `Condition: ${near.condition}` }] : ev;
      const dn = add({ type: 'decision', label: 'Cached?', detail: near ? `Checks ${near.condition} (${near.file}:${near.line}); on a hit the cached value is returned.` : `On a hit the cached value is returned; the branch is inferred from a cache read, a data call and a cache write on the same path (${s.file}:${s.line}).`, lane: laneFor(s, 'server'), file: dev[0].file, line: dev[0].line, evidence: dev, tools: [], confidence: near ? 'confirmed' : 'strong', decision: { question: 'Cached?', condition: near?.condition ?? 'cache hit', kind: 'cache' } });
      go(dn);
      rejoin.push({ from: dn, label: 'Yes', kind: 'true', ev: dev });
      next = { kind: 'false', label: 'No' };
    }
    const range = scopeOf(ctx, s, route);
    if (range) pending.push(...sd.filter((d) => !usedDecisions.has(`${d.file}:${d.line}`)).map((d) => ({ d, lane: laneOfFile(d.file, laneFor(s, type)), scope: { file: range[0], from: range[1], to: range[2] } })));
  });
  flushMw();
  flushDecisions();

  // The end of the main path.
  const last = tail ? byId.get(tail) : undefined;
  const lastStep = main.at(-1);
  if (last && lastStep && ['response', 'resolve', 'state'].includes(lastStep.kind ?? '') && !rejoin.length && !next) last.type = 'end';
  else if (last) {
    const unknown = last.type === 'unknown';
    const end = add({ type: 'end', label: unknown ? 'Stops: next hop unknown' : 'End of traced path', detail: unknown ? `Tracing stops at ${cite(last.evidence[0])}: the target is not written in the code.` : `The traced path ends at ${cite(last.evidence[0])}.`, lane: last.lane, file: last.file, line: last.line, evidence: last.evidence.slice(0, 1), tools: [], confidence: unknown ? 'unknown' : 'strong' });
    go(end);
    resolveRejoins(end);
  }
  resolveRejoins(tail!);

  // Background work stitched to the enqueue.
  if (background.length) {
    let bTail: string | null = queueNode ?? tail;
    background.forEach((s, i) => {
      const type = s.kind === 'worker' ? 'job' : stepType(s, false);
      const ev = toEvidence(ctx, s.evidence, s);
      const tools = s.tool ? [s.tool] : /^(tool|host):/.test(s.node) && (type === 'store' || type === 'external' || type === 'job') ? [s.node] : [];
      const nid = add({ type, label: s.label ?? s.node, detail: s.explanation, lane: type === 'store' ? 'data' : type === 'external' || type === 'unknown' ? 'external' : 'background', file: s.file, line: s.line, evidence: ev, tools, dataIn: s.input, dataOut: s.output, confidence: s.kind === 'unknown' ? 'unknown' : 'confirmed' }, false);
      link(bTail, nid, i === 0 ? 'async' : s.kind === 'unknown' ? 'unknown' : 'sequence', i === 0 ? /"([^"]+)"/.exec(byId.get(bTail!)?.dataIn ?? '')?.[1] : undefined);
      bTail = nid;
    });
  }

  // Folded near-duplicate endpoints.
  const trigger = nodes[0];
  if (folded.length && trigger) {
    const members = folded.map((e) => ({ label: e.ref.label, file: e.ref.file, line: e.ref.line }));
    const g = add({ type: 'group', label: `+${folded.length} similar endpoint${folded.length === 1 ? '' : 's'}`, detail: members.map((m) => `${m.label} (${m.file}${m.line ? `:${m.line}` : ''})`).join('; '), lane: laneOfFile(members[0].file, 'backend'), file: members[0].file, line: members[0].line, evidence: members.slice(0, 6).map((m) => ({ file: m.file, line: m.line, detail: m.label })), tools: [], confidence: 'confirmed', members }, false);
    link(trigger.id, g, 'group', undefined, byId.get(g)!.evidence.slice(0, 1));
  }

  capNodes(nodes, edges, id);

  const flow = finishFlow(ctx, {
    id,
    key,
    cycle: cap.cycle,
    nodes,
    edges,
    rep,
    repEntry,
    folded,
    stitched,
    sourceFlowIds: [...new Set([rep.id, ...repEntry.flows.map((f) => f.id)])],
  });
  return flow;
}

function fixActionLabel(label: string, component?: string): string {
  if (/^Click “button”$/.test(label)) return component ? `Click in ${component}` : 'Click';
  if (/^Submit “form”$/.test(label)) return component ? `Submit in ${component}` : 'Submit';
  return label;
}

/** Very large flows: keep the first nodes on the path and fold the rest into one expandable group. */
function capNodes(nodes: AutoNode[], edges: AutoEdge[], id: string) {
  if (nodes.length <= MAX_NODES) return;
  const keep = new Set([...nodes].sort((a, b) => a.order - b.order).slice(0, MAX_NODES - 1).map((n) => n.id));
  const dropped = nodes.filter((n) => !keep.has(n.id));
  const g: AutoNode = { id: `${id}:more`, type: 'group', label: `+${dropped.length} more steps`, detail: dropped.map((n) => n.label).join('; '), lane: dropped[0].lane, file: dropped[0].file, line: dropped[0].line, evidence: dropped[0].evidence.slice(0, 1), tools: [...new Set(dropped.flatMap((n) => n.tools))], confidence: 'strong', order: MAX_NODES, members: dropped.map((n) => ({ label: n.label, file: n.file, line: n.line })) };
  nodes.splice(0, nodes.length, ...nodes.filter((n) => keep.has(n.id)), g);
  const kept = edges.filter((e) => keep.has(e.source) && keep.has(e.target));
  const into = edges.find((e) => keep.has(e.source) && !keep.has(e.target));
  if (into) kept.push({ ...into, id: `${id}:emore`, target: g.id });
  edges.splice(0, edges.length, ...kept);
}

/* ================================================================== naming, explanation, validation */

function actorOf(rep: Flow, entry: Entry, ctx?: ChartCtx): string {
  if (rep.action) return rep.action.kind === 'load' ? `${rep.action.component ?? 'The'} page` : 'User';
  if (rep.trigger.kind === 'queue') return 'Worker';
  if (rep.trigger.kind === 'schedule') return 'Scheduler';
  const hook = /webhooks?\/([\w-]+)/i.exec(entry.route?.path ?? '');
  if (hook) return capitalize(hook[1]);
  if (entry.route?.kind === 'page') return 'Visitor';
  const first = rep.steps[0];
  if (first?.kind === 'client' && first.lane !== 'frontend' && ctx) {
    const app = ctx.arch.nodes.find((n) => n.id === first.node && n.kind === 'app');
    if (app) return `The ${app.name} service`;
  }
  return 'API client';
}

const HTTP_NAMES = /^(get|post|put|patch|delete|head|options|handler|default)$/i;

/** The object a route is about, from its last static path segment that is not itself a verb. */
function routeObject(path: string): string | undefined {
  const statics = path.split('/').filter((x) => x && x !== 'api' && !/^v\d+$/.test(x) && !/^[:{[<*]/.test(x));
  const objs = statics.filter((x) => !verbPhrase(x) && !/^(stream|events?)$/.test(x));
  return objs.at(-1) ? words(objs.at(-1)!).join(' ') : undefined;
}

function nameFlow(rep: Flow, entry: Entry, ctx?: ChartCtx): string {
  const actor = actorOf(rep, entry, ctx);
  const route = entry.route;
  const client = rep.steps.find((s) => s.kind === 'client' && s.lane === 'frontend');
  // A page-load hook is named after its component, which says nothing about what it loads.
  const handlerUi = rep.action?.kind === 'load' ? undefined : rep.steps.find((s) => s.kind === 'handler' && s.lane === 'frontend' && s.fn);
  let phrase: string | null = null;
  if (/webhooks?\//i.test(route?.path ?? '')) phrase = 'sends a webhook event';
  else if (route?.kind === 'page') phrase = route.path === '/' ? 'opens the home page' : `opens ${route.path}`;
  else if (rep.steps.some((s) => s.transport === 'Event stream' || /EventSource|WebSocket/.test(s.label ?? ''))) {
    const obj = route ? routeObject(route.path) : undefined;
    phrase = `streams ${obj ? `${obj} updates` : 'updates'}`;
  }
  const sources = [
    rep.action && rep.action.kind !== 'load' ? rep.action.label.replace(/^(Click|Submit)\s*/, '') : '',
    handlerUi?.fn ?? '',
    client?.label?.replace(/\(\)$/, '').split('.').pop() ?? '',
    route?.handler && !HTTP_NAMES.test(route.handler) ? route.handler : '',
    rep.trigger.kind !== 'route' ? (rep.trigger.name ?? '') : '',
  ].filter(Boolean);
  for (const src of sources) {
    if (phrase) break;
    phrase = verbPhrase(src);
  }
  if (!phrase && client?.label && /^(?:\w+\.)?(me|whoami|session|currentUser)\(\)$/.test(client.label)) phrase = 'loads the signed-in user';
  if (!phrase && route) phrase = routePhrase(route.method, route.path);
  if (!phrase && rep.trigger.kind === 'queue') phrase = `processes ${rep.trigger.name ? `“${rep.trigger.name}”` : 'queued work'}`;
  if (!phrase && rep.trigger.kind === 'schedule') phrase = 'runs scheduled work';
  // A bare verb ("toggles") gets its object from the route ("toggles consent").
  if (phrase && !phrase.includes(' ') && route) {
    const obj = routeObject(route.path);
    if (obj) phrase = `${phrase} ${/s$/.test(obj) && !/ss$/.test(obj) ? obj.replace(/ies$/, 'y').replace(/s$/, '') : obj}`;
  }
  const name = clean(`${actor} ${phrase ?? 'runs this flow'}`);
  return name && !isBanned(name) ? capitalize(name) : capitalize(`${actor} ${entry.ref.label}`);
}

function finishFlow(
  ctx: ChartCtx,
  p: { id: string; key: string; cycle: CycleType; nodes: AutoNode[]; edges: AutoEdge[]; rep?: Flow; repEntry?: Entry; folded: Entry[]; stitched: Entry[]; sourceFlowIds: string[]; name?: string },
): MainFlow {
  const { nodes, edges } = p;
  const name = p.name ?? (p.rep && p.repEntry ? nameFlow(p.rep, p.repEntry, ctx) : 'How the app starts');
  const toolIds = [...new Set(nodes.flatMap((n) => n.tools))];
  const tools = toolIds.map((id) => ({ id, name: ctx.toolName(id) }));
  const counted = nodes.filter((n) => n.type !== 'group' && n.type !== 'jump');
  const traced = counted.filter((n) => n.confidence !== 'unknown').length;
  const percent = counted.length ? Math.round((traced / counted.length) * 100) : 0;
  const trigger = nodes.find((n) => n.type === 'trigger');
  const ends = nodes.filter((n) => n.type === 'end');
  const mainEnd = [...ends].filter((n) => n.order < 500).sort((a, b) => a.order - b.order).at(-1) ?? ends[0];
  const stops = nodes.filter((n) => n.type === 'store' || n.type === 'external').map((n) => n.tools[0] ? ctx.toolName(n.tools[0]) : n.label);
  const purpose = clean([trigger?.label, [...new Set(stops)].slice(0, 2).join(' / ') || nodes.find((n) => n.type === 'server' && n !== trigger)?.label, mainEnd?.label].filter(Boolean).join(' → '));
  const explanation = explain(ctx, nodes, edges, name, tools, p.folded);

  const shown: EntryRef[] = p.repEntry ? [p.repEntry.ref, ...p.stitched.map((e) => e.ref)] : [];
  const flow: MainFlow = {
    id: p.id,
    key: p.key,
    cycle: p.cycle,
    name,
    generatedName: name,
    purpose: purpose || name,
    nodes,
    edges,
    tools,
    confidence: { percent, label: percent >= 90 ? 'Fully traced' : percent >= 60 ? 'Mostly traced' : 'Partially traced' },
    partial: false,
    problems: [],
    explanation,
    entries: { shown, folded: p.folded.map((e) => e.ref) },
    sourceFlowIds: p.sourceFlowIds,
    score: scoreOf(p.cycle, nodes, p.folded.length + shown.length),
  };
  flow.problems = validate(flow);
  return flow;
}

function scoreOf(cycle: CycleType, nodes: AutoNode[], entries: number): number {
  const types = new Set(nodes.map((n) => n.type));
  return entries * 2 + types.size * 3 + Math.min(nodes.length, 30) + nodes.filter((n) => n.type === 'decision').length * 2 + (types.has('trigger') && nodes[0]?.lane === 'frontend' ? 8 : 0) + (cycle === 'core' ? 4 : 0) - nodes.filter((n) => n.type === 'unknown').length * 3;
}

function explain(ctx: ChartCtx, nodes: AutoNode[], edges: AutoEdge[], name: string, tools: MainFlow['tools'], folded: Entry[]): FlowExplanation {
  const item = (text: string, n?: AutoNode, extra: AutoEvidence[] = []): ExplanationItem => ({ text: clean(text, n ? `${n.label} (${cite(n.evidence[0])}).` : ''), cites: [...(n ? n.evidence.slice(0, 1) : []), ...extra], nodeId: n?.id });
  const mainPath = [...nodes].filter((n) => n.type !== 'group').sort((a, b) => a.order - b.order);
  const trigger = nodes.find((n) => n.type === 'trigger');
  const handler = nodes.find((n) => n.type === 'server' && n.file !== trigger?.file) ?? nodes.find((n) => n.type === 'server');
  const stores = nodes.filter((n) => n.type === 'store');
  const externals = nodes.filter((n) => n.type === 'external');
  const end = [...nodes].filter((n) => n.type === 'end' && n.order < 500).sort((a, b) => a.order - b.order).at(-1) ?? nodes.find((n) => n.type === 'end');
  const what: ExplanationItem[] = [];
  if (trigger) what.push(item(`${name}: it starts with ${trigger.label} (${cite(trigger.evidence[0])}).`, trigger));
  if (handler) {
    const via = [...new Set([...stores, ...externals].map((n) => (n.tools[0] ? ctx.toolName(n.tools[0]) : n.label)))];
    what.push(item(`${handler.label} runs at ${cite(handler.evidence[0])}${via.length ? ` and uses ${via.join(', ')}` : ''}.`, handler));
  }
  if (end) what.push(item(`It ends with ${end.label} (${cite(end.evidence[0])}).`, end));

  // A step reads "label — detail" unless the detail already says the label.
  const steps = mainPath.map((n, i) => item(n.detail && n.detail.includes(n.label.replace(/\?$/, '')) ? `${i + 1}. ${n.detail}` : `${i + 1}. ${n.label} — ${n.detail ?? cite(n.evidence[0])}`, n));

  const inputs: ExplanationItem[] = [];
  for (const n of nodes) if ((n.type === 'request' || n.type === 'trigger' || (n.type === 'server' && n.entryKey)) && n.dataIn) inputs.push(item(`${n.label}: ${n.dataIn} (${cite(n.evidence[0])}).`, n));
  for (const e of edges) if (e.label && e.kind === 'sequence' && byIdOf(nodes, e.target)?.entryKey) inputs.push(item(`Sent: ${e.label} (${cite(e.evidence[0])}).`, byIdOf(nodes, e.target)));
  const stored = stores.map((n) => item(`${n.tools[0] ? ctx.toolName(n.tools[0]) : n.label}: ${n.dataIn ?? n.label} (${cite(n.evidence[0])}).`, n));
  const returned = nodes.filter((n) => n.dataOut && (n.type === 'end' || /resolves|response/i.test(n.label))).map((n) => item(`${n.label}${n.dataOut && !n.label.includes(n.dataOut) ? `: ${n.dataOut}` : ''} (${cite(n.evidence[0])}).`, n));

  const decisions = nodes
    .filter((n) => n.type === 'decision')
    .map((n) => {
      const exits = edges.filter((e) => e.source === n.id && (e.kind === 'false' || e.kind === 'true' || e.kind === 'error'));
      const failure = exits.map((e) => byIdOf(nodes, e.target)).find((t) => t?.type === 'end');
      return item(`${n.label} — ${n.detail ?? cite(n.evidence[0])}${failure ? ` The caller sees: ${failure.label}.` : ''}`, n, failure ? failure.evidence.slice(0, 1) : []);
    });
  if (!decisions.length) decisions.push({ text: 'No error handling found in the traced code.', cites: [] });

  const toolItems = tools.map((t) => {
    const n = nodes.find((x) => x.tools.includes(t.id))!;
    return item(`${t.name} — ${n.dataIn ?? n.label} (${cite(n.evidence[0])}).`, n);
  });
  const foldedItems = folded.map((e) => ({ text: `${e.ref.label} (${e.ref.file}${e.ref.line ? `:${e.ref.line}` : ''})`, cites: [{ file: e.ref.file, line: e.ref.line }] }));
  const counted = nodes.filter((n) => n.type !== 'group' && n.type !== 'jump');
  const unknown = counted.filter((n) => n.confidence === 'unknown').map((n) => item(`${n.label}: ${n.detail ?? 'not traced'}`, n));
  const traced = counted.length - unknown.length;
  return {
    what,
    steps,
    data: { inputs: dedupe(inputs), stored, returned },
    decisions,
    tools: toolItems,
    folded: foldedItems,
    confidence: { percent: counted.length ? Math.round((traced / counted.length) * 100) : 0, traced, total: counted.length, unknown },
  };
}

const byIdOf = (nodes: AutoNode[], id: string) => nodes.find((n) => n.id === id);
const dedupe = (items: ExplanationItem[]) => [...new Map(items.map((i) => [i.text, i])).values()];

export function validate(f: MainFlow): string[] {
  const problems: string[] = [];
  const triggers = f.nodes.filter((n) => n.type === 'trigger');
  if (triggers.length !== 1) problems.push(`${triggers.length} triggers (expected exactly one)`);
  if (!f.nodes.some((n) => n.type === 'end')) problems.push('no end node');
  if (triggers[0]) {
    const out = new Map<string, string[]>();
    for (const e of f.edges) out.set(e.source, [...(out.get(e.source) ?? []), e.target]);
    const seen = new Set([triggers[0].id]);
    const stack = [triggers[0].id];
    while (stack.length) for (const t of out.get(stack.pop()!) ?? []) if (!seen.has(t)) (seen.add(t), stack.push(t));
    const unreachable = f.nodes.filter((n) => !seen.has(n.id));
    if (unreachable.length) problems.push(`${unreachable.length} node(s) not reachable from the trigger`);
  }
  for (const n of f.nodes) {
    if (!n.evidence.length || !n.evidence[0].file) problems.push(`node "${n.label}" has no evidence`);
    if ((n.type === 'ui' || n.lane === 'frontend') && BACKEND_PATH.test(n.file) && !FRONTEND_PATH.test(n.file)) problems.push(`backend file ${n.file} in the frontend lane (${n.type} "${n.label}")`);
  }
  for (const e of f.edges) if (!e.evidence.length) problems.push(`edge ${e.id} has no evidence`);
  for (const t of [f.name, f.purpose, ...f.nodes.map((n) => n.label)]) if (isBanned(t)) problems.push(`banned wording: "${t}"`);
  const layout = layoutFlow(f.nodes, f.edges, DEFAULT_LAYOUT);
  problems.push(...layoutProblems(layout));
  return problems;
}

/* ================================================================== selection */

/** Up to four flows with distinct purposes: one per cycle type in order, then the strongest others. Never padded. */
function chooseFlows(pool: MainFlow[]): string[] {
  const out: string[] = [];
  for (const cycle of ['access', 'core', 'data', 'background', 'startup'] as CycleType[]) {
    const best = pool.find((f) => f.cycle === cycle);
    if (best && out.length < MAX_FLOWS) out.push(best.key);
  }
  for (const f of pool) {
    if (out.length >= MAX_FLOWS) break;
    if (out.includes(f.key)) continue;
    // Only flows that stand on their own: several steps and more than one endpoint, or a rich single one.
    const steps = f.nodes.filter((n) => n.type !== 'group').length;
    if (steps >= 6 && (f.entries.shown.length + f.entries.folded.length >= 2 || steps >= 9)) out.push(f.key);
  }
  return out;
}

function ensureUniqueNames(pool: MainFlow[]) {
  const seen = new Map<string, number>();
  for (const f of pool) {
    const n = seen.get(f.name) ?? 0;
    seen.set(f.name, n + 1);
    if (n > 0) {
      const res = f.key.split('|')[0].replace(/^(access|background)$/, '');
      f.name = f.generatedName = `${f.name} (${res && res !== 'access' && res !== 'background' ? res : f.entries.shown[0]?.label ?? n + 1})`;
    }
  }
}

/** A step that is the entry of another selected flow continues there: a "jump to flow" node. */
function addJumps(pool: MainFlow[], selected: string[]) {
  const chosen = pool.filter((f) => selected.includes(f.key));
  for (const f of chosen)
    for (const n of [...f.nodes])
      for (const other of chosen) {
        if (other === f || !n.entryKey || !other.entries.shown.some((e) => e.key === n.entryKey)) continue;
        const jid = `${f.id}:jump-${other.id}`;
        if (f.nodes.some((x) => x.id === jid)) continue;
        f.nodes.push({ id: jid, type: 'jump', label: `Continues in “${other.name}”`, lane: n.lane, file: n.file, line: n.line, evidence: n.evidence.slice(0, 1), tools: [], confidence: 'confirmed', order: 900, jumpTo: other.key });
        f.edges.push({ id: `${jid}:e`, source: n.id, target: jid, kind: 'jump', evidence: n.evidence.slice(0, 1) });
      }
}

/* ================================================================== fallbacks */

/** UI events that call something the server code does not handle (client-only apps). */
function buildClientFlow(ctx: ChartCtx, input: AutomationInput, entries: Entry[]): { flow: MainFlow; entries: Entry[] } | null {
  const { facts } = input;
  const triggers = facts.uiTriggers.filter((t) => !/\.test\.|\/test\//.test(t.file));
  if (!triggers.length) return null;
  const list: Entry[] = [];
  const flows: { entry: Entry; nodes: AutoNode[]; edges: AutoEdge[] }[] = [];
  for (const t of triggers.slice(0, 40)) {
    const call = facts.httpCalls.find((h) => h.file === t.target.file && h.line === t.target.line);
    const key = `ui|${t.file}:${t.trigger.line}`;
    const label = fixActionLabel(t.trigger.kind === 'click' ? `Click “${t.label ?? 'button'}”` : t.trigger.kind === 'submit' ? `Submit “${t.label ?? 'form'}”` : t.trigger.kind === 'load' ? `${t.component ?? 'Component'} loads` : `${t.component ?? base(t.file)} calls ${t.callee}()`, t.component);
    const entry: Entry = { ref: { key, label, kind: 'ui', file: t.file, line: t.trigger.line }, flows: [], cycle: 'data', mutating: t.trigger.kind === 'click' || t.trigger.kind === 'submit', resource: t.component ?? base(t.file), capKey: key };
    list.push(entry);
    const id = stableId('mf_', key);
    const nodes: AutoNode[] = [];
    const edges: AutoEdge[] = [];
    const n = (x: Omit<AutoNode, 'id' | 'order'>) => {
      const nn = { ...x, id: `${id}:n${nodes.length + 1}`, order: nodes.length + 1 };
      nodes.push(nn);
      return nn.id;
    };
    const ev = (file: string, line: number, snippet: string): AutoEvidence[] => [{ file, line, snippet }];
    const a = n({ type: 'trigger', label, lane: 'frontend', file: t.file, line: t.trigger.line, evidence: ev(t.file, t.trigger.line, t.trigger.snippet), tools: [], confidence: 'confirmed', detail: `${label} (${t.file}:${t.trigger.line}).` });
    const h = n({ type: 'ui', label: t.handler ? `${t.handler.name}()` : 'Event handler', lane: 'frontend', file: t.file, line: t.line, evidence: ev(t.file, t.line, t.snippet), tools: [], confidence: 'confirmed', detail: `Calls ${t.callee}() (${t.file}:${t.line}).` });
    const target = call?.host ?? (call?.envVar ? `URL in ${call.envVar}` : call?.url);
    const r = n({ type: call && (call.host || call.url) ? 'external' : 'unknown', label: target ? `${call?.method ?? 'GET'} ${target}` : 'Request target unknown', lane: 'external', file: call?.file ?? t.target.file, line: call?.line ?? t.target.line, evidence: ev(call?.file ?? t.target.file, call?.line ?? t.target.line, call?.snippet ?? ''), tools: [], confidence: target ? 'confirmed' : 'unknown', detail: call ? `${call.client} ${call.method ?? ''} ${call.url ?? '(URL built at runtime)'} (${call.file}:${call.line}).` : undefined });
    edges.push({ id: `${id}:e1`, source: a, target: h, kind: 'sequence', evidence: nodes[1].evidence });
    edges.push({ id: `${id}:e2`, source: h, target: r, kind: 'sequence', evidence: nodes[2].evidence });
    let prev = r;
    const after = t.after.length ? t.after : [];
    for (const x of after.slice(0, 3)) {
      const label2 = x.kind === 'navigate' ? `Navigate · ${x.detail}` : x.kind === 'state' ? `State · ${x.detail}` : x.kind === 'reload' ? `Refetch · ${x.detail}` : 'Notification';
      const s = n({ type: 'ui', label: label2, lane: 'frontend', file: t.file, line: x.line, evidence: ev(t.file, x.line, x.snippet), tools: [], confidence: 'confirmed', detail: `${label2} (${t.file}:${x.line}).` });
      edges.push({ id: `${id}:e${edges.length + 1}`, source: prev, target: s, kind: 'sequence', evidence: nodes.at(-1)!.evidence });
      prev = s;
    }
    const last = nodes.find((x) => x.id === prev)!;
    if (last.type === 'ui') last.type = 'end';
    else {
      const e = n({ type: 'end', label: 'End of traced path', lane: last.lane, file: last.file, line: last.line, evidence: last.evidence, tools: [], confidence: 'strong', detail: `The traced path ends at ${cite(last.evidence[0])}.` });
      edges.push({ id: `${id}:e${edges.length + 1}`, source: prev, target: e, kind: last.type === 'unknown' ? 'unknown' : 'sequence', evidence: last.evidence });
    }
    flows.push({ entry, nodes, edges });
  }
  // One flow per component group: the richest trigger, the others folded.
  flows.sort((a, b) => b.nodes.length - a.nodes.length || (a.entry.ref.key < b.entry.ref.key ? -1 : 1));
  const best = flows[0];
  if (!best) return null;
  const folded = list.filter((e) => e !== best.entry && e.resource === best.entry.resource);
  if (folded.length) {
    const g: AutoNode = { id: `${best.nodes[0].id}-g`, type: 'group', label: `+${folded.length} similar trigger${folded.length === 1 ? '' : 's'}`, lane: 'frontend', file: folded[0].ref.file, line: folded[0].ref.line, evidence: folded.slice(0, 6).map((e) => ({ file: e.ref.file, line: e.ref.line, detail: e.ref.label })), tools: [], confidence: 'confirmed', order: 600, members: folded.map((e) => ({ label: e.ref.label, file: e.ref.file, line: e.ref.line })) };
    best.nodes.push(g);
    best.edges.push({ id: `${g.id}:e`, source: best.nodes[0].id, target: g.id, kind: 'group', evidence: g.evidence.slice(0, 1) });
  }
  const flow = finishFlow(ctx, { id: stableId('mf_', best.entry.ref.key), key: best.entry.ref.key, cycle: 'data', nodes: best.nodes, edges: best.edges, repEntry: best.entry, folded, stitched: [], sourceFlowIds: [], name: capitalize(clean(`User ${verbPhrase(best.entry.ref.label.replace(/^(Click|Submit)\s*/, '')) ?? 'triggers a request'}`)) });
  void entries;
  return { flow, entries: list };
}

/**
 * "How the app starts" (or how a command / script runs): the real import chain from the entry
 * point — entry → modules it loads → their data and external calls. Used when no request, job or
 * UI flow can be traced, so no project is ever empty.
 */
function buildEntryChainFlow(ctx: ChartCtx, input: AutomationInput, projectType: ProjectType): { flow: MainFlow; entry: Entry; kind: NonNullable<Diagnostics['fallback']>['kind']; reason: string } | null {
  const { graph, facts } = input;
  const files = graph.nodes.filter((n) => n.type !== 'external' && n.type !== 'unresolved');
  if (!files.length) return null;
  const analyzed = new Set(files.filter((n) => n.analyzed || TRACED_LANGUAGES.has(n.language)).map((n) => n.id));
  const entryIds = graph.summary.entryPoints.map((e) => e.id).filter((id) => files.some((f) => f.id === id));
  const cliFile = graph.edges.find((e) => e.external && CLI_PACKAGES.has(e.target.replace(/^ext:/, '')))?.source;
  const start =
    (projectType === 'cli' && cliFile) ||
    entryIds.find((id) => analyzed.has(id)) ||
    files.filter((f) => MAIN_FILE.test(f.id)).sort((a, b) => a.id.split('/').length - b.id.split('/').length || (a.id < b.id ? -1 : 1))[0]?.id ||
    [...files].sort((a, b) => (a.id < b.id ? -1 : 1))[0].id;
  const kind: 'startup' | 'command' | 'script' | 'unsupported' = !analyzed.has(start) ? 'unsupported' : projectType === 'cli' ? 'command' : projectType === 'scripts' ? 'script' : 'startup';
  const key = `${kind}|${start}`;
  const id = stableId('mf_', key);
  const nodes: AutoNode[] = [];
  const edges: AutoEdge[] = [];
  const node = (x: Omit<AutoNode, 'id' | 'order'>) => {
    const nn = { ...x, id: `${id}:n${nodes.length + 1}`, order: nodes.length + 1 };
    nodes.push(nn);
    return nn;
  };
  const entryReason = graph.summary.entryPoints.find((e) => e.id === start);
  // The command's name is the package's own name when a manifest declares one.
  const manifest = [...facts.manifests].filter((m) => start.startsWith(m.dir ? `${m.dir}/` : '')).sort((a, b) => b.dir.length - a.dir.length)[0];
  const command = manifest?.name?.replace(/^@[^/]+\//, '') ?? base(start).replace(/\.\w+$/, '');
  const lane: AutoLane = projectType === 'static-frontend' ? 'frontend' : 'backend';
  const trigger = node({
    type: 'trigger',
    label: kind === 'command' ? `Run the ${command} command` : kind === 'script' ? `Run ${base(start)}` : `Start ${base(start)}`,
    lane,
    file: start,
    line: 1,
    evidence: [{ file: start, line: 1, detail: entryReason ? `Entry point (${(entryReason as { reasons?: string[] }).reasons?.join(', ') ?? 'declared'})` : 'Entry file' }],
    tools: [],
    confidence: 'confirmed',
    detail: `The program starts in ${start}${entryReason ? ' (declared as an entry point)' : ''}.`,
  });
  if (kind === 'unsupported') {
    const lang = files.find((f) => f.id === start)?.language ?? 'this language';
    const u = node({ type: 'unknown', label: `Not traced: ${lang} is not analyzed`, lane: 'backend', file: start, line: 1, evidence: [{ file: start, line: 1 }], tools: [], confidence: 'unknown', detail: `CodePilot reads imports and calls in JavaScript, TypeScript and Python; ${lang} files are listed but their code is not traced.` });
    const e = node({ type: 'end', label: 'Stops here', lane: 'backend', file: start, line: 1, evidence: [{ file: start, line: 1 }], tools: [], confidence: 'unknown', detail: 'Nothing beyond the entry file can be traced.' });
    edges.push({ id: `${id}:e1`, source: trigger.id, target: u.id, kind: 'unknown', evidence: u.evidence });
    edges.push({ id: `${id}:e2`, source: u.id, target: e.id, kind: 'unknown', evidence: e.evidence });
  } else {
    // Breadth-first over resolved imports, in import-line order: at most 3 levels and 10 modules.
    const byFile = new Map<string, AutoNode>([[start, trigger]]);
    let frontier = [start];
    for (let depth = 0; depth < 3 && frontier.length && nodes.length < 11; depth++) {
      const next: string[] = [];
      for (const f of frontier) {
        const out = graph.edges.filter((e) => e.source === f && e.resolved && !e.external && !e.typeOnly).sort((a, b) => a.line - b.line);
        for (const e of out) {
          if (byFile.has(e.target) || nodes.length >= 11) continue;
          const m = node({ type: 'server', label: `Loads ${base(e.target)}`, lane, file: e.target, line: 1, evidence: [{ file: e.source, line: e.line, detail: `Imports ${e.target}` }], tools: [], confidence: 'confirmed', detail: `${base(e.source)} imports ${e.target} (${e.source}:${e.line}).` });
          byFile.set(e.target, m);
          edges.push({ id: `${id}:e${edges.length + 1}`, source: byFile.get(f)!.id, target: m.id, kind: 'sequence', evidence: m.evidence });
          next.push(e.target);
        }
      }
      frontier = next;
    }
    // Data and external calls made by the loaded modules.
    for (const [file, owner] of byFile) {
      for (const c of facts.calls.filter((x) => x.file === file).slice(0, 2)) {
        const toolNode = ctx.arch.nodes.find((n) => n.id === `tool:${c.tool}`) ?? ctx.arch.nodes.find((n) => n.id.endsWith(c.tool));
        const s = node({ type: c.op === 'http' ? 'external' : 'store', label: `${toolNode?.name ?? c.tool} · ${c.callee}()`, lane: c.op === 'http' ? 'external' : 'data', file: c.file, line: c.line, evidence: [{ file: c.file, line: c.line, snippet: c.snippet }], tools: toolNode ? [toolNode.id] : [], confidence: 'confirmed', detail: `${c.callee}() (${c.file}:${c.line}).`, dataIn: c.arg });
        edges.push({ id: `${id}:e${edges.length + 1}`, source: owner.id, target: s.id, kind: 'sequence', evidence: s.evidence });
      }
    }
    const leaves = nodes.filter((n) => !edges.some((e) => e.source === n.id));
    const end = node({ type: 'end', label: kind === 'command' ? 'Command finishes (end of traced chain)' : kind === 'script' ? 'Script finishes (end of traced chain)' : `Initialized: ${byFile.size} module${byFile.size === 1 ? '' : 's'} loaded`, lane, file: start, line: 1, evidence: trigger.evidence, tools: [], confidence: 'strong', detail: `End of the traced import chain from ${start}; what the program does at run time beyond this is not traced.` });
    for (const l of leaves.slice(0, 4)) edges.push({ id: `${id}:e${edges.length + 1}`, source: l.id, target: end.id, kind: 'sequence', evidence: end.evidence });
  }
  const entry: Entry = { ref: { key, label: trigger.label, kind: kind === 'command' ? 'command' : 'startup', file: start, line: 1 }, flows: [], cycle: 'startup', mutating: false, resource: start, capKey: key };
  const flow = finishFlow(ctx, { id, key, cycle: 'startup', nodes, edges, repEntry: entry, folded: [], stitched: [], sourceFlowIds: [], name: kind === 'command' ? `How the ${command} command runs` : kind === 'script' ? `How ${base(start)} runs` : 'How the app starts' });
  const reason =
    kind === 'unsupported'
      ? `${files.find((f) => f.id === start)?.language ?? 'This'} code is not traced by CodePilot, so only the entry file is shown.`
      : facts.routes.length
        ? 'Routes were found but none could be traced to a flow; showing how the program starts instead.'
        : `No HTTP routes, UI event handlers, queue consumers or schedules were recognized, so this shows how ${kind === 'command' ? 'the command runs' : 'the program starts'}, from its real import chain.`;
  return { flow, entry, kind, reason };
}
