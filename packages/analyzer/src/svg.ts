import { edgeControlPoint, SHAPES, shapePath, TYPE_LABELS } from './shapes.ts';
import type { GraphEdge, GraphNode, NodeType } from './types.ts';
import type { Positions } from './layout.ts';

const COLORS = {
  bg: '#0B0D0A',
  node: '#C9CDC2',
  nodeMuted: '#7D8376',
  text: '#E8EAE3',
  textMuted: '#9DA394',
  line: '#262B22',
  dependency: '#FF5C5C',
  risk: '#E2574C',
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface SvgOptions {
  title: string;
  subtitle?: string;
}

/** Static SVG rendering of the graph, used for export. */
export function renderGraphSvg(nodes: GraphNode[], edges: GraphEdge[], positions: Positions, opts: SvgOptions): string {
  const visible = nodes.filter((n) => positions[n.id]);
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  const radius = (id: string) => 3.5 + Math.min(6, Math.sqrt(degree.get(id) ?? 0) * 1.1);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of visible) {
    const [x, y] = positions[n.id];
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  if (!visible.length) { minX = minY = 0; maxX = maxY = 100; }
  const pad = 60;
  const header = 70;
  const legendH = 120;
  const width = Math.max(900, maxX - minX + pad * 2);
  const height = maxY - minY + pad * 2 + header + legendH;
  const ox = -minX + pad + (width - (maxX - minX + pad * 2)) / 2;
  const oy = -minY + pad + header;

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(width)}" height="${Math.ceil(height)}" viewBox="0 0 ${Math.ceil(width)} ${Math.ceil(height)}" font-family="IBM Plex Sans, Helvetica, Arial, sans-serif">`);
  parts.push(`<rect width="100%" height="100%" fill="${COLORS.bg}"/>`);
  parts.push(`<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${COLORS.dependency}"/></marker></defs>`);
  parts.push(`<text x="${pad}" y="38" fill="${COLORS.text}" font-size="20" font-weight="600">${esc(opts.title)}</text>`);
  if (opts.subtitle) parts.push(`<text x="${pad}" y="58" fill="${COLORS.textMuted}" font-size="12" font-family="IBM Plex Mono, Menlo, monospace">${esc(opts.subtitle)}</text>`);
  parts.push(`<line x1="0" x2="${Math.ceil(width)}" y1="${header - 0.5}" y2="${header - 0.5}" stroke="${COLORS.line}"/>`);

  parts.push(`<g fill="none" stroke="${COLORS.dependency}" stroke-opacity="0.45" stroke-width="0.8" marker-end="url(#arrow)">`);
  const drawn = new Set<string>();
  for (const e of edges) {
    const a = positions[e.source];
    const b = positions[e.target];
    if (!a || !b || e.source === e.target) continue;
    const key = `${e.source}\0${e.target}`;
    if (drawn.has(key)) continue;
    drawn.add(key);
    const x1 = a[0] + ox, y1 = a[1] + oy, x2 = b[0] + ox, y2 = b[1] + oy;
    const [cx, cy] = edgeControlPoint(x1, y1, x2, y2);
    // End the curve at the target's boundary so the arrow tip is visible.
    const r = radius(e.target) + 1.5;
    const dx = x2 - cx, dy = y2 - cy;
    const len = Math.hypot(dx, dy) || 1;
    const ex = x2 - (dx / len) * r, ey = y2 - (dy / len) * r;
    parts.push(`<path d="M${x1.toFixed(1)} ${y1.toFixed(1)}Q${cx.toFixed(1)} ${cy.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}"${e.resolved ? '' : ' stroke-dasharray="3 3"'}/>`);
  }
  parts.push('</g>');

  const labelled = [...visible].sort((p, q) => (degree.get(q.id) ?? 0) - (degree.get(p.id) ?? 0)).slice(0, visible.length <= 80 ? visible.length : 40);
  // Greedy label placement: higher-degree nodes first, skip labels that would overlap.
  const placed: [number, number, number, number][] = [];
  const labelSet = new Set<string>();
  for (const n of labelled) {
    const [x, y] = positions[n.id];
    const text = n.type === 'external' || n.type === 'unresolved' ? n.path : n.path.split('/').pop()!;
    const bx = x + ox + radius(n.id) + 4, by = y + oy - 6, bw = text.length * 6.1, bh = 12;
    if (placed.some(([px, py, pw, ph]) => bx < px + pw && bx + bw > px && by < py + ph && by + bh > py)) continue;
    placed.push([bx, by, bw, bh]);
    labelSet.add(n.id);
  }
  for (const n of visible) {
    const [x, y] = positions[n.id];
    const spec = SHAPES[n.type];
    const color = n.type === 'unresolved' ? COLORS.risk : n.type === 'external' ? COLORS.nodeMuted : COLORS.node;
    const d = shapePath(n.type, x + ox, y + oy, radius(n.id));
    parts.push(spec.filled ? `<path d="${d}" fill="${color}" stroke="${COLORS.bg}" stroke-width="1"><title>${esc(n.path)}</title></path>` : `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.4"><title>${esc(n.path)}</title></path>`);
    if (labelSet.has(n.id)) {
      const label = n.type === 'external' || n.type === 'unresolved' ? n.path : n.path.split('/').pop()!;
      parts.push(`<text x="${(x + ox + radius(n.id) + 4).toFixed(1)}" y="${(y + oy + 3.5).toFixed(1)}" fill="${COLORS.textMuted}" font-size="10" font-family="IBM Plex Mono, Menlo, monospace">${esc(label)}</text>`);
    }
  }

  // Legend
  const ly = height - legendH + 20;
  parts.push(`<line x1="0" x2="${Math.ceil(width)}" y1="${ly - 20.5}" y2="${ly - 20.5}" stroke="${COLORS.line}"/>`);
  const types = [...new Set(visible.map((n) => n.type))] as NodeType[];
  types.forEach((t, i) => {
    const col = i % 6, row = Math.floor(i / 6);
    const x = pad + col * 150, y = ly + row * 26;
    const d = shapePath(t, x + 6, y + 6, 5);
    const color = t === 'unresolved' ? COLORS.risk : t === 'external' ? COLORS.nodeMuted : COLORS.node;
    parts.push(SHAPES[t].filled ? `<path d="${d}" fill="${color}"/>` : `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.4"/>`);
    parts.push(`<text x="${x + 18}" y="${y + 10}" fill="${COLORS.textMuted}" font-size="11">${esc(TYPE_LABELS[t])}</text>`);
  });
  const ey = ly + Math.ceil(types.length / 6) * 26 + 8;
  parts.push(`<path d="M${pad} ${ey + 6}h28" stroke="${COLORS.dependency}" stroke-width="1.5" marker-end="url(#arrow)"/>`);
  parts.push(`<text x="${pad + 38}" y="${ey + 10}" fill="${COLORS.textMuted}" font-size="11">Import — arrow points to the dependency</text>`);
  parts.push(`<path d="M${pad + 330} ${ey + 6}h28" stroke="${COLORS.dependency}" stroke-width="1.5" stroke-dasharray="3 3"/>`);
  parts.push(`<text x="${pad + 368}" y="${ey + 10}" fill="${COLORS.textMuted}" font-size="11">Unresolved import</text>`);

  parts.push('</svg>');
  return parts.join('\n');
}
