/**
 * Directory clusters for the dependency graph. The depth is chosen per repository so clusters
 * are informative: not one giant `src` cluster, not hundreds of single-file folders.
 * Shared by the layouts (which pull clusters together) and the canvas (which draws them).
 */

export const EXTERNAL_CLUSTER = 'External dependencies';
export const UNRESOLVED_CLUSTER = 'Unresolved';

export interface ClusterNode {
  id: string;
  type: string;
  path?: string;
}

function keyAt(path: string, depth: number): string {
  const segs = path.split('/').slice(0, -1);
  if (!segs.length) return '(root)';
  return segs.slice(0, depth).join('/');
}

/** Cluster key per node id. */
export function clusterKeys(nodes: ClusterNode[]): Map<string, string> {
  const out = new Map<string, string>();
  const files = nodes.filter((n) => n.type !== 'external' && n.type !== 'unresolved');
  for (const n of nodes) {
    if (n.type === 'external') out.set(n.id, EXTERNAL_CLUSTER);
    else if (n.type === 'unresolved') out.set(n.id, UNRESOLVED_CLUSTER);
  }
  if (!files.length) return out;
  let chosen = 1;
  for (let depth = 1; depth <= 4; depth++) {
    const counts = new Map<string, number>();
    for (const f of files) {
      const k = keyAt(f.path ?? f.id, depth);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const largest = Math.max(...counts.values());
    chosen = depth;
    if (counts.size > 40) {
      chosen = Math.max(1, depth - 1);
      break;
    }
    if (largest <= files.length * 0.45 && counts.size >= 3) break;
  }
  for (const f of files) out.set(f.id, keyAt(f.path ?? f.id, chosen));
  return out;
}
