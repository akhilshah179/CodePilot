import type { NodeType } from './types.ts';

/**
 * Node markers. Each type has a distinct geometry so the graph never relies on color alone.
 * Paths are SVG path data so the browser (Path2D) and the SVG exporter draw identical shapes.
 */
export interface ShapeSpec {
  label: string;
  /** Filled shape vs outline-only. */
  filled: boolean;
  /** Relative visual scale so shapes of the same `r` read as similar weight. */
  scale: number;
}

export const SHAPES: Record<NodeType, ShapeSpec> = {
  page: { label: 'Square', filled: true, scale: 0.9 },
  route: { label: 'Diamond', filled: true, scale: 1.15 },
  api: { label: 'Hexagon', filled: true, scale: 1.05 },
  component: { label: 'Circle', filled: true, scale: 1 },
  action: { label: 'Triangle', filled: true, scale: 1.2 },
  service: { label: 'Pentagon', filled: true, scale: 1.08 },
  utility: { label: 'Inverted triangle', filled: true, scale: 1.2 },
  config: { label: 'Plus', filled: true, scale: 1.1 },
  other: { label: 'Bar', filled: true, scale: 1 },
  external: { label: 'Hollow diamond', filled: false, scale: 1.1 },
  unresolved: { label: 'Cross', filled: false, scale: 1 },
};

export const TYPE_LABELS: Record<NodeType, string> = {
  route: 'Routes',
  page: 'Pages',
  component: 'Components',
  action: 'Actions',
  service: 'Services',
  utility: 'Utilities',
  api: 'APIs',
  config: 'Configuration',
  other: 'Other',
  external: 'External dependencies',
  unresolved: 'Unresolved',
};

const f = (n: number) => Math.round(n * 100) / 100;

function polygon(x: number, y: number, r: number, sides: number, rotation: number): string {
  const pts: string[] = [];
  for (let i = 0; i < sides; i++) {
    const a = rotation + (i * 2 * Math.PI) / sides;
    pts.push(`${f(x + r * Math.cos(a))} ${f(y + r * Math.sin(a))}`);
  }
  return `M${pts.join('L')}Z`;
}

export function shapePath(type: NodeType, x: number, y: number, radius: number): string {
  const r = radius * SHAPES[type].scale;
  switch (type) {
    case 'component':
      return `M${f(x - r)} ${f(y)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0Z`;
    case 'page':
      return `M${f(x - r)} ${f(y - r)}h${f(2 * r)}v${f(2 * r)}h${f(-2 * r)}Z`;
    case 'route':
    case 'external':
      return polygon(x, y, r, 4, -Math.PI / 2);
    case 'api':
      return polygon(x, y, r, 6, 0);
    case 'action':
      return polygon(x, y + r * 0.2, r, 3, -Math.PI / 2);
    case 'utility':
      return polygon(x, y - r * 0.2, r, 3, Math.PI / 2);
    case 'service':
      return polygon(x, y, r, 5, -Math.PI / 2);
    case 'config': {
      const a = r * 0.38;
      return `M${f(x - a)} ${f(y - r)}h${f(2 * a)}v${f(r - a)}h${f(r - a)}v${f(2 * a)}h${f(a - r)}v${f(r - a)}h${f(-2 * a)}v${f(a - r)}h${f(a - r)}v${f(-2 * a)}h${f(r - a)}Z`;
    }
    case 'other':
      return `M${f(x - r)} ${f(y - r * 0.5)}h${f(2 * r)}v${f(r)}h${f(-2 * r)}Z`;
    case 'unresolved': {
      const a = r * 0.8;
      return `M${f(x - a)} ${f(y - a)}L${f(x + a)} ${f(y + a)}M${f(x + a)} ${f(y - a)}L${f(x - a)} ${f(y + a)}`;
    }
  }
}

/** Quadratic Bézier control point for a gently curved edge; direction-aware so A→B and B→A separate. */
export function edgeControlPoint(x1: number, y1: number, x2: number, y2: number, curvature = 0.12): [number, number] {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  return [mx - dy * curvature, my + dx * curvature];
}
