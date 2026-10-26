import type {
  ClassificationEvidence,
  EdgeKind,
  ExportEntry,
  FileDiagnostic,
  GraphEdge,
  GraphNode,
  GraphSummary,
  NodeType,
  ScanStats,
} from '@codepilot/analyzer/types';

import type {
  Architecture,
  ArchEdge,
  ArchNode,
  BlastRadius,
  Evidence,
  Flow,
  FlowLane,
  FlowStep,
  ArchitectureSummary,
  Overlay,
  PatternName,
  Confidence,
  Layer,
  SystemLayer,
  SystemLink,
  SystemMap,
  SystemNode,
  TechIntel,
  IntelConfidence,
  FlowStage,
  FlowIndex,
} from '@codepilot/analyzer/architecture/types';

export type { GraphEdge, GraphNode, GraphSummary, NodeType, EdgeKind, ClassificationEvidence, ExportEntry, FileDiagnostic, ScanStats };
export type { Architecture, ArchEdge, ArchNode, BlastRadius, Evidence, Flow, FlowLane, FlowStep, ArchitectureSummary, Overlay, PatternName, Confidence, Layer, SystemLayer, SystemLink, SystemMap, SystemNode, TechIntel, IntelConfidence, FlowStage, FlowIndex };

export interface ApiErrorBody {
  code: string;
  message: string;
  action?: { label: string; href: string };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody,
  ) {
    super(body.message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      ...init,
      headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    });
  } catch {
    throw new ApiError(0, { code: 'network', message: 'Could not reach the CodePilot server. Check your connection and try again.' });
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiError(res.status, body ?? { code: 'http_' + res.status, message: `Request failed (${res.status}).` });
  }
  return res.json() as Promise<T>;
}

// --- Types mirroring the server responses -----------------------------------

export interface Me {
  user: { id: string; name: string | null; email: string | null; avatarUrl: string | null } | null;
  github?: { login: string | null } | null;
  google?: { email: string | null } | null;
}

export interface Providers {
  github: boolean;
  google: boolean;
  dev: boolean;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  ownerType: 'User' | 'Organization';
  fullName: string;
  private: boolean;
  language: string | null;
  description: string | null;
  updatedAt: string;
  pushedAt: string | null;
  defaultBranch: string;
  htmlUrl: string;
  sizeKb: number;
  archived: boolean;
  fork: boolean;
  project: { id: string; branch: string; lastStatus: string | null; analyzedAt: string | null } | null;
}

export interface RepoList {
  repos: Repo[];
  total: number;
  page: number;
  pages: number;
  perPage: number;
  owners: { login: string; type: string; count: number }[];
  truncated: boolean;
  fetchedAt: string;
}

export interface Branch {
  name: string;
  protected: boolean;
  isDefault: boolean;
  commitSha: string;
}

export interface ScanPolicy {
  excludedDirectories: string[];
  secretFiles: string[];
  secretContent: string[];
  generated: string[];
  limits: { maxParseBytes: number; maxFiles: number };
}

export interface Project {
  id: string;
  owner: string;
  repo: string;
  fullName: string;
  private: boolean;
  defaultBranch: string | null;
  branch: string;
  htmlUrl: string | null;
  isSample: boolean;
}

