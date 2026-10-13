import type { ArchEdge, ArchNode, Confidence, EdgeKind, ExportEntry, Flow, Layer, NodeType } from '../../lib/api.ts';
import data from './heroGraph.json';

export interface HeroSnapshot {
  generatedAt: string;
  commit: string | null;
  totals: { files: number; edges: number; externalPackages: number };
  nodes: { id: string; type: NodeType; directory: string; x: number; y: number }[];
  edges: { source: string; target: string; kind: EdgeKind; line: number; typeOnly: boolean }[];
  hubs: string[];
  chain: { id: string; line?: number }[];
  tech: { name: string; version: string; file: string; line: number }[];
  doc: { id: string; exports: ExportEntry[]; consumers: { id: string; line: number }[]; dependencies: { id: string; line: number }[] };
  frameworks: string[];
  /** Exported symbols per file (up to 8 each). */
  symbols: { file: string; name: string; kind: string; line: number }[];
  /** External packages imported by source files, most-imported first. */
  packages: { name: string; files: string[] }[];
  /** Technology intelligence for catalogued technologies. */
  technologies: {
    id: string;
    name: string;
    category: string;
    version?: string;
    confidence: 'confirmed' | 'strong' | 'possible' | 'unknown';
    general?: string;
    role: string;
    why: string;
    usedBy: string[];
    files: { path: string; line?: number }[];
    connections: { direction: 'in' | 'out'; name: string; labels: string[] }[];
    routes: number;
    flows: number;
    evidence: { kind: string; file: string; line?: number; snippet?: string; detail: string }[];
  }[];
  /** A user action traced end to end without an unknown hop. */
  traceFlow: {
    id: string;
    name: string;
    title: string;
    steps: { stage?: string; kind?: string; label: string; file: string; line?: number; fn?: string; transport?: string; branch?: string; explanation: string }[];
  } | null;
  architecture: {
    layers: Layer[];
    nodes: (Pick<ArchNode, 'id' | 'kind' | 'name' | 'category' | 'layer' | 'display' | 'role' | 'confidence'> & { version?: string; files: { path: string; line?: number }[]; chips: string[] })[];
    edges: { id: string; source: string; target: string; labels: ArchEdge['labels']; confidence: Confidence; evidence: string[] }[];
    flow: Flow | null;
    evidence: Record<string, { id: string; kind: string; file: string; line?: number; snippet?: string; detail: string }>;
    pattern: string | null;
    stats: { routes: number; apps: number; tools: number; hosts: number; edges: number; flows: number; evidence: number };
  };
}

/** Output of `npm run hero:snapshot`: the real analysis of this repository. */
export const snapshot = data as unknown as HeroSnapshot;
