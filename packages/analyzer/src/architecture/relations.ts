import type { ArchEdge } from './types.ts';

/**
 * Relationship semantics shared by the web diagram and the exports. Colour has meaning and only
 * these meanings: cyan = request/data calls, blue = reads/consumption, green = writes, amber =
 * publishing, purple = identity/auth, neutral = structural (depends on, deploys).
 */
export type Relation = 'calls' | 'reads' | 'writes' | 'caches' | 'publishes' | 'subscribes' | 'auth' | 'depends' | 'uses' | 'proxy' | 'delivery';

export const RELATION_LABELS: Record<Relation, string> = {
  calls: 'Calls',
  reads: 'Reads / queries',
  writes: 'Writes',
  caches: 'Reads and writes cache',
  publishes: 'Publishes / enqueues',
  subscribes: 'Subscribes / consumes',
  auth: 'Authenticates with',
  depends: 'Depends on',
  uses: 'Uses',
  proxy: 'Routes to',
  delivery: 'Builds / deploys',
};

export function relationOf(labels: string[]): Relation {
  const has = (...l: string[]) => labels.some((x) => l.includes(x));
  if (has('OAuth', 'auth')) return 'auth';
  if (has('publish', 'enqueue', 'pub/sub')) return 'publishes';
  if (has('consume')) return 'subscribes';
  if (has('cache write') && has('cache read')) return 'caches';
  if (has('cache write')) return 'writes';
  if (has('cache read', 'SQL', 'query')) return 'reads';
  if (has('REST', 'HTTP', 'gRPC', 'GraphQL', 'WebSocket', 'API call', 'webhook', 'email', 'object storage')) return 'calls';
  if (has('proxy')) return 'proxy';
  if (has('deploys', 'builds', 'tests', 'hosts', 'configures')) return 'delivery';
  if (has('depends on')) return 'depends';
  return 'uses';
}

export interface EdgeStyle {
  color: string;
  dash: string;
  width: number;
}

const REL_STYLE: Record<Relation, EdgeStyle> = {
  calls: { color: '#00d2ff', dash: '', width: 1.6 },
  reads: { color: '#4c9aff', dash: '', width: 1.5 },
  writes: { color: '#10b981', dash: '', width: 1.5 },
  caches: { color: '#00d2ff', dash: '5 4', width: 1.4 },
  publishes: { color: '#ffb020', dash: '', width: 1.6 },
  subscribes: { color: '#4c9aff', dash: '5 4', width: 1.4 },
  auth: { color: '#b48cff', dash: '', width: 1.4 },
  depends: { color: 'rgba(255,255,255,0.45)', dash: '4 4', width: 1.1 },
  uses: { color: 'rgba(255,255,255,0.5)', dash: '', width: 1.1 },
  proxy: { color: 'rgba(255,255,255,0.8)', dash: '', width: 1.5 },
  delivery: { color: 'rgba(255,255,255,0.4)', dash: '2 4', width: 1 },
};

export const relationColor = (r: Relation) => REL_STYLE[r].color;

export function edgeStyle(e: Pick<ArchEdge, 'labels' | 'confidence'>): EdgeStyle & { opacity: number } {
  const s = REL_STYLE[relationOf(e.labels)];
  // Confidence adds its own treatment: strong inference is dashed, possible is dotted and faint.
  const dash = e.confidence === 'confirmed' ? s.dash : e.confidence === 'strong' ? s.dash || '7 4' : '1.5 4';
  return { ...s, dash, opacity: e.confidence === 'confirmed' ? 0.9 : e.confidence === 'strong' ? 0.7 : 0.5 };
}