export interface AnalysisInfo {
  id: string;
  branch: string;
  status: 'queued' | 'running' | 'complete' | 'failed';
  stage: string;
  counters: { filesScanned: number; nodesClassified: number; edgesFound: number };
  commitSha: string | null;
  error: { code: string; message: string } | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface ProjectInfo {
  project: Project;
  analysis: AnalysisInfo | null;
  completed: AnalysisInfo | null;
}

export type Layout = 'force' | 'circular' | 'layered' | 'type' | 'directory';

export interface PositionedNode extends GraphNode {
  x: number;
  y: number;
  exportsPreview?: string[];
  exportCount?: number;
}

export interface GraphResponse {
  project: Project;
  analysis: { id: string; branch: string; commitSha: string | null; finishedAt: string | null };
  layout: Layout;
  nodes: PositionedNode[];
  edges: GraphEdge[];
  cycles?: GraphSummary['cycles'];
  orphans?: string[];
  entryPoints?: string[];
  frameworks: string[];
  scan: ScanStats;
  warnings: string[];
}

export interface ArchitectureResponse {
  project: Project;
  analysis: GraphResponse['analysis'];
  architecture: Pick<Architecture, 'layers' | 'nodes' | 'edges' | 'evidence' | 'generatedAt'> & {
    id: string;
    detectorVersion: number;
    commitSha: string | null;
    reused: boolean;
    patterns: ArchitectureSummary['patterns'];
    totals: ArchitectureSummary['totals'];
    /** Absent for architectures computed before the system map existed (regenerate to get it). */
    system?: SystemMap;
    flows: { id: string; title: string; trigger: Flow['trigger']; variant?: Flow['variant']; confidence: Confidence; steps: number; action?: Flow['action']; lanes?: FlowLane[] }[];
  };
}

export interface ToolDetails {
  node: ArchNode;
  chips: ArchNode[];
  hosts: ArchNode[];
  connections: { edge: ArchEdge; direction: 'in' | 'out'; other: { id: string; name: string; kind?: string; layer?: Layer; category?: string } }[];
  blast: Omit<BlastRadius, 'nodes'> & { nodes: (BlastRadius['nodes'][number] & { name: string; layer?: Layer })[] };
  flows: { id: string; title: string }[];
  evidence: Record<string, Evidence>;
  confidenceLabel: string;
}

export interface IntelligenceResponse {
  project: Project;
  analysis: GraphResponse['analysis'];
  /** The analysis snapshot these explanations belong to. */
  snapshot: { architectureId: string; commitSha: string | null; generatedAt: string; detectorVersion: number; analysisId: string };
  technologies: TechIntel[];
  evidence: Record<string, Evidence>;
}

/** A completed analysis: project → branch → commit → analysis. */
export interface Snapshot {
  analysisId: string;
  branch: string;
  commitSha: string | null;
  finishedAt: string | null;
  current: boolean;
}

export interface ShareLink {
  id: string;
  kind: 'wireframe' | 'architecture';
  token: string;
  url: string;
  embedUrl: string;
}

/* ---- Code tab ---- */

export type CodeState = 'ready' | 'storing' | 'empty' | 'failed' | 'pending' | 'not-stored';
/** Compact explorer entry: path, size, language, lines, masked count; or a not-stored entry with its reason. */
export interface CodeEntry {
  p: string;
  s?: number;
  l?: string;
  n?: number;
  m?: number;
  r?: string;
  d?: 1;
}
export interface CodeTree {
  state: CodeState;
  snapshot: { analysisId: string; branch: string; commitSha: string | null; createdAt: string; analysisStatus: string; analysisStage: string; storedAt: string | null };
  counts: { stored: number; notStored: number; notStoredDirectories: number; notStoredFiles: number; byReason: Record<string, number>; bytes: number };
  truncated: boolean;
  storeError: string | null;
  failure: { analysisId: string; stage: string; code: string | null; message: string | null } | null;
  reasons: Record<string, string>;
  entries: CodeEntry[];
  canRetry: boolean;
}
export type CodeFile =
  | { path: string; stored: true; language: string; size: number; lines: number; maskedLines: number[]; content: string; analysisId: string }
  | { path: string; stored: false; directory: boolean; reason: string; reasonText: string; size: number | null };
export interface CodeOutline {
  path: string;
  language: string | null;
  supported: boolean;
  symbols: { name: string; kind: string; line: number; depth: number }[];
}
export interface CodeRelations {
  status: 'ready' | 'pending' | 'unavailable';
  importsAnalyzed: boolean;
  importers: { path: string; line: number; specifier: string; symbols: string[]; typeOnly: boolean }[];
  imports: { specifier: string; line: number; symbols: string[]; typeOnly: boolean; resolved: boolean; external: boolean; target: string | null; packageName: string | null; reason: string | null }[];
}
export interface CodeSearchResult {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  results: { path: string; total: number; matches: { line: number; col: number; len: number; text: string; offset: number }[] }[];
  filesSearched: number;
  filesMatched: number;
  matches: number;
  truncated: boolean;
}
export interface CodeSnapshotQuery {
  analysisId?: string;
  commit?: string;
}

/** Where view data comes from: a project the user can access, or a read-only share token. */
export interface DataSource {
  base: string;
  readOnly: boolean;
  projectId?: string;
}

export const projectSource = (id: string): DataSource => ({ base: `/api/projects/${encodeURIComponent(id)}`, readOnly: false, projectId: id });
export const shareSource = (token: string): DataSource => ({ base: `/api/shared/${encodeURIComponent(token)}`, readOnly: true });

export interface SummaryResponse {
  project: Project;
  analysis: GraphResponse['analysis'];
  summary: GraphSummary;
  unresolved: { total: number; items: { source: string; specifier: string; line: number; reason: string }[] };
  frameworks: string[];
  scan: ScanStats;
  warnings: string[];
}

export interface NodeDetails {
  node: GraphNode;
  facts: { exports: ExportEntry[]; diagnostics: FileDiagnostic[] };
  imports: {
    edgeId: string;
    target: string;
    targetPath: string;
    targetType?: NodeType;
    specifier: string;
    symbols: string[];
    kind: EdgeKind;
    line: number;
    resolved: boolean;
    external: boolean;
    typeOnly: boolean;
    resolution?: string;
    unresolvedReason?: string;
  }[];
  consumers: { edgeId: string; source: string; sourceType?: NodeType; specifier: string; symbols: string[]; kind: EdgeKind; line: number; typeOnly: boolean }[];
  dependencies: string[];
  dependents: string[];
  counts: { dependencies: number; dependents: number; externalImports: number; unresolvedImports: number };
  transitive: { dependencies: Record<1 | 2 | 3, string[]>; dependents: Record<1 | 2 | 3, string[]> };
  entryPoint: string[] | null;
  orphan: boolean;
  cycles: number[];
}

/* ---------------------------------------------------------------- Automation Engine */

export type { AutoNode, AutoEdge, AutoEvidence, AutoLane, AutoNodeType, AutoEdgeKind, MainFlow, FlowExplanation, ExplanationItem, CycleType, EntryRef, Diagnostics as AutomationDiagnostics } from '@codepilot/analyzer/automation/types';
import type { MainFlow as AutoMainFlow, EntryRef as AutoEntryRef, Diagnostics as AutoDiagnostics, CycleType as AutoCycle } from '@codepilot/analyzer/automation/types';

export interface AutomationFlow extends AutoMainFlow {
  renamed: boolean;
}

export interface AutomationResponse {
  schemaVersion: number;
  /** The stored flows were made by another engine version and were rebuilt for this request. */
  regenerated: boolean;
  status: 'ok' | 'fallback' | 'partial' | 'empty';
  projectType: string;
  projectTypeLabel: string;
  project: { name: string };
  snapshot: { analysisId: string; branch: string; commitSha: string | null; finishedAt: string | null };
  latestAnalysis: { status: string; error: { code: string | null; message: string | null } } | null;
  flows: AutomationFlow[];
  candidates: { id: string; key: string; name: string; cycle: AutoCycle; purpose: string; steps: number; confidence: AutoMainFlow['confidence']; partial: boolean; selected: boolean }[];
  coverage: { total: number; shown: number; folded: number; omitted: number };
  diagnostics: AutoDiagnostics;
}

export interface AutomationCoverage {
  total: number;
  shown: AutoEntryRef[];
  folded: AutoEntryRef[];
  omitted: AutoEntryRef[];
}

/* ---------------------------------------------------------------- Collective Intelligence */

export interface PrivacyPolicy {
  minN: number;
  minCell: number;
}
/** One aggregate cell; `count`/`share` are null when the cell is suppressed for privacy. */
export interface StatCell {
  count: number | null;
  share: number | null;
  suppressed: boolean;
}
export interface PopulationInfo {
  key: string;
  n: number;
  definition: string;
}
export interface CollectiveFrame {
  label: 'COLLECTIVE DATA';
  status: 'available' | 'withheld';
  population: PopulationInfo | null;
  considered: PopulationInfo[];
  policy: PrivacyPolicy;
  privacy: string;
  note: string;
}
export interface MetricBenchmark {
  metric: string;
  label: string;
  definition: string;
  n: number;
  thisProject: { bucket: string };
  distribution: ({ bucket: string; isThisProject: boolean } & StatCell)[];
  position: { lower: StatCell; same: StatCell; higher: StatCell };
}
export interface ThisProjectFrame {
  label: 'THIS PROJECT';
  source: string;
}
export interface BenchmarkResponse {
  snapshot: { analysisId: string; branch: string; commitSha: string | null; finishedAt: string | null };
  thisProject: ThisProjectFrame & { pattern: string; sizeBand: string; metrics: { metric: string; label: string; definition: string; value: string; bucket: string }[] };
  collective: CollectiveFrame & { computedMonth: string | null; metrics: MetricBenchmark[] };
  consent: { enabled: boolean };
}
export interface ReviewedPattern {
  id: string;
  status: 'pending_review' | 'approved' | 'rejected';
  claim: 'correlation' | 'causal';
  kind: string;
  statement: string;
  n: number;
  support: number;
  confidence: number;
  baseline: number;
  lift: number;
  chi2: number;
  reviewNote: string | null;
  reviewedMonth: string | null;
}
export interface InsightItem extends StatCell {
  trait?: string;
  element?: string;
  label: string;
  kind: 'observed' | 'correlated';
  n: number;
  statement: string;
}
export interface InsightsResponse {
  snapshot: BenchmarkResponse['snapshot'];
  thisProject: ThisProjectFrame & { traits: { trait: string; label: string }[] };
  collective: CollectiveFrame & {
    prevalence: InsightItem[];
    outcomes: { status: 'available' | 'no-outcome-data'; reporting: StatCell | null; items: InsightItem[] };
    reviewedPatterns: ReviewedPattern[];
  };
}
export interface CollectiveStatus {
  enabled: boolean;
  canChange: boolean;
  schemaVersion: number;
  policy: PrivacyPolicy;
  history: { action: 'granted' | 'revoked'; schemaVersion: number; by: string | null; at: string; effect: Record<string, unknown> | null }[];
  contributed: { month: string; active: boolean; current: boolean; fingerprint: Record<string, unknown> }[];
  outcomes: { element: string; month: string; active: boolean }[];
  retention: string;
}
export interface CollectiveSchema {
  version: number;
  fields: { field: string; meaning: string; values?: readonly string[] }[];
  never: string[];
  policy: PrivacyPolicy;
}
export interface StateOfArchitecture {
  label: 'COLLECTIVE DATA';
  status: 'available' | 'withheld';
  population: PopulationInfo;
  policy: PrivacyPolicy;
  note: string;
  computedMonth?: string;
  sections: { id: string; title: string; items: ({ trait: string; label: string } & StatCell)[] }[];
  metrics?: { metric: string; label: string; definition: string; n: number; distribution: ({ bucket: string } & StatCell)[] }[];
  reviewedPatterns?: ReviewedPattern[];
}
export interface IncidentTagResult {
  id: string;
  nodeId: string;
  month: string;
  source: string;
  contributed: { element: string; month: string; outcome: 'incident' } | null;
  descriptionShared: false;
  note: string;
}

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });
const q = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
};
const enc = encodeURIComponent;

