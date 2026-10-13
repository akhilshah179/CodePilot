import { SYSTEM_LAYERS, SYSTEM_LAYER_LABELS } from '@codepilot/analyzer/architecture/types';
import type { TechIntel } from '../../lib/api.ts';

const W = 520;
const ROW = 64;
const NODE_W = 132;
const NODE_H = 30;

/**
 * A small, layered picture of the system around one technology: what reaches it from above
 * (clients, transports, routes, handlers, services) and what it reaches. Drawn from the system
 * map's real links; the technology itself is highlighted.
 */
export function FocusedGraph({ graph, onNode }: { graph: TechIntel['graph']; onNode?(id: string): void }) {
  if (!graph.nodes.length) return <p className="faint small">This technology is not part of the system map (it has no traced connection to other components).</p>;
  const layers = SYSTEM_LAYERS.filter((l) => graph.nodes.some((n) => n.layer === l));
  const rows = layers.map((l) => graph.nodes.filter((n) => n.layer === l).sort((a, b) => Number(b.focus) - Number(a.focus) || a.name.localeCompare(b.name)));
  const pos = new Map<string, { x: number; y: number }>();
  rows.forEach((row, ri) => {
    const shown = row.slice(0, 3);
    const gap = (W - shown.length * NODE_W) / (shown.length + 1);
    shown.forEach((n, i) => pos.set(n.id, { x: gap + i * (NODE_W + gap), y: 22 + ri * ROW }));
  });
  const hidden = rows.reduce((s, r) => s + Math.max(0, r.length - 3), 0);
  const H = 22 + layers.length * ROW - (ROW - NODE_H) + 8;
  return (
    <figure className="fg">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Relationship graph: ${graph.nodes.map((n) => n.name).join(', ')}`}>
        <defs>
          <marker id="fg-ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0 0L10 5L0 10z" fill="rgba(255,255,255,0.55)" />
          </marker>
          <marker id="fg-ah-async" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0 0L10 5L0 10z" fill="#ffb020" />
          </marker>
        </defs>
        {layers.map((l, i) => (
          <text key={l} x={4} y={14 + i * ROW} className="fg-layer">
            {SYSTEM_LAYER_LABELS[l]}
          </text>
        ))}
        {graph.links.map((l, i) => {
          const a = pos.get(l.source);
          const b = pos.get(l.target);
          if (!a || !b) return null;
          const x1 = a.x + NODE_W / 2;
          const x2 = b.x + NODE_W / 2;
          const down = b.y >= a.y;
          const y1 = down ? a.y + NODE_H : a.y;
          const y2 = down ? b.y - 2 : b.y + NODE_H + 2;
          const same = a.y === b.y;
          const d = same ? `M${a.x + NODE_W} ${a.y + NODE_H / 2} L${b.x - 2} ${b.y + NODE_H / 2}` : `M${x1} ${y1} C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;
          return (
            <path key={i} d={d} fill="none" stroke={l.async ? '#ffb020' : 'rgba(255,255,255,0.4)'} strokeWidth={1.2} strokeDasharray={l.async ? '5 4' : undefined} markerEnd={`url(#${l.async ? 'fg-ah-async' : 'fg-ah'})`}>
              <title>{l.label}</title>
            </path>
          );
        })}
        {graph.nodes.map((n) => {
          const p = pos.get(n.id);
          if (!p) return null;
          return (
            <g key={n.id} className={`fg-node${n.focus ? ' is-focus' : ''}`} onClick={() => onNode?.(n.id)} role={onNode ? 'button' : undefined} tabIndex={onNode ? 0 : undefined}>
              <rect x={p.x} y={p.y} width={NODE_W} height={NODE_H} rx={7} />
              <text x={p.x + 9} y={p.y + 19}>
                {n.name.length > 17 ? `${n.name.slice(0, 16)}…` : n.name}
              </text>
              <title>{`${n.kind}: ${n.name}`}</title>
            </g>
          );
        })}
      </svg>
      {hidden > 0 && <figcaption className="faint small">{hidden} more connected component{hidden === 1 ? '' : 's'} not drawn — see the system map.</figcaption>}
    </figure>
  );
}
