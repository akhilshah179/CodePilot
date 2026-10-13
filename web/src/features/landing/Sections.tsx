import { CATEGORY_ICONS } from '@codepilot/analyzer/architecture/icons';
import { motion, useInView, useReducedMotion } from 'motion/react';
import { ArrowRight } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { ConfidenceBadge } from '../../components/ui.tsx';
import { basename } from '../../lib/format.ts';
import { edgeStyle, nodeEyebrow, relationOf, RELATION_LABELS } from '../architecture/style.ts';
import type { ArchNode } from '../../lib/api.ts';
import { EASE } from './motion.tsx';
import { snapshot, type HeroSnapshot } from './snapshot.ts';

/*
 * The landing page's product sections. Every diagram here is drawn from `heroGraph.json` — the
 * real output of CodePilot's analyzer run on its own repository — so nothing shown is invented.
 * Where a feature is not shipped yet it says so.
 */

const arch = snapshot.architecture;
type SnapNode = HeroSnapshot['architecture']['nodes'][number];
type SnapEdge = HeroSnapshot['architecture']['edges'][number];
const nodeById = new Map(arch.nodes.map((n) => [n.id, n]));
const ev = (id: string) => arch.evidence[id];
const where = (e: { file: string; line?: number }) => `${e.file}${e.line ? `:${e.line}` : ''}`;
const nameOf = (id: string) => nodeById.get(id)?.name ?? id;
const eyebrowOf = (n: SnapNode) => nodeEyebrow(n as unknown as ArchNode);

/* ---------------------------------------------------------------- architecture mini-diagram */

const COL_W = 250;
const CARD_W = 184;
const CARD_H = 70;
const ROW_H = 112;
const TOP = 44;

interface Placed {
  node: SnapNode;
  x: number;
  y: number;
}

/**
 * Lanes left to right in the analyzer's layer order. Nodes after the application lane share one
 * running row counter, so a connection that skips a lane never runs through another card.
 */
function placeNodes(): { placed: Placed[]; width: number; height: number; lanes: { layer: string; x: number }[] } {
  const layers = arch.layers.filter((l) => arch.nodes.some((n) => n.layer === l && n.display === 'node'));
  const placed: Placed[] = [];
  let shared = 0;
  let rows = 1;
  layers.forEach((layer, li) => {
    const list = arch.nodes.filter((n) => n.layer === layer && n.display === 'node');
    list.forEach((node, i) => {
      const row = li >= 2 ? shared++ : i;
      rows = Math.max(rows, row + 1);
      placed.push({ node, x: 20 + li * COL_W, y: TOP + row * ROW_H });
    });
  });
  return { placed, width: 20 + layers.length * COL_W - (COL_W - CARD_W) + 20, height: TOP + rows * ROW_H - (ROW_H - CARD_H) + 16, lanes: layers.map((layer, li) => ({ layer, x: 20 + li * COL_W })) };
}

const LANE_NAMES: Record<string, string> = { clients: 'Clients', edge: 'Edge', application: 'Application', data: 'Data', async: 'Async', external: 'External', delivery: 'Delivery' };

/** Connection path, plus where its label sits. An edge that skips a lane drops into the gap first and runs below the cards it passes. */
function edgePath(a: Placed, b: Placed): { d: string; lx: number; ly: number } {
  const x1 = a.x + CARD_W;
  const y1 = a.y + CARD_H / 2;
  const x2 = b.x - 6;
  const y2 = b.y + CARD_H / 2;
  if (b.x - a.x > COL_W && y2 !== y1) {
    const gx = x1 + (COL_W - CARD_W) - 6;
    return { d: `M${x1} ${y1} C${x1 + 44} ${y1} ${gx - 30} ${y2} ${gx} ${y2} L${x2} ${y2}`, lx: (gx + x2) / 2, ly: y2 - 7 };
  }
  const k = Math.max(40, (x2 - x1) * 0.45);
  return { d: `M${x1} ${y1} C${x1 + k} ${y1} ${x2 - k} ${y2} ${x2} ${y2}`, lx: (x1 + x2) / 2, ly: (y1 + y2) / 2 - 7 };
}

