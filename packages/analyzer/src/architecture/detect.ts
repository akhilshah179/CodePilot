import type { DependencyGraph } from '../types.ts';
import { CATALOG_BY_ID, imageRepository, imageTag, toolForHelmChart, toolForImage, toolForScheme, toolForTerraform, toolsForEnv, toolsForModule, toolsForPackage, type CatalogEntry } from './catalog.ts';
import { EvidenceStore, FileUses, stableId } from './evidence.ts';
import { buildFindings } from './findings.ts';
import { buildSystemMap } from './system.ts';
import { buildTechnologyIntel } from './intelligence.ts';
import { opLabel, opText } from './ops.ts';
import type { AppInfo, AppKind, DetectorContext, EdgeDraft, NodeDraft } from './context.ts';
import { buildFlows } from './flows.ts';
import { bestRoutes, FileGraph } from './graph.ts';
import { SymbolIndex, type Scope } from './symbols.ts';
import { dirOf, isSecretKey, joinPath } from './text.ts';
import {
  ARCH_DETECTOR_VERSION,
  LAYERS,
  type ArchEdge,
  type ArchNode,
  type ArchNodeKind,
  type Architecture,
  type ArchitectureFacts,
  type BlastRadius,
  type CallFact,
  type ComposeService,
  type Confidence,
  type EdgeLabel,
  type EvidenceRef,
  type Layer,
  type ManifestDependency,
  type ManifestFact,
  type OpKind,
  type Overlay,
  type RouteFact,
  type ToolCategory,
} from './types.ts';

/**
 * Stage 2 of architecture detection. Pure: facts + dependency graph → architecture.
 *
 * Rules of the road:
 *  - A node exists only if some evidence names it; its confidence reflects the strongest kind.
 *  - An edge exists only if evidence ties both ends together (a call in a file that belongs to
 *    the source, a config line naming the target, a Compose `depends_on`…). Two technologies
 *    being commonly used together is never a reason for an edge.
 *  - Anything inferred says so (confidence + reason), and anything undeterminable is listed as a
 *    limitation instead of being guessed.
 */

export interface DetectInput {
  facts: ArchitectureFacts;
  graph: DependencyGraph;
  repository?: { commitSha?: string; branch?: string; name?: string };
}

const RANK: Record<Confidence, number> = { confirmed: 3, strong: 2, possible: 1 };
export const maxConfidence = (a: Confidence, b: Confidence): Confidence => (RANK[a] >= RANK[b] ? a : b);

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:__tests__|__mocks__|tests?|spec|e2e|cypress|playwright)\/|(?:^|\/)test_[^/]+\.py$|_test\.(?:py|go)$|(?:^|\/)conftest\.py$|Test\.java$|_spec\.rb$/;
const SERVER_CATEGORIES = new Set(['database', 'cache', 'queue', 'search', 'storage']);
const TEST_DOCKERFILE = /playwright|cypress|(?:^|[/.-])(?:e2e|tests?)(?:[/.-]|$)/i;
const TEST_COMPOSE = /(?:^|[/.-])(?:tests?|e2e|ci)(?:[/.-][\w.-]*)?\.ya?ml$|(?:^|\/)(?:tests?|e2e)\//i;
const MIGRATION_TOOLS = new Set(['alembic']);
const MIGRATION_FILE = /(?:^|\/)(?:migrations|alembic|db\/migrate)\//;
const SERVER_TOOLS = new Set(['nextjs', 'nuxt', 'sveltekit', 'remix', 'astro', 'express', 'fastify', 'koa', 'hono', 'nestjs', 'elysia', 'fastapi', 'flask', 'django', 'starlette', 'gin', 'echo', 'fiber', 'chi', 'gorilla-mux', 'spring-boot', 'rails', 'sinatra', 'laravel', 'symfony', 'actix', 'axum', 'aspnet']);
const UI_TOOLS = new Set(['react', 'vue', 'svelte', 'angular', 'solid', 'preact', 'react-native']);
const WORKER_CMD = /\bcelery\b[^|;&]*\b(?:worker|beat)\b|\brq\s+worker\b|\bdramatiq\b|\barq\b|\bsidekiq\b|\bhuey_consumer\b/i;
const CLIENT_SCRIPT = /\b(?:vite|react-scripts|webpack(?:-dev-server)?\s+serve|ng\s+(?:serve|build)|expo|parcel|astro|nuxt|next|svelte-kit|remix|vue-cli-service)\b/;
const RELATIONAL = new Set(['postgresql', 'mysql', 'sqlite', 'aws-rds', 'cloud-sql', 'planetscale', 'sql-database']);
const LOCAL_HOSTS = /^(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|::1|example\.(?:com|org)|[\w-]+\.local|host\.docker\.internal)$/;
const KNOWN_HOSTS: [RegExp, string][] = [
  [/(^|\.)stripe\.com$/, 'stripe'],
  [/(^|\.)openai\.com$/, 'openai'],
  [/(^|\.)anthropic\.com$/, 'anthropic'],
  [/(^|\.)sendgrid\.(?:com|net)$/, 'sendgrid'],
  [/(^|\.)twilio\.com$/, 'twilio'],
  [/(^|\.)slack\.com$/, 'slack'],
  [/(^|\.)resend\.com$/, 'resend'],
  [/(^|\.)algolia\.net$/, 'algolia'],
  [/(^|\.)sentry\.io$/, 'sentry'],
  [/(^|\.)supabase\.co$/, 'supabase'],
  [/(^|\.)generativelanguage\.googleapis\.com$/, 'gemini'],
];

const TEST_CMD = /\b(?:npm\s+(?:run\s+)?test|yarn\s+test|pnpm\s+(?:run\s+)?test|vitest|jest|mocha|pytest|python\s+-m\s+pytest|tox|go\s+test|cargo\s+test|mvn\s+(?:-\S+\s+)*(?:test|verify)|gradle\w*\s+test|rspec|bundle\s+exec\s+rspec|phpunit|dotnet\s+test|playwright\s+test|cypress\s+run)\b/;
const DEPLOY: [RegExp, string][] = [
  [/\bvercel\b|amondnet\/vercel-action/, 'vercel'],
  [/\bflyctl\b|superfly\/flyctl-actions/, 'flyio'],
  [/\bnetlify\s+deploy\b|nwtgck\/actions-netlify|netlify\/actions/, 'netlify'],
  [/\bkubectl\s+(?:apply|set\s+image|rollout)|azure\/k8s-deploy/, 'kubernetes'],
  [/\bhelm\s+(?:upgrade|install)\b/, 'helm'],
  [/\bterraform\s+apply\b|hashicorp\/setup-terraform/, 'terraform'],
  [/\b(?:serverless|sls)\s+deploy\b|serverless\/github-action/, 'serverless-framework'],
  [/\baws\s+ecs\b|amazon-ecs-deploy-task-definition/, 'aws-ecs'],
  [/\baws\s+lambda\s+update-function|appleboy\/lambda-action/, 'aws-lambda'],
  [/\bgcloud\s+run\s+deploy\b|google-github-actions\/deploy-cloudrun/, 'cloud-run'],
  [/\bgcloud\s+app\s+deploy\b|google-github-actions\/deploy-appengine/, 'gae'],
  [/\bheroku\b|akhileshns\/heroku-deploy/, 'heroku'],
  [/\brailway\s+up\b/, 'railway'],
  [/\bfirebase\s+deploy\b|FirebaseExtended\/action-hosting-deploy/, 'firebase-hosting'],
  [/\brender\b.*deploy|render-deploy/, 'render'],
  [/\bwrangler\s+(?:deploy|publish)\b|cloudflare\/wrangler-action/, 'cloudflare-workers'],
];
const DOCKER_BUILD = /\bdocker\s+(?:buildx\s+)?build\b|docker\/build-push-action|\bdocker\s+compose\s+build\b/;
const REGISTRY_PUSH = /\bdocker\s+push\b|docker\/login-action|docker\/build-push-action[\s\S]*push|aws-actions\/amazon-ecr-login/;

export class Detector implements DetectorContext {
  readonly ev = new EvidenceStore();
  readonly nodes = new Map<string, NodeDraft>();
  readonly edges = new Map<string, EdgeDraft>();
  readonly apps: AppInfo[] = [];
  readonly fileGraph: FileGraph;
  readonly limitations: string[] = [];
  /** file → app ids */
  private readonly appCache = new Map<string, string[]>();
  private reachSets: Map<string, Set<string>> | null = null;
  readonly fileSet: Set<string>;
  readonly routesByApp = new Map<string, RouteFact[]>();
  /** Compose service name → node id, for wiring by hostname. */
  readonly serviceNode = new Map<string, string>();
  /** Tool id → declared compose/k8s instances (service names). */
  private readonly instances = new Map<string, string[]>();

  readonly symbols: SymbolIndex;
  private readonly reachCache = new Map<string, Set<string> | null>();

  constructor(
    readonly facts: ArchitectureFacts,
    readonly graph: DependencyGraph,
  ) {
    this.fileGraph = new FileGraph(graph, facts.internalImports);
    this.symbols = new SymbolIndex(facts, graph.edges);
    this.fileSet = new Set(graph.nodes.filter((n) => n.type !== 'external' && n.type !== 'unresolved').map((n) => n.id));
  }

  // --- Drafting helpers -----------------------------------------------------------------------------------------------

  e(ref: EvidenceRef): string {
    return this.ev.add(ref);
  }

  node(id: string, init: Omit<NodeDraft, 'id' | 'hosts' | 'roles' | 'reasons' | 'evidence' | 'files' | 'badges' | 'ops'> & Partial<NodeDraft>): NodeDraft {
    let n = this.nodes.get(id);
    if (!n) {
      n = { hosts: new Set(), roles: [], reasons: [], evidence: new Set(), files: new FileUses(), badges: [], ops: new Map(), ...init, id };
      this.nodes.set(id, n);
    } else {
      n.confidence = maxConfidence(n.confidence, init.confidence);
    }
    return n;
  }

  toolNode(tool: CatalogEntry, confidence: Confidence, id = `tool:${tool.id}`, name = tool.name): NodeDraft {
    return this.node(id, {
      kind: 'tool',
      name,
      category: tool.category,
      layer: tool.layer,
      display: tool.display ?? 'node',
      confidence,
      description: tool.description,
      catalog: tool.id,
    });
  }

  edge(source: string, target: string, label: EdgeLabel, overlays: Overlay[], confidence: Confidence, evidence: string[], reason: string, isAsync = false): EdgeDraft | null {
    if (source === target) return null;
    const key = `${source}->${target}`;
    let e = this.edges.get(key);
    if (!e) {
      e = { id: stableId('edge_', key), source, target, labels: new Set(), overlays: new Set(), confidence, async: isAsync, evidence: new Set(), reasons: [] };
      this.edges.set(key, e);
    }
    e.labels.add(label);
    for (const o of overlays) e.overlays.add(o);
    e.confidence = maxConfidence(e.confidence, confidence);
    e.async ||= isAsync;
    for (const id of evidence) e.evidence.add(id);
    if (reason && !e.reasons.includes(reason)) e.reasons.push(reason);
    return e;
  }

  appById(id: string): AppInfo | undefined {
    return this.apps.find((a) => a.id === id);
  }

  // --- File → app assignment -------------------------------------------------------------------------------------------

  /** Apps a file belongs to: longest app root, disambiguated by entry closures; otherwise apps that import it. */
  appsOf(file: string): string[] {
    const hit = this.appCache.get(file);
    if (hit) return hit;
    if (TEST_FILE.test(file)) {
      this.appCache.set(file, []);
      return [];
    }
    let best = -1;
    let candidates: AppInfo[] = [];
    for (const a of this.apps) {
      if (a.kind === 'client' && a.synthesized) continue;
      const inRoot = a.root === '' || file === a.root || file.startsWith(a.root + '/');
      if (!inRoot) continue;
      if (a.root.length > best) {
        best = a.root.length;
        candidates = [a];
      } else if (a.root.length === best) candidates.push(a);
    }
    let result: string[];
    if (candidates.length <= 1) result = candidates.map((a) => a.id);
    else {
      const inClosure = candidates.filter((a) => a.closure?.has(file));
      if (inClosure.length) result = inClosure.map((a) => a.id);
      // No entry point was traced for any of them: the code is shared by all.
      else if (candidates.every((a) => !a.closure)) result = candidates.map((a) => a.id);
      // Some entries were traced and none reaches this file: attributing it would be a guess.
      else result = [];
    }
    if (!result.length && !candidates.length) {
      // Shared library code outside every app root: attribute to the apps that import it.
      if (!this.reachSets) {
        this.reachSets = new Map();
        for (const a of this.apps) {
          const own = [...this.fileSet].filter((f) => a.root === '' || f.startsWith(a.root + '/'));
          this.reachSets.set(a.id, this.fileGraph.closure(a.closure ? [...a.closure] : own));
        }
      }
      result = this.apps.filter((a) => this.reachSets!.get(a.id)?.has(file)).map((a) => a.id);
    }
    this.appCache.set(file, result);
    return result;
  }

  /**
   * Call sites (`file#line`) a process can actually reach, for apps that share their code with
   * other processes (an API and its worker built from one directory). Roots are what the process
   * runs: route handlers for servers, tasks and consumers for workers, plus module-level code of
   * its entry file. Null when not applicable (the whole file set belongs to the app).
   */
  reachable(appId: string): Set<string> | null {
    if (this.reachCache.has(appId)) return this.reachCache.get(appId)!;
    const app = this.appById(appId);
    let result: Set<string> | null = null;
    if (app?.closure && [...app.closure].some((f) => this.symbols.has(f))) {
      const closure = app.closure;
      const roots: Scope[] = [];
      if (app.kind === 'worker') {
        for (const d of this.facts.definitions) {
          if (!closure.has(d.file) || !['task', 'queue-consumer', 'topic-consumer', 'scheduler', 'worker-app'].includes(d.kind)) continue;
          const def = this.symbols.enclosing(d.file, d.line);
          roots.push(def ? this.symbols.scopeOf(def) : { file: d.file, start: d.line, end: d.line + 1 });
        }
      } else {
        for (const r of this.facts.routes) {
          if (closure.has(r.file)) roots.push({ file: r.file, start: r.bodyStart ?? r.line, end: r.bodyEnd ?? r.line, refs: r.refs });
        }
      }
      if (app.entry) roots.push(...this.symbols.moduleScope(app.entry.file));
      const scopes = this.symbols.reach(roots, (f) => closure.has(f));
      result = new Set<string>();
      const inScope = (file: string, line: number) => scopes.some((sc) => sc.file === file && line >= sc.start && line <= sc.end);
      for (const c of this.facts.calls) if (closure.has(c.file) && inScope(c.file, c.line)) result.add(`${c.file}#${c.line}`);
      for (const h of this.facts.httpCalls) if (closure.has(h.file) && inScope(h.file, h.line)) result.add(`${h.file}#${h.line}`);
    }
    this.reachCache.set(appId, result);
    return result;
  }

