/**
 * Contracts for architecture detection.
 *
 * Two stages, deliberately separated:
 *  1. Extraction (needs the checkout): reads manifests, infrastructure files and source text and
 *     records *facts* — each with a file, a line and a short redacted snippet.
 *  2. Detection (pure): turns facts + the dependency graph into tools, connections, flows and a
 *     summary. It never reads files, so it can be re-run after the checkout is gone.
 *
 * Nothing in either stage may be invented: every tool, edge, flow step and risk carries the
 * evidence that produced it, and anything that is not directly evidenced is marked with a
 * lower confidence rather than presented as fact.
 */

/** Bump when extraction output changes shape or meaning. */
export const ARCH_EXTRACTOR_VERSION = 2;
/** Bump when detection rules change; cached architectures with an older version are recomputed. */
export const ARCH_DETECTOR_VERSION = 6;

/** `strong` is displayed as "strong inference". */
export type Confidence = 'confirmed' | 'strong' | 'possible';

export const CONFIDENCE_LABELS: Record<Confidence, string> = {
  confirmed: 'Confirmed',
  strong: 'Strong inference',
  possible: 'Possible',
};

export type EvidenceKind =
  | 'manifest'
  | 'lockfile'
  | 'import'
  | 'client-init'
  | 'call'
  | 'config'
  | 'env'
  | 'route'
  | 'http-call'
  | 'compose'
  | 'dockerfile'
  | 'kubernetes'
  | 'helm'
  | 'terraform'
  | 'serverless'
  | 'ci'
  | 'proxy'
  | 'platform'
  | 'schema'
  | 'secret'
  | 'port'
  | 'auth'
  | 'queue'
  | 'graph'
  | 'middleware'
  | 'ui'
  | 'response';

/** A pointer into the repository. `snippet` is one source line, trimmed and redacted. */
export interface EvidenceRef {
  kind: EvidenceKind;
  file: string;
  line?: number;
  snippet?: string;
  /** What this line shows, in plain words. */
  detail: string;
}

export interface Evidence extends EvidenceRef {
  id: string;
}

// ---------------------------------------------------------------------------------------------
// Stage 1: extraction facts
// ---------------------------------------------------------------------------------------------

export type Ecosystem = 'npm' | 'pypi' | 'go' | 'cargo' | 'gem' | 'composer' | 'maven' | 'nuget';

export interface ManifestDependency {
  name: string;
  /** Version constraint exactly as declared (may be empty, e.g. requirements without a pin). */
  spec: string;
  line: number;
  dev: boolean;
}

export interface ManifestFact {
  file: string;
  ecosystem: Ecosystem;
  /** Directory of the manifest ('' for the repository root). */
  dir: string;
  name?: string;
  dependencies: ManifestDependency[];
  /** npm scripts / pyproject scripts / Procfile-like commands, with their line. */
  scripts: { name: string; command: string; line: number }[];
}

/** Resolved versions from a lockfile, keyed by package name. */
export interface LockfileFact {
  file: string;
  ecosystem: Ecosystem;
  dir: string;
  versions: Record<string, string>;
}

export type SourceLanguage = 'js' | 'python' | 'go' | 'java' | 'ruby' | 'php' | 'rust' | 'csharp';

/** An import of an external module from a non-JS source file (JS/TS imports come from the dependency graph). */
export interface ModuleImportFact {
  file: string;
  line: number;
  lang: SourceLanguage;
  module: string;
  /** Local names the import binds (aliases included), when the syntax makes them explicit. */
  bindings: string[];
  snippet: string;
}

/** A file-to-file import for languages the dependency graph does not cover (Python, Go). */
export interface InternalImportFact {
  source: string;
  target: string;
  line: number;
  /** Names imported from the target, when explicit (`from x import a, b`). */
  symbols: string[];
}

export type OpKind =
  | 'sql'
  | 'query'
  | 'cache-read'
  | 'cache-write'
  | 'cache-delete'
  | 'publish'
  | 'consume'
  | 'enqueue'
  | 'object-read'
  | 'object-write'
  | 'http'
  | 'rpc'
  | 'auth'
  | 'payment'
  | 'email'
  | 'ai'
  | 'search'
  | 'send'
  | 'webhook';

/** `const redis = new Redis(...)` — a client for a catalogued tool bound to an identifier. */
export interface ClientFact {
  file: string;
  line: number;
  tool: string;
  name: string;
  snippet: string;
  /** First literal argument when meaningful (queue name for `new Queue('emails')`). */
  arg?: string;
}