export function ArchitectureDemo({ highlight }: { highlight?: string } = {}) {
  const reduce = !!useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: '-100px' });
  const { placed, width, height, lanes } = useMemo(placeNodes, []);
  const pos = new Map(placed.map((p) => [p.node.id, p]));
  const [sel, setSel] = useState<{ kind: 'node' | 'edge'; id: string } | null>(null);
  const edges = arch.edges.filter((e) => pos.has(e.source) && pos.has(e.target));
  const selEdge = sel?.kind === 'edge' ? edges.find((e) => e.id === sel.id) : undefined;
  const selNode = sel?.kind === 'node' ? nodeById.get(sel.id) : undefined;
  const lit = (e: SnapEdge) => (highlight ? e.id === highlight : !sel || (sel.kind === 'edge' ? sel.id === e.id : e.source === sel.id || e.target === sel.id));
  const show = reduce || inView;

  return (
    <div className="arch-demo" ref={ref}>
      <div className="arch-demo-canvas">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`CodePilot's detected architecture: ${arch.nodes.filter((n) => n.display === 'node').map((n) => n.name).join(', ')}.`}>
          <defs>
            {edges.map((e) => (
              <marker key={e.id} id={`m-${e.id}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M0 0L10 5L0 10z" fill={edgeStyle(e).color} />
              </marker>
            ))}
          </defs>
          {lanes.map((l, i) => (
            <motion.g key={l.layer} initial={reduce ? false : { opacity: 0 }} animate={show ? { opacity: 1 } : undefined} transition={{ delay: i * 0.08, duration: 0.5 }}>
              <rect x={l.x - 10} y={8} width={CARD_W + 20} height={height - 12} rx="10" className="lane-bg" />
              <text x={l.x} y={28} className="lane-title">
                {LANE_NAMES[l.layer] ?? l.layer}
              </text>
            </motion.g>
          ))}
          {edges.map((e, i) => {
            const s = edgeStyle(e);
            const a = pos.get(e.source)!;
            const b = pos.get(e.target)!;
            const on = lit(e);
            const path = edgePath(a, b);
            return (
              <g key={e.id} className="arch-demo-edge" onClick={() => setSel({ kind: 'edge', id: e.id })} role="button" tabIndex={0} aria-label={`${nameOf(e.source)} to ${nameOf(e.target)}: ${e.labels.join(', ')}. Show evidence.`} onKeyDown={(k) => (k.key === 'Enter' || k.key === ' ') && setSel({ kind: 'edge', id: e.id })}>
                <path d={path.d} stroke="transparent" strokeWidth="14" fill="none" />
                <motion.path
                  d={path.d}
                  stroke={s.color}
                  strokeWidth={on ? s.width + 0.6 : s.width}
                  strokeDasharray={s.dash || undefined}
                  fill="none"
                  markerEnd={`url(#m-${e.id})`}
                  initial={reduce ? false : { pathLength: 0, opacity: 0 }}
                  animate={show ? { pathLength: 1, opacity: on ? s.opacity : 0.18 } : undefined}
                  transition={{ pathLength: { delay: 0.5 + i * 0.25, duration: 0.7, ease: EASE }, opacity: { duration: 0.25 } }}
                />
                <motion.text
                  x={path.lx}
                  y={path.ly}
                  className="edge-tag"
                  fill={s.color}
                  initial={reduce ? false : { opacity: 0 }}
                  animate={show ? { opacity: on ? 1 : 0.3 } : undefined}
                  transition={{ delay: reduce ? 0 : 1 + i * 0.25 }}
                >
                  {e.labels.join(' · ')}
                </motion.text>
              </g>
            );
          })}
          {placed.map((p, i) => {
            const n = p.node;
            const active = sel?.kind === 'node' && sel.id === n.id;
            return (
              <motion.g
                key={n.id}
                className={`arch-demo-node${active ? ' is-active' : ''}`}
                initial={reduce ? false : { opacity: 0, y: 8 }}
                animate={show ? { opacity: 1, y: 0 } : undefined}
                transition={{ delay: 0.15 + i * 0.1, duration: 0.5, ease: EASE }}
                onClick={() => setSel({ kind: 'node', id: n.id })}
                role="button"
                tabIndex={0}
                aria-label={`${n.name}, ${eyebrowOf(n)}. ${n.role}. Show details.`}
                onKeyDown={(k) => (k.key === 'Enter' || k.key === ' ') && setSel({ kind: 'node', id: n.id })}
              >
                <rect x={p.x} y={p.y} width={CARD_W} height={CARD_H} rx="9" className="card" />
                <g transform={`translate(${p.x + 12} ${p.y + 14})`}>
                  <path d={iconPath(n)} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" transform="scale(0.62)" className="card-icon" />
                </g>
                <text x={p.x + 34} y={p.y + 24} className="card-eyebrow">
                  {eyebrowOf(n).toUpperCase()}
                </text>
                <text x={p.x + 12} y={p.y + 46} className="card-name">
                  {n.name.length > 24 ? n.name.slice(0, 23) + '…' : n.name}
                </text>
                <text x={p.x + 12} y={p.y + 61} className="card-meta">
                  {chipsOf(n) || n.role}
                </text>
              </motion.g>
            );
          })}
        </svg>
      </div>
      <aside className="arch-demo-side" aria-live="polite">
        {selEdge ? (
          <EdgeEvidence edge={selEdge} />
        ) : selNode ? (
          <NodeDetails node={selNode} />
        ) : (
          <>
            <p className="side-k">Select a card or a connection</p>
            <p className="side-v">Each one opens the evidence it was drawn from.</p>
            <ul className="rel-legend">
              {[...new Set(edges.map((e) => relationOf(e.labels)))].map((r) => {
                const s = edgeStyle({ labels: edges.find((e) => relationOf(e.labels) === r)!.labels, confidence: 'confirmed' });
                return (
                  <li key={r}>
                    <svg width="28" height="8" aria-hidden="true">
                      <line x1="0" y1="4" x2="28" y2="4" stroke={s.color} strokeWidth="2" strokeDasharray={s.dash || undefined} />
                    </svg>
                    {RELATION_LABELS[r]}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </aside>
    </div>
  );
}

const iconPath = (n: SnapNode) => CATEGORY_ICONS[n.category] ?? CATEGORY_ICONS.application;

function chipsOf(n: SnapNode): string {
  return n.chips
    .map((c) => nodeById.get(c))
    .filter((c): c is SnapNode => !!c)
    .map((c) => `${c.name}${c.version ? ' ' + c.version : ''}`)
    .join(' · ');
}

function EdgeEvidence({ edge }: { edge: SnapEdge }) {
  return (
    <div className="side-body">
      <p className="side-k">
        {nameOf(edge.source)} <ArrowRight size={12} aria-hidden="true" /> {nameOf(edge.target)}
      </p>
      <p className="side-v">
        {edge.labels.join(', ')} · <ConfidenceBadge level={edge.confidence} compact />
      </p>
      <ul className="snip-list">
        {edge.evidence.map((id) => ev(id)).filter(Boolean).map((e) => (
          <li key={e.id}>
            <span className="snip-where mono">
              {e.kind} · {where(e)}
            </span>
            {e.snippet && <code className="snip mono">{e.snippet}</code>}
            <span className="snip-detail">{e.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NodeDetails({ node }: { node: SnapNode }) {
  return (
    <div className="side-body">
      <p className="side-k">
        {eyebrowOf(node)} <ConfidenceBadge level={node.confidence} compact />
      </p>
      <p className="side-title">{node.name}</p>
      <p className="side-v">{node.role}</p>
      {chipsOf(node) && <p className="side-v mono small">{chipsOf(node)}</p>}
      <ul className="snip-list">
        {node.files.map((f) => (
          <li key={f.path}>
            <span className="snip-where mono">{where({ file: f.path, line: f.line })}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------------------------------------------------------------- dependency graph */

/** Basename, or `dir/basename` where two files in `all` share a basename. */
function shortName(id: string, all: string[]): string {
  const b = basename(id);
  if (all.filter((x) => basename(x) === b).length < 2) return b;
  return id.split('/').slice(-2).join('/');
}

export function DependencyDemo() {
  const reduce = !!useReducedMotion();
  const ref = useRef<SVGSVGElement>(null);
  const inView = useInView(ref, { once: true, margin: '-80px' });
  const [hub, setHub] = useState(snapshot.hubs[0]);
  const consumers = [...new Set(snapshot.edges.filter((e) => e.target === hub).map((e) => e.source))];
  const deps = [...new Set(snapshot.edges.filter((e) => e.source === hub).map((e) => e.target))];
  const W = 800;
  const H = 300;
  const cx = W / 2;
  const cy = H / 2;
  const shownC = consumers.slice(0, 7);
  const shownD = deps.slice(0, 6);
  const place = (list: string[], x: number) => list.map((id, i) => ({ id, x, y: ((i + 1) * H) / (list.length + 1) }));
  const left = place(shownC, 200);
  const right = place(shownD, W - 200);
  const hubs = snapshot.hubs.slice(0, 4);
  const names = [...shownC, ...shownD, hub];
  const show = reduce || inView;
  return (
    <div className="dep-demo">
      <div className="dep-pick" role="radiogroup" aria-label="File to inspect">
        {hubs.map((h) => (
          <button key={h} type="button" role="radio" aria-checked={h === hub} className={h === hub ? 'is-active' : ''} onClick={() => setHub(h)} title={h}>
            {shortName(h, hubs)}
          </button>
        ))}
      </div>
      <svg ref={ref} key={hub} viewBox={`0 0 ${W} ${H}`} className="dep-svg" role="img" aria-label={`${hub} is imported by ${consumers.length} files and imports ${deps.length}.`}>
        <defs>
          <marker id="dep-ah-red" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
            <path d="M0 0L10 5L0 10z" fill="var(--dep)" />
          </marker>
          <marker id="dep-ah-blue" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
            <path d="M0 0L10 5L0 10z" fill="var(--con)" />
          </marker>
        </defs>
        {left.map((n, i) => (
          <motion.path key={n.id} d={`M${n.x + 6} ${n.y} C${n.x + 90} ${n.y} ${cx - 90} ${cy} ${cx - 14} ${cy}`} stroke="var(--con)" strokeWidth="1.3" fill="none" markerEnd="url(#dep-ah-blue)" initial={reduce ? false : { pathLength: 0, opacity: 0 }} animate={show ? { pathLength: 1, opacity: 0.85 } : undefined} transition={{ delay: 0.2 + i * 0.06, duration: 0.6, ease: EASE }} />
        ))}
        {right.map((n, i) => (
          <motion.path key={n.id} d={`M${cx + 14} ${cy} C${cx + 90} ${cy} ${n.x - 90} ${n.y} ${n.x - 8} ${n.y}`} stroke="var(--dep)" strokeWidth="1.3" fill="none" markerEnd="url(#dep-ah-red)" initial={reduce ? false : { pathLength: 0, opacity: 0 }} animate={show ? { pathLength: 1, opacity: 0.85 } : undefined} transition={{ delay: 0.5 + i * 0.06, duration: 0.6, ease: EASE }} />
        ))}
        {left.map((n) => (
          <g key={n.id}>
            <circle cx={n.x} cy={n.y} r="4.5" fill="var(--node)" />
            <text x={n.x - 12} y={n.y + 4} textAnchor="end" className="dep-label">
              {shortName(n.id, names)}
            </text>
            <title>{n.id}</title>
          </g>
        ))}
        {right.map((n) => (
          <g key={n.id}>
            <circle cx={n.x} cy={n.y} r="4.5" fill="var(--node)" />
            <text x={n.x + 12} y={n.y + 4} className="dep-label">
              {shortName(n.id, names)}
            </text>
            <title>{n.id}</title>
          </g>
        ))}
        <circle cx={cx} cy={cy} r="11" fill="var(--accent)" />
        <circle cx={cx} cy={cy} r="20" fill="none" stroke="var(--accent-line)" />
        <text x={cx} y={cy + 40} textAnchor="middle" className="dep-center">
          {shortName(hub, names)}
        </text>
      </svg>
      <p className="dep-caption">
        <span className="con-count mono">{consumers.length}</span> files import <code>{hub}</code>
        {consumers.length > shownC.length && <span className="faint"> (showing {shownC.length})</span>} · it imports <span className="dep-count mono">{deps.length}</span>
        {deps.length > shownD.length && <span className="faint"> (showing {shownD.length})</span>}
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- grounded answers */

export function GroundedAnswer() {
  const d = snapshot.doc;
  const cites = d.consumers.slice(0, 4);
  return (
    <div className="grounded">
      <p className="grounded-status">
        <span className="tag">Coming next</span>
        <span className="faint small">The answer below is composed directly from the graph — no language model is involved yet.</span>
      </p>
      <div className="chat">
        <p className="chat-q">What depends on {basename(d.id)}?</p>
        <div className="chat-a">
          <p>
            <strong>{d.consumers.length} files</strong> import <code>{d.id}</code>, and it imports {d.dependencies.length} of its own. It exports {d.exports.length} symbols
            {d.exports[0] ? (
              <>
                , starting with <code>{d.exports[0].name}</code>
              </>
            ) : null}
            .
          </p>
          <ul className="cites">
            {cites.map((c, i) => (
              <li key={c.id}>
                <span className="cite-n mono">[{i + 1}]</span>
                <span className="mono">
                  {c.id}:{c.line}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- evidence */

export function EvidenceDemo() {
  const items = arch.edges.flatMap((e) => e.evidence.slice(0, 1).map((id) => ({ edge: e, e: ev(id) }))).filter((x) => x.e);
  return (
    <ul className="evidence-wall">
      {items.map(({ edge, e }, i) => (
        <motion.li key={e.id} initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.08, duration: 0.5, ease: EASE }}>
          <div className="ev-top">
            <span className="mono small">
              {nameOf(edge.source)} → {nameOf(edge.target)}
            </span>
            <ConfidenceBadge level={edge.confidence} compact />
          </div>
          <code className="snip mono">{e.snippet ?? e.detail}</code>
          <div className="ev-bottom mono">
            <span>{e.kind}</span>
            <span>{where(e)}</span>
          </div>
        </motion.li>
      ))}
    </ul>
  );
}