  /** Whether `appId` reaches a call site; always true for apps without a reach set. */
  reaches(appId: string, file: string, line: number): boolean {
    const r = this.reachable(appId);
    return !r || r.has(`${file}#${line}`);
  }

  // --- Main -----------------------------------------------------------------------------------------------------------------

  run(): void {
    this.buildApps();
    this.detectTools();
    this.infrastructure();
    this.codeEdges();
    this.httpEdges();
    this.queueEdges();
    this.proxyEdges();
    this.composeEdges();
    this.deliveryEdges();
    this.pruneGenericInstances();
    this.securityBadges();
    this.finalizeNodes();
  }

  /** With several Compose instances of one technology, keep the generic node only if something still points at it. */
  private pruneGenericInstances() {
    for (const toolId of this.instances.keys()) {
      const id = `tool:${toolId}`;
      const n = this.nodes.get(id);
      if (!n) continue;
      const connected = [...this.edges.values()].some((e) => e.source === id || e.target === id);
      if (!connected) {
        this.nodes.delete(id);
        continue;
      }
      if (!n.name.includes('instance not determined')) n.name = `${n.name} (instance not determined)`;
      n.reasons.push(`Compose declares several ${CATALOG_BY_ID.get(toolId)?.name} services (${this.instances.get(toolId)!.join(', ')}); some usage could not be tied to one of them.`);
    }
  }

  // --- Apps ----------------------------------------------------------------------------------------------------------------------

  private manifestFor(dir: string) {
    return this.facts.manifests.filter((m) => m.dir === dir);
  }