export const api = {
  me: () => request<Me>('/api/me'),
  providers: () => request<Providers>('/api/auth/providers'),
  devSignIn: () => request<{ ok: true }>('/api/auth/dev', json({})),
  logout: () => request<{ ok: true }>('/api/auth/logout', json({})),
  scanPolicy: () => request<ScanPolicy>('/api/scan-policy'),
  sample: () => request<{ projectId: string | null; status: string | null }>('/api/sample'),
  repos: (params: { q?: string; owner?: string; page?: number; perPage?: number; refresh?: boolean }) =>
    request<RepoList>(`/api/github/repos${q({ ...params, refresh: params.refresh ? '1' : undefined })}`),
  repo: (owner: string, repo: string) => request<{ repo: Repo; branches: Branch[] }>(`/api/github/repos/${enc(owner)}/${enc(repo)}`),
  createProject: (owner: string, repo: string, branch: string) => request<{ projectId: string; analysisId: string }>('/api/projects', json({ owner, repo, branch })),
  project: (id: string) => request<ProjectInfo>(`/api/projects/${enc(id)}`),
  snapshots: (id: string) => request<{ snapshots: Snapshot[] }>(`/api/projects/${enc(id)}/snapshots`),
  graph: (id: string, layout: Layout) => request<GraphResponse>(`/api/projects/${enc(id)}/graph${q({ layout })}`),
  summary: (id: string) => request<SummaryResponse>(`/api/projects/${enc(id)}/graph/summary`),
  node: (id: string, nodeId: string) => request<NodeDetails>(`/api/projects/${enc(id)}/graph/nodes/${enc(nodeId)}`),
  exportUrl: (id: string, format: 'png' | 'svg' | 'json', layout: Layout, types?: string[]) =>
    `/api/projects/${enc(id)}/graph/export${q({ format, layout, types: types?.join(',') })}`,
  streamUrl: (id: string, analysisId?: string) => `/api/projects/${enc(id)}/analysis/stream${q({ analysisId })}`,
  createShare: (id: string, kind: 'wireframe' | 'architecture') => request<ShareLink>(`/api/projects/${enc(id)}/shares`, json({ kind })),
  shared: (token: string) => request<{ kind: 'wireframe' | 'architecture'; project: Project; analysis: GraphResponse['analysis'] }>(`/api/shared/${enc(token)}`),
  collectiveStatus: (id: string) => request<CollectiveStatus>(`/api/projects/${enc(id)}/collective-intelligence/status`),
  setCollectiveConsent: (id: string, enabled: boolean) =>
    request<{ enabled: boolean; effect: Record<string, unknown>; status: CollectiveStatus }>(`/api/projects/${enc(id)}/collective-intelligence/consent`, json({ enabled })),
  benchmark: (id: string) => request<BenchmarkResponse>(`/api/projects/${enc(id)}/benchmark`),
  patternInsights: (id: string) => request<InsightsResponse>(`/api/projects/${enc(id)}/pattern-insights`),
  stateOfArchitecture: () => request<StateOfArchitecture>('/api/collective-intelligence/state-of-architecture'),
  collectiveSchema: () => request<CollectiveSchema>('/api/collective-intelligence/schema'),
  replaceFlow: (id: string, flowId: string, key: string) => request<AutomationResponse>(`/api/projects/${enc(id)}/automation/flows/${enc(flowId)}/replace`, json({ key })),
  renameFlow: (id: string, flowId: string, name: string | null) => request<AutomationResponse>(`/api/projects/${enc(id)}/automation/flows/${enc(flowId)}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  incidentTag: (id: string, nodeId: string, body: { month?: string; source?: string; description?: string }) =>
    request<IncidentTagResult>(`/api/projects/${enc(id)}/graph/nodes/${enc(nodeId)}/incident-tag`, json(body)),
};

/** Data endpoints shared by project views and read-only share views. */
export const data = {
  graph: (src: DataSource, layout: Layout) => request<GraphResponse>(`${src.base}/graph${q({ layout })}`),
  layout: (src: DataSource, layout: Layout) => request<{ layout: Layout; positions: Record<string, [number, number]> }>(`${src.base}/graph/layout${q({ layout })}`),
  summary: (src: DataSource) => request<SummaryResponse>(`${src.base}/graph/summary`),
  node: (src: DataSource, nodeId: string) => request<NodeDetails>(`${src.base}/graph/nodes/${enc(nodeId)}`),
  graphExportUrl: (src: DataSource, format: 'png' | 'svg' | 'json', layout: Layout, types?: string[]) => `${src.base}/graph/export${q({ format, layout: layout, types: types?.join(',') })}`,
  architecture: (src: DataSource) => request<ArchitectureResponse>(`${src.base}/architecture`),
  regenerate: (src: DataSource) => request<ArchitectureResponse>(`${src.base}/architecture/regenerate`, json({})),
  tool: (src: DataSource, id: string) => request<ToolDetails>(`${src.base}/architecture/tools/${enc(id)}`),
  /** Flows of the latest analysis, or of a specific snapshot. */
  flows: (src: DataSource, analysisId?: string) => request<{ flows: Flow[]; evidence: Record<string, Evidence> }>(`${src.base}/architecture/flows${q({ analysisId })}`),
  intelligence: (src: DataSource) => request<IntelligenceResponse>(`${src.base}/architecture/intelligence`),
  automation: (src: DataSource) => request<AutomationResponse>(`${src.base}/automation/flows`),
  automationCoverage: (src: DataSource) => request<AutomationCoverage>(`${src.base}/automation/coverage`),
  archSummary: (src: DataSource) => request<{ summary: ArchitectureSummary; evidence: Record<string, Evidence> }>(`${src.base}/architecture/summary`),
  archExportUrl: (src: DataSource, format: 'png' | 'svg' | 'pdf' | 'mermaid' | 'json', overlay: Overlay) => `${src.base}/architecture/export${q({ format, overlay })}`,
};

/** Code tab: always pinned to one snapshot (analysis) once the tree has resolved it. */
export const code = {
  tree: (projectId: string, snap: CodeSnapshotQuery) => request<CodeTree>(`/api/projects/${enc(projectId)}/code${q({ ...snap })}`),
  file: (projectId: string, analysisId: string, path: string) => request<CodeFile>(`/api/projects/${enc(projectId)}/code/file${q({ analysisId, path })}`),
  outline: (projectId: string, analysisId: string, path: string) => request<CodeOutline>(`/api/projects/${enc(projectId)}/code/outline${q({ analysisId, path })}`),
  relations: (projectId: string, analysisId: string, path: string) => request<CodeRelations>(`/api/projects/${enc(projectId)}/code/relations${q({ analysisId, path })}`),
  search: (projectId: string, analysisId: string, query: string, opts: { caseSensitive: boolean; wholeWord: boolean }, signal?: AbortSignal) =>
    request<CodeSearchResult>(`/api/projects/${enc(projectId)}/code/search${q({ analysisId, q: query, case: opts.caseSensitive ? 1 : undefined, word: opts.wholeWord ? 1 : undefined })}`, { signal }),
};

/** Full-page navigations for OAuth (the server redirects to the provider). */
export const authUrls = {
  github: (next?: string, intent: 'signin' | 'connect' = 'signin') => `/api/auth/github/start${q({ intent, next })}`,
  google: (next?: string) => `/api/auth/google/start${q({ next })}`,
};