/** An operation on a client identifier or tool module, e.g. `redis.get(key)` → cache-read. */
export interface CallFact {
  file: string;
  line: number;
  tool: string;
  op: OpKind;
  /** The receiver and method as written, e.g. `redis.get`. */
  callee: string;
  /** For `ClientFact`s defined in another file, where the client came from. */
  via?: string;
  snippet: string;
  /** Extra operation detail (TTL present, task name, topic…). */
  arg?: string;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | 'ANY';

/** `app.use('/api', router)` / `app.include_router(router, prefix='/api')`: routes of `target` are served under `prefix`. */
export interface MountFact {
  file: string;
  line: number;
  prefix: string;
  target: string;
}

export interface RouteFact {
  file: string;
  line: number;
  /** `api` handles requests, `page` renders UI, `action` is a server action (RPC over POST). */
  kind: 'api' | 'page' | 'action';
  method: HttpMethod;
  /** Route path as declared; framework conventions (Next.js directories) are converted to a path. */
  path: string;
  framework: string;
  /** How the route was found: decorator, router call, file convention. */
  source: 'decorator' | 'router-call' | 'file-convention' | 'config';
  handler?: string;
  /** A guard/dependency visible in the route definition (e.g. `Depends(get_current_user)`). */
  auth?: { line: number; snippet: string };
  snippet: string;
  /** First line of the handler body when it differs from `line` (a page's component). */
  bodyStart?: number;
  /** Last line of the handler body (next route in the file, or end of file). */
  bodyEnd?: number;
  /** Project code the handler body references (imported names and same-file definitions). */
  refs?: SymbolRef[];
  /** The first response the handler produces, when it is written in the body. */
  response?: ResponseFact;
}

export interface ResponseFact {
  line: number;
  kind: 'json' | 'redirect' | 'stream' | 'send' | 'render' | 'file' | 'status';
  /** Short shape summary: object keys (`{ ok }`), a model name, or the returned expression. */
  shape?: string;
  snippet: string;
}

/**
 * Where a client call is triggered from the UI: the event, the handler, and what the code does
 * with the result (navigate, set state, reload). Found by following the API client function to
 * its call sites.
 */
export interface UiTriggerFact {
  /** File and line of the call to the client function (`api.devSignIn()`). */
  file: string;
  line: number;
  /** How the client function is called, e.g. `api.devSignIn`. */
  callee: string;
  /** The HTTP call the client function makes. */
  target: { file: string; line: number };
  trigger: { kind: 'click' | 'submit' | 'change' | 'key' | 'load' | 'call'; line: number; snippet: string };
  /** Named handler function, when the event calls one (`handleImport`). */
  handler?: { name: string; line: number };
  /** Enclosing component (PascalCase function). */
  component?: string;
  /** Visible label of the element that triggers it (button text), when written in the JSX. */
  label?: string;
  /** What happens after the response: navigation, state updates, refetches. */
  after: { kind: 'navigate' | 'state' | 'reload' | 'notify'; line: number; detail: string; snippet: string }[];
  snippet: string;
}

/** Request middleware: global hooks, `app.use(...)`, framework middleware and guards. */
export interface MiddlewareFact {
  file: string;
  line: number;
  name: string;
  kind: 'hook' | 'use' | 'plugin' | 'guard' | 'dependency' | 'setting';
  /** Framework lifecycle phase, e.g. Fastify `onRequest`. */
  phase?: string;
  /** What it is for: security, auth, cors, compression, session, logging, rate-limit, other. */
  purpose: 'auth' | 'security' | 'cors' | 'compression' | 'session' | 'logging' | 'rate-limit' | 'parsing' | 'other';
  /** The code's own description (a comment next to it), when there is one. */
  note?: string;
  framework?: string;
  snippet: string;
}

/** A reference from a function body to project code: `file` + top-level `symbol` (whole module when absent). */
export interface SymbolRef {
  file: string;
  symbol?: string;
  /** Line of the first reference in the body. */
  line: number;
}

/** A top-level definition (function, class, assignment) and the project code its body references. */
export interface SymbolFact {
  file: string;
  name: string;
  line: number;
  end: number;
  refs: SymbolRef[];
}

export interface HttpCallFact {
  file: string;
  line: number;
  client: string;
  method?: HttpMethod;
  /** Literal URL or path, when the target is written in the code. */
  url?: string;
  /** Hostname of a literal absolute URL. */
  host?: string;
  /** Env var the URL is read from, when visible on the same line. */
  envVar?: string;
  snippet: string;
  /** Wire protocol when it is not plain REST (EventSource → SSE, WebSocket, GraphQL endpoint). */
  protocol?: 'REST' | 'SSE' | 'WebSocket' | 'GraphQL' | 'tRPC' | 'gRPC';
  /** The client function this call is written in (`devSignIn`), and the object it belongs to (`api`). */
  fn?: string;
  owner?: string;
  /** Declared response type (`request<Me>(…)` → `Me`). */
  responseType?: string;
}

export interface EnvRefFact {
  file: string;
  line: number;
  name: string;
}

export type DefinitionKind =
  | 'http-app'
  | 'worker-app'
  | 'task'
  | 'queue-producer'
  | 'queue-consumer'
  | 'topic-producer'
  | 'topic-consumer'
  | 'scheduler'
  | 'webhook-handler'
  | 'auth-middleware'
  | 'graphql-server'
  | 'grpc-server'
  | 'websocket-server';

/** Things the code declares: app instances, tasks, consumers, webhooks. */
export interface DefinitionFact {
  file: string;
  line: number;
  kind: DefinitionKind;
  tool?: string;
  /** Task, queue, topic or app name as written. */
  name?: string;
  snippet: string;
}

/** Configuration that ties a library to a concrete backend, e.g. a Prisma datasource provider. */
export interface ConfigFact {
  file: string;
  line: number;
  kind: 'datasource' | 'broker' | 'result-backend' | 'url' | 'cache-backend' | 'dialect';
  /** Catalog id of the backend (postgresql, redis…); empty when the value comes from an env var. */
  tool: string;
  /** Env var the value is read from, when visible (resolved against Compose environments later). */
  envVar?: string;
  /** Library that is configured (prisma, celery, sqlalchemy…), when known. */
  via?: string;
  /** Host from a URL, when present (used to match compose services). */
  host?: string;
  snippet: string;
}

export interface SecretFact {
  file: string;
  line: number;
  /** Key name for key/value secrets (compose environment), never the value. */
  key?: string;
  kind: 'credential-pattern' | 'plaintext-env';
}

// --- Infrastructure --------------------------------------------------------------------------

export interface ComposeEnvVar {
  key: string;
  line: number;
  /** URL scheme and host when the value is a URL (credentials stripped). */
  scheme?: string;
  host?: string;
  /** Value is a secret-looking literal (never stored). */
  secret: boolean;
}

export interface ComposeService {
  name: string;
  line: number;
  image?: string;
  imageLine?: number;
  build?: { context: string; dockerfile?: string; line: number };
  command?: { text: string; line: number };
  ports: { published?: string; target: string; line: number }[];
  expose: { port: string; line: number }[];
  dependsOn: { name: string; line: number }[];
  links: { name: string; line: number }[];
  environment: ComposeEnvVar[];
  healthcheck?: number;
  replicas?: { count: number; line: number };
  /** Traefik/nginx-proxy routing labels and similar, as key=value lines. */
  labels: { text: string; line: number }[];
}

export interface ComposeFact {
  file: string;
  services: ComposeService[];
}

export interface DockerfileFact {
  file: string;
  stages: { image: string; line: number; alias?: string }[];
  expose: { port: string; line: number }[];
  commands: { kind: 'CMD' | 'ENTRYPOINT'; text: string; line: number }[];
  user?: { name: string; line: number };
  healthcheck?: number;
}

export interface KubernetesObject {
  file: string;
  kind: string;
  name: string;
  line: number;
  images: { image: string; line: number }[];
  ports: { port: string; line: number }[];
  serviceType?: { value: string; line: number };
  /** Ingress → backend service names. */
  backends: { service: string; line: number; path?: string; host?: string }[];
  labels: Record<string, string>;
  selector: Record<string, string>;
  replicas?: { count: number; line: number };
}

export interface TerraformResource {
  file: string;
  line: number;
  type: string;
  name: string;
  /** Selected attributes (engine, runtime…) with their line. */
  attributes: Record<string, { value: string; line: number }>;
}

export interface TerraformFact {
  resources: TerraformResource[];
  providers: { file: string; line: number; name: string }[];
  modules: { file: string; line: number; name: string; source: string }[];
}

export interface ServerlessFact {
  file: string;
  provider?: { name: string; runtime?: string; line: number };
  functions: { name: string; line: number; handler?: string; events: { kind: string; line: number; path?: string; method?: string }[] }[];
}

export interface CiStep {
  line: number;
  name?: string;
  uses?: string;
  run?: string;
  /** Action inputs (`with:`), stringified. */
  with?: Record<string, string>;
}

export interface CiFact {
  file: string;
  system: 'github-actions' | 'gitlab-ci' | 'circleci' | 'azure-pipelines' | 'bitbucket' | 'jenkins' | 'travis';
  name?: string;
  triggers: string[];
  jobs: { name: string; line: number; steps: CiStep[] }[];
}

export interface ProxyFact {
  file: string;
  line: number;
  kind: 'nginx' | 'caddy' | 'traefik' | 'haproxy';
  /** Upstream host (compose service name or hostname) and port. */
  upstream: string;
  port?: string;
  path?: string;
  snippet: string;
}

export interface PlatformFact {
  file: string;
  line: number;
  platform: string;
  detail: string;
  snippet: string;
}

export interface InfraFacts {
  compose: ComposeFact[];
  dockerfiles: DockerfileFact[];
  kubernetes: KubernetesObject[];
  helm: { file: string; name: string; line: number; dependencies: { name: string; line: number }[] }[];
  terraform: TerraformFact;
  serverless: ServerlessFact[];
  ci: CiFact[];
  proxies: ProxyFact[];
  platforms: PlatformFact[];
  /** Procfile-style process declarations. */
  processes: { file: string; line: number; name: string; command: string }[];
}

export interface ArchitectureFacts {
  version: number;
  manifests: ManifestFact[];
  lockfiles: LockfileFact[];
  imports: ModuleImportFact[];
  internalImports: InternalImportFact[];
  /** Top-level definitions with their references (JS/TS and Python), for flow tracing. */
  symbols: SymbolFact[];
  clients: ClientFact[];
  calls: CallFact[];
  routes: RouteFact[];
  mounts: MountFact[];
  httpCalls: HttpCallFact[];
  uiTriggers: UiTriggerFact[];
  middleware: MiddlewareFact[];
  envRefs: EnvRefFact[];
  definitions: DefinitionFact[];
  configs: ConfigFact[];
  secrets: SecretFact[];
  infra: InfraFacts;
  /** Source files per language that were read for extraction. */
  languages: Record<string, number>;
  /** Files that could not be parsed (malformed YAML/TOML/JSON), with the reason. */
  warnings: { file: string; message: string }[];
}

// ---------------------------------------------------------------------------------------------
// Stage 2: detected architecture
// ---------------------------------------------------------------------------------------------

export const LAYERS = ['clients', 'edge', 'application', 'data', 'async', 'external', 'delivery'] as const;
export type Layer = (typeof LAYERS)[number];

export const LAYER_LABELS: Record<Layer, string> = {
  clients: 'Clients',
  edge: 'Edge / gateway',
  application: 'Application services',
  data: 'Data / cache',
  async: 'Queues / async workers',
  external: 'External services / cloud',
  delivery: 'Delivery',
};

export type ToolCategory =
  | 'frontend'
  | 'framework'
  | 'runtime'
  | 'database'
  | 'cache'
  | 'search'
  | 'storage'
  | 'queue'
  | 'worker'
  | 'orm'
  | 'auth'
  | 'payments'
  | 'email'
  | 'messaging'
  | 'ai'
  | 'observability'
  | 'http-client'
  | 'api'
  | 'cloud'
  | 'container'
  | 'orchestration'
  | 'iac'
  | 'ci'
  | 'hosting'
  | 'proxy'
  | 'realtime'
  | 'analytics'
  | 'service'
  | 'application';

export type ArchNodeKind =
  /** A runnable unit built from this repository (service, worker, frontend). */
  | 'app'
  /** A catalogued technology: database, cache, SDK, framework, platform. */
  | 'tool'
  /** A remote HTTP host called with a literal URL. */
  | 'host'
  /** A container image the repository runs but does not build. */
  | 'container';

export interface FileUse {
  path: string;
  lines: number[];
  /** What the file does with the node: import, cache-read, route… */
  uses: string[];
}

export interface ArchNode {
  id: string;
  kind: ArchNodeKind;
  name: string;
  category: ToolCategory;
  layer: Layer;
  /** Libraries render as chips inside the application that uses them. */
  display: 'node' | 'chip';
  /** For chips: the app nodes they are shown inside. */
  hosts?: string[];
  /** Version as declared or locked. `package` names the dependency it comes from when that is not the technology itself (a driver). */
  version?: { value: string; source: string; line?: number; package?: string };
  confidence: Confidence;
  /** What the evidence shows this node doing here, e.g. "Cache reads and writes in 3 files". */
  role: string;
  /** What the technology is (catalog text; not repository-specific). */
  description?: string;
  /** Why CodePilot believes it is present, in one sentence citing evidence. */
  reason: string;
  evidence: string[];
  files: FileUse[];
  /** Short facts rendered as badges (port published, runs as root, replicas…). */
  badges: { text: string; tone: 'neutral' | 'risk' | 'accent'; evidence: string[]; overlay?: Overlay }[];
  /** For apps: root directory and the libraries shown inside. */
  app?: { root: string; frameworks: string[]; language?: string; entry?: { file: string; line?: number }; chips: string[] };
}

export type Overlay = 'dataflow' | 'dependency' | 'deployment' | 'security';
export const OVERLAYS: Overlay[] = ['dataflow', 'dependency', 'deployment', 'security'];

export type EdgeLabel =
  | 'REST'
  | 'HTTP'
  | 'gRPC'
  | 'GraphQL'
  | 'WebSocket'
  | 'SQL'
  | 'query'
  | 'cache read'
  | 'cache write'
  | 'pub/sub'
  | 'publish'
  | 'consume'
  | 'enqueue'
  | 'object storage'
  | 'webhook'
  | 'OAuth'
  | 'auth'
  | 'API call'
  | 'email'
  | 'proxy'
  | 'depends on'
  | 'deploys'
  | 'builds'
  | 'tests'
  | 'hosts'
  | 'configures'
  | 'uses';

export interface ArchEdge {
  id: string;
  source: string;
  target: string;
  labels: EdgeLabel[];
  overlays: Overlay[];
  confidence: Confidence;
  /** Asynchronous (queue/topic) vs synchronous request. */
  async: boolean;
  evidence: string[];
  /** One-sentence reason citing the evidence. */
  reason: string;
}

export type FlowStepMode = 'sync' | 'async' | 'cache-hit' | 'cache-miss' | 'publish' | 'consume' | 'unknown';

export interface FlowStep {
  step: number;
  node: string;
  file: string;
  line?: number;
  mode: FlowStepMode;
  explanation: string;
  evidence: string[];
  /** Only set when measured; static analysis never measures latency, so this stays undefined. */
  latencyMs?: number;
  /** Edge travelled to reach this step (from the previous step's node), when one exists. */
  edge?: string;
  /** Request-lifecycle presentation: which swimlane, what kind of operation, a short label. */
  lane?: FlowLane;
  kind?: FlowStepKind;
  label?: string;
  /** Label for the connection into this step, as the code shows it (`fetch POST /api/x`, `JSON response`). */
  transport?: string;
  /** Background work that does not block the response, or a cache branch. */
  branch?: 'async' | 'cache-hit' | 'cache-miss';
  /** Technology involved at this step (architecture node id). */
  tool?: string;
  /** Pipeline stage for the flow canvas. */
  stage?: FlowStage;
  /** Function (or route handler) the step's line belongs to. */
  fn?: string;
  /** What goes in and comes out at this step, when the code shows it (call arguments, method + path, response shape, declared type). */
  input?: string;
  output?: string;
  /**
   * How directly the code shows this step: a call, route, registration or response written in the
   * code is confirmed; a function reached by following references is a strong inference (reachable,
   * not proven to run); an inferred cache branch is strong; an unresolved hop is unknown.
   */
  confidence?: IntelConfidence;
  /** When set, edge into this step originates at step index parentStepIndex instead of previous step. Useful for branching journey flows. */
  parentStepIndex?: number;
  /** When true, this step represents global middleware registered across the whole app */
  isGlobalMiddleware?: boolean;
  /** When step could not be resolved, the specific source-grounded reason */
  unresolvedReason?: UnresolvedStepReason;
}

export const FLOW_STAGES = ['user', 'frontend', 'transport', 'backend', 'services', 'tools', 'data', 'external', 'response'] as const;
export type FlowStage = (typeof FLOW_STAGES)[number];

/** What a flow touches, for searching the flow library. */
export interface FlowIndex {
  routes: string[];
  components: string[];
  functions: string[];
  files: string[];
  technologies: { id: string; name: string; category: string }[];
  /** database, cache, queue, external, auth… — categories of the technologies it reaches. */
  categories: string[];
}

export type FlowLane = 'frontend' | 'backend' | 'external' | 'async';
export type FlowStepKind =
  | 'action'
  | 'handler'
  | 'client'
  | 'route'
  | 'middleware'
  | 'service'
  | 'data'
  | 'cache'
  | 'queue'
  | 'external'
  | 'worker'
  | 'response'
  | 'resolve'
  | 'state'
  | 'unknown';

export type FlowType = 'user-journey' | 'request' | 'background' | 'system' | 'external';

export interface FlowCorrelation {
  type: 'page-lifecycle' | 'user-action' | 'event-handler' | 'function-chain' | 'route-call' | 'async-chain' | 'system-endpoint' | 'unknown';
  reason: string;
  sourceFile?: string;
  component?: string;
  handler?: string;
  evidence?: string[];
}

export interface FlowJourney {
  id: string;
  domain: string;
  title: string;
  type: FlowType;
  flowId: string;
  correlation: FlowCorrelation;
  evidence: string[];
  subflowIds: string[];
  description?: string;
}

export interface FlowHierarchyCounts {
  journeys: number;
  requests: number;
  background: number;
  system: number;
  external: number;
  totalTracedUnits: number;
}

export interface FlowHierarchy {
  journeys: FlowJourney[];
  counts: FlowHierarchyCounts;
  domains: string[];
}

export interface Flow {
  id: string;
  title: string;
  /** How the scenario starts. */
  trigger: { kind: 'route' | 'queue' | 'schedule'; method?: HttpMethod; path?: string; name?: string };
  variant?: 'cache-hit' | 'cache-miss';
  confidence: Confidence;
  steps: FlowStep[];
  /** True when tracing stopped at a call whose target could not be determined. */
  truncated: boolean;
  notes: string[];
  /** A user action traced from the UI (button, form, page load) — present only when found in code. */
  action?: { label: string; kind: UiTriggerFact['trigger']['kind']; component?: string; file: string; line: number };
  /** Lanes used by the steps, in display order. */
  lanes?: FlowLane[];
  /** Display name: the UI action when there is one, else the route or job. */
  name?: string;
  index?: FlowIndex;
  /** Hierarchical Flow Model classification: user-journey, request, background, system, external */
  flowType?: FlowType;
  /** Hierarchical domain: e.g. AUTHENTICATION, PROJECT MANAGEMENT, ANALYSIS, SYSTEM, BACKGROUND, UNKNOWN RELATIONSHIP */
  domain?: string;
  /** Journey this execution unit belongs to, if correlated into one */
  journeyId?: string;
  journeyTitle?: string;
  parentJourneyId?: string;
  /** For journey execution flows, child technical subflow IDs */
  subflowIds?: string[];
  /** Grounded correlation evidence establishing why this flow is grouped or kept independent */
  correlation?: FlowCorrelation;
  /** Architectural importance ranking (HIGH, MEDIUM, LOW) with explicit reasons */
  importance?: FlowImportance;
  /** ID of near-duplicate cluster if this flow belongs to one */
  clusterId?: string;
  /** Capability this flow belongs to */
  capabilityId?: string;
  /** Explanation of why this flow belongs to its capability */
  whyBelongsToCapability?: string;
}

/* ---------------------------------------------------------------- automation engine v2 */

export type HeroJoinType =
  | 'route-param-reuse'
  | 'response-consumption'
  | 'database-write-read'
  | 'enqueue-worker'
  | 'navigation-call'
  | 'function-call'
  | 'unlinked';

export interface HeroJoin {
  sourceFlowId: string;
  targetFlowId: string;
  sourceFile: string;
  sourceLine?: number;
  targetFile: string;
  targetLine?: number;
  relationshipType: HeroJoinType;
  confidence: 'confirmed' | 'strong' | 'possible' | 'unknown';
  explanation: string;
  evidence: string[];
}

export interface HeroStage {
  id: string;
  stageIndex: number;
  title: string;
  trigger: string;
  tool?: string;
  technology?: string;
  flowId: string;
  isBackground?: boolean;
  evidence: string[];
  durationMs?: number;
  joinWithNext?: HeroJoin;
  subStepsCount: number;
  subStepsSummary?: string[];
}

export interface HeroFlow {
  id: string;
  title: string;
  description: string;
  stages: HeroStage[];
  backgroundStages: HeroStage[];
  joins: HeroJoin[];
  evidence: string[];
  confidence: 'confirmed' | 'strong' | 'possible' | 'unknown';
  isCustomPinned?: boolean;
}

export type FlowImportanceLevel = 'HIGH' | 'MEDIUM' | 'LOW';

export interface FlowImportance {
  level: FlowImportanceLevel;
  score: number;
  reasons: string[];
}

export interface NearDuplicateCluster {
  id: string;
  title: string;
  representativeFlowId: string;
  memberFlowIds: string[];
  differences: string[];
  evidence: string[];
}

export interface CapabilityGroup {
  id: string;
  name: string;
  summary: string;
  flowCount: number;
  requestCount: number;
  externalServices: string[];
  importantTechnologies: string[];
  flowIds: string[];
  whyBelongs: Record<string, string>;
  mergedPatterns: NearDuplicateCluster[];
  evidence: string[];
}

export interface GlobalMiddlewareStep {
  id: string;
  name: string;
  file: string;
  line: number;
  phase?: string;
  explanation: string;
  evidence: string[];
}

export interface GlobalMiddleware {
  steps: GlobalMiddlewareStep[];
  label: string;
  evidence: string[];
}

export type UnresolvedStepReason =
  | 'dynamic call'
  | 'callback'
  | 'runtime-generated target'
  | 'unavailable dependency source'
  | 'unknown';

export interface UnresolvedStep {
  flowId: string;
  flowTitle: string;
  file: string;
  line?: number;
  stepIndex: number;
  reason: UnresolvedStepReason;
  explanation: string;
}

export interface TraceCoverage {
  entryPoints: number;
  totalFlows: number;
  requests: number;
  fullyTracedFlows: number;
  unknownSteps: number;
  backgroundFlows: number;
  coveragePercent: number;
  unresolvedSteps: UnresolvedStep[];
}

/* ---------------------------------------------------------------- automation engine v3: four main flows */

export interface MainFlowStage {
  id: string;
  stageIndex: number;
  title: string;
  trigger: string;
  tools: string[];
  file: string;
  line?: number;
  isBackground?: boolean;
  branch?: 'async' | 'cache-hit' | 'cache-miss' | 'fork';
  forkLabel?: string;
  isUnknown?: boolean;
  unresolvedReason?: UnresolvedStepReason;
  subStepsCount: number;
  subStepsSummary?: string[];
  evidence: string[];
}

export interface MainFlowJoin {
  sourceStageId: string;
  targetStageId: string;
  sourceFile: string;
  sourceLine?: number;
  targetFile: string;
  targetLine?: number;
  relationshipType: HeroJoinType;
  confidence: 'confirmed' | 'strong' | 'possible' | 'unknown';
  explanation: string;
  evidence: string[];
}

export interface MainFlowFoldedMember {
  id: string;
  name: string;
  kind: 'route' | 'action' | 'job' | 'redirect' | 'health' | 'share' | 'static' | 'minor';
  detail: string;
  file: string;
  line?: number;
  reason: string;
  evidence?: string[];
}

export interface MainFlowStepNarrative {
  stepNumber: number;
  title: string;
  narrative: string;
  file: string;
  line?: number;
}

export interface MainFlowToolUsage {
  name: string;
  role: string;
  file?: string;
  line?: number;
}

export interface MainFlowDataInAndOut {
  inputs: string[];
  stored: string[];
  returned: string[];
}

export interface MainFlowFailurePoint {
  failurePoint: string;
  handling: string;
  userVisibleImpact: string;
  file?: string;
  line?: number;
}

export interface MainFlowIncludedSmallerFlow {
  name: string;
  detail: string;
  file?: string;
  line?: number;
}

export interface MainFlowConfidenceStats {
  percent: number;
  fullyTracedCount: number;
  totalCount: number;
  unknownSteps: { stage: string; file: string; line?: number; reason: string }[];
}

export interface MainFlowExplanation {
  whatItDoes: string;
  whyItExists: string;
  stepByStep: MainFlowStepNarrative[];
  toolsAndServices: MainFlowToolUsage[];
  dataInAndOut: MainFlowDataInAndOut;
  ifSomethingFails: MainFlowFailurePoint[];
  includedSmallerFlows: MainFlowIncludedSmallerFlow[];
  confidence: MainFlowConfidenceStats;
}

export interface MainFlow {
  id: string;
  name: string;
  purpose: string;
  stepCount: number;
  tools: string[];
  stages: MainFlowStage[];
  backgroundStages: MainFlowStage[];
  joins: MainFlowJoin[];
  foldedMembers: MainFlowFoldedMember[];
  explanation: MainFlowExplanation;
  confidence: 'confirmed' | 'strong' | 'possible' | 'unknown';
  coveragePercent: number;
  whyChosen: string;
  isCustomRenamed?: boolean;
  customName?: string;
  evidence: string[];
}

export interface MainFlowCandidate {
  id: string;
  name: string;
  purpose: string;
  stepCount: number;
  tools: string[];
  score: number;
}

export interface MainFlowsCoverage {
  totalEntryPoints: number;
  coveredEntryPoints: number;
  minorFoldedOrOmittedCount: number;
  coveragePercent: number;
  foldedItems: MainFlowFoldedMember[];
}

export interface MainFlowsOverview {
  flows: MainFlow[];
  coverage: MainFlowsCoverage;
  globalMiddleware: GlobalMiddleware;
  isStaticFrontendOnly?: boolean;
  staticFrontendReason?: string;
  allFlowCandidates: MainFlowCandidate[];
  evidence: Record<string, Evidence>;
}

export interface AutomationOverview {
  heroFlow: HeroFlow;
  capabilities: CapabilityGroup[];
  globalMiddleware: GlobalMiddleware;
  traceCoverage: TraceCoverage;
  mainFlows?: MainFlowsOverview;
  counts: {
    mainFlow: number;
    capabilities: number;
    flows: number;
    requests: number;
    background: number;
    system: number;
    external: number;
    totalTracedUnits: number;
  };
  isStaticFrontendOnly?: boolean;
  evidence: Record<string, Evidence>;
}

/* ---------------------------------------------------------------- system map */

export const SYSTEM_LAYERS = ['client', 'transport', 'backend', 'services', 'data', 'async', 'external', 'infra'] as const;
export type SystemLayer = (typeof SYSTEM_LAYERS)[number];
export const SYSTEM_LAYER_LABELS: Record<SystemLayer, string> = {
  client: 'Client / Frontend',
  transport: 'Transport / API',
  backend: 'Backend / Application',
  services: 'Services',
  data: 'Data / Cache',
  async: 'Async workers',
  external: 'External services',
  infra: 'Deployment / Infrastructure',
};

export type SystemNodeKind = 'client' | 'transport' | 'api' | 'proxy' | 'middleware' | 'handler' | 'service' | 'tool' | 'queue' | 'worker' | 'external' | 'infra';

/**
 * A component of the running system, one level finer than architecture nodes: API groups,
 * middleware, route handlers and service modules inside an application, plus the tools and
 * services they reach. Each one points at the files and evidence it comes from.
 */
export interface SystemNode {
  id: string;
  kind: SystemNodeKind;
  layer: SystemLayer;
  name: string;
  detail: string;
  /** Application this component belongs to (architecture node id). */
  app?: string;
  /** Architecture node this component is (tools, hosts, apps). */
  arch?: string;
  files: { path: string; line?: number }[];
  routes?: { method: HttpMethod; path: string; file: string; line: number; auth: boolean }[];
  /** Libraries used at this point (transport clients, ORMs). */
  libraries?: string[];
  evidence: string[];
  confidence: Confidence;
}

export interface SystemLink {
  id: string;
  source: string;
  target: string;
  /** What travels, as the code shows it: `REST · fetch`, `SQL`, `imports`, `enqueue`. */
  label: string;
  kind: 'transport' | 'route' | 'call' | 'data' | 'async' | 'deploy';
  async: boolean;
  /** Number of call sites / routes / imports behind the link. */
  count: number;
  evidence: string[];
  confidence: Confidence;
}

export interface SystemMap {
  layers: SystemLayer[];
  nodes: SystemNode[];
  links: SystemLink[];
  /** Applications and the system nodes drawn inside their boundary. */
  groups: { app: string; name: string; frameworks: string[]; nodes: string[] }[];
}

export type PatternName = 'monolith' | 'modular monolith' | 'microservices' | 'multi-service' | 'serverless' | 'event-driven' | 'static frontend';

/** Stable, repository-independent identifiers of what a finding is about (titles name the repository's own components). */
export const FINDING_CODES = [
  'async-background-work',
  'read-cache',
  'ci-tests',
  'container-healthchecks',
  'versioned-migrations',
  'route-auth-checks',
  'no-import-cycles',
  'credentials-in-source',
  'compose-plaintext-secrets',
  'datastore-host-ports',
  'shared-single-point-of-failure',
  'cache-no-expiry',
  'sync-external-calls-no-queue',
  'import-cycles',
  'unpinned-image-tags',
] as const;
export type FindingCode = (typeof FINDING_CODES)[number];

export interface Finding {
  id: string;
  code: FindingCode;
  title: string;
  detail: string;
  confidence: Confidence;
  evidence: string[];
  /** Nodes the finding is about, for focusing the diagram. */
  nodes: string[];
  severity?: 'info' | 'low' | 'medium' | 'high';
}

export interface ArchitectureSummary {
  patterns: { name: PatternName; confidence: Confidence; reason: string; evidence: string[] }[];
  strengths: Finding[];
  risks: Finding[];
  /** Counts for the header. */
  totals: { tools: number; apps: number; edges: number; flows: number; evidence: number };
  /** Why some things could not be determined (languages not analyzed, malformed files…). */
  limitations: string[];
}

export interface BlastRadius {
  /** Architecture nodes reachable against the direction of use (who breaks if this fails). */
  nodes: { id: string; depth: number; via: string }[];
  /** Files that use the node directly, then their dependents in the import graph. */
  files: { path: string; depth: number }[];
  routes: { method: HttpMethod; path: string; file: string; line: number }[];
}

export interface Architecture {
  version: number;
  generatedAt: string;
  repository: { commitSha?: string; branch?: string; name?: string };
  layers: Layer[];
  nodes: ArchNode[];
  edges: ArchEdge[];
  flows: Flow[];
  /** Hierarchical Flow Model: grouped user & system journeys backed by evidence */
  journeys?: FlowJourney[];
  /** Full hierarchy with domains, counts and journey structures */
  hierarchy?: FlowHierarchy;
  /** Automation Engine V2: Project Story, Hero Pipeline, Capability Groups, and Coverage */
  automation?: AutomationOverview;
  heroFlow?: HeroFlow;
  capabilities?: CapabilityGroup[];
  globalMiddleware?: GlobalMiddleware;
  traceCoverage?: TraceCoverage;
  mainFlows?: MainFlowsOverview;
  flowsV4?: FlowV4[];
  automationV4?: AutomationOverviewV4;
  evidence: Record<string, Evidence>;
  summary: ArchitectureSummary;
  blast: Record<string, BlastRadius>;
  /** How the system works: components per layer and the links between them. */
  system: SystemMap;
  /** What each technology does in this repository, and the evidence for it. */
  technologies: TechIntel[];
}

/* ---------------------------------------------------------------- Automation Engine V4: Real Flowcharts */

export type FlowNodeType =
  | 'trigger'
  | 'ui_step'
  | 'request'
  | 'server_step'
  | 'decision'
  | 'data_store'
  | 'external_service'
  | 'background_job'
  | 'end'
  | 'jump'
  | 'unknown';

export type FlowchartLane = 'user' | 'frontend' | 'backend' | 'data' | 'external';

export type FlowEdgeKind = 'sequence' | 'true' | 'false' | 'error' | 'async' | 'jump' | 'unknown';

export interface FlowNode {
  id: string;
  flowId: string;
  type: FlowNodeType;
  label: string;
  file: string;
  line: number;
  snippetRef?: string;
  snippet?: string;
  tools: string[];
  lane: FlowchartLane;
  tooltip?: string;
  decisionExpr?: string;
  decisionOutcomes?: string[];
  dataOperation?: 'read' | 'write';
  targetFlowId?: string;
  jumpTargetFlow?: string;
  unresolvedReason?: string;
  unknownReason?: string;
  similarEndpoints?: { name: string; route: string; file: string; line: number }[];
  evidence: string[];
}

export interface FlowEdge {
  id: string;
  flowId: string;
  source: string;
  target: string;
  kind: FlowEdgeKind;
  label?: string;
  timer?: string;
  evidence: string[];
}

export interface FlowSummary {
  whatItDoes: string;
  dataMoving: string;
  failureHandling: string;
  whyItExists?: string;
}

export interface FlowV4 {
  id: string;
  projectId?: string;
  name: string;
  summary: FlowSummary;
  tools: string[];
  nodes: FlowNode[];
  edges: FlowEdge[];
  triggerNodeId: string;
  endNodeIds: string[];
  coverage?: number;
  confidence: number;
  pinnedByUser?: boolean;
  customName?: string;
  isCustomRenamed?: boolean;
  purpose?: string;
  allCandidates?: { id: string; name: string; tools: string[]; summary: FlowSummary; purpose?: string }[];
}

export interface EntryPointItem {
  id: string;
  name: string;
  route?: string;
  file: string;
  line: number;
  kind: 'route' | 'ui' | 'job' | 'handler';
  disposition: 'shown' | 'folded' | 'omitted';
  reason?: string;
}

export interface AutomationCoverageV4 {
  totalEntryPoints: number;
  shownCount: number;
  foldedCount: number;
  omittedCount: number;
  shown: EntryPointItem[];
  folded: EntryPointItem[];
  omitted: EntryPointItem[];
}

export interface AutomationOverviewV4 {
  flows: FlowV4[];
  coverage: AutomationCoverageV4;
  globalMiddleware: GlobalMiddleware;
  allFlowCandidates: { id: string; name: string; tools: string[]; nodeCount: number }[];
  isStaticFrontendOnly?: boolean;
  staticFrontendReason?: string;
  evidence: Record<string, Evidence>;
}

/* ---------------------------------------------------------------- technology intelligence */

/** `unknown`: the repository does not show enough to say. */
export type IntelConfidence = Confidence | 'unknown';

/** One claim about a technology in this project, with the evidence that supports it. */
export interface TechStatement {
  text: string;
  confidence: IntelConfidence;
  evidence: string[];
}

/**
 * A technology explained in the context of this repository snapshot: what it does here, why the
 * code shows it is used, where, through which components, routes and flows — each claim cited.
 * `general` is catalog text about the technology in general and is never presented as a project fact.
 */
export interface TechIntel {
  id: string;
  name: string;
  /** `library`: a dependency outside the technology catalog, described from its imports alone. */
  kind: ArchNodeKind | 'library';
  category: ToolCategory | 'library';
  version?: string;
  confidence: Confidence;
  general?: string;
  role: TechStatement;
  why: TechStatement;
  /** Applications and components that use it. */
  usedBy: string[];
  files: { path: string; lines: number[]; uses: string[] }[];
  /** Functions whose bodies call it. */
  functions: { file: string; line: number; name: string; calls: string[] }[];
  /** Routes it serves (framework), or routes whose traced flows reach it. */
  routes: { method: HttpMethod; path: string; file: string; line: number; via: 'framework' | 'flow' }[];
  operations: { op: OpKind; label: string; count: number }[];
  clients: { name: string; file: string; line: number }[];
  scripts: { name: string; command: string; file: string; line: number }[];
  connections: { direction: 'in' | 'out'; id: string; name: string; labels: string[]; confidence: Confidence; evidence: string[] }[];
  flows: { id: string; title: string }[];
  /** System-map components that are, or use, this technology. */
  system: string[];
  /** A small neighbourhood of the system map around it, for a focused relationship graph. */
  graph: { nodes: { id: string; name: string; kind: SystemNodeKind; layer: SystemLayer; focus: boolean }[]; links: { source: string; target: string; label: string; async: boolean }[] };
  evidence: string[];
}
