import type { DependencyGraph } from '../types.ts';
import type { EvidenceStore, FileUses } from './evidence.ts';
import type { FileGraph } from './graph.ts';
import type { ArchNode, ArchNodeKind, ArchitectureFacts, CallFact, ComposeService, Confidence, EdgeLabel, EvidenceRef, Layer, OpKind, Overlay, RouteFact, ToolCategory } from './types.ts';

/**
 * What flow tracing and the summary need from detection. Declared separately so those modules
 * depend on this contract, not on the detector implementation (no import cycle).
 */

export type AppKind = 'service' | 'worker' | 'client' | 'function';

export interface AppInfo {
  id: string;
  name: string;
  root: string;
  kind: AppKind;
  framework?: string;
  entry?: { file: string; line?: number };
  /** Files reachable from the entry, when the entry is known and the root is shared. */
  closure?: Set<string>;
  compose?: { file: string; service: ComposeService };
  /** Dockerfile that builds the app, when known. */
  dockerfile?: string;
  synthesized?: boolean;
  evidence: string[];
  confidence: Confidence;
  reason: string;
}

export interface NodeDraft {
  id: string;
  kind: ArchNodeKind;
  name: string;
  category: ToolCategory;
  layer: Layer;
  display: 'node' | 'chip';
  hosts: Set<string>;
  version?: ArchNode['version'];
  confidence: Confidence;
  roles: string[];
  description?: string;
  reasons: string[];
  evidence: Set<string>;
  files: FileUses;
  badges: ArchNode['badges'];
  app?: ArchNode['app'];
  catalog?: string;
  /** Operations observed on this node, for role text. */
  ops: Map<OpKind, Set<string>>;
}

export interface EdgeDraft {
  id: string;
  source: string;
  target: string;
  labels: Set<EdgeLabel>;
  overlays: Set<Overlay>;
  confidence: Confidence;
  async: boolean;
  evidence: Set<string>;
  reasons: string[];
}


export interface DetectorContext {
  readonly facts: ArchitectureFacts;
  readonly graph: DependencyGraph;
  readonly ev: EvidenceStore;
  readonly nodes: Map<string, NodeDraft>;
  readonly edges: Map<string, EdgeDraft>;
  readonly apps: AppInfo[];
  readonly fileGraph: FileGraph;
  readonly fileSet: Set<string>;
  readonly limitations: string[];
  readonly routesByApp: Map<string, RouteFact[]>;
  readonly serviceNode: Map<string, string>;
  e(ref: EvidenceRef): string;
  appById(id: string): AppInfo | undefined;
  appsOf(file: string): string[];
  callEvidence(c: CallFact): string;
  targetFor(toolId: string, appId?: string): string;
  ormBackend(ormId: string): { tool: string; evidence: string[]; inferred?: boolean } | undefined;
  isUiFile(file: string, app: AppInfo): boolean;
}
