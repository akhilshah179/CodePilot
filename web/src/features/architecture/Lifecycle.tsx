import {
  ArrowLeftRight,
  Box,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Cog,
  Crosshair,
  Database,
  ExternalLink,
  FileCode2,
  Filter,
  Globe,
  HelpCircle,
  ListOrdered,
  MousePointerClick,
  Pause,
  Play,
  Reply,
  RotateCcw,
  Route,
  Search,
  Workflow,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ConfidenceBadge, EvidenceItem } from '../../components/ui.tsx';
import type { ArchNode, Evidence, Flow, FlowLane, FlowStep } from '../../lib/api.ts';
import type { FileOpener } from '../../lib/fileLinks.ts';
import { basename } from '../../lib/format.ts';
import { useMediaQuery, usePrefersReducedMotion } from '../../lib/hooks.ts';

interface Props {
  flows: Flow[];
  evidence: Record<string, Evidence>;
  archById: Map<string, ArchNode>;
  opener: FileOpener;
  flowId: string | null;
  onFlow(id: string): void;
  onWireframe?(path: string): void;
  /** Focus a technology or application in the system map. */
  onNode(archId: string): void;
  /** Open this flow on the Automation Engine canvas. */
  onAutomation?(flowId: string): void;
}

const LANE_LABEL: Record<FlowLane, string> = { frontend: 'Frontend', backend: 'Backend', external: 'External services', async: 'Async workers' };

const KIND: Record<NonNullable<FlowStep['kind']>, { label: string; icon: LucideIcon; tone: string }> = {
  action: { label: 'User action', icon: MousePointerClick, tone: 'amber' },
  handler: { label: 'Handler', icon: FileCode2, tone: 'plain' },
  client: { label: 'API client', icon: ArrowLeftRight, tone: 'cyan' },
  route: { label: 'Route', icon: Route, tone: 'plain' },
  middleware: { label: 'Middleware', icon: Filter, tone: 'violet' },
  service: { label: 'Service', icon: Cog, tone: 'plain' },
  data: { label: 'Database', icon: Database, tone: 'green' },
  cache: { label: 'Cache', icon: Zap, tone: 'cyan' },
  queue: { label: 'Queue', icon: ListOrdered, tone: 'amber' },
  external: { label: 'External API', icon: Globe, tone: 'blue' },
  worker: { label: 'Worker', icon: Workflow, tone: 'violet' },
  response: { label: 'Response', icon: Reply, tone: 'blue' },
  resolve: { label: 'Client receives', icon: CircleDot, tone: 'blue' },
  state: { label: 'UI update', icon: Box, tone: 'amber' },
  unknown: { label: 'Unknown next hop', icon: HelpCircle, tone: 'red' },
};

const ROW = 78;
const CARD_H = 56;
const HEAD = 40;
const BEAT = 1150;

/** Scenario key without the cache-variant suffix, so hit/miss appear as one scenario. */
const baseTitle = (f: Flow) => f.title.replace(/ · cache (hit|miss)$/, '');

