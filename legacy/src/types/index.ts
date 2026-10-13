export type ConfidenceLevel = 'CONFIRMED' | 'STRONG_INFERENCE' | 'POSSIBLE' | 'UNKNOWN';

export type TechnologyCategory =
  | 'Frontend Framework'
  | 'Backend Framework'
  | 'Programming Language'
  | 'Database'
  | 'Cache'
  | 'Message Queue'
  | 'ORM'
  | 'Authentication'
  | 'Cloud Services'
  | 'Payment Services'
  | 'Storage'
  | 'ML Framework'
  | 'Testing'
  | 'Monitoring'
  | 'CI/CD'
  | 'Deployment'
  | 'Infrastructure';

export type NodeType =
  | 'service'
  | 'frontend'
  | 'backend'
  | 'api'
  | 'database'
  | 'cache'
  | 'queue'
  | 'cloud'
  | 'file'
  | 'function'
  | 'class'
  | 'component'
  | 'auth'
  | 'storage'
  | 'ml';

export type NodeLayer = 'client' | 'gateway' | 'service' | 'data' | 'external' | 'infra';

export type RelationType =
  | 'CONTAINS'
  | 'IMPORTS'
  | 'CALLS'
  | 'DEPENDS_ON'
  | 'USES'
  | 'CONNECTS_TO'
  | 'READS_FROM'
  | 'WRITES_TO'
  | 'CALLS_API'
  | 'AUTHENTICATES_WITH'
  | 'CACHES_IN'
  | 'PUBLISHES_TO'
  | 'SUBSCRIBES_TO'
  | 'DEPLOYS_TO'
  | 'CONFIGURED_BY';

export interface Evidence {
  file: string;
  line?: number;
  snippet: string;
  type: 'import' | 'call' | 'manifest' | 'config' | 'annotation' | 'schema' | 'class';
  description: string;
}

export interface Technology {
  id: string;
  name: string;
  category: TechnologyCategory;
  version: string;
  confidence: ConfidenceLevel;
  purpose: string;
  role: string;
  whyUsed: string;
  files: string[];
  evidence: Evidence[];
  connections: string[];
  icon?: string;
  color?: string;
}

export interface GraphNode {
  id: string;
  label: string;
  type: NodeType;
  layer: NodeLayer;
  technology?: string;
  filePath?: string;
  description: string;
  status?: 'healthy' | 'warning' | 'bottleneck';
  confidence: ConfidenceLevel;
  evidence: Evidence[];
  x: number;
  y: number;
  metrics?: {
    linesOfCode?: number;
    complexity?: 'Low' | 'Medium' | 'High';
    dependencyCount?: number;
    callers?: number;
  };
  tags?: string[];
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  relation: RelationType;
  confidence: ConfidenceLevel;
  evidence?: Evidence[];
  animated?: boolean;
  bidirectional?: boolean;
  description?: string;
}

export interface RequestFlowStep {
  stepIndex: number;
  nodeId: string;
  action: string;
  description: string;
  payloadPreview?: string;
  sourceFile?: string;
  sourceCode?: string;
  latencyEstimate?: string;
}

export interface RequestFlow {
  id: string;
  name: string;
  description: string;
  trigger: string;
  steps: RequestFlowStep[];
  edgeSequence: string[];
  category: 'auth' | 'data' | 'async' | 'payment' | 'ml' | 'general';
}

export interface ArchitectureAuditItem {
  id: string;
  title: string;
  type: 'bottleneck' | 'coupling' | 'circular' | 'spof' | 'caching' | 'scaling' | 'security';
  severity: 'critical' | 'high' | 'medium' | 'low';
  currentArchitecture: string;
  potentialImprovement: string;
  reason: string;
  tradeOffs: string;
  alternative: string;
  affectedNodes: string[];
}

export interface ImpactAnalysisResult {
  targetNodeId: string;
  targetNodeLabel: string;
  blastRadiusScore: number; // 0-100
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  directDependents: {
    nodeId: string;
    label: string;
    relation: string;
    impact: string;
    filePath?: string;
  }[];
  transitiveDependents: {
    nodeId: string;
    label: string;
    depth: number;
    path: string[];
  }[];
  breakingRisk: string;
  recommendedPreChecks: string[];
}

export interface InterviewQuestion {
  id: string;
  question: string;
  context: string;
  suggestedAnswer: string;
  evidenceReference: string;
  difficulty: 'Intermediate' | 'Advanced' | 'Staff';
  category: 'System Design' | 'Trade-offs' | 'Scaling' | 'Security' | 'Failure Recovery';
}

export interface InterviewPrep {
  elevatorPitch30s: string;
  overview2Min: string;
  architectureDeepDive5Min: string;
  technicalQuestions: InterviewQuestion[];
}

export interface SymbolInfo {
  name: string;
  kind: 'class' | 'function' | 'interface' | 'variable' | 'endpoint' | 'model';
  line: number;
  doc?: string;
}

export interface ProjectFile {
  path: string;
  name: string;
  extension: string;
  size: number;
  type: 'code' | 'config' | 'manifest' | 'doc' | 'infra' | 'asset';
  language?: string;
  content?: string;
  imports?: string[];
  exports?: string[];
  symbols?: SymbolInfo[];
}

export interface ProjectDocumentation {
  overview: string;
  architecture: string;
  apiReference: string;
  dataFlow: string;
  setupGuide: string;
  deployment: string;
}

export interface Project {
  id: string;
  name: string;
  fullName?: string;
  description: string;
  repoUrl?: string;
  branch: string;
  stars?: number;
  forks?: number;
  isSample?: boolean;
  lastSynced: string;
  stats: {
    filesCount: number;
    linesOfCode: number;
    languages: { name: string; percentage: number; color: string }[];
    servicesCount: number;
    apisCount: number;
    techCount: number;
    healthScore: number;
  };
  technologies: Technology[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  flows: RequestFlow[];
  auditItems: ArchitectureAuditItem[];
  files: ProjectFile[];
  interview: InterviewPrep;
  docs: ProjectDocumentation;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  citations?: {
    type: 'file' | 'tech' | 'node' | 'evidence';
    title: string;
    reference: string;
    snippet?: string;
    line?: number;
  }[];
  suggestedFollowUps?: string[];
}
