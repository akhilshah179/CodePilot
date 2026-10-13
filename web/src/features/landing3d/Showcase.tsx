import { Bot, Cpu, FileCode2, LayoutDashboard, Network, ShieldCheck, Workflow, type LucideIcon } from 'lucide-react';
import { AnimatePresence, motion, useInView, useReducedMotion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ConfidenceBadge } from '../../components/ui.tsx';
import { EASE } from '../landing/motion.tsx';
import { ArchitectureDemo, DependencyDemo, EvidenceDemo, GroundedAnswer } from '../landing/Sections.tsx';
import { snapshot } from '../landing/snapshot.ts';
import { areaOf } from './model.ts';

/*
 * The platform, surface by surface. Each panel is a working miniature driven by the same real
 * snapshot as the story — CodePilot's analysis of its own repository.
 */

const SURFACES: { id: string; title: string; line: string; icon: LucideIcon; render: () => React.ReactNode }[] = [
  { id: 'overview', title: 'Codebase Overview', line: 'Totals, applications and the files everything depends on.', icon: LayoutDashboard, render: () => <OverviewDemo /> },
  { id: 'wireframe', title: 'Dependency Wireframe', line: 'What a file uses, and what uses it — line-exact.', icon: Network, render: () => <DependencyDemo /> },
  { id: 'architecture', title: 'Architecture Intelligence', line: 'Applications, data and services the code proves.', icon: FileCode2, render: () => <ArchitectureDemo /> },
  { id: 'automation', title: 'Automation Engine', line: 'A real request, played through every stage.', icon: Workflow, render: () => <AutomationDemo /> },
  { id: 'technology', title: 'Technology Intelligence', line: 'Why each technology is here, from its evidence.', icon: Cpu, render: () => <TechIntelDemo /> },
  { id: 'chat', title: 'AI Codebase Chat', line: 'Answers that cite files and lines. Coming next.', icon: Bot, render: () => <GroundedAnswer /> },
  { id: 'evidence', title: 'Evidence & Traceability', line: 'The stored lines behind every connection.', icon: ShieldCheck, render: () => <EvidenceDemo /> },
];

export function Showcase() {
  const [active, setActive] = useState(0);
  const s = SURFACES[active];
  return (
    <div className="lx-show">
      <div className="lx-show-nav" role="tablist" aria-label="Product surfaces" aria-orientation="vertical">
        {SURFACES.map((x, i) => (
          <button
            key={x.id}
            id={`show-tab-${x.id}`}
            role="tab"
            aria-selected={i === active}
            aria-controls="show-panel"
            tabIndex={i === active ? 0 : -1}
            onClick={() => setActive(i)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
              e.preventDefault();
              const next = (i + (e.key === 'ArrowDown' ? 1 : SURFACES.length - 1)) % SURFACES.length;
              setActive(next);
              document.getElementById(`show-tab-${SURFACES[next].id}`)?.focus();
            }}
          >
            <span className="lx-show-n mono">{String(i + 1).padStart(2, '0')}</span>
            <x.icon size={16} aria-hidden="true" />
            <span className="lx-show-t">
              <strong>{x.title}</strong>
              <span>{x.line}</span>
            </span>
            {i === active && <motion.span layoutId="show-bar" className="lx-show-bar" transition={{ duration: 0.35, ease: EASE }} />}
          </button>
        ))}
      </div>
      <div className="lx-show-window glass" id="show-panel" role="tabpanel" aria-labelledby={`show-tab-${s.id}`}>
        <div className="l-window-bar">
          <span className="l-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="small">{s.title}</span>
          <span className="mono faint small l-window-meta">codepilot{snapshot.commit ? ` @ ${snapshot.commit.slice(0, 7)}` : ''}</span>
        </div>
        <AnimatePresence mode="wait">
          <motion.div key={s.id} className="lx-show-body" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.3, ease: EASE }}>
            {s.render()}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- overview */

