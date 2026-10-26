/*
 * Automation Engine: the main flows ("cycles") of a project as flowcharts. Built on the traced
 * request lifecycles, decision facts and the import graph; every node and edge carries evidence.
 */

/** Bump whenever the shape or the rules change; stored results with another version are regenerated. */
export const AUTOMATION_SCHEMA_VERSION = 2;

export const CYCLE_TYPES = ['access', 'core', 'data', 'background', 'startup'] as const;
export type CycleType = (typeof CYCLE_TYPES)[number];

export type ProjectType =
  | 'full-stack'
  | 'backend-api'
  | 'static-frontend'
  | 'nextjs'
  | 'microservices'
  | 'event-driven'
  | 'cli'
  | 'scripts'
  | 'library'
  | 'unsupported'
  | 'empty';

export type AutoNodeType = 'trigger' | 'ui' | 'request' | 'server' | 'decision' | 'store' | 'external' | 'job' | 'end' | 'jump' | 'unknown' | 'group';
export type AutoEdgeKind = 'sequence' | 'true' | 'false' | 'error' | 'async' | 'jump' | 'unknown' | 'group';
export const LANES = ['frontend', 'backend', 'data', 'external', 'background'] as const;
export type AutoLane = (typeof LANES)[number];

export interface AutoEvidence {
  file: string;
  line?: number;
  snippet?: string;
  detail?: string;
}

export interface AutoNode {
  id: string;
  type: AutoNodeType;
  label: string;
  /** Longer text: the step's explanation (cites file:line), the condition of a decision. */
  detail?: string;
  lane: AutoLane;
  file: string;
  line?: number;
  evidence: AutoEvidence[];
  /** Architecture node ids of the technologies this step uses. */
  tools: string[];
  dataIn?: string;
  dataOut?: string;
  /** How directly the code shows the step. */
  confidence: 'confirmed' | 'strong' | 'unknown';
  /** Order on the main path (1-based), for the step-by-step explanation; branches come after. */
  order: number;
  /** Decisions: the question, the condition as written, and which answer leaves the path. */
  decision?: { question: string; condition: string; kind: string };
  /** Group nodes: the folded endpoints. */
  members?: { label: string; file: string; line?: number }[];
  /** Jump nodes: the main flow this continues in. */
  jumpTo?: string;
  /** Route or job this node is the entry of, for jumps between flows. */
  entryKey?: string;
}

export interface AutoEdge {
  id: string;
  source: string;
  target: string;
  kind: AutoEdgeKind;
  /** What moves along the edge, as named in the code, or the branch answer. Absent rather than guessed. */
  label?: string;
  /** A timer the code sets on this transition (expiry, timeout, retry, schedule). */
  timer?: string;
  evidence: AutoEvidence[];
}

export interface ExplanationItem {
  text: string;
  cites: AutoEvidence[];
  nodeId?: string;
}

export interface FlowExplanation {
  what: ExplanationItem[];
  steps: ExplanationItem[];
  data: { inputs: ExplanationItem[]; stored: ExplanationItem[]; returned: ExplanationItem[] };
  decisions: ExplanationItem[];
  tools: ExplanationItem[];
  folded: ExplanationItem[];
  confidence: { percent: number; traced: number; total: number; unknown: ExplanationItem[] };
}

export interface EntryRef {
  key: string;
  label: string;
  kind: 'route' | 'page' | 'action' | 'queue' | 'schedule' | 'ui' | 'command' | 'startup';
  file: string;
  line?: number;
  /** For omitted entries: why. */
  reason?: string;
}

export interface MainFlow {
  /** Stable across commits while the capability exists (hash of the capability key). */
  id: string;
  key: string;
  cycle: CycleType;
  name: string;
  /** Name generated from the code; `name` differs only when a user renamed the flow. */
  generatedName: string;
  purpose: string;
  nodes: AutoNode[];
  edges: AutoEdge[];
  tools: { id: string; name: string }[];
  confidence: { percent: number; label: 'Fully traced' | 'Mostly traced' | 'Partially traced' };
  /** Validation failed but this is the best available flow. */
  partial: boolean;
  problems: string[];
  explanation: FlowExplanation;
  entries: { shown: EntryRef[]; folded: EntryRef[] };
  /** Traced lifecycle flows this main flow is built from. */
  sourceFlowIds: string[];
  score: number;
}

export interface Diagnostics {
  entryPoints: number;
  tracedFlows: number;
  capabilities: number;
  flowsBuilt: number;
  rejected: { name: string; reasons: string[] }[];
  /** Share of entry points with a traced flow. */
  traceCoverage: number;
  notes: string[];
  fallback?: { kind: 'client' | 'startup' | 'command' | 'script' | 'unsupported'; reason: string };
}

export interface AutomationResult {
  schemaVersion: number;
  projectType: ProjectType;
  projectTypeLabel: string;
  status: 'ok' | 'fallback' | 'partial' | 'empty';
  /** Every capability that produced a valid (or best partial) flow, ranked; the first ones are the default selection. */
  flows: MainFlow[];
  /** Keys of the default main flows (at most 4). */
  selected: string[];
  coverage: { total: number; shown: EntryRef[]; folded: EntryRef[]; omitted: EntryRef[] };
  diagnostics: Diagnostics;
}