  /** Resolve a start command to an entry file inside `root`. */
  entryFromCommand(cmd: string, root: string, depth = 0): { file: string } | undefined {
    const inRoot = (rel: string) => joinPath(root, rel.replace(/^\.\//, ''));
    const exists = (p: string | null) => (p && this.fileSet.has(p) ? p : undefined);
    const pyModule = (mod: string) => {
      const parts = mod.split(':')[0].split('.');
      for (let n = parts.length; n > 0; n--) {
        const base = inRoot(parts.slice(0, n).join('/'));
        const hit = exists(base ? base + '.py' : null) ?? exists(base ? base + '/__init__.py' : null);
        if (hit) return hit;
      }
      return undefined;
    };
    let m = /\b(?:uvicorn|gunicorn|hypercorn|daphne|granian)\b(?:\s+-{1,2}[\w-]+(?:[= ](?!\S+:\w+\b)\S+)?)*\s+([\w.]+):\w+/.exec(cmd);
    if (m) return wrap(pyModule(m[1]));
    m = /\bfastapi\s+(?:run|dev)\s+([\w/.-]+\.py)/.exec(cmd);
    if (m) return wrap(exists(inRoot(m[1])));
    m = /\bcelery\s+(?:-A|--app)[= ]?\s*([\w.:]+)/.exec(cmd);
    if (m) return wrap(pyModule(m[1]));
    m = /\bpython\d?(?:\.\d+)?\s+(?:-u\s+)?-m\s+([\w.]+)/.exec(cmd);
    if (m) return wrap(pyModule(m[1]));
    m = /\bpython\d?(?:\.\d+)?\s+(?:-u\s+)?([\w/.-]+\.py)/.exec(cmd);
    if (m) return wrap(exists(inRoot(m[1])));
    m = /\b(?:node|tsx|ts-node|bun|nodemon|deno\s+run)\s+(?:-{1,2}\S+\s+)*([\w/.-]+\.[cm]?[jt]sx?)\b/.exec(cmd);
    if (m) return wrap(exists(inRoot(m[1])));
    m = /\bgo\s+run\s+([\w/.-]+)/.exec(cmd);
    if (m) return wrap(exists(inRoot(m[1])) ?? exists(inRoot(m[1] + '/main.go')));
    m = /\b(?:npm\s+(?:run\s+)?|yarn\s+|pnpm\s+(?:run\s+)?)([\w:-]+)/.exec(cmd);
    if (m && depth < 2) {
      const script = this.manifestFor(root).flatMap((mf) => mf.scripts).find((s) => s.name === m![1]);
      if (script) return this.entryFromCommand(script.command, root, depth + 1);
    }
    return undefined;
    function wrap(file: string | undefined) {
      return file ? { file } : undefined;
    }
  }

  private buildApps() {
    const { facts } = this;
    const used = new Set<string>();
    const slug = (name: string) => {
      let s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';
      for (let k = 2; used.has(s); k++) s = `${s.replace(/-\d+$/, '')}-${k}`;
      used.add(s);
      return s;
    };
    const dockerfiles = new Map(facts.infra.dockerfiles.map((d) => [d.file, d]));

    // 1. Compose services built from this repository. Test compose files describe test setups, not the system.
    const composeByName = new Map<string, AppInfo>();
    for (const cf of facts.infra.compose.filter((c) => TEST_COMPOSE.test(c.file))) {
      this.limitations.push(`${cf.file} is a test setup (${cf.services.length} services) and is not part of the architecture shown.`);
    }
    facts.infra.compose = facts.infra.compose.filter((c) => !TEST_COMPOSE.test(c.file));
    for (const cf of facts.infra.compose) {
      for (const svc of cf.services) {
        if (!svc.build) continue;
        const context = joinPath(dirOf(cf.file), svc.build.context);
        if (context === null) continue;
        const dockerfilePath = joinPath(context, svc.build.dockerfile ?? 'Dockerfile');
        const df = dockerfilePath ? dockerfiles.get(dockerfilePath) : undefined;
        const runCmd = svc.command?.text ?? df?.commands.at(-1)?.text ?? '';
        if (TEST_CMD.test(runCmd) || /playwright|cypress|(?:^|[/.-])e2e(?:[/.-]|$)/i.test(`${svc.name} ${dockerfilePath ?? ''}`)) {
          this.limitations.push(`Compose service "${svc.name}" runs tests (${cf.file}:${svc.line}), so it is not shown as part of the running system.`);
          continue;
        }
        // A monorepo build context with the Dockerfile inside one package builds that package.
        const dfDir = dockerfilePath ? dirOf(dockerfilePath) : context;
        const root = dfDir !== context && (context === '' || dfDir.startsWith(context + '/')) && facts.manifests.some((m) => m.dir === dfDir) ? dfDir : context;
        const existing = composeByName.get(svc.name);
        const ev = this.e({ kind: 'compose', file: cf.file, line: svc.build.line, snippet: `${svc.name}: build ${svc.build.context}`, detail: `Compose service "${svc.name}" is built from ${root || 'the repository root'}` });
        if (existing) {
          existing.evidence.push(ev);
          continue;
        }
        const dockerfile = dockerfilePath;
        const dcmd = df?.commands.at(-1);
        const cmd = svc.command?.text ?? dcmd?.text ?? '';
        const kind: AppKind = WORKER_CMD.test(cmd) ? 'worker' : 'service';
        const app: AppInfo = {
          id: `app:${slug(svc.name)}`,
          name: svc.name,
          root,
          kind,
          compose: { file: cf.file, service: svc },
          dockerfile: dockerfilePath ?? undefined,
          evidence: [ev],
          confidence: 'confirmed',
          reason: `Built from ${root || 'the repository root'} by Compose service "${svc.name}" (${cf.file}:${svc.build.line})${root !== context ? ` with ${dockerfilePath}` : ''}.`,
        };
        const entry = cmd ? this.entryFromCommand(cmd, root) : undefined;
        if (entry) {
          const line = svc.command?.line ?? dcmd?.line;
          app.entry = { file: entry.file, line: undefined };
          app.evidence.push(
            this.e({ kind: svc.command ? 'compose' : 'dockerfile', file: svc.command ? cf.file : dockerfile!, line, snippet: cmd.slice(0, 160), detail: `Start command runs ${entry.file}` }),
          );
        } else if (cmd) {
          app.evidence.push(this.e({ kind: svc.command ? 'compose' : 'dockerfile', file: svc.command ? cf.file : dockerfile!, line: svc.command?.line ?? dcmd?.line, snippet: cmd.slice(0, 160), detail: 'Start command' }));
        }
        composeByName.set(svc.name, app);
        this.apps.push(app);
      }
    }

    // 2. Procfile processes (when Compose does not define the apps).
    if (!this.apps.length) {
      for (const p of facts.infra.processes) {
        const root = dirOf(p.file);
        const kind: AppKind = WORKER_CMD.test(p.command) || /^worker/.test(p.name) ? 'worker' : p.name === 'release' ? 'service' : 'service';
        if (p.name === 'release') continue;
        const app: AppInfo = {
          id: `app:${slug(p.name)}`,
          name: p.name,
          root,
          kind,
          evidence: [this.e({ kind: 'platform', file: p.file, line: p.line, snippet: `${p.name}: ${p.command}`.slice(0, 160), detail: `Procfile process "${p.name}"` })],
          confidence: 'confirmed',
          reason: `Declared as process "${p.name}" in ${p.file}:${p.line}.`,
        };
        const entry = this.entryFromCommand(p.command, root);
        if (entry) app.entry = { file: entry.file };
        this.apps.push(app);
      }
    }

    // 3. Serverless services.
    for (const s of facts.infra.serverless) {
      if (!s.functions.length) continue;
      const root = dirOf(s.file);
      if (this.apps.some((a) => a.root === root)) continue;
      this.apps.push({
        id: `app:${slug(root.split('/').pop() || 'functions')}`,
        name: root.split('/').pop() || 'functions',
        root,
        kind: 'function',
        evidence: s.functions.map((f) => this.e({ kind: 'serverless', file: s.file, line: f.line, snippet: `${f.name}: ${f.handler ?? ''}`.trim(), detail: `Serverless function "${f.name}"` })),
        confidence: 'confirmed',
        reason: `${s.functions.length} functions declared in ${s.file}.`,
      });
    }

    // 4. Package roots with server, worker or client evidence.
    const manifestDirs = [...new Set(facts.manifests.map((m) => m.dir))].sort((a, b) => b.length - a.length);
    const packageOf = (file: string) => manifestDirs.find((d) => d === '' || file.startsWith(d + '/')) ?? null;
    const byPackage = new Map<string, string[]>();
    for (const f of this.fileSet) {
      const pkg = packageOf(f);
      if (pkg === null) continue;
      if (!byPackage.has(pkg)) byPackage.set(pkg, []);
      byPackage.get(pkg)!.push(f);
    }
    const importsByFile = new Map<string, Set<string>>();
    for (const imp of facts.imports) {
      for (const t of toolsForModule(imp.lang, imp.module)) {
        if (!importsByFile.has(imp.file)) importsByFile.set(imp.file, new Set());
        importsByFile.get(imp.file)!.add(t.id);
      }
    }
    const coveredRoots = new Set(this.apps.map((a) => a.root));
    for (const dir of [...byPackage.keys()].sort()) {
      if (coveredRoots.has(dir) || this.apps.some((a) => a.root !== '' && dir.startsWith(a.root + '/'))) continue;
      const files = new Set(byPackage.get(dir)!);
      const httpDefs = facts.definitions.filter((d) => files.has(d.file) && (d.kind === 'http-app' || d.kind === 'graphql-server' || d.kind === 'grpc-server'));
      const apiRoutes = facts.routes.filter((r) => files.has(r.file) && r.kind !== 'page');
      const pageRoutes = facts.routes.filter((r) => files.has(r.file) && r.kind === 'page');
      const toolIds = new Set([...files].flatMap((f) => [...(importsByFile.get(f) ?? [])]));
      const server = [...toolIds].find((t) => SERVER_TOOLS.has(t));
      const workerDefs = facts.definitions.filter((d) => files.has(d.file) && (d.kind === 'worker-app' || d.kind === 'task' || d.kind === 'queue-consumer' || d.kind === 'topic-consumer'));
      const ui = [...toolIds].find((t) => UI_TOOLS.has(t));
      const scripts = this.manifestFor(dir).flatMap((m) => m.scripts);
      const clientScript = scripts.find((s) => CLIENT_SCRIPT.test(s.command));
      const manifest = this.manifestFor(dir)[0];
      const name = (manifest?.name?.replace(/^@[^/]+\//, '') || dir.split('/').pop() || this.graphName()).trim();
      let kind: AppKind | null = null;
      const evidence: string[] = [];
      let reason = '';
      if (httpDefs.length || apiRoutes.length || (server && server !== 'nextjs' && server !== 'astro') || (server === 'nextjs' && (pageRoutes.length || apiRoutes.length))) {
        kind = 'service';
        const d = httpDefs[0];
        if (d) evidence.push(this.e({ kind: 'config', file: d.file, line: d.line, snippet: d.snippet, detail: `Creates the ${d.tool ? CATALOG_BY_ID.get(d.tool)?.name + ' ' : ''}application` }));
        for (const r of apiRoutes.slice(0, 3)) evidence.push(this.e({ kind: 'route', file: r.file, line: r.line, snippet: r.snippet, detail: `${r.method} ${r.path}` }));
        if (!evidence.length && pageRoutes.length) for (const r of pageRoutes.slice(0, 3)) evidence.push(this.e({ kind: 'route', file: r.file, line: r.line, snippet: r.file, detail: `Page ${r.path} (${r.framework} file convention)` }));
        reason = d ? `Creates a server in ${d.file}:${d.line}${apiRoutes.length ? ` and declares ${apiRoutes.length} routes` : ''}.` : apiRoutes.length ? `Declares ${apiRoutes.length} routes (first: ${apiRoutes[0].file}:${apiRoutes[0].line}).` : `Uses ${CATALOG_BY_ID.get(server!)?.name} (${this.manifestLine(dir, server!)}).`;
      } else if (workerDefs.length) {
        kind = 'worker';
        const d = workerDefs[0];
        evidence.push(this.e({ kind: 'queue', file: d.file, line: d.line, snippet: d.snippet, detail: `Defines ${d.kind.replace('-', ' ')}${d.name ? ` "${d.name}"` : ''}` }));
        reason = `Defines background ${workerDefs.length === 1 ? 'work' : 'workers'} (${d.file}:${d.line}).`;
      } else if (ui && (clientScript || this.fileSet.has(joinPath(dir, 'index.html') ?? '') || pageRoutes.length)) {
        kind = 'client';
        if (clientScript) evidence.push(this.e({ kind: 'manifest', file: manifest?.file ?? dir, line: clientScript.line, snippet: `"${clientScript.name}": "${clientScript.command}"`.slice(0, 160), detail: `Frontend build/dev script` }));
        const firstUi = [...files].find((f) => importsByFile.get(f)?.has(ui));
        if (firstUi) {
          const imp = facts.imports.find((i) => i.file === firstUi);
          if (imp) evidence.push(this.e({ kind: 'import', file: imp.file, line: imp.line, snippet: imp.snippet, detail: `Imports ${imp.module}` }));
        }
        reason = `Frontend package using ${CATALOG_BY_ID.get(ui)?.name}${clientScript ? ` with a "${clientScript.name}" script (${manifest?.file}:${clientScript.line})` : ''}.`;
      }
      if (!kind) continue;
      this.apps.push({ id: `app:${slug(name)}`, name, root: dir, kind, framework: server ?? ui, evidence, confidence: 'confirmed', reason });
    }

    // 5. Dockerfiles not referenced by Compose.
    const composeDockerfiles = new Set(this.apps.filter((a) => a.compose).map((a) => a.dockerfile));
    for (const d of facts.infra.dockerfiles) {
      if (composeDockerfiles.has(d.file) || TEST_DOCKERFILE.test(d.file)) continue;
      const root = dirOf(d.file);
      if (this.apps.some((a) => a.root === root)) continue;
      const hasSource = [...this.fileSet].some((f) => (root === '' || f.startsWith(root + '/')) && this.graph.nodes.find((n) => n.id === f)?.analyzed !== false && /\.(?:[cm]?[jt]sx?|py|go|rb|php|java|kt|rs|cs)$/.test(f));
      if (!hasSource) continue;
      const cmd = d.commands.at(-1);
      const kind: AppKind = cmd && WORKER_CMD.test(cmd.text) ? 'worker' : 'service';
      const name = root.split('/').pop() || this.graphName();
      const app: AppInfo = {
        id: `app:${slug(name)}`,
        name,
        root,
        kind,
        dockerfile: d.file,
        evidence: [this.e({ kind: 'dockerfile', file: d.file, line: d.stages[0]?.line ?? 1, snippet: d.stages.map((s) => `FROM ${s.image}`).join(' · ').slice(0, 160), detail: 'Container image definition' })],
        confidence: 'confirmed',
        reason: `Container built from ${d.file}.`,
      };
      if (cmd) {
        const entry = this.entryFromCommand(cmd.text, root);
        if (entry) app.entry = { file: entry.file };
      }
      this.apps.push(app);
    }

    // 6. Celery tasks without a declared worker process.
    const celeryTasks = facts.definitions.filter((d) => d.kind === 'task' && d.tool === 'celery');
    const celeryApp = facts.definitions.find((d) => d.kind === 'worker-app' && d.tool === 'celery');
    const hasCeleryWorker = this.apps.some((a) => a.kind === 'worker' && a.compose?.service.command && /celery/.test(a.compose.service.command.text)) ||
      facts.infra.processes.some((p) => /celery/.test(p.command)) || facts.infra.dockerfiles.some((d) => d.commands.some((c) => /celery[^|;&]*worker/.test(c.text)));
    if ((celeryTasks.length || celeryApp) && !hasCeleryWorker) {
      const anchor = celeryApp ?? celeryTasks[0];
      const host = this.apps.find((a) => a.root === '' || anchor.file.startsWith(a.root + '/'));
      const worker: AppInfo = {
        id: `app:${slug('celery-worker')}`,
        name: 'Celery worker',
        root: host?.root ?? dirOf(anchor.file),
        kind: 'worker',
        synthesized: true,
        closure: this.fileGraph.closure(celeryTasks.map((t) => t.file).concat(celeryApp ? [celeryApp.file] : [])),
        evidence: [anchor, ...celeryTasks.slice(0, 4)].map((d) => this.e({ kind: 'queue', file: d.file, line: d.line, snippet: d.snippet, detail: d.kind === 'task' ? `Celery task "${d.name}"` : 'Celery application' })),
        confidence: 'strong',
        reason: `Celery ${celeryTasks.length ? `tasks are defined (${celeryTasks[0].file}:${celeryTasks[0].line})` : 'is configured'}, which run in a separate worker process; no worker start command was found in Compose, a Procfile or a Dockerfile.`,
      };
      this.apps.push(worker);
    }

    // 7. Fallback: one application for the whole repository.
    if (!this.apps.length) {
      const sourceFiles = [...this.fileSet].filter((f) => /\.(?:[cm]?[jt]sx?|py|go|rb|php|java|kt|rs|cs|vue|svelte)$/.test(f));
      if (sourceFiles.length) {
        this.apps.push({
          id: `app:${slug(this.graphName())}`,
          name: this.graphName(),
          root: '',
          kind: 'service',
          evidence: [this.e({ kind: 'graph', file: sourceFiles[0], detail: `${sourceFiles.length} source files; no server, worker or frontend entry could be identified` })],
          confidence: 'strong',
          reason: `The repository contains ${sourceFiles.length} source files, but no server, worker or frontend entry point could be identified, so it is shown as a single application.`,
        });
        this.limitations.push('No runnable entry point (server, worker, frontend or container) was found; the code is shown as a single application.');
      }
    }

    // Entry closures for apps that share a root, so each file is attributed to the right process.
    const byRoot = new Map<string, AppInfo[]>();
    for (const a of this.apps) {
      if (!byRoot.has(a.root)) byRoot.set(a.root, []);
      byRoot.get(a.root)!.push(a);
    }
    for (const group of byRoot.values()) {
      if (group.length < 2) continue;
      for (const a of group) if (a.entry && !a.closure) a.closure = this.fileGraph.closure([a.entry.file]);
      const unresolved = group.filter((a) => !a.closure);
      if (unresolved.length === group.length) {
        this.limitations.push(`${group.map((a) => `"${a.name}"`).join(', ')} are built from the same directory and their start commands could not be traced to entry files, so their code is attributed to all of them.`);
      } else if (unresolved.length) {
        this.limitations.push(`${group.map((a) => `"${a.name}"`).join(', ')} are built from the same directory. Code is attributed by following imports from each traced start command; ${unresolved.map((a) => `"${a.name}"`).join(', ')} ${unresolved.length === 1 ? 'has' : 'have'} no traceable entry file, so no code is attributed to ${unresolved.length === 1 ? 'it' : 'them'}.`);
      }
    }

    // Routes per app.
    for (const r of facts.routes) for (const id of this.appsOf(r.file)) {
      if (!this.routesByApp.has(id)) this.routesByApp.set(id, []);
      this.routesByApp.get(id)!.push(r);
    }
    // A process with no HTTP surface whose code consumes queues or topics is a worker.
    for (const a of this.apps) {
      if (a.kind !== 'service') continue;
      const routes = (this.routesByApp.get(a.id) ?? []).filter((r) => r.kind !== 'page');
      const http = facts.definitions.some((d) => (d.kind === 'http-app' || d.kind === 'graphql-server' || d.kind === 'grpc-server') && this.appsOf(d.file).includes(a.id));
      const consumer = facts.definitions.find((d) => ['queue-consumer', 'topic-consumer', 'task'].includes(d.kind) && this.appsOf(d.file).includes(a.id));
      if (!routes.length && !http && consumer) {
        a.kind = 'worker';
        a.evidence.push(this.e({ kind: 'queue', file: consumer.file, line: consumer.line, snippet: consumer.snippet, detail: `Consumes ${consumer.name ? `"${consumer.name}"` : 'messages'} and serves no HTTP routes` }));
        a.reason += ` It serves no HTTP routes and consumes ${consumer.name ? `"${consumer.name}"` : 'messages'} (${consumer.file}:${consumer.line}).`;
      }
    }

    // App nodes.
    for (const a of this.apps) {
      const cmd = a.compose?.service.command;
      if (cmd) a.evidence.push(this.e({ kind: 'compose', file: a.compose!.file, line: cmd.line, snippet: cmd.text.slice(0, 160), detail: `Start command of "${a.name}"` }));
      const layer: Layer = a.kind === 'worker' ? 'async' : a.kind === 'client' ? 'clients' : 'application';
      const n = this.node(a.id, { kind: 'app', name: a.name, category: a.kind === 'client' ? 'frontend' : a.kind === 'worker' ? 'worker' : 'application', layer, display: 'node', confidence: a.confidence });
      for (const id of a.evidence) n.evidence.add(id);
      n.reasons.push(a.reason);
      n.app = { root: a.root, frameworks: [], chips: [], entry: a.entry };
      if (a.compose) this.serviceNode.set(a.compose.service.name, a.id);
      if (cmd) n.badges.push({ text: `runs: ${cmd.text.replace(/\s+/g, ' ').slice(0, 48)}${cmd.text.length > 48 ? '…' : ''}`, tone: 'neutral', evidence: [this.e({ kind: 'compose', file: a.compose!.file, line: cmd.line, snippet: cmd.text.slice(0, 160), detail: `Start command of "${a.name}"` })], overlay: 'deployment' });
    }
  }

  graphName(): string {
    return this.graph.repository.name ?? 'application';
  }

  private manifestLine(dir: string, toolId: string): string {
    for (const m of this.manifestFor(dir)) {
      const d = m.dependencies.find((dep) => toolsForPackage(m.ecosystem, dep.name).some((t) => t.id === toolId));
      if (d) return `${m.file}:${d.line}`;
    }
    return 'manifest';
  }

  // --- Tools from code and manifests -----------------------------------------------------------------------------------------------

  /** Per tool: files with code evidence (imports, clients, calls, configs). */
  readonly codeFiles = new Map<string, Map<string, string[]>>();

  private addCode(toolId: string, file: string, evidence: string) {
    if (!this.codeFiles.has(toolId)) this.codeFiles.set(toolId, new Map());
    const m = this.codeFiles.get(toolId)!;
    if (!m.has(file)) m.set(file, []);
    m.get(file)!.push(evidence);
  }

  private detectTools() {
    const { facts } = this;
    const present = new Map<string, { confidence: Confidence; evidence: string[]; reasons: string[] }>();
    const mark = (id: string, confidence: Confidence, evidence: string[], reason: string) => {
      const p = present.get(id) ?? { confidence, evidence: [], reasons: [] };
      p.confidence = maxConfidence(p.confidence, confidence);
      p.evidence.push(...evidence);
      if (reason) p.reasons.push(reason);
      present.set(id, p);
    };

    // Test code is not part of the running system.
    const runtime = <T extends { file: string }>(list: T[]) => list.filter((x) => !TEST_FILE.test(x.file));
    for (const imp of runtime(facts.imports)) {
      for (const t of toolsForModule(imp.lang, imp.module)) {
        const id = this.e({ kind: 'import', file: imp.file, line: imp.line, snippet: imp.snippet, detail: `Imports ${imp.module}` });
        this.addCode(t.id, imp.file, id);
        mark(t.id, 'confirmed', [id], '');
      }
    }
    for (const c of runtime(facts.clients)) {
      const t = CATALOG_BY_ID.get(c.tool);
      const id = this.e({ kind: 'client-init', file: c.file, line: c.line, snippet: c.snippet, detail: `Creates a ${t?.name ?? c.tool} client "${c.name}"${c.arg ? ` (${c.arg})` : ''}` });
      this.addCode(c.tool, c.file, id);
      mark(c.tool, 'confirmed', [id], '');
    }
    for (const c of runtime(facts.calls)) {
      const id = this.callEvidence(c);
      this.addCode(c.tool, c.file, id);
      mark(c.tool, 'confirmed', [id], '');
    }
    for (const c of runtime(facts.configs)) {
      if (c.tool) {
        const id = this.e({ kind: c.file.endsWith('.prisma') ? 'schema' : 'config', file: c.file, line: c.line, snippet: c.snippet, detail: this.configDetail(c) });
        mark(c.tool, 'confirmed', [id], '');
        if (c.via) mark(c.via, 'confirmed', [id], '');
        // A connection string in application code is usage by the app that contains it.
        if (c.kind === 'url' && !c.via && this.fileSet.has(c.file) && /\.(?:[cm]?[jt]sx?|py|go|rb|java|kt|php|rs|cs)$/.test(c.file)) this.addCode(c.tool, c.file, id);
      }
    }

    // Routes found through a framework's conventions or APIs confirm the framework.
    for (const r of runtime(facts.routes)) {
      if (!CATALOG_BY_ID.has(r.framework)) continue;
      const id = this.e({ kind: 'route', file: r.file, line: r.line, snippet: r.snippet, detail: r.kind === 'page' ? `Page ${r.path} (${r.framework} file convention)` : `${r.method} ${r.path}` });
      this.addCode(r.framework, r.file, id);
      mark(r.framework, 'confirmed', [id], '');
    }

    // Manifest declarations: version sources, and presence when nothing else mentions the tool.
    for (const m of facts.manifests) {
      for (const d of m.dependencies) {
        for (const t of toolsForPackage(m.ecosystem, d.name)) {
          const id = this.e({ kind: 'manifest', file: m.file, line: d.line, snippet: `${d.name}${d.spec ? ' ' + d.spec : ''}`, detail: `Declares ${d.name}${d.spec ? ` ${d.spec}` : ''}${d.dev ? ' (development dependency)' : ''}` });
          if (present.has(t.id)) present.get(t.id)!.evidence.push(id);
          else if (!d.dev) mark(t.id, 'strong', [id], `Declared in ${m.file}:${d.line}, but no import or call was found in the analyzed source.`);
        }
      }
    }

    // Env var names are weak hints on their own.
    for (const env of runtime(facts.envRefs)) {
      for (const t of toolsForEnv(env.name)) {
        const id = this.e({ kind: 'env', file: env.file, line: env.line, snippet: env.name, detail: `Reads ${env.name}` });
        if (present.has(t.id)) present.get(t.id)!.evidence.push(id);
        else mark(t.id, 'possible', [id], `Only the environment variable ${env.name} (${env.file}:${env.line}) suggests ${t.name}.`);
      }
    }

    // Technologies required by other technologies (BullMQ → Redis).
    for (const [id] of [...present]) {
      const t = CATALOG_BY_ID.get(id);
      for (const r of t?.requires ?? []) {
        if (!present.has(r.id)) mark(r.id, 'strong', present.get(id)!.evidence.slice(0, 2), r.reason);
      }
    }

    for (const [id, p] of present) {
      const t = CATALOG_BY_ID.get(id);
      if (!t) continue;
      if (t.category === 'framework' || t.category === 'frontend' || t.category === 'runtime') {
        // Frameworks become chips inside apps only when an app uses them; skip pure declarations.
        if (p.confidence !== 'confirmed') continue;
      }
      const n = this.toolNode(t, p.confidence);
      for (const e of p.evidence) n.evidence.add(e);
      for (const r of p.reasons) if (!n.reasons.includes(r)) n.reasons.push(r);
      for (const [file, evs] of this.codeFiles.get(id) ?? []) for (const e of evs) n.files.add(file, this.ev.get(e)?.line, this.useOf(e));
    }
  }

  callEvidence(c: CallFact): string {
    return this.e({ kind: 'call', file: c.file, line: c.line, snippet: c.snippet, detail: `${opText(c.op)}: ${c.callee}${c.arg && c.arg !== 'ttl' ? ` (${c.arg})` : ''}${c.via ? ` — client created in ${c.via}` : ''}` });
  }

  private useOf(evId: string): string {
    const e = this.ev.get(evId);
    if (!e) return 'use';
    if (e.kind === 'call') return e.detail.split(':')[0].toLowerCase();
    if (e.kind === 'client-init') return 'client';
    if (e.kind === 'config') return 'connection string';
    return e.kind;
  }

  private configDetail(c: { kind: string; tool: string; via?: string; host?: string; envVar?: string }): string {
    const tool = CATALOG_BY_ID.get(c.tool)?.name ?? c.tool;
    const via = c.via ? CATALOG_BY_ID.get(c.via)?.name ?? c.via : undefined;
    switch (c.kind) {
      case 'datasource':
      case 'dialect':
        return `${via ?? 'Data layer'} is configured for ${tool}`;
      case 'broker':
        return `${via ?? 'Task queue'} broker is ${tool || `read from ${c.envVar}`}`;
      case 'result-backend':
        return `${via ?? 'Task queue'} result backend is ${tool || `read from ${c.envVar}`}`;
      case 'cache-backend':
        return `${via ?? 'Framework'} cache backend is ${tool}`;
      default:
        return `Connection string for ${tool}${c.host ? ` (host ${c.host})` : ''}`;
    }
  }

  // --- Infrastructure nodes -----------------------------------------------------------------------------------------------------

  private infrastructure() {
    const { infra } = this.facts;

    // Compose services that run catalogued images (databases, caches, proxies…) or unknown images.
    const imageServices = new Map<string, { tool: CatalogEntry | undefined; services: { file: string; svc: ComposeService }[] }>();
    for (const cf of infra.compose) {
      for (const svc of cf.services) {
        if (svc.build || !svc.image) continue;
        // `docker-compose.images.yml` running a prebuilt image of a service another file builds: same service.
        const built = this.apps.find((a) => a.compose?.service.name === svc.name);
        if (built) {
          const ev = this.e({ kind: 'compose', file: cf.file, line: svc.imageLine ?? svc.line, snippet: `image: ${svc.image}`, detail: `"${svc.name}" also runs as prebuilt image ${svc.image}` });
          this.nodes.get(built.id)?.evidence.add(ev);
          this.nodes.get(built.id)?.badges.push({ text: `image ${imageRepository(svc.image)}`, tone: 'neutral', evidence: [ev], overlay: 'deployment' });
          continue;
        }
        const tool = toolForImage(svc.image);
        const key = tool?.id ?? `container:${svc.name}`;
        if (!imageServices.has(key)) imageServices.set(key, { tool, services: [] });
        const entry = imageServices.get(key)!;
        if (!entry.services.some((s) => s.svc.name === svc.name)) entry.services.push({ file: cf.file, svc });
      }
    }
    for (const [key, { tool, services }] of imageServices) {
      for (const { file, svc } of services) {
        const evidence = this.e({ kind: 'compose', file, line: svc.imageLine ?? svc.line, snippet: `image: ${svc.image}`, detail: `Compose service "${svc.name}" runs ${svc.image}` });
        if (tool) {
          const multiple = services.length > 1;
          const id = multiple ? `tool:${tool.id}@${svc.name}` : `tool:${tool.id}`;
          const n = this.toolNode(tool, 'confirmed', id, multiple ? `${tool.name} · ${svc.name}` : tool.name);
          n.display = 'node';
          n.evidence.add(evidence);
          n.reasons.push(`Runs as Compose service "${svc.name}" (${file}:${svc.imageLine ?? svc.line}).`);
          n.roles.push(`Compose service "${svc.name}"`);
          const tag = imageTag(svc.image!);
          if (tag && !n.version) n.version = { value: tag, source: file, line: svc.imageLine };
          this.serviceNode.set(svc.name, id);
          if (multiple) {
            if (!this.instances.has(tool.id)) this.instances.set(tool.id, []);
            this.instances.get(tool.id)!.push(svc.name);
          }
        } else {
          const n = this.node(key, { kind: 'container', name: svc.name, category: 'container', layer: 'application', display: 'node', confidence: 'confirmed', description: `Container image ${svc.image} (its source is not in this repository).` });
          n.evidence.add(evidence);
          n.reasons.push(`Compose service "${svc.name}" runs image ${svc.image} (${file}:${svc.imageLine ?? svc.line}).`);
          n.roles.push(`Runs image ${imageRepository(svc.image!)}`);
          const tag = imageTag(svc.image!);
          n.version = { value: tag ?? 'latest', source: file, line: svc.imageLine };
          this.serviceNode.set(svc.name, key);
        }
      }
    }

    // Terraform resources.
    for (const r of infra.terraform.resources) {
      let tool = toolForTerraform(r.type);
      const engine = r.attributes.engine?.value ?? r.attributes.database_version?.value;
      let badge: string | undefined;
      if ((tool?.id === 'aws-rds' || tool?.id === 'cloud-sql') && engine) {
        const engineTool = /postgres/i.test(engine) ? 'postgresql' : /mysql|maria|aurora-mysql/i.test(engine) ? 'mysql' : undefined;
        if (engineTool) {
          badge = `${tool.name} (${engine})`;
          tool = CATALOG_BY_ID.get(engineTool);
        }
      }
      if (!tool) continue;
      const evidence = this.e({ kind: 'terraform', file: r.file, line: r.line, snippet: `resource "${r.type}" "${r.name}"`, detail: `Terraform provisions ${r.type} "${r.name}"` });
      const n = this.toolNode(tool, 'confirmed');
      n.display = 'node';
      n.evidence.add(evidence);
      n.reasons.push(`Provisioned by Terraform resource ${r.type}.${r.name} (${r.file}:${r.line}).`);
      if (badge) n.badges.push({ text: badge, tone: 'neutral', evidence: [evidence], overlay: 'deployment' });
      const version = r.attributes.engine_version ?? r.attributes.runtime;
      if (version && !n.version) n.version = { value: version.value, source: r.file, line: version.line };
      const tf = this.toolNode(CATALOG_BY_ID.get('terraform')!, 'confirmed');
      tf.evidence.add(evidence);
      this.edge('tool:terraform', n.id, 'configures', ['deployment'], 'confirmed', [evidence], `Terraform resource ${r.type}.${r.name} (${r.file}:${r.line}) provisions it.`);
    }
    if (infra.terraform.providers.length || infra.terraform.modules.length) {
      const tf = this.toolNode(CATALOG_BY_ID.get('terraform')!, 'confirmed');
      for (const p of infra.terraform.providers) tf.evidence.add(this.e({ kind: 'terraform', file: p.file, line: p.line, snippet: `provider "${p.name}"`, detail: `Terraform provider ${p.name}` }));
    }

    // Helm charts and their dependencies.
    for (const chart of infra.helm) {
      const evidence = this.e({ kind: 'helm', file: chart.file, line: chart.line, snippet: `name: ${chart.name}`, detail: `Helm chart "${chart.name}"` });
      this.toolNode(CATALOG_BY_ID.get('helm')!, 'confirmed').evidence.add(evidence);
      for (const dep of chart.dependencies) {
        const tool = toolForHelmChart(dep.name);
        if (!tool) continue;
        const depEv = this.e({ kind: 'helm', file: chart.file, line: dep.line, snippet: `- name: ${dep.name}`, detail: `Helm chart dependency ${dep.name}` });
        const n = this.toolNode(tool, 'confirmed');
        n.display = 'node';
        n.evidence.add(depEv);
        n.reasons.push(`Installed as a dependency of Helm chart "${chart.name}" (${chart.file}:${dep.line}).`);
        this.edge('tool:helm', n.id, 'configures', ['deployment'], 'confirmed', [depEv], `Helm chart "${chart.name}" installs ${dep.name}.`);
      }
    }

    // Kubernetes workloads: images become apps (by name), catalogued tools, or containers.
    const workloads = infra.kubernetes.filter((o) => ['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'Pod'].includes(o.kind));
    const workloadNode = new Map<string, string>();
    if (infra.kubernetes.length) {
      const k8s = this.toolNode(CATALOG_BY_ID.get('kubernetes')!, 'confirmed');
      for (const o of infra.kubernetes.slice(0, 20)) k8s.evidence.add(this.e({ kind: 'kubernetes', file: o.file, line: o.line, snippet: `kind: ${o.kind} · ${o.name}`, detail: `Kubernetes ${o.kind} "${o.name}"` }));
    }
    for (const w of workloads) {
      for (const img of w.images) {
        const evidence = this.e({ kind: 'kubernetes', file: w.file, line: img.line, snippet: `image: ${img.image}`, detail: `Kubernetes ${w.kind} "${w.name}" runs ${img.image}` });
        const repo = imageRepository(img.image);
        const last = repo.split('/').pop()!;
        const tool = toolForImage(img.image);
        const app = this.apps.find((a) => a.name.toLowerCase() === last || a.name.toLowerCase() === w.name.toLowerCase() || a.root.split('/').pop()?.toLowerCase() === last);
        let id: string;
        if (app) {
          id = app.id;
          const n = this.nodes.get(id)!;
          n.evidence.add(evidence);
          n.badges.push({ text: `Kubernetes ${w.kind} "${w.name}"`, tone: 'neutral', evidence: [evidence], overlay: 'deployment' });
          if (w.replicas && w.replicas.count > 1) n.badges.push({ text: `${w.replicas.count} replicas`, tone: 'neutral', evidence: [this.e({ kind: 'kubernetes', file: w.file, line: w.replicas.line, snippet: `replicas: ${w.replicas.count}`, detail: `${w.name} runs ${w.replicas.count} replicas` })], overlay: 'deployment' });
        } else if (tool) {
          const n = this.toolNode(tool, 'confirmed');
          n.display = 'node';
          n.evidence.add(evidence);
          n.reasons.push(`Runs in Kubernetes ${w.kind} "${w.name}" (${w.file}:${img.line}).`);
          id = n.id;
        } else {
          const n = this.node(`container:k8s-${w.name}`, { kind: 'container', name: w.name, category: 'container', layer: 'application', display: 'node', confidence: 'confirmed', description: `Container image ${img.image}.` });
          n.evidence.add(evidence);
          n.reasons.push(`Kubernetes ${w.kind} "${w.name}" runs ${img.image} (${w.file}:${img.line}); no application in this repository could be matched to the image by name.`);
          n.version = { value: imageTag(img.image) ?? 'latest', source: w.file, line: img.line };
          id = n.id;
        }
        workloadNode.set(w.name, id);
        this.edge('tool:kubernetes', id, 'hosts', ['deployment'], app ? 'strong' : 'confirmed', [evidence], `Kubernetes ${w.kind} "${w.name}" runs image ${img.image}${app ? `, matched to "${app.name}" by name` : ''}.`);
      }
    }
    // Services → workloads by selector; Ingress → services.
    const serviceTargets = new Map<string, string[]>();
    for (const svc of infra.kubernetes.filter((o) => o.kind === 'Service')) {
      const targets = workloads.filter((w) => Object.keys(svc.selector).length && Object.entries(svc.selector).every(([k, v]) => w.labels[k] === v || (w.selector[k] === v))).map((w) => workloadNode.get(w.name)).filter((x): x is string => !!x);
      serviceTargets.set(svc.name, targets);
      if (svc.serviceType && /LoadBalancer|NodePort/.test(svc.serviceType.value)) {
        const evidence = this.e({ kind: 'port', file: svc.file, line: svc.serviceType.line, snippet: `type: ${svc.serviceType.value}`, detail: `Service "${svc.name}" is exposed outside the cluster (${svc.serviceType.value})` });
        for (const t of targets) this.nodes.get(t)?.badges.push({ text: `Exposed via ${svc.serviceType.value}`, tone: 'risk', evidence: [evidence], overlay: 'security' });
      }
    }
    for (const ing of infra.kubernetes.filter((o) => o.kind === 'Ingress')) {
      const n = this.toolNode(CATALOG_BY_ID.get('k8s-ingress')!, 'confirmed', `tool:k8s-ingress`, 'Kubernetes Ingress');
      n.evidence.add(this.e({ kind: 'kubernetes', file: ing.file, line: ing.line, snippet: `kind: Ingress · ${ing.name}`, detail: `Ingress "${ing.name}"` }));
      for (const b of ing.backends) {
        const evidence = this.e({ kind: 'kubernetes', file: ing.file, line: b.line, snippet: `${b.host ?? ''}${b.path ?? ''} → ${b.service}`.trim(), detail: `Ingress routes ${b.host ?? ''}${b.path ?? '/'} to service ${b.service}` });
        for (const t of serviceTargets.get(b.service) ?? []) this.edge(n.id, t, 'proxy', ['dataflow', 'deployment'], 'confirmed', [evidence], `Ingress "${ing.name}" routes ${b.path ?? '/'} to service "${b.service}" (${ing.file}:${b.line}).`);
      }
    }

    // Serverless events.
    for (const s of infra.serverless) {
      const app = this.apps.find((a) => a.kind === 'function' && a.root === dirOf(s.file));
      if (!app) continue;
      if (s.provider?.name === 'aws') {
        const evidence = this.e({ kind: 'serverless', file: s.file, line: s.provider.line, snippet: `provider: aws${s.provider.runtime ? ` · ${s.provider.runtime}` : ''}`, detail: 'Functions deploy to AWS Lambda' });
        const n = this.toolNode(CATALOG_BY_ID.get('aws-lambda')!, 'confirmed');
        n.evidence.add(evidence);
        this.edge(n.id, app.id, 'hosts', ['deployment'], 'confirmed', [evidence], `serverless.yml deploys these functions to AWS Lambda (${s.file}:${s.provider.line}).`);
      }
      for (const fn of s.functions) {
        for (const evt of fn.events) {
          const evidence = this.e({ kind: 'serverless', file: s.file, line: evt.line, snippet: `${evt.kind}${evt.method ? ` ${evt.method}` : ''}${evt.path ? ` ${evt.path}` : ''}`, detail: `Function "${fn.name}" is triggered by ${evt.kind}` });
          if (/^http/.test(evt.kind) && s.provider?.name === 'aws') {
            const gw = this.toolNode(CATALOG_BY_ID.get('api-gateway')!, 'confirmed');
            gw.evidence.add(evidence);
            this.edge(gw.id, app.id, 'proxy', ['dataflow'], 'confirmed', [evidence], `API Gateway invokes "${fn.name}" for ${evt.method?.toUpperCase() ?? 'ANY'} ${evt.path ?? '/'} (${s.file}:${evt.line}).`);
            this.facts.routes.push({ file: s.file, line: evt.line, kind: 'api', method: (evt.method?.toUpperCase() as RouteFact['method']) ?? 'ANY', path: evt.path?.startsWith('/') ? evt.path : `/${evt.path ?? ''}`, framework: 'serverless', source: 'config', handler: fn.handler, snippet: `${evt.kind}: ${evt.method ?? ''} ${evt.path ?? ''}`.trim() });
          } else if (evt.kind === 'sqs') {
            const q = this.toolNode(CATALOG_BY_ID.get('sqs')!, 'confirmed');
            q.evidence.add(evidence);
            this.edge(q.id, app.id, 'consume', ['dataflow'], 'confirmed', [evidence], `SQS events trigger "${fn.name}" (${s.file}:${evt.line}).`, true);
          }
        }
      }
    }
  }

  // --- Code-derived edges ------------------------------------------------------------------------------------------------------------

  /** The node that stands for `toolId` when used from `appId` (resolving Compose instances). */
  targetFor(toolId: string, appId?: string): string {
    const names = this.instances.get(toolId);
    if (!names?.length) return `tool:${toolId}`;
    const app = appId ? this.appById(appId) : undefined;
    const svc = app?.compose?.service;
    if (svc) {
      const byEnv = svc.environment.find((e) => e.host && names.includes(e.host));
      if (byEnv) return `tool:${toolId}@${byEnv.host}`;
      const deps = svc.dependsOn.map((d) => d.name).filter((d) => names.includes(d));
      if (deps.length === 1) return `tool:${toolId}@${deps[0]}`;
    }
    const tool = CATALOG_BY_ID.get(toolId)!;
    const generic = this.toolNode(tool, 'strong', `tool:${toolId}`, `${tool.name} (instance not determined)`);
    generic.display = 'node';
    return generic.id;
  }

  /** Backend database for an ORM, from datasource/dialect configuration. */
  ormBackend(ormId: string): { tool: string; evidence: string[]; inferred?: boolean } | undefined {
    const t = CATALOG_BY_ID.get(ormId);
    const req = t?.requires?.[0];
    const cfgs = this.facts.configs.filter((c) => c.via === ormId && c.tool && (c.kind === 'datasource' || c.kind === 'dialect' || c.kind === 'url'));
    if (cfgs.length) {
      return { tool: cfgs[0].tool, evidence: cfgs.slice(0, 3).map((c) => this.e({ kind: c.file.endsWith('.prisma') ? 'schema' : 'config', file: c.file, line: c.line, snippet: c.snippet, detail: this.configDetail(c) })) };
    }
    if (req) return { tool: req.id, evidence: [] };
    // Env-driven datasource (Prisma `url = env("DATABASE_URL")`): resolve through Compose environments.
    // One relational database with direct evidence (driver import, connection string, container): the ORM talks to it.
    if (ormId !== 'mongoose') {
      const relational = [...this.nodes.values()].filter((n) => n.catalog && RELATIONAL.has(n.catalog) && n.catalog !== 'sql-database' && n.confidence === 'confirmed');
      const ids = [...new Set(relational.map((n) => n.catalog!))];
      if (ids.length === 1) {
        const n = relational.find((x) => x.catalog === ids[0])!;
        const ev = [...n.evidence].map((id) => this.ev.get(id)!).filter((e) => e && (e.kind === 'config' || e.kind === 'compose' || e.kind === 'import' || e.kind === 'terraform')).slice(0, 2).map((e) => e.id);
        return { tool: ids[0], evidence: ev, inferred: true };
      }
    }
    const envCfg = this.facts.configs.find((c) => c.via === ormId && c.envVar);
    if (envCfg) {
      for (const cf of this.facts.infra.compose) {
        for (const svc of cf.services) {
          const e = svc.environment.find((v) => v.key === envCfg.envVar && v.scheme);
          const tool = e?.scheme ? toolForScheme(e.scheme) : undefined;
          if (tool && e) return { tool: tool.id, evidence: [this.e({ kind: 'compose', file: cf.file, line: e.line, snippet: `${e.key}=${e.scheme}://…${e.host ? e.host : ''}`, detail: `${envCfg.envVar} points at ${tool.name}` })] };
        }
      }
    }
    return undefined;
  }

  private codeEdges() {
    const callsByToolFile = new Map<string, CallFact[]>();
    for (const c of this.facts.calls) {
      const k = `${c.tool}\0${c.file}`;
      if (!callsByToolFile.has(k)) callsByToolFile.set(k, []);
      callsByToolFile.get(k)!.push(c);
    }

    for (const [toolId, files] of this.codeFiles) {
      const tool = CATALOG_BY_ID.get(toolId);
      const node = this.nodes.get(`tool:${toolId}`);
      if (!tool) continue;
      for (const [file, evs] of files) {
        const allCalls = callsByToolFile.get(`${toolId}\0${file}`) ?? [];
        for (const appId of this.appsOf(file)) {
          const app = this.nodes.get(appId)!;
          // In code shared by several processes, only call sites this process reaches count.
          const calls = allCalls.filter((c) => this.reaches(appId, c.file, c.line));
          const reach = this.reachable(appId);
          const closure = this.appById(appId)?.closure;
          // The tool is called somewhere in this process's code, but not from anything it runs.
          const unreached = !!reach && !calls.length && this.facts.calls.some((c) => c.tool === toolId && closure?.has(c.file));
          if (unreached && (tool.display ?? 'node') !== 'chip') continue;
          app.files.add(file, undefined, 'code');
          if ((tool.display ?? 'node') === 'chip') {
            if (node) node.hosts.add(appId);
            if (SERVER_TOOLS.has(toolId) || UI_TOOLS.has(toolId)) app.app!.frameworks.includes(tool.name) || app.app!.frameworks.push(tool.name);
            if (!app.app!.chips.includes(`tool:${toolId}`)) app.app!.chips.push(`tool:${toolId}`);
            if (tool.category === 'orm' && !unreached) this.ormEdge(appId, toolId, file, evs, calls);
            if (toolId === 'celery') continue;
            continue;
          }
          const target = this.targetFor(toolId, appId);
          const onlyConfig = !calls.length && evs.every((id) => this.ev.get(id)?.kind === 'config');
          const labels = calls.length ? [...new Set(calls.map((c) => opLabel(c.op, toolId)))] : onlyConfig ? (['uses'] as EdgeLabel[]) : [this.defaultLabel(tool)];
          const overlays: Overlay[] = ['dataflow'];
          if (tool.category === 'auth') overlays.push('security');
          const conf: Confidence = calls.length || evs.length ? 'confirmed' : 'strong';
          for (const label of labels) {
            const isAsync = label === 'publish' || label === 'enqueue' || label === 'pub/sub';
            if (label === 'consume') this.edge(target, appId, 'consume', overlays, conf, evs, `${app.name} consumes from ${tool.name} (${this.ev.citeList(evs)}).`, true);
            else if (label === 'webhook') this.edge(target, appId, 'webhook', ['dataflow', 'security'], conf, evs, `${tool.name} calls ${app.name}'s webhook handler (${this.ev.citeList(evs)}).`);
            else this.edge(appId, target, label, overlays, conf, evs, `${app.name} ${this.verb(label)} ${tool.name} in ${this.ev.citeList(evs)}.`, isAsync);
          }
          const tn = this.nodes.get(target);
          if (tn) {
            tn.files.add(file, calls[0]?.line ?? this.ev.get(evs[0])?.line, calls.length ? calls.map((c) => opText(c.op).toLowerCase()).join(', ') : 'import');
            for (const c of calls) {
              if (!tn.ops.has(c.op)) tn.ops.set(c.op, new Set());
              tn.ops.get(c.op)!.add(file);
            }
          }
        }
      }
    }

    // Tools with only manifest evidence: attach to the app whose manifest declares them.
    for (const n of this.nodes.values()) {
      if (n.kind !== 'tool' || !n.catalog || this.codeFiles.has(n.catalog) || n.confidence !== 'strong') continue;
      const tool = CATALOG_BY_ID.get(n.catalog)!;
      for (const m of this.facts.manifests) {
        const d = m.dependencies.find((dep) => !dep.dev && toolsForPackage(m.ecosystem, dep.name).some((t) => t.id === tool.id));
        if (!d) continue;
        const app = this.apps.find((a) => a.root === m.dir) ?? this.apps.find((a) => a.root === '' || m.dir.startsWith(a.root + '/'));
        if (!app) continue;
        const evidence = this.e({ kind: 'manifest', file: m.file, line: d.line, snippet: `${d.name}${d.spec ? ' ' + d.spec : ''}`, detail: `Declares ${d.name}${d.spec ? ` ${d.spec}` : ''}` });
        if ((tool.display ?? 'node') === 'chip') {
          n.hosts.add(app.id);
          const a = this.nodes.get(app.id)!;
          if (!a.app!.chips.includes(n.id)) a.app!.chips.push(n.id);
        } else {
          this.edge(app.id, n.id, 'uses', ['dependency'], 'strong', [evidence], `${app.name} declares ${d.name} in ${m.file}:${d.line}; no call site was found, so how it is used is not known.`);
        }
      }
    }
  }

  private ormEdge(appId: string, ormId: string, file: string, evs: string[], calls: CallFact[]) {
    // Migrations change the schema at deploy time; they are not queries on the request path.
    if (MIGRATION_TOOLS.has(ormId) || MIGRATION_FILE.test(file)) return;
    const backend = this.ormBackend(ormId);
    const orm = CATALOG_BY_ID.get(ormId)!;
    const app = this.nodes.get(appId)!;
    let target: string;
    if (backend) {
      const dbTool = CATALOG_BY_ID.get(backend.tool);
      if (!dbTool) return;
      target = this.targetFor(backend.tool, appId);
      const db = this.nodes.get(target) ?? this.toolNode(dbTool, backend.evidence.length ? 'confirmed' : 'strong', target);
      db.display = 'node';
      for (const e of backend.evidence) db.evidence.add(e);
      const why = backend.inferred
        ? `${orm.name} is not configured for a specific engine in the analyzed files; ${dbTool.name} is the only relational database with direct evidence (${this.ev.citeList(backend.evidence, 2)})`
        : backend.evidence.length
          ? `${orm.name} is configured for ${dbTool.name} (${this.ev.citeList(backend.evidence, 1)})`
          : (orm.requires?.[0]?.reason ?? '').replace(/\.$/, '');
      if (!db.reasons.some((r) => r.includes(orm.name))) db.reasons.push(`${why}.`);
      this.edge(`tool:${ormId}`, target, 'depends on', ['dependency'], backend.evidence.length && !backend.inferred ? 'confirmed' : 'strong', backend.evidence, `${why}.`);
    } else {
      const generic = this.node('tool:sql-database', {
        kind: 'tool',
        name: 'Database (engine not determined)',
        category: 'database',
        layer: 'data',
        display: 'node',
        confidence: 'strong',
        description: 'A database used through an ORM whose engine is not declared in the analyzed files.',
      });
      if (!generic.reasons.length) generic.reasons.push(`${orm.name} is used, but no datasource, dialect or connection string names the database engine.`);
      target = generic.id;
    }
    const label: EdgeLabel = ormId === 'mongoose' ? 'query' : 'SQL';
    const all = [...evs, ...calls.map((c) => this.callEvidence(c))];
    this.edge(appId, target, label, ['dataflow'], 'confirmed', all, `${app.name} queries the database through ${orm.name} in ${this.ev.citeList(all)}.`);
    const tn = this.nodes.get(target)!;
    tn.files.add(file, calls[0]?.line ?? this.ev.get(evs[0])?.line, calls.length ? `${calls.length} ${orm.name} ${calls.length === 1 ? 'query' : 'queries'}` : `${orm.name} import`);
    for (const c of calls) {
      if (!tn.ops.has(c.op)) tn.ops.set(c.op, new Set());
      tn.ops.get(c.op)!.add(file);
    }
    if (!tn.roles.includes(`via ${orm.name}`)) tn.roles.push(`via ${orm.name}`);
  }

  private defaultLabel(tool: CatalogEntry): EdgeLabel {
    switch (tool.category) {
      case 'database':
        return RELATIONAL.has(tool.id) ? 'SQL' : 'query';
      case 'storage':
        return 'object storage';
      case 'email':
        return 'email';
      case 'auth':
        return tool.id.startsWith('oauth-') ? 'OAuth' : 'auth';
      case 'payments':
      case 'ai':
      case 'messaging':
      case 'service':
      case 'observability':
      case 'analytics':
      case 'realtime':
      case 'search':
        return 'API call';
      default:
        return 'uses';
    }
  }

  verb(label: EdgeLabel): string {
    switch (label) {
      case 'SQL':
      case 'query':
        return 'queries';
      case 'cache read':
        return 'reads from';
      case 'cache write':
        return 'writes to';
      case 'publish':
      case 'pub/sub':
        return 'publishes to';
      case 'enqueue':
        return 'enqueues jobs on';
      case 'object storage':
        return 'stores objects in';
      case 'REST':
      case 'API call':
        return 'calls';
      case 'OAuth':
        return 'signs users in with';
      case 'auth':
        return 'authenticates with';
      case 'email':
        return 'sends email through';
      default:
        return 'uses';
    }
  }

  // --- HTTP -----------------------------------------------------------------------------------------------------------------------------

  private httpEdges() {
    const composeHosts = new Map<string, string>();
    for (const [name, id] of this.serviceNode) composeHosts.set(name.toLowerCase(), id);
    const allRoutes = this.facts.routes;
    let unknown = 0;

    // UI code inside server apps (Next.js pages, SSR apps) gets a browser client node.
    for (const app of this.apps) {
      if (app.kind !== 'service') continue;
      const pages = (this.routesByApp.get(app.id) ?? []).filter((r) => r.kind === 'page');
      const uiFiles = [...(this.codeFiles.get('react')?.keys() ?? []), ...(this.codeFiles.get('vue')?.keys() ?? []), ...(this.codeFiles.get('svelte')?.keys() ?? [])].filter((f) => this.appsOf(f).includes(app.id));
      if (!pages.length && !uiFiles.length) continue;
      const framework = pages[0]?.framework === 'nextjs' ? 'Next.js' : uiFiles.length ? (this.codeFiles.get('react')?.size ? 'React' : this.codeFiles.get('vue')?.size ? 'Vue' : 'Svelte') : 'web';
      const id = `client:${app.id.slice(4)}`;
      const single = this.apps.filter((a) => a.kind === 'service').length === 1;
      const n = this.node(id, { kind: 'app', name: single ? 'Browser' : `Browser · ${app.name}`, category: 'frontend', layer: 'clients', display: 'node', confidence: 'confirmed', description: 'The part of the application that runs in the user’s browser.' });
      n.app = { root: app.root, frameworks: [framework], chips: [], entry: undefined };
      const evidence: string[] = [];
      for (const r of pages.slice(0, 5)) {
        const e = this.e({ kind: 'route', file: r.file, line: r.line, snippet: r.file, detail: `Page ${r.path} (${r.framework} file convention)` });
        evidence.push(e);
        n.files.add(r.file, undefined, 'page');
      }
      for (const f of uiFiles.slice(0, 40)) n.files.add(f, undefined, 'ui');
      for (const e of evidence) n.evidence.add(e);
      for (const f of uiFiles.slice(0, 3)) {
        const imp = this.facts.imports.find((i) => i.file === f && UI_TOOLS.has(toolsForModule(i.lang, i.module)[0]?.id ?? ''));
        if (imp) n.evidence.add(this.e({ kind: 'import', file: imp.file, line: imp.line, snippet: imp.snippet, detail: `Imports ${imp.module}` }));
      }
      n.reasons.push(pages.length ? `${app.name} serves ${pages.length} pages by ${pages[0].framework} file convention (first: ${pages[0].file}).` : `${uiFiles.length} files in ${app.name} import a UI framework.`);
      if (pages.length) this.edge(id, app.id, 'HTTP', ['dataflow'], 'strong', evidence, `The browser requests pages that ${app.name} renders (${pages.length} page files by ${pages[0].framework} convention).`);
      (app as AppInfo & { clientNode?: string }).clientNode = id;
    }

    // Relative URLs only resolve in a browser, so JS files outside every app that fetch relative
    // paths are browser scripts calling the server that declares the matching route.
    const browserCalls = this.facts.httpCalls.filter((h) => !this.appsOf(h.file).length && !TEST_FILE.test(h.file) && h.url?.startsWith('/') && !h.url.startsWith('//') && /\.[cm]?[jt]sx?$|\.vue$|\.svelte$/.test(h.file));
    for (const call of browserCalls) {
      const matches = bestRoutes(allRoutes.filter((r) => r.kind !== 'page' && (!call.method || r.method === 'ANY' || r.method === call.method)), call.url!);
      const targets = new Set(matches.flatMap((r) => this.appsOf(r.file)));
      if (!targets.size) continue;
      const callEv = this.e({ kind: 'http-call', file: call.file, line: call.line, snippet: call.snippet, detail: `${call.client}${call.method ? ` ${call.method}` : ''} ${call.url}` });
      const client = this.node('client:browser', { kind: 'app', name: 'Browser scripts', category: 'frontend', layer: 'clients', display: 'node', confidence: 'confirmed', description: 'Script files that call the API with relative URLs, which only resolve in a browser.' });
      client.app ??= { root: '', frameworks: [], chips: [] };
      client.evidence.add(callEv);
      client.files.add(call.file, call.line, 'HTTP call');
      if (!client.reasons.length) client.reasons.push(`${call.file} calls the API with relative URLs (${call.url} at line ${call.line}); relative URLs only resolve in a browser.`);
      for (const t of targets) {
        const route = matches.find((r) => this.appsOf(r.file).includes(t))!;
        const routeEv = this.e({ kind: 'route', file: route.file, line: route.line, snippet: route.snippet, detail: `${route.method} ${route.path}` });
        this.edge('client:browser', t, 'REST', ['dataflow'], 'confirmed', [callEv, routeEv], `${call.file}:${call.line} requests ${call.url}, handled by ${route.method} ${route.path} (${route.file}:${route.line}).`);
      }
    }

    for (const call of this.facts.httpCalls) {
      const fromApps = this.appsOf(call.file);
      if (!fromApps.length) continue;
      const callEv = this.e({ kind: 'http-call', file: call.file, line: call.line, snippet: call.snippet, detail: `${call.client}${call.method ? ` ${call.method}` : ''} ${call.url ?? (call.envVar ? `(URL from ${call.envVar})` : '(URL computed at runtime)')}` });
      for (const appId of fromApps) {
        if (!this.reaches(appId, call.file, call.line)) continue;
        const app = this.appById(appId)!;
        const sourceId = this.isUiFile(call.file, app) ? ((app as AppInfo & { clientNode?: string }).clientNode ?? appId) : appId;
        // 1. Literal external host.
        if (call.host && !LOCAL_HOSTS.test(call.host)) {
          const internal = composeHosts.get(call.host.split('.')[0]);
          if (internal && !call.host.includes('.')) {
            this.edge(sourceId, internal, 'REST', ['dataflow'], 'confirmed', [callEv], `${app.name} calls ${call.url} (${call.file}:${call.line}); "${call.host}" is a Compose service.`);
            continue;
          }
          const known = KNOWN_HOSTS.find(([re]) => re.test(call.host!))?.[1];
          const target = known ? this.toolNode(CATALOG_BY_ID.get(known)!, 'confirmed') : this.node(`host:${call.host}`, { kind: 'host', name: call.host, category: 'service', layer: 'external', display: 'node', confidence: 'confirmed', description: 'A remote HTTP host called with a literal URL.' });
          target.display = 'node';
          target.evidence.add(callEv);
          target.files.add(call.file, call.line, 'HTTP call');
          if (!target.reasons.length) target.reasons.push(`Called with a literal URL in ${call.file}:${call.line}.`);
          this.edge(sourceId, target.id, 'REST', ['dataflow'], 'confirmed', [callEv], `${app.name} calls ${call.url} (${call.file}:${call.line}).`);
          continue;
        }
        // 2. Relative path: match against declared routes.
        if (call.url && call.url.startsWith('/') && !call.url.startsWith('//')) {
          const matches = bestRoutes(allRoutes.filter((r) => r.kind !== 'page' && (!call.method || r.method === 'ANY' || r.method === call.method)), call.url!);
          const targets = new Set(matches.flatMap((r) => this.appsOf(r.file)));
          for (const t of targets) {
            const route = matches.find((r) => this.appsOf(r.file).includes(t))!;
            const routeEv = this.e({ kind: 'route', file: route.file, line: route.line, snippet: route.snippet, detail: `${route.method} ${route.path}` });
            if (t === appId && sourceId === appId) continue; // a server calling its own route
            this.edge(sourceId, t, 'REST', ['dataflow'], 'confirmed', [callEv, routeEv], `${call.file}:${call.line} requests ${call.url}, handled by ${route.method} ${route.path} (${route.file}:${route.line}).`);
          }
          if (!targets.size && sourceId !== appId) unknown++;
          continue;
        }
        // 3. URL from an env var: resolve through the app's Compose environment.
        if (call.envVar) {
          const env = app.compose?.service.environment.find((e) => e.key === call.envVar && e.host);
          const target = env?.host ? composeHosts.get(env.host.toLowerCase()) : undefined;
          if (target && env) {
            const envEv = this.e({ kind: 'compose', file: app.compose!.file, line: env.line, snippet: `${env.key}=${env.scheme}://${env.host}`, detail: `${env.key} points at Compose service "${env.host}"` });
            this.edge(sourceId, target, env.scheme?.startsWith('http') ? 'REST' : 'uses', ['dataflow'], 'confirmed', [callEv, envEv], `${app.name} calls the URL in ${call.envVar} (${call.file}:${call.line}), which Compose sets to service "${env.host}".`);
            continue;
          }
          // Relative path under an env base: match route paths (strong inference).
          if (call.url?.startsWith('/')) {
            const matches = bestRoutes(allRoutes.filter((r) => r.kind !== 'page' && (!call.method || r.method === 'ANY' || r.method === call.method)), call.url!);
            const targets = new Set(matches.flatMap((r) => this.appsOf(r.file)).filter((t) => t !== appId));
            if (targets.size === 1) {
              const t = [...targets][0];
              const route = matches.find((r) => this.appsOf(r.file).includes(t))!;
              const routeEv = this.e({ kind: 'route', file: route.file, line: route.line, snippet: route.snippet, detail: `${route.method} ${route.path}` });
              this.edge(sourceId, t, 'REST', ['dataflow'], 'strong', [callEv, routeEv], `${call.file}:${call.line} requests ${call.url} under a base URL from ${call.envVar}; the path matches ${route.method} ${route.path} (${route.file}:${route.line}), but the base URL itself is configuration.`);
              continue;
            }
          }
        }
        unknown++;
      }
    }
    if (unknown) this.limitations.push(`${unknown} outbound HTTP ${unknown === 1 ? 'call has' : 'calls have'} a target that cannot be determined statically (URL computed at runtime or read from configuration); ${unknown === 1 ? 'it is' : 'they are'} shown in flows as "Outbound call target unknown".`);
  }

  isUiFile(file: string, app: AppInfo): boolean {
    if (app.kind === 'client') return false;
    const ui = ['react', 'vue', 'svelte', 'angular', 'solid', 'preact'].some((t) => this.codeFiles.get(t)?.has(file));
    return ui && !/(?:^|\/)(?:api|server|routes?)\//.test(file) && !this.facts.routes.some((r) => r.file === file && r.kind !== 'page');
  }

  // --- Queues -----------------------------------------------------------------------------------------------------------------------------

  private queueEdges() {
    const { facts } = this;
    // Celery: producers → broker → worker.
    const celeryWorkers = this.apps.filter((a) => a.kind === 'worker' && (a.synthesized || /celery/.test(a.compose?.service.command?.text ?? '') || facts.definitions.some((d) => d.tool === 'celery' && this.appsOf(d.file).includes(a.id))));
    const enqueues = facts.calls.filter((c) => c.tool === 'celery' && c.op === 'enqueue');
    if (celeryWorkers.length && (enqueues.length || facts.definitions.some((d) => d.tool === 'celery'))) {
      const brokerCfg = facts.configs.find((c) => c.kind === 'broker' && c.tool) ?? facts.configs.find((c) => c.kind === 'broker');
      let broker: { tool: string; evidence: string[] } | undefined;
      if (brokerCfg?.tool) broker = { tool: brokerCfg.tool, evidence: [this.e({ kind: 'config', file: brokerCfg.file, line: brokerCfg.line, snippet: brokerCfg.snippet, detail: this.configDetail(brokerCfg) })] };
      else if (brokerCfg?.envVar) {
        for (const cf of facts.infra.compose) for (const svc of cf.services) {
          const e = svc.environment.find((v) => v.key === brokerCfg.envVar && v.scheme);
          const tool = e?.scheme ? toolForScheme(e.scheme) : undefined;
          if (tool && e && !broker) broker = { tool: tool.id, evidence: [this.e({ kind: 'config', file: brokerCfg.file, line: brokerCfg.line, snippet: brokerCfg.snippet, detail: `Celery broker URL is read from ${brokerCfg.envVar}` }), this.e({ kind: 'compose', file: cf.file, line: e.line, snippet: `${e.key}=${e.scheme}://${e.host ?? ''}`, detail: `${e.key} is set to a ${tool.name} URL` })] };
        }
      }
      for (const worker of celeryWorkers) {
        const workerEv = [...worker.evidence];
        if (broker) {
          const target = this.targetFor(broker.tool, worker.id);
          const bn = this.nodes.get(target) ?? this.toolNode(CATALOG_BY_ID.get(broker.tool)!, 'confirmed', target);
          bn.display = 'node';
          for (const e of broker.evidence) bn.evidence.add(e);
          if (!bn.roles.includes('Celery broker')) bn.roles.push('Celery broker');
          this.edge(target, worker.id, 'consume', ['dataflow'], 'confirmed', [...broker.evidence, ...workerEv.slice(0, 2)], `The Celery worker takes tasks from ${bn.name} (${this.ev.citeList(broker.evidence, 1)}).`, true);
        }
      }
      for (const call of enqueues) {
        const ev = this.callEvidence(call);
        for (const appId of this.appsOf(call.file).filter((a) => this.reaches(a, call.file, call.line))) {
          if (celeryWorkers.some((w) => w.id === appId) && !this.appById(appId)?.synthesized && celeryWorkers.length === 1 && this.apps.length > 1) {
            // Tasks enqueued from inside the worker still go through the broker.
          }
          const app = this.nodes.get(appId)!;
          if (broker) {
            const target = this.targetFor(broker.tool, appId);
            this.edge(appId, target, 'enqueue', ['dataflow'], 'confirmed', [ev, ...broker.evidence], `${app.name} enqueues Celery task "${call.arg}" (${call.file}:${call.line}) on the broker.`, true);
          } else {
            for (const w of celeryWorkers) if (w.id !== appId) this.edge(appId, w.id, 'enqueue', ['dataflow'], 'strong', [ev], `${app.name} enqueues Celery task "${call.arg}" (${call.file}:${call.line}); the broker between them is not declared in the analyzed files.`, true);
          }
        }
      }
      if (!broker) this.limitations.push('Celery is used, but its broker could not be determined from code, configuration or Compose environment.');
    }

    // BullMQ / Bull: producers (queue.add) and consumers (new Worker) meet in Redis.
    const bull = facts.calls.filter((c) => c.tool === 'bullmq');
    const bullConsumers = facts.definitions.filter((d) => d.tool === 'bullmq' && d.kind === 'queue-consumer');
    if (bull.length || bullConsumers.length) {
      const redisConf: Confidence = this.nodes.get('tool:redis')?.confidence === 'confirmed' ? 'confirmed' : 'strong';
      for (const c of bull.filter((x) => x.op === 'enqueue')) {
        const ev = this.callEvidence(c);
        for (const appId of this.appsOf(c.file).filter((a) => this.reaches(a, c.file, c.line))) {
          const target = this.targetFor('redis', appId);
          this.ensureRedis(target, 'BullMQ job storage');
          this.edge(appId, target, 'enqueue', ['dataflow'], redisConf, [ev], `${this.nodes.get(appId)!.name} adds jobs to queue "${c.arg ?? '?'}" (${c.file}:${c.line}); BullMQ stores jobs in Redis.`, true);
        }
      }
      for (const d of bullConsumers) {
        const ev = this.e({ kind: 'queue', file: d.file, line: d.line, snippet: d.snippet, detail: `BullMQ worker for queue "${d.name ?? '?'}"` });
        for (const appId of this.appsOf(d.file)) {
          const target = this.targetFor('redis', appId);
          this.ensureRedis(target, 'BullMQ job storage');
          this.edge(target, appId, 'consume', ['dataflow'], redisConf, [ev], `${this.nodes.get(appId)!.name} processes queue "${d.name ?? '?'}" (${d.file}:${d.line}).`, true);
        }
      }
    }

    // RQ enqueues and consume definitions for brokers (Kafka, RabbitMQ, SQS…) are handled in codeEdges via ops.
  }

  private ensureRedis(id: string, role: string) {
    const n = this.nodes.get(id) ?? this.toolNode(CATALOG_BY_ID.get('redis')!, 'strong', id);
    n.display = 'node';
    if (!n.roles.includes(role)) n.roles.push(role);
    if (n.confidence !== 'confirmed' && !n.reasons.some((r) => r.includes('BullMQ'))) n.reasons.push('BullMQ stores jobs in Redis by design; no Redis client or container was found directly.');
  }

  // --- Edge / proxies ----------------------------------------------------------------------------------------------------------------------

  private proxyEdges() {
    const { infra } = this.facts;
    for (const p of infra.proxies) {
      const toolId = p.kind === 'caddy' ? 'caddy' : p.kind === 'traefik' ? 'traefik' : 'nginx';
      const proxyId = this.nodes.has(`tool:${toolId}`) ? `tool:${toolId}` : [...this.nodes.keys()].find((k) => k.startsWith(`tool:${toolId}@`)) ?? `tool:${toolId}`;
      const proxy = this.nodes.get(proxyId) ?? this.toolNode(CATALOG_BY_ID.get(toolId)!, 'confirmed');
      const ev = this.e({ kind: 'proxy', file: p.file, line: p.line, snippet: p.snippet, detail: `${p.kind} forwards ${p.path ?? 'requests'} to ${p.upstream}${p.port ? `:${p.port}` : ''}` });
      proxy.evidence.add(ev);
      proxy.files.add(p.file, p.line, 'proxy config');
      const target = this.serviceNode.get(p.upstream) ?? this.serviceNode.get(p.upstream.split('.')[0]);
      if (target) this.edge(proxy.id, target, 'proxy', ['dataflow', 'deployment'], 'confirmed', [ev], `${proxy.name} forwards ${p.path ?? 'requests'} to "${p.upstream}" (${p.file}:${p.line}).`);
      else if (LOCAL_HOSTS.test(p.upstream) && p.port) {
        const byPort = this.apps.filter((a) => a.compose?.service.ports.some((x) => x.target === p.port) || a.compose?.service.expose.some((x) => x.port === p.port));
        if (byPort.length === 1) this.edge(proxy.id, byPort[0].id, 'proxy', ['dataflow', 'deployment'], 'strong', [ev], `${proxy.name} forwards to port ${p.port} (${p.file}:${p.line}), the port "${byPort[0].name}" listens on.`);
        else proxy.badges.push({ text: `forwards to ${p.upstream}:${p.port}`, tone: 'neutral', evidence: [ev] });
      }
    }
    // Traefik routes to containers that opt in with labels.
    for (const cf of infra.compose) {
      for (const svc of cf.services) {
        const label = svc.labels.find((l) => /^traefik\.(?:enable=true|http\.routers\.)/.test(l.text));
        if (!label) continue;
        const traefik = [...this.nodes.keys()].find((k) => k === 'tool:traefik' || k.startsWith('tool:traefik@'));
        const target = this.serviceNode.get(svc.name);
        if (!traefik || !target) continue;
        const ev = this.e({ kind: 'compose', file: cf.file, line: label.line, snippet: label.text.slice(0, 160), detail: `Traefik routing label on "${svc.name}"` });
        this.edge(traefik, target, 'proxy', ['dataflow', 'deployment'], 'confirmed', [ev], `Traefik routes to "${svc.name}" via its labels (${cf.file}:${label.line}).`);
      }
    }
    // Next.js middleware runs in front of routes.
    for (const d of this.facts.definitions.filter((x) => x.kind === 'auth-middleware' && x.tool === 'nextjs-middleware')) {
      const ev = this.e({ kind: 'config', file: d.file, line: d.line, snippet: d.snippet, detail: 'Next.js middleware (runs before matching routes)' });
      const n = this.toolNode(CATALOG_BY_ID.get('nextjs-middleware')!, 'confirmed');
      n.evidence.add(ev);
      n.files.add(d.file, d.line, 'middleware');
      // Auth when the middleware (or a module it imports/re-exports, like `export { auth as middleware } from '@/auth'`) uses an auth library.
      const near = [d.file, ...(this.fileGraph.out.get(d.file) ?? []).map((h) => h.target)];
      const authImport = this.facts.imports.find((i) => near.includes(i.file) && toolsForModule(i.lang, i.module).some((t) => t.category === 'auth'));
      const auth = this.facts.calls.some((c) => c.file === d.file && c.op === 'auth') || !!authImport;
      if (authImport) n.evidence.add(this.e({ kind: 'import', file: authImport.file, line: authImport.line, snippet: authImport.snippet, detail: `Imports ${authImport.module}` }));
      for (const appId of this.appsOf(d.file)) {
        this.edge(n.id, appId, 'proxy', auth ? ['dataflow', 'security'] : ['dataflow'], 'confirmed', [ev], `${d.file} runs before ${this.nodes.get(appId)!.name}'s routes.`);
        const client = `client:${appId.slice(4)}`;
        if (this.nodes.has(client)) this.edge(client, n.id, 'HTTP', ['dataflow'], 'strong', [ev], 'Requests from the browser pass through the middleware first.');
      }
      if (auth) {
        n.badges.push({ text: 'auth boundary', tone: 'accent', evidence: [ev, ...(authImport ? [this.e({ kind: 'import', file: authImport.file, line: authImport.line, snippet: authImport.snippet, detail: `Imports ${authImport.module}` })] : [])], overlay: 'security' });
        n.roles.push(`Auth boundary (${authImport ? CATALOG_BY_ID.get(toolsForModule(authImport.lang, authImport.module).find((t) => t.category === 'auth')!.id)?.name : 'auth check'})`);
      } else n.roles.push('Runs before matching routes');
    }
  }

  // --- Compose wiring ---------------------------------------------------------------------------------------------------------------------------

  private composeEdges() {
    for (const cf of this.facts.infra.compose) {
      for (const svc of cf.services) {
        const from = this.serviceNode.get(svc.name);
        if (!from) continue;
        for (const dep of [...svc.dependsOn, ...svc.links]) {
          const to = this.serviceNode.get(dep.name);
          if (!to) continue;
          const ev = this.e({ kind: 'compose', file: cf.file, line: dep.line, snippet: `depends_on: ${dep.name}`, detail: `"${svc.name}" depends on "${dep.name}"` });
          this.edge(from, to, 'depends on', ['dependency', 'deployment'], 'confirmed', [ev], `Compose starts "${dep.name}" before "${svc.name}" (${cf.file}:${dep.line}).`);
        }
        for (const env of svc.environment) {
          if (!env.host) continue;
          const to = this.serviceNode.get(env.host);
          if (!to || to === from) continue;
          const tool = env.scheme ? toolForScheme(env.scheme) : undefined;
          const ev = this.e({ kind: 'compose', file: cf.file, line: env.line, snippet: `${env.key}=${env.scheme}://${env.host}`, detail: `${env.key} points "${svc.name}" at "${env.host}"` });
          // Configuration alone proves a connection, not what travels over it.
          const label: EdgeLabel = 'uses';
          void tool;
          const existing = this.edges.get(`${from}->${to}`);
          if (existing && existing.overlays.has('dataflow')) {
            existing.evidence.add(ev);
            existing.overlays.add('dependency');
          } else {
            this.edge(from, to, label, ['dataflow', 'dependency'], 'strong', [ev], `"${svc.name}" is configured to reach "${env.host}" through ${env.key} (${cf.file}:${env.line}); no call site confirms how it is used.`);
          }
        }
      }
    }
  }

  // --- Delivery: Docker, CI, hosting ---------------------------------------------------------------------------------------------------------------

  private deliveryEdges() {
    const { infra } = this.facts;
    if (infra.dockerfiles.length) {
      const docker = this.toolNode(CATALOG_BY_ID.get('docker')!, 'confirmed');
      for (const d of infra.dockerfiles) {
        const ev = this.e({ kind: 'dockerfile', file: d.file, line: d.stages[0]?.line ?? 1, snippet: d.stages.map((s) => `FROM ${s.image}`).join(' · ').slice(0, 160), detail: `Dockerfile (${d.stages.length} stage${d.stages.length === 1 ? '' : 's'})` });
        docker.evidence.add(ev);
        docker.files.add(d.file, d.stages[0]?.line, 'Dockerfile');
        const app = TEST_DOCKERFILE.test(d.file) ? undefined : this.apps.find((a) => a.dockerfile === d.file || (!a.compose && a.root === dirOf(d.file)));
        if (!app) continue;
        this.edge(docker.id, app.id, 'builds', ['deployment'], 'confirmed', [ev], `${d.file} builds the "${app.name}" image.`);
        const n = this.nodes.get(app.id)!;
        const base = d.stages.at(-1);
        if (base) n.badges.push({ text: `image FROM ${base.image}`, tone: 'neutral', evidence: [this.e({ kind: 'dockerfile', file: d.file, line: base.line, snippet: `FROM ${base.image}`, detail: `Runtime base image ${base.image}` })], overlay: 'deployment' });
        if (d.healthcheck) n.badges.push({ text: 'healthcheck', tone: 'neutral', evidence: [this.e({ kind: 'dockerfile', file: d.file, line: d.healthcheck, snippet: 'HEALTHCHECK', detail: 'Container healthcheck' })], overlay: 'deployment' });
      }
    }
    if (infra.compose.length) {
      const compose = this.toolNode(CATALOG_BY_ID.get('docker-compose')!, 'confirmed');
      for (const cf of infra.compose) {
        for (const svc of cf.services) {
          const target = this.serviceNode.get(svc.name);
          const ev = this.e({ kind: 'compose', file: cf.file, line: svc.line, snippet: `${svc.name}:`, detail: `Compose service "${svc.name}"` });
          compose.evidence.add(ev);
          if (target) this.edge(compose.id, target, 'hosts', ['deployment'], 'confirmed', [ev], `${cf.file} runs "${svc.name}".`);
          if (target && svc.replicas && svc.replicas.count > 1) this.nodes.get(target)?.badges.push({ text: `${svc.replicas.count} replicas`, tone: 'neutral', evidence: [this.e({ kind: 'compose', file: cf.file, line: svc.replicas.line, snippet: `replicas: ${svc.replicas.count}`, detail: `${svc.name} runs ${svc.replicas.count} replicas` })], overlay: 'deployment' });
        }
        compose.files.add(cf.file, undefined, 'compose');
      }
    }

    for (const ci of infra.ci) {
      const toolId = ci.system === 'bitbucket' ? 'bitbucket-pipelines' : ci.system;
      const tool = CATALOG_BY_ID.get(toolId);
      if (!tool) continue;
      const n = this.toolNode(tool, 'confirmed');
      n.files.add(ci.file, ci.jobs[0]?.line, 'pipeline');
      n.evidence.add(this.e({ kind: 'ci', file: ci.file, line: ci.jobs[0]?.line ?? 1, snippet: `${ci.name ?? ci.file}${ci.triggers.length ? ` · on ${ci.triggers.join(', ')}` : ''}`.slice(0, 160), detail: `CI pipeline${ci.triggers.length ? ` (on ${ci.triggers.join(', ')})` : ''}` }));
      for (const job of ci.jobs) {
        for (const step of job.steps) {
          const text = [step.uses, step.run, step.with ? Object.entries(step.with).map(([k, v]) => `${k}=${v}`).join(' ') : ''].filter(Boolean).join(' ');
          if (!text) continue;
          const snippetText = (step.run ?? step.uses ?? '').split('\n')[0].slice(0, 160);
          if (TEST_CMD.test(text)) {
            const ev = this.e({ kind: 'ci', file: ci.file, line: step.line, snippet: snippetText, detail: `Job "${job.name}" runs tests` });
            n.evidence.add(ev);
            if (!n.roles.includes('runs tests')) n.roles.push('runs tests');
            const app = this.appForCiText(text);
            if (app) this.edge(n.id, app.id, 'tests', ['deployment'], 'confirmed', [ev], `Job "${job.name}" runs tests for "${app.name}" (${ci.file}:${step.line}).`);
          }
          if (DOCKER_BUILD.test(text)) {
            const ev = this.e({ kind: 'ci', file: ci.file, line: step.line, snippet: snippetText, detail: `Job "${job.name}" builds a container image` });
            n.evidence.add(ev);
            if (!n.roles.includes('builds images')) n.roles.push('builds images');
            const app = this.appForCiText(text);
            if (app) this.edge(n.id, app.id, 'builds', ['deployment'], 'confirmed', [ev], `Job "${job.name}" builds the "${app.name}" image (${ci.file}:${step.line}).`);
            if (REGISTRY_PUSH.test(text) || /push\s*[=:]\s*true/.test(text)) {
              const reg = this.toolNode(CATALOG_BY_ID.get('container-registry')!, 'confirmed');
              reg.evidence.add(ev);
              this.edge(n.id, reg.id, 'deploys', ['deployment'], 'confirmed', [ev], `Job "${job.name}" pushes images to a registry (${ci.file}:${step.line}).`);
            }
          }
          for (const [re, target] of DEPLOY) {
            if (!re.test(text)) continue;
            const ev = this.e({ kind: 'ci', file: ci.file, line: step.line, snippet: snippetText, detail: `Job "${job.name}" deploys to ${CATALOG_BY_ID.get(target)?.name}` });
            const hosting = this.toolNode(CATALOG_BY_ID.get(target)!, 'confirmed');
            hosting.evidence.add(ev);
            if (!n.roles.includes('deploys')) n.roles.push('deploys');
            this.edge(n.id, hosting.id, 'deploys', ['deployment'], 'confirmed', [ev], `Job "${job.name}" deploys to ${hosting.name} (${ci.file}:${step.line}).`);
            break;
          }
        }
      }
    }

    for (const p of infra.platforms) {
      const tool = CATALOG_BY_ID.get(p.platform);
      if (!tool) continue;
      const ev = this.e({ kind: 'platform', file: p.file, line: p.line, snippet: p.snippet || p.file, detail: p.detail });
      const n = this.toolNode(tool, 'confirmed');
      n.evidence.add(ev);
      n.files.add(p.file, p.line, 'platform config');
      const dir = dirOf(p.file);
      const app = this.apps.filter((a) => a.kind !== 'worker' && (a.root === dir || dir.startsWith(a.root + '/') || a.root === '')).sort((a, b) => b.root.length - a.root.length)[0];
      if (app) this.edge(n.id, app.id, 'hosts', ['deployment'], 'strong', [ev], `${p.file} configures ${tool.name} for "${app.name}".`);
    }
  }

  private appForCiText(text: string): AppInfo | undefined {
    const candidates = this.apps.filter((a) => a.root && new RegExp(`(?:^|[\\s./=])${a.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[\\s/]|$)`).test(text));
    if (candidates.length === 1) return candidates[0];
    const services = this.apps.filter((a) => a.kind !== 'client');
    if (!candidates.length && this.apps.length === 1) return this.apps[0];
    if (!candidates.length && services.length === 1 && !/\b(?:web|frontend|client)\b/.test(text)) return services[0];
    return undefined;
  }

  // --- Security overlay --------------------------------------------------------------------------------------------------------------------------------

  private securityBadges() {
    const { facts } = this;
    for (const cf of facts.infra.compose) {
      for (const svc of cf.services) {
        const id = this.serviceNode.get(svc.name);
        const n = id ? this.nodes.get(id) : undefined;
        if (!n) continue;
        for (const p of svc.ports) {
          if (!p.published) continue;
          const ev = this.e({ kind: 'port', file: cf.file, line: p.line, snippet: `${p.published}:${p.target}`, detail: `"${svc.name}" publishes container port ${p.target} on host port ${p.published}` });
          const dataStore = n.category === 'database' || n.category === 'cache' || n.category === 'queue' || n.category === 'search';
          n.badges.push({ text: `port ${p.published} published`, tone: dataStore ? 'risk' : 'neutral', evidence: [ev], overlay: 'security' });
        }
        const secrets = svc.environment.filter((e) => e.secret);
        if (secrets.length) {
          const evs = secrets.map((s) => this.e({ kind: 'secret', file: cf.file, line: s.line, snippet: `${s.key}: ‹redacted›`, detail: `${s.key} is set to a literal value in ${cf.file}` }));
          n.badges.push({ text: `${secrets.length} plain-text secret${secrets.length === 1 ? '' : 's'}`, tone: 'risk', evidence: evs, overlay: 'security' });
        }
      }
    }
    for (const d of facts.infra.dockerfiles) {
      const app = TEST_DOCKERFILE.test(d.file) ? undefined : this.apps.find((a) => a.dockerfile === d.file || (!a.compose && a.root === dirOf(d.file)));
      if (!app) continue;
      for (const x of d.expose) this.nodes.get(app.id)!.badges.push({ text: `EXPOSE ${x.port}`, tone: 'neutral', evidence: [this.e({ kind: 'port', file: d.file, line: x.line, snippet: `EXPOSE ${x.port}`, detail: `Container listens on port ${x.port}` })], overlay: 'security' });
    }
    for (const app of this.apps) {
      const n = this.nodes.get(app.id)!;
      const secretsInCode = facts.secrets.filter((s) => s.kind === 'credential-pattern' && this.appsOf(s.file).includes(app.id));
      if (secretsInCode.length) {
        const evs = secretsInCode.slice(0, 10).map((s) => this.e({ kind: 'secret', file: s.file, line: s.line, snippet: '‹credential-shaped value redacted›', detail: 'Credential-shaped value in source (value not stored)' }));
        n.badges.push({ text: `${secretsInCode.length} credential-like value${secretsInCode.length === 1 ? '' : 's'} in source`, tone: 'risk', evidence: evs, overlay: 'security' });
      }
      const secretEnv = facts.envRefs.filter((e) => isSecretKey(e.name) && this.appsOf(e.file).includes(app.id));
      const names = [...new Set(secretEnv.map((e) => e.name))];
      if (names.length) {
        const evs = names.slice(0, 12).map((name) => {
          const ref = secretEnv.find((e) => e.name === name)!;
          return this.e({ kind: 'env', file: ref.file, line: ref.line, snippet: name, detail: `Reads secret ${name} from the environment` });
        });
        n.badges.push({ text: `reads ${names.length} secret${names.length === 1 ? '' : 's'} from env`, tone: 'neutral', evidence: evs, overlay: 'security' });
      }
      const routes = (this.routesByApp.get(app.id) ?? []).filter((r) => r.kind !== 'page');
      const guarded = routes.filter((r) => r.auth);
      if (routes.length && guarded.length) {
        const evs = guarded.slice(0, 12).map((r) => this.e({ kind: 'auth', file: r.file, line: r.auth!.line, snippet: r.auth!.snippet, detail: `Auth check on ${r.method} ${r.path}` }));
        n.badges.push({ text: `auth check on ${guarded.length}/${routes.length} routes`, tone: 'accent', evidence: evs, overlay: 'security' });
      }
    }
  }

  // --- Finalize ------------------------------------------------------------------------------------------------------------------------------------------

  private finalizeNodes() {
    for (const e of this.edges.values()) {
      const specific = [...e.labels].filter((l) => l !== 'uses' && l !== 'depends on');
      if (specific.length && e.labels.has('uses')) e.labels.delete('uses');
    }
    for (const n of this.nodes.values()) {
      const seenBadges = new Set<string>();
      n.badges = n.badges.filter((b) => {
        const key = `${b.text}|${b.overlay ?? ''}`;
        if (seenBadges.has(key)) {
          const first = n.badges.find((x) => `${x.text}|${x.overlay ?? ''}` === key)!;
          for (const ev of b.evidence) if (!first.evidence.includes(ev)) first.evidence.push(ev);
          return false;
        }
        seenBadges.add(key);
        return true;
      });
      if (n.kind === 'tool' && n.catalog && !n.version) n.version = this.versionFor(n.catalog, n.hosts);
      if (n.kind === 'app') {
        const app = this.appById(n.id);
        const routes = app ? (this.routesByApp.get(app.id) ?? []) : [];
        const api = routes.filter((r) => r.kind === 'api').length;
        const pages = routes.filter((r) => r.kind === 'page').length;
        const actions = routes.filter((r) => r.kind === 'action').length;
        const tasks = this.facts.definitions.filter((d) => d.kind === 'task' && app && this.appsOf(d.file).includes(app.id)).length;
        const parts: string[] = [];
        if (app?.kind === 'worker') parts.push(tasks ? `Background worker · ${tasks} task${tasks === 1 ? '' : 's'}` : 'Background worker');
        else if (app?.kind === 'client') parts.push('Frontend');
        else if (app?.kind === 'function') parts.push('Serverless functions');
        else if (n.id.startsWith('client:')) parts.push('Runs in the browser');
        else parts.push(api || actions ? 'HTTP server' : 'Application');
        if (api) parts.push(`${api} route${api === 1 ? '' : 's'}`);
        if (actions) parts.push(`${actions} server action${actions === 1 ? '' : 's'}`);
        if (pages && app?.kind !== 'worker') parts.push(`${pages} page${pages === 1 ? '' : 's'}`);
        n.roles.unshift(parts.join(' · '));
        // Framework names come from chips.
        if (n.app) {
          for (const chip of n.app.chips) {
            const t = CATALOG_BY_ID.get(chip.slice(5));
            if (t && (SERVER_TOOLS.has(t.id) || UI_TOOLS.has(t.id)) && !n.app.frameworks.includes(t.name)) n.app.frameworks.push(t.name);
          }
          const langs = new Map<string, number>();
          for (const f of n.files.paths()) {
            const lang = this.graph.nodes.find((g) => g.id === f)?.language;
            if (lang && lang !== 'json' && lang !== 'yaml') langs.set(lang, (langs.get(lang) ?? 0) + 1);
          }
          n.app.language = [...langs].sort((a, b) => b[1] - a[1])[0]?.[0];
        }
      } else if (n.kind === 'tool') {
        const opsText: string[] = [];
        const count = (ops: OpKind[]) => new Set(ops.flatMap((o) => [...(n.ops.get(o) ?? [])])).size;
        const reads = count(['cache-read']);
        const writes = count(['cache-write', 'cache-delete']);
        if (reads || writes) opsText.push([reads ? `reads in ${reads} file${reads === 1 ? '' : 's'}` : '', writes ? `writes in ${writes} file${writes === 1 ? '' : 's'}` : ''].filter(Boolean).join(', '));
        const sql = count(['sql', 'query']);
        if (sql) opsText.push(`queried in ${sql} file${sql === 1 ? '' : 's'}`);
        const pub = count(['publish', 'enqueue']);
        if (pub) opsText.push(`published to from ${pub} file${pub === 1 ? '' : 's'}`);
        const cons = count(['consume']);
        if (cons) opsText.push(`consumed in ${cons} file${cons === 1 ? '' : 's'}`);
        const obj = count(['object-read', 'object-write']);
        if (obj) opsText.push(`object reads/writes in ${obj} file${obj === 1 ? '' : 's'}`);
        const api = count(['payment', 'ai', 'email', 'send', 'search', 'http', 'rpc']);
        if (api) opsText.push(`called from ${api} file${api === 1 ? '' : 's'}`);
        const evFiles = new Set([...n.evidence].map((id) => this.ev.get(id)?.file).filter(Boolean));
        if (opsText.length) n.roles.unshift(opsText.join('; ').replace(/^./, (c) => c.toUpperCase()));
        else if (!n.files.size && evFiles.size && n.confidence === 'confirmed' && !n.roles.length) n.roles.unshift(`Configured in ${evFiles.size} file${evFiles.size === 1 ? '' : 's'}`);
        else if (n.files.size) {
          const imported = n.files.list().some((f) => f.uses.includes('import'));
          n.roles.unshift(`${imported ? 'Imported' : 'Configured'} in ${n.files.size} file${n.files.size === 1 ? '' : 's'}`);
        }
        if (!n.reasons.length) {
          const ids = [...n.evidence];
          if (ids.length) n.reasons.push(`Evidence: ${this.ev.citeList(ids, 3)}.`);
        } else if (n.confidence === 'confirmed' && n.reasons.every((r) => !/\d/.test(r))) {
          n.reasons.unshift(`Evidence: ${this.ev.citeList([...n.evidence], 3)}.`);
        }
        if (n.confidence === 'confirmed' && n.files.size) {
          const first = [...n.evidence].map((id) => this.ev.get(id)!).find((e) => e.kind === 'call' || e.kind === 'client-init' || e.kind === 'import');
          if (first && !n.reasons.some((r) => r.includes(`${first.file}:${first.line}`))) n.reasons.unshift(`${first.detail} in ${first.file}:${first.line}${n.files.size > 1 ? ` and ${n.files.size - 1} other file${n.files.size === 2 ? '' : 's'}` : ''}.`);
        }
      }
      if (n.kind === 'host' && !n.roles.length) n.roles.push(`Called with a literal URL from ${n.files.size} file${n.files.size === 1 ? '' : 's'}`);
      if (n.display === 'chip' && !n.hosts.size) n.display = 'node';
    }
  }

  versionFor(toolId: string, hosts?: Set<string>): ArchNode['version'] {
    const tool = CATALOG_BY_ID.get(toolId);
    if (!tool) return undefined;
    const roots = [...(hosts ?? [])].map((h) => this.appById(h)?.root).filter((r): r is string => r !== undefined);
    const candidates: { m: ManifestFact; d: ManifestDependency }[] = [];
    for (const m of this.facts.manifests) for (const d of m.dependencies) if (toolsForPackage(m.ecosystem, d.name).some((t) => t.id === toolId)) candidates.push({ m, d });
    if (!candidates.length) return undefined;
    candidates.sort((a, b) => Number(a.d.dev) - Number(b.d.dev) || Number(!roots.includes(a.m.dir)) - Number(!roots.includes(b.m.dir)) || a.m.dir.length - b.m.dir.length);
    const { m, d } = candidates[0];
    const lock = this.facts.lockfiles.filter((l) => l.ecosystem === m.ecosystem).sort((a, b) => Number(b.dir === m.dir) - Number(a.dir === m.dir) || a.dir.length - b.dir.length);
    // For servers (databases, caches, brokers) a client package's version is not the server's version.
    const pkg = SERVER_CATEGORIES.has(tool.category) || tool.id === 'sql-database' ? d.name : undefined;
    for (const l of lock) {
      const v = l.versions[d.name] ?? l.versions[d.name.toLowerCase()];
      if (v && (l.dir === m.dir || m.dir.startsWith(l.dir))) return { value: v, source: l.file, package: pkg };
    }
    if (d.spec) return { value: d.spec.replace(/^==\s*(?=\d)/, '').replace(/^v(?=\d)/, ''), source: m.file, line: d.line, package: pkg };
    return undefined;
  }
}

export function detectArchitecture(input: DetectInput): Architecture {
  const d = new Detector(input.facts, input.graph);
  d.run();
  const flows = buildFlows(d);
  const blast: Record<string, BlastRadius> = {};
  for (const n of d.nodes.values()) blast[n.id] = blastRadius(d, n.id);
  if (input.facts.warnings.length) d.limitations.push(`${input.facts.warnings.length} file${input.facts.warnings.length === 1 ? '' : 's'} could not be parsed and were skipped: ${input.facts.warnings.slice(0, 3).map((w) => `${w.file} (${w.message})`).join('; ')}${input.facts.warnings.length > 3 ? '…' : ''}.`);

  const nodes: ArchNode[] = [...d.nodes.values()]
    .map((n) => ({
      id: n.id,
      kind: n.kind,
      name: n.name,
      category: n.category,
      layer: n.layer,
      display: n.display,
      hosts: n.hosts.size ? [...n.hosts] : undefined,
      version: n.version,
      confidence: n.confidence,
      role: n.roles.filter(Boolean).join(' · ') || (n.kind === 'tool' ? 'Declared' : ''),
      description: n.description,
      reason: n.reasons.join(' '),
      evidence: [...n.evidence],
      files: n.files.list(),
      badges: n.badges,
      app: n.app,
    }))
    .sort((a, b) => LAYERS.indexOf(a.layer) - LAYERS.indexOf(b.layer) || (a.kind === 'app' ? 0 : 1) - (b.kind === 'app' ? 0 : 1) || (a.name < b.name ? -1 : 1));

  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges: ArchEdge[] = [...d.edges.values()]
    .filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target))
    .map((e) => ({ id: e.id, source: e.source, target: e.target, labels: [...e.labels], overlays: [...e.overlays], confidence: e.confidence, async: e.async, evidence: [...e.evidence], reason: e.reasons.join(' ') }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  const layers = LAYERS.filter((l) => nodes.some((n) => n.layer === l && n.display === 'node'));
  const evidence = Object.fromEntries([...d.ev.all].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  const arch: Architecture = {
    version: ARCH_DETECTOR_VERSION,
    generatedAt: new Date().toISOString(),
    repository: { commitSha: input.repository?.commitSha ?? input.graph.repository.commitSha, branch: input.repository?.branch ?? input.graph.repository.branch, name: input.repository?.name ?? input.graph.repository.name },
    layers,
    nodes,
    edges,
    flows,
    evidence,
    blast,
    summary: { patterns: [], strengths: [], risks: [], totals: { tools: 0, apps: 0, edges: 0, flows: 0, evidence: 0 }, limitations: [] },
    system: { layers: [], nodes: [], links: [], groups: [] },
    technologies: [],
  };
  arch.system = buildSystemMap(d, arch);
  arch.technologies = buildTechnologyIntel(d, arch);
  arch.summary = buildFindings(d, arch);
  // Findings may cite evidence created after the snapshot above.
  arch.evidence = Object.fromEntries([...d.ev.all].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  arch.summary.totals.evidence = Object.keys(arch.evidence).length;
  return arch;
}

/** Who breaks if `id` fails: callers depend on callees; consumers depend on the broker they read from. */
export function blastRadius(d: Detector, id: string): BlastRadius {
  const dependsOn = new Map<string, { node: string; edge: string }[]>();
  for (const e of d.edges.values()) {
    if (!e.overlays.has('dataflow') && !e.overlays.has('dependency')) continue;
    const consume = e.labels.has('consume') && e.labels.size === 1;
    const [dependent, dependency] = consume ? [e.target, e.source] : [e.source, e.target];
    if (!dependsOn.has(dependency)) dependsOn.set(dependency, []);
    dependsOn.get(dependency)!.push({ node: dependent, edge: e.id });
  }
  const nodes: BlastRadius['nodes'] = [];
  const seen = new Set([id]);
  let frontier = [id];
  for (let depth = 1; depth <= 4 && frontier.length; depth++) {
    const next: string[] = [];
    for (const f of frontier) {
      for (const { node, edge } of dependsOn.get(f) ?? []) {
        if (seen.has(node)) continue;
        seen.add(node);
        nodes.push({ id: node, depth, via: edge });
        next.push(node);
      }
    }
    frontier = next;
  }
  const n = d.nodes.get(id);
  const direct = n?.files.paths() ?? [];
  const reach = d.fileGraph.dependents(direct, 3);
  const files = [...reach].map(([path, depth]) => ({ path, depth })).sort((a, b) => a.depth - b.depth || (a.path < b.path ? -1 : 1)).slice(0, 300);
  const fileSet = new Set(reach.keys());
  const routes = d.facts.routes.filter((r) => fileSet.has(r.file) && r.kind !== 'page').map((r) => ({ method: r.method, path: r.path, file: r.file, line: r.line }));
  return { nodes, files, routes };
}