function OverviewDemo() {
  const reduce = !!useReducedMotion();
  const areas = (['web', 'server', 'analyzer'] as const).map((a) => ({ a, n: snapshot.nodes.filter((x) => areaOf(x.id) === a).length }));
  const max = Math.max(...areas.map((x) => x.n));
  const inbound = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of snapshot.edges) m.set(e.target, (m.get(e.target) ?? 0) + 1);
    return m;
  }, []);
  const tiles = [
    ['Source files', snapshot.totals.files],
    ['Imports resolved', snapshot.totals.edges],
    ['Exported symbols', snapshot.symbols.length],
    ['External packages', snapshot.totals.externalPackages],
    ['API routes', snapshot.architecture.stats.routes],
    ['Traced flows', snapshot.architecture.stats.flows],
  ] as const;
  return (
    <div className="ov">
      <dl className="ov-tiles">
        {tiles.map(([k, v], i) => (
          <motion.div key={k} initial={reduce ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05, duration: 0.4, ease: EASE }}>
            <dd className="mono">{v.toLocaleString()}</dd>
            <dt>{k}</dt>
          </motion.div>
        ))}
      </dl>
      <div className="ov-cols">
        <div>
          <p className="side-k">Files by application</p>
          <ul className="ov-bars">
            {areas.map(({ a, n }, i) => (
              <li key={a}>
                <span className="mono">{a === 'analyzer' ? 'packages/analyzer' : a}</span>
                <span className="ov-track">
                  <motion.span className={`ov-fill a-${a}`} initial={reduce ? false : { width: 0 }} animate={{ width: `${(n / max) * 100}%` }} transition={{ delay: 0.2 + i * 0.1, duration: 0.7, ease: EASE }} />
                </span>
                <span className="mono faint">{n}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="side-k">Most depended-on</p>
          <ol className="ov-hubs">
            {snapshot.hubs.map((h) => (
              <li key={h}>
                <span className="mono">{h}</span>
                <span className="mono faint">{inbound.get(h) ?? 0} importers</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- automation */

const STAGE_ORDER = ['user', 'frontend', 'transport', 'backend', 'services', 'tools', 'data', 'external', 'response'];

function AutomationDemo() {
  const flow = snapshot.traceFlow;
  const reduce = !!useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { margin: '-60px' });
  const [step, setStep] = useState(0);
  const layout = useMemo(() => {
    if (!flow) return null;
    const stages = STAGE_ORDER.filter((s) => flow.steps.some((x) => x.stage === s));
    const rows = new Map<string, number>();
    const keys = new Map<string, { x: number; y: number; label: string; stage: string }>();
    const path = flow.steps.map((s) => {
      const key = `${s.stage}|${s.label}|${s.file}`;
      if (!keys.has(key)) {
        const r = rows.get(s.stage ?? '') ?? 0;
        rows.set(s.stage ?? '', r + 1);
        keys.set(key, { x: 20 + stages.indexOf(s.stage ?? '') * 150, y: 44 + r * 46, label: s.label, stage: s.stage ?? '' });
      }
      return key;
    });
    const H = 44 + Math.max(...rows.values()) * 46 + 10;
    return { stages, keys, path, W: 20 + stages.length * 150, H };
  }, [flow]);

  useEffect(() => {
    if (!flow || reduce || !inView) return;
    const t = window.setTimeout(() => setStep((s) => (s + 1) % (flow.steps.length + 2)), step >= flow.steps.length - 1 ? 1800 : 950);
    return () => window.clearTimeout(t);
  }, [step, flow, reduce, inView]);

  if (!flow || !layout) return null;
  const cur = Math.min(step, flow.steps.length - 1);
  const at = layout.keys.get(layout.path[cur])!;
  const s = flow.steps[cur];
  return (
    <div className="ad" ref={ref}>
      <div className="ad-head">
        <strong>{flow.name}</strong>
        <span className="mono faint small">{flow.title.split(' → ').pop()}</span>
        <span className="mono small ad-count">
          {cur + 1}/{flow.steps.length}
        </span>
      </div>
      <div className="ad-scroll">
        <svg viewBox={`0 0 ${layout.W} ${layout.H}`} className="ad-svg" role="img" aria-label={`${flow.name}: ${flow.steps.map((x) => x.label).join(', then ')}`}>
          {layout.stages.map((st, i) => (
            <g key={st}>
              <rect x={12 + i * 150} y={8} width={136} height={layout.H - 14} rx={8} className="ad-col" />
              <text x={24 + i * 150} y={26} className="ad-stage">
                {st.toUpperCase()}
              </text>
            </g>
          ))}
          {layout.path.slice(1).map((k, i) => {
            const a = layout.keys.get(layout.path[i])!;
            const b = layout.keys.get(k)!;
            if (a === b) return null;
            const done = i + 1 <= cur;
            // Same stage: straight down (or up) between cards; otherwise from the side facing the target.
            const d =
              a.x === b.x
                ? `M${a.x + 60} ${b.y > a.y ? a.y + 28 : a.y} L${b.x + 60} ${b.y > a.y ? b.y : b.y + 28}`
                : b.x > a.x
                  ? `M${a.x + 120} ${a.y + 14} C${a.x + 140} ${a.y + 14} ${b.x - 20} ${b.y + 14} ${b.x} ${b.y + 14}`
                  : `M${a.x} ${a.y + 14} C${a.x - 20} ${a.y + 14} ${b.x + 140} ${b.y + 14} ${b.x + 120} ${b.y + 14}`;
            return <path key={i} d={d} className={`ad-edge${done ? ' is-done' : ''}`} />;
          })}
          {[...layout.keys.entries()].map(([k, n]) => {
            const idx = layout.path.indexOf(k);
            const state = layout.path.slice(0, cur + 1).includes(k) ? (layout.path[cur] === k ? 'current' : 'done') : 'todo';
            return (
              <g key={k} className={`ad-node is-${state}`} transform={`translate(${n.x} ${n.y})`}>
                <rect width={120} height={28} rx={6} />
                <text x={8} y={18}>
                  {n.label.length > 17 ? `${n.label.slice(0, 16)}…` : n.label}
                </text>
                <title>{`${idx + 1}. ${n.label}`}</title>
              </g>
            );
          })}
          {!reduce && <motion.circle r={5} className="ad-packet" animate={{ cx: at.x + 60, cy: at.y + 14 }} transition={{ duration: 0.6, ease: EASE }} />}
        </svg>
      </div>
      <p className="ad-now small">
        <span className="mono ad-stage-tag">{s.stage}</span> {s.explanation}{' '}
        <span className="mono faint">
          {s.file}
          {s.line ? `:${s.line}` : ''}
        </span>
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- technology intelligence */

function TechIntelDemo() {
  const [sel, setSel] = useState(0);
  const t = snapshot.technologies[sel];
  if (!t) return null;
  return (
    <div className="ti">
      <ul className="ti-list" role="listbox" aria-label="Technologies">
        {snapshot.technologies.map((x, i) => (
          <li key={x.id} role="option" aria-selected={i === sel}>
            <button type="button" onClick={() => setSel(i)}>
              <span className="ti-name">{x.name}</span>
              <span className="mono faint small">{x.category}</span>
            </button>
          </li>
        ))}
      </ul>
      <motion.div key={t.id} className="ti-card" initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.35, ease: EASE }}>
        <div className="ti-top">
          <h4>{t.name}</h4>
          {t.version && <span className="mono faint small">{t.version}</span>}
          <ConfidenceBadge level={t.confidence} compact />
        </div>
        <p className="ti-role">{t.role}</p>
        <p className="ti-why small muted">{t.why}</p>
        <div className="ti-conn">
          {(t.connections.length ? t.connections.map((c) => (c.direction === 'in' ? `${c.name} → ${t.name}` : `${t.name} → ${c.name}`) + (c.labels.length ? ` · ${c.labels.join(', ')}` : '')) : t.usedBy.map((u) => `${u} uses ${t.name}`)).map((c) => (
            <span key={c} className="ti-pill mono">
              {c}
            </span>
          ))}
          {t.routes > 0 && <span className="ti-pill mono">{t.routes} routes</span>}
          {t.flows > 0 && <span className="ti-pill mono">{t.flows} flows</span>}
        </div>
        {t.evidence[0] && (
          <div className="ti-ev">
            <code className="snip mono">{t.evidence[0].snippet ?? t.evidence[0].detail}</code>
            <span className="mono faint small">
              {t.evidence[0].file}
              {t.evidence[0].line ? `:${t.evidence[0].line}` : ''}
            </span>
          </div>
        )}
      </motion.div>
    </div>
  );
}
