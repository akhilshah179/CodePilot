import type { ArchNode, Confidence, Flow, Layer } from '../../lib/api.ts';

/**
 * Visual semantics for the architecture diagram. Colour has meaning and only these meanings:
 * cyan = request/data calls, blue = reads/consumption, green = writes, amber = publishing and
 * CodePilot actions, purple = identity/auth, neutral = structural (depends on, deploys).
 */

export { relationOf, relationColor, edgeStyle, RELATION_LABELS, type Relation, type EdgeStyle } from '@codepilot/analyzer/architecture/relations';

export const LAYER_COLORS: Record<Layer, string> = {
  clients: '#4c9aff',
  edge: '#ffb020',
  application: '#ffffff',
  data: '#10b981',
  async: '#b48cff',
  external: '#00d2ff',
  delivery: 'rgba(255,255,255,0.5)',
};

/** Short type word shown above a node's name. */
export function nodeEyebrow(n: ArchNode): string {
  if (n.id.startsWith('client:')) return 'Client';
  if (n.kind === 'app') return n.layer === 'async' ? 'Worker' : n.category === 'frontend' ? 'Frontend' : 'Application';
  if (n.kind === 'host') return 'External API';
  if (n.kind === 'container') return 'Container';
  const map: Record<string, string> = {
    database: 'Database',
    cache: 'Cache',
    queue: 'Queue',
    worker: 'Worker',
    storage: 'Storage',
    search: 'Search',
    proxy: 'Gateway',
    auth: 'Identity',
    payments: 'Payments',
    email: 'Email',
    messaging: 'Messaging',
    ai: 'AI API',
    observability: 'Observability',
    analytics: 'Analytics',
    ci: 'CI/CD',
    hosting: 'Hosting',
    container: 'Container',
    orchestration: 'Orchestration',
    iac: 'Infrastructure',
    service: 'Service',
    realtime: 'Realtime',
    cloud: 'Cloud',
  };
  return map[n.category] ?? 'Tool';
}

export const CONFIDENCE_ORDER: Confidence[] = ['confirmed', 'strong', 'possible'];

/** Flow signal appearance per step mode. */
export const MODE_STYLE: Record<Flow['steps'][number]['mode'], { color: string; label: string; hollow?: boolean }> = {
  sync: { color: '#00d2ff', label: 'Synchronous' },
  async: { color: '#b48cff', label: 'Asynchronous', hollow: true },
  'cache-hit': { color: '#10b981', label: 'Cache hit' },
  'cache-miss': { color: '#f59e0b', label: 'Cache miss' },
  publish: { color: '#ffb020', label: 'Queue publish' },
  consume: { color: '#b48cff', label: 'Queue consume', hollow: true },
  unknown: { color: '#ef4444', label: 'Target unknown' },
};