export function Lifecycle(p: Props) {
  const reduced = usePrefersReducedMotion();
  const narrow = useMediaQuery('(max-width: 900px)');
  const [query, setQuery] = useState('');
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<0.5 | 1 | 2>(1);
  const swimRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);

  const flow = p.flows.find((f) => f.id === p.flowId) ?? p.flows[0];
  const variants = flow ? p.flows.filter((f) => baseTitle(f) === baseTitle(flow) && f.variant) : [];

  // Scenario list: user actions first, then other requests, then background work.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const seen = new Set<string>();
    const list = p.flows.filter((f) => {
      const key = baseTitle(f);
      if (seen.has(key)) return false;
      seen.add(key);
      return !q || `${f.title} ${f.action?.label ?? ''} ${f.action?.component ?? ''}`.toLowerCase().includes(q);
    });
    return [
      { title: 'User actions', items: list.filter((f) => f.action) },
      { title: 'Requests', items: list.filter((f) => !f.action && f.trigger.kind === 'route') },
      { title: 'Background jobs', items: list.filter((f) => f.trigger.kind !== 'route') },
    ].filter((g) => g.items.length);
  }, [p.flows, query]);

  useEffect(() => {
    setStep(0);
    setPlaying(false);
  }, [flow?.id]);

  // Auto-advance while playing.
  useEffect(() => {
    if (!playing || !flow) return;
    if (step >= flow.steps.length - 1) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setStep((s) => s + 1), BEAT / speed);
    return () => clearTimeout(t);
  }, [playing, step, speed, flow]);

  useEffect(() => {
    const el = swimRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [flow?.id, narrow]);

  // Keep the current step in view.
  useEffect(() => {
    swimRef.current?.querySelector<HTMLElement>(`[data-step="${step}"]`)?.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
  }, [step, reduced]);

  if (!flow) {
    return (
      <div className="lifecycle lc-empty">
        <p>No request flows could be traced from this repository’s code.</p>
        <p className="faint small">Flows start at a route handler, a queue consumer or a schedule; CodePilot shows them only when the path is visible in the source.</p>
      </div>
    );
  }

  const lanes: FlowLane[] = flow.lanes?.length ? flow.lanes : ['backend'];
  const colW = width / lanes.length;
  const cardW = Math.min(300, colW - 36);
  const cx = (s: FlowStep) => (lanes.indexOf(s.lane ?? 'backend') + 0.5) * colW;
  const cy = (i: number) => HEAD + i * ROW + CARD_H / 2;
  const current = flow.steps[step];

  /** Connector into step i: from the previous step, or from the enqueue for the first background step. */
  const connectors = flow.steps.map((s, i) => {
    if (i === 0) return null;
    let from = i - 1;
    const asyncStart = s.branch === 'async' && flow.steps[i - 1].branch !== 'async';
    if (asyncStart) {
      for (let k = i - 1; k >= 0; k--) if (flow.steps[k].kind === 'queue') {
        from = k;
        break;
      }
    }
    const a = flow.steps[from];
    const x0 = cx(a);
    const x1 = cx(s);
    const y0 = cy(from) + (x0 === x1 ? CARD_H / 2 : 0);
    const y1 = cy(i) - CARD_H / 2;
    const side = x1 > x0 ? 1 : -1;
    const d = x0 === x1 ? `M${x0} ${y0} L${x1} ${y1}` : `M${x0 + (side * cardW) / 2} ${cy(from)} L${x1} ${cy(from)} L${x1} ${y1}`;
    const pts = x0 === x1 ? [[x0, y0], [x1, y1]] : [[x0 + (side * cardW) / 2, cy(from)], [x1, cy(from)], [x1, y1]];
    const label = asyncStart ? 'ASYNC · does not block the response' : a.kind === 'response' ? a.transport : x0 !== x1 ? s.transport : undefined;
    const tone = asyncStart || s.branch === 'async' ? 'async' : a.kind === 'response' || s.kind === 'response' ? 'response' : s.kind === 'unknown' ? 'unknown' : x0 !== x1 ? 'transport' : 'plain';
    return { d, pts, label, tone, lx: x0 === x1 ? x0 + 10 : (x0 + x1) / 2, ly: x0 === x1 ? (y0 + y1) / 2 : cy(from) - 8 };
  });
  const height = HEAD + flow.steps.length * ROW + 12;
  const packet = step > 0 ? connectors[step] : null;

  const stepDetails = (s: FlowStep) => {
    const k = KIND[s.kind ?? 'service'];
    const tool = s.tool ? p.archById.get(s.tool) : undefined;
    const href = p.opener.href(s.file, s.line);
    const sync = s.branch === 'async' || s.mode === 'async' || s.mode === 'consume' ? 'Asynchronous — runs in the background' : s.mode === 'publish' ? 'Asynchronous hand-off (enqueue)' : s.branch ? `Cache ${s.branch === 'cache-hit' ? 'hit' : 'miss'}` : 'Synchronous';
    return (
      <>
        <p className="eyebrow">
          Step {s.step} of {flow.steps.length} · {k.label}
        </p>
        <h3 className="lc-d-title">{s.label ?? k.label}</h3>
        <p className="lc-d-expl">{s.explanation}</p>
        <dl className="lc-d-meta">
          <div>
            <dt>File</dt>
            <dd className="mono">
              {href ? (
                <a href={href} target="_blank" rel="noreferrer">
                  {s.file}
                  {s.line ? `:${s.line}` : ''} <ExternalLink size={11} />
                </a>
              ) : (
                `${s.file}${s.line ? `:${s.line}` : ''}`
              )}
            </dd>
          </div>
          {tool && (
            <div>
              <dt>Technology</dt>
              <dd>
                <button type="button" className="link-btn" onClick={() => p.onNode(tool.id)}>
                  <Crosshair size={12} /> {tool.name}
                </button>
              </dd>
            </div>
          )}
          <div>
            <dt>Mode</dt>
            <dd>{sync}</dd>
          </div>
          {s.transport && (
            <div>
              <dt>Transport</dt>
              <dd className="mono">{s.transport}</dd>
            </div>
          )}
        </dl>
        {p.onWireframe && (
          <button type="button" className="btn btn-sm" onClick={() => p.onWireframe!(s.file)}>
            <CircleDot size={13} /> Show {basename(s.file)} in Wireframe
          </button>
        )}
        {s.evidence.length > 0 && (
          <ul className="ev-list">
            {s.evidence.map((id) => p.evidence[id]).filter(Boolean).map((e) => (
              <EvidenceItem key={e.id} ev={e} href={p.opener.href(e.file, e.line)} />
            ))}
          </ul>
        )}
      </>
    );
  };

  return (
    <div className="lifecycle">
      <aside className="lc-list" aria-label="Scenarios">
        <label className="tm-search">
          <Search size={14} aria-hidden="true" />
          <input type="search" placeholder="Find a scenario…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Find a scenario" />
        </label>
        {groups.map((g) => (
          <section key={g.title}>
            <h3 className="lc-group">{g.title}</h3>
            <ul>
              {g.items.map((f) => (
                <li key={f.id}>
                  <button type="button" className={`lc-item${baseTitle(f) === baseTitle(flow) ? ' is-active' : ''}`} onClick={() => p.onFlow(f.id)} aria-current={baseTitle(f) === baseTitle(flow)}>
                    <span className="lc-item-title">{f.action?.label ?? baseTitle(f)}</span>
                    {f.action && <span className="lc-item-route mono">{baseTitle(f).split(' → ').pop()}</span>}
                    <span className="lc-item-meta mono">
                      {f.steps.length} steps{f.lanes?.includes('async') ? ' · async' : ''}
                      {f.truncated ? ' · stops at unknown' : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </aside>

      <section className="lc-main" aria-label="Request lifecycle">
        <header className="lc-head">
          <div>
            <p className="eyebrow">{flow.action ? `User action${flow.action.component ? ` in ${flow.action.component}` : ''}` : flow.trigger.kind === 'route' ? 'Request' : flow.trigger.kind === 'queue' ? 'Background job' : 'Schedule'}</p>
            <h2 className="lc-title">{flow.action?.label ?? baseTitle(flow)}</h2>
            {flow.action && <p className="mono faint">{baseTitle(flow).split(' → ').pop()}</p>}
          </div>
          <div className="lc-head-side">
            <ConfidenceBadge level={flow.confidence} />
            {variants.length > 1 && (
              <div className="segmented" role="group" aria-label="Cache branch">
                {variants.map((v) => (
                  <button key={v.id} type="button" aria-pressed={v.id === flow.id} onClick={() => p.onFlow(v.id)}>
                    {v.variant === 'cache-hit' ? 'Cache hit' : 'Cache miss'}
                  </button>
                ))}
              </div>
            )}
          </div>
        </header>

        <div className="lc-controls glass" role="toolbar" aria-label="Playback">
          <button type="button" className="icon-btn" aria-label="Previous step" onClick={() => (setPlaying(false), setStep((s) => Math.max(0, s - 1)))} disabled={step === 0}>
            <ChevronLeft size={16} />
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary lc-play"
            onClick={() => {
              if (step >= flow.steps.length - 1) setStep(0);
              setPlaying((v) => !v || step >= flow.steps.length - 1);
            }}
            aria-label={playing ? 'Pause' : 'Play'}
          >
            {playing ? <Pause size={14} /> : <Play size={14} />} {playing ? 'Pause' : step >= flow.steps.length - 1 ? 'Replay' : 'Play'}
          </button>
          <button type="button" className="icon-btn" aria-label="Next step" onClick={() => (setPlaying(false), setStep((s) => Math.min(flow.steps.length - 1, s + 1)))} disabled={step >= flow.steps.length - 1}>
            <ChevronRight size={16} />
          </button>
          <button type="button" className="icon-btn" aria-label="Replay from the start" onClick={() => (setStep(0), setPlaying(true))}>
            <RotateCcw size={14} />
          </button>
          <input
            className="lc-scrub"
            type="range"
            min={0}
            max={flow.steps.length - 1}
            value={step}
            onChange={(e) => (setPlaying(false), setStep(Number(e.target.value)))}
            aria-label="Step"
            aria-valuetext={`Step ${step + 1} of ${flow.steps.length}: ${current?.label ?? ''}`}
          />
          <span className="mono faint small">
            {step + 1}/{flow.steps.length}
          </span>
          <div className="segmented" role="group" aria-label="Speed">
            {([0.5, 1, 2] as const).map((v) => (
              <button key={v} type="button" aria-pressed={speed === v} onClick={() => setSpeed(v)}>
                {v}×
              </button>
            ))}
          </div>
          {p.onAutomation && (
            <button type="button" className="btn btn-sm" onClick={() => p.onAutomation!(flow.id)}>
              Automation
            </button>
          )}
        </div>

        {narrow ? (
          <ol className="lc-vertical">
            {flow.steps.map((s, i) => {
              const k = KIND[s.kind ?? 'service'];
              const Icon = k.icon;
              const prev = flow.steps[i - 1];
              const label = prev && prev.lane !== s.lane ? (prev.kind === 'response' ? prev.transport : s.transport) : undefined;
              return (
                <li key={s.step} data-step={i} className={`lc-vstep tone-${k.tone}${i === step ? ' is-current' : ''}${i > step ? ' is-future' : ''}`}>
                  {label && <span className="lc-vlabel mono">{label}</span>}
                  <button type="button" onClick={() => (setPlaying(false), setStep(i))}>
                    <span className="lc-lane-chip">{LANE_LABEL[s.lane ?? 'backend']}</span>
                    <span className="lc-card-kind">
                      <Icon size={13} /> {k.label}
                      {s.branch === 'async' && <span className="lc-badge">async</span>}
                    </span>
                    <span className="lc-card-label">{s.label}</span>
                    <span className="lc-card-where mono">
                      {basename(s.file)}
                      {s.line ? `:${s.line}` : ''}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        ) : (
          <div className="lc-swim" ref={swimRef} style={{ ['--lanes' as string]: lanes.length }}>
            <div className="lc-lanes" aria-hidden="true">
              {lanes.map((l) => (
                <div key={l} className={`lc-lane lane-${l}`}>
                  <span>{LANE_LABEL[l]}</span>
                </div>
              ))}
            </div>
            <svg className="lc-svg" width={width} height={height} aria-hidden="true">
              <defs>
                {['plain', 'transport', 'response', 'async', 'unknown'].map((t) => (
                  <marker key={t} id={`lc-ah-${t}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M0 0L10 5L0 10z" className={`lc-ah tone-${t}`} />
                  </marker>
                ))}
              </defs>
              {connectors.map((c, i) =>
                c ? (
                  <g key={i} className={`lc-conn tone-${c.tone}${i <= step ? ' is-done' : ''}`}>
                    <path d={c.d} markerEnd={`url(#lc-ah-${c.tone})`} />
                  </g>
                ) : null,
              )}
              {packet && !reduced && (
                <motion.circle
                  key={`${flow.id}-${step}`}
                  r={5}
                  className={`lc-packet tone-${packet.tone}`}
                  initial={{ cx: packet.pts[0][0], cy: packet.pts[0][1], opacity: 0 }}
                  animate={{ cx: packet.pts.map((pt) => pt[0]), cy: packet.pts.map((pt) => pt[1]), opacity: [0, 1, 1, 0.9] }}
                  transition={{ duration: (BEAT * 0.62) / speed / 1000, ease: 'easeInOut' }}
                />
              )}
            </svg>
            {connectors.map((c, i) =>
              c?.label ? (
                <span key={`lbl-${i}`} className={`lc-label mono tone-${c.tone}${i <= step ? ' is-done' : ''}`} style={{ left: c.lx, top: c.ly }}>
                  {c.label}
                </span>
              ) : null,
            )}
            <ol className="lc-steps" style={{ height }}>
              {flow.steps.map((s, i) => {
                const k = KIND[s.kind ?? 'service'];
                const Icon = k.icon;
                return (
                  <li key={s.step} data-step={i} style={{ left: cx(s) - cardW / 2, top: cy(i) - CARD_H / 2, width: cardW, height: CARD_H }}>
                    <button
                      type="button"
                      className={`lc-card tone-${k.tone}${i === step ? ' is-current' : ''}${i > step ? ' is-future' : ''}${s.branch ? ` br-${s.branch}` : ''}`}
                      onClick={() => (setPlaying(false), setStep(i))}
                      aria-current={i === step ? 'step' : undefined}
                      aria-label={`Step ${s.step}: ${k.label}, ${s.label}, ${s.file}${s.line ? ` line ${s.line}` : ''}`}
                    >
                      <span className="lc-card-kind">
                        <Icon size={13} /> {k.label}
                        {s.branch === 'async' && <span className="lc-badge">async</span>}
                        {(s.branch === 'cache-hit' || s.branch === 'cache-miss') && <span className="lc-badge">{s.branch === 'cache-hit' ? 'hit' : 'miss'}</span>}
                      </span>
                      <span className="lc-card-label">{s.label}</span>
                      <span className="lc-card-where mono">
                        {basename(s.file)}
                        {s.line ? `:${s.line}` : ''}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        )}
        {flow.notes.length > 0 && (
          <ul className="lc-notes">
            {flow.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}
      </section>

      <aside className="lc-detail glass" aria-live="polite" aria-label="Step details">
        {current && stepDetails(current)}
      </aside>
    </div>
  );
}
