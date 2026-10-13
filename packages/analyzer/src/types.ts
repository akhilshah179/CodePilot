/**
 * Shared data contracts for the CodePilot analysis engine.
 *
 * Everything in a DependencyGraph is derived from files on disk. Nothing here is
 * allowed to carry file contents or secret values — only paths, import
 * specifiers, symbol names, line numbers and sizes.
 */

export const FILE_NODE_TYPES = [
  'route',
  'page',
  'component',
  'action',
  'service',
  'utility',
  'api',
  'config',
  'other',
] as const;

export type FileNodeType = (typeof FILE_NODE_TYPES)[number];
export type NodeType = FileNodeType | 'external' | 'unresolved';

export const EDGE_KINDS = ['static', 'dynamic', 're-export', 'require'] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export interface ClassificationEvidence {
  /** Stable rule identifier, e.g. `path:next-app-page` or `content:use-server`. */
  rule: string;
  /** Human-readable explanation of what matched. */
  detail: string;
  source: 'path' | 'content' | 'default';
  /** 1-based line for content evidence. */
  line?: number;
}

export interface GraphNode {
  /** Repo-relative POSIX path for files; `ext:<package>` for external packages; `unresolved:<key>` otherwise. */
  id: string;
  path: string;
  type: NodeType;
  language: string;
  /** Bytes on disk (0 for external/unresolved). */
  size: number;
  classification_evidence: ClassificationEvidence[];
  /** Top-level directory (`.` for files at the repository root). */
  directory: string;
  /** True when imports were extracted from this file's source. */
  analyzed: boolean;
  /** Why the file was not analyzed, when `analyzed` is false and it is a file node. */
  not_analyzed_reason?: string;
  flags?: NodeFlags;
  /** Physical line count, for text files that were read. */
  loc?: number;
  /** Cyclomatic complexity, for parsed JS/TS files. */
  complexity?: ComplexityFacts;
}

/**
 * McCabe cyclomatic complexity: 1 + decision points (if, ?:, loops, case, catch, &&, ||, ??)
 * per function. Top-level statements with decisions count as one extra unit named `(module)`.
 */
export interface ComplexityFacts {
  functions: number;
  /** Highest per-function complexity, with the function it belongs to. */
  max: number;
  maxName?: string;
  maxLine?: number;
  /** Decision points across the whole file. */
  decisions: number;
}

export interface NodeFlags {
  /** Number of credential-like values detected. Values themselves are never stored. */
  secretsDetected?: number;
  parseErrors?: number;
  builtin?: boolean;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  /** Imported symbol names as written in the source (`default`, `*`, or named bindings). */
  symbols: string[];
  kind: EdgeKind;
  /** 1-based line of the import statement in `source`. */
  line: number;
  resolved: boolean;
  /** Raw module specifier from the source code. */
  specifier: string;
  typeOnly: boolean;
  external: boolean;
  /** How the specifier was resolved (e.g. `relative+extension`, `tsconfig-paths @/* (tsconfig.json)`). */
  resolution?: string;
  /** Why resolution failed, when `resolved` is false. */
  unresolved_reason?: string;
}

export interface ExportEntry {
  name: string;
  kind:
    | 'function'
    | 'class'
    | 'variable'
    | 'type'
    | 'interface'
    | 'enum'
    | 'namespace'
    | 'default'
    | 'named'
    | 're-export'
    | 'commonjs';
  line: number;
  /** For re-exports, the specifier they come from. */
  from?: string;
}

export interface FileDiagnostic {
  line: number;
  code: 'non-literal-dynamic-import' | 'non-literal-require' | 'glob-import' | 'parse-error';
  message: string;
}

export interface FileFacts {
  exports: ExportEntry[];
  diagnostics: FileDiagnostic[];
}

export interface EntryPoint {
  id: string;
  reasons: string[];
}

export interface CycleChain {
  /** All files in the strongly connected component. */
  members: string[];
  /** One concrete cycle through the component, as edge hops that can be traced to source lines. */
  chain: { source: string; target: string; line: number }[];
  /** True when every edge in the chain is a type-only import (harmless at runtime). */
  typeOnly: boolean;
}

export interface RankedNode {
  id: string;
  count: number;
}

export interface GraphSummary {
  totals: {
    files: number;
    analyzedFiles: number;
    dependencies: number;
    externalImports: number;
    externalPackages: number;
    unresolvedImports: number;
  };
  countsByType: Record<FileNodeType, number>;
  mostDependedOn: RankedNode[];
  mostDependencies: RankedNode[];
  cycles: CycleChain[];
  orphans: { id: string; hasDependencies: boolean }[];
  entryPoints: EntryPoint[];
}

export interface ExcludedFile {
  path: string;
  reason: ExclusionReason;
}

export type ExclusionReason =
  | 'excluded-directory'
  | 'secret-file'
  | 'secret-content'
  | 'generated'
  | 'lockfile'
  | 'binary'
  | 'symlink';

export interface ScanStats {
  filesScanned: number;
  excluded: Record<ExclusionReason, number>;
  excludedDirectories: string[];
}

export interface RepositoryMetadata {
  owner?: string;
  name?: string;
  branch?: string;
  commitSha?: string;
}

export interface DependencyGraph {
  version: 1;
  generatedAt: string;
  repository: RepositoryMetadata;
  nodes: GraphNode[];
  edges: GraphEdge[];
  files: Record<string, FileFacts>;
  summary: GraphSummary;
  scan: ScanStats;
  frameworks: string[];
  warnings: string[];
}

export type AnalysisStage = 'scanning' | 'parsing' | 'resolving' | 'building';

export interface AnalysisProgress {
  stage: AnalysisStage;
  filesScanned: number;
  nodesClassified: number;
  edgesFound: number;
}

export interface PartialGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface AnalyzeOptions {
  repository?: RepositoryMetadata;
  /** Additional repo-relative directory prefixes to skip (used for the bundled sample). */
  ignore?: string[];
  onProgress?: (p: AnalysisProgress) => void;
  onPartial?: (p: PartialGraph) => void;
  /** Files larger than this are listed but not parsed. */
  maxParseBytes?: number;
  maxFiles?: number;
  signal?: AbortSignal;
}
