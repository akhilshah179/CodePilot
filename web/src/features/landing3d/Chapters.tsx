import { Check } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';
import { ConfidenceBadge } from '../../components/ui.tsx';
import { EASE } from '../landing/motion.tsx';
import { snapshot } from '../landing/snapshot.ts';
import { areaOf } from './model.ts';
import { setStory, useStory } from './story.ts';

/*
 * The story: six chapters scrolled over the living codebase. Each card says what the scene is
 * showing at that moment, with the real numbers, files and lines behind it.
 */

const arch = snapshot.architecture;
const count = (a: string) => snapshot.nodes.filter((n) => areaOf(n.id) === a).length;
const nameOf = (id: string) => arch.nodes.find((n) => n.id === id)?.name ?? id;
const flow = snapshot.traceFlow;
const techs = snapshot.technologies;
const restEdge = arch.edges.find((e) => e.source === 'app:web' && e.target === 'app:server');
const restEv = restEdge?.evidence.map((id) => arch.evidence[id]).filter(Boolean) ?? [];

export const STATUS = [
  { label: 'Repository analyzed', ch: 1 },
  { label: 'Dependencies detected', ch: 2 },
  { label: 'Architecture mapped', ch: 3 },
  { label: 'Execution flows traced', ch: 4 },
  { label: 'Technologies identified', ch: 5 },
  { label: 'Evidence linked', ch: 6 },
];

export const COUNTS = [
  { label: 'Files', value: snapshot.totals.files },
  { label: 'Imports', value: snapshot.totals.edges },
  { label: 'Routes', value: arch.stats.routes },
  { label: 'Flows', value: arch.stats.flows },
  { label: 'Technologies', value: techs.length },
];

function Chapter({ n, id, eyebrow, title, children, side = 'left' }: { n: number; id: string; eyebrow: string; title: ReactNode; children: ReactNode; side?: 'left' | 'right' }) {
  return (
    <section id={id} className={`lx-chapter side-${side}`} data-chapter={n} aria-labelledby={`${id}-title`}>
      <motion.div className="lx-card glass" initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ amount: 0.35 }} transition={{ duration: 0.7, ease: EASE }}>
        <div className="lx-card-top">
          <p className="lx-eyebrow">
            <span className="mono">{String(n).padStart(2, '0')}</span>
            {eyebrow}
          </p>
          {STATUS[n - 1] && (
            <span className="lx-status mono">
              <Check size={11} aria-hidden="true" /> {STATUS[n - 1].label}
            </span>
          )}
        </div>
        <h2 id={`${id}-title`}>{title}</h2>
        {children}
      </motion.div>
    </section>
  );
}

export function Story() {
  return (
    <>
      <Chapter n={1} id="discover" eyebrow="Discover" title="A repository enters CodePilot.">
        <p>
          One branch is shallow-cloned from GitHub into temporary storage. Dependencies, build output and secret files are skipped before anything is parsed. What remains is source — here, CodePilot’s own.
        </p>
        <dl className="lx-facts">
          <div>
            <dt>web/</dt>
            <dd className="mono">{count('web')} files</dd>
          </div>
          <div>
            <dt>server/</dt>
            <dd className="mono">{count('server')} files</dd>
          </div>
          <div>
            <dt>packages/analyzer/</dt>
            <dd className="mono">{count('analyzer')} files</dd>
          </div>
        </dl>
      </Chapter>

      <Chapter n={2} id="understand" eyebrow="Understand" title="Files become a structured graph." side="right">
        <p>
          Every import is resolved to an exact file and line — through aliases, workspaces and index files. {snapshot.totals.edges} imports connect {snapshot.totals.files} files; {snapshot.symbols.length} exported symbols sit around the files that declare them. Directories become groups, and applications emerge.
        </p>
        <p className="lx-hint small">Hover a node to see what it imports and what imports it.</p>
      </Chapter>

      <Chapter n={3} id="map" eyebrow="Map" title="The graph becomes architecture.">
        <p>Routes, clients, queries and manifests are assembled into applications, data stores and services — only the connections the code proves.</p>
        <ul className="lx-links">
          {arch.edges.map((e) => (
            <li key={e.id}>
              <span className="mono">
                {nameOf(e.source)} → {nameOf(e.target)}
              </span>
              <span className="lx-link-label">{e.labels.join(' · ')}</span>
              <ConfidenceBadge level={e.confidence} compact />
            </li>
          ))}
        </ul>
        {arch.pattern && <p className="small faint">Detected pattern: {arch.pattern}.</p>}
      </Chapter>

      {flow && (
        <Chapter n={4} id="trace" eyebrow="Trace" title="Follow one request through the code." side="right">
          <p>
            <strong>{flow.name}</strong> <span className="mono faint">{flow.title.split(' → ').pop()}</span> — {flow.steps.length} steps traced from the page’s data hook through transport, route and middleware, and back to UI state.
          </p>
          <TraceSteps />
        </Chapter>
      )}

      <Chapter n={5} id="explain" eyebrow="Explain" title="Every technology, explained from its evidence.">
        <TechExplain />
      </Chapter>

      <Chapter n={6} id="verify" eyebrow="Verify" title="Every claim points at a line." side="right">
        <p>The connection between web and server is not inferred from folder names. This is the line that proves it, and the route it reaches.</p>
        {restEv[0] && restEv[1] && (
          <ol className="lx-chain">
            <li>
              <span className="lx-chain-k">File</span>
              <span className="mono">{restEv[0].file}</span>
            </li>
            <li>
              <span className="lx-chain-k">Line {restEv[0].line}</span>
              <code className="mono">{restEv[0].snippet}</code>
            </li>
            <li>
              <span className="lx-chain-k">Relationship</span>
              <span className="mono">{restEv[0].detail}</span>
            </li>
            <li>
              <span className="lx-chain-k">Route</span>
              <span className="mono">
                {restEv[1].file}:{restEv[1].line}
              </span>
            </li>
            <li>
              <span className="lx-chain-k">Architecture</span>
              <span>
                web → server · {restEdge!.labels.join(' · ')} <ConfidenceBadge level={restEdge!.confidence} compact />
              </span>
            </li>
          </ol>
        )}
        <p className="small faint">
          {arch.stats.evidence} pieces of evidence back this analysis; each stores a file, a line and a redacted snippet.
        </p>
      </Chapter>
    </>
  );
}

function TraceSteps() {
  const animated = useStory((s) => s.traceStep);
  // With reduced motion the scene shows the whole path at once, and so does the list.
  const step = useReducedMotion() ? Infinity : animated;
  if (!flow) return null;
  return (
    <ol className="lx-steps" aria-label="Traced steps">
      {flow.steps.map((s, i) => (
        <li key={i} className={i === step ? 'is-current' : i < step ? 'is-done' : undefined}>
          <span className="lx-step-stage mono">{s.stage}</span>
          <span className="lx-step-label">{s.label}</span>
          <span className="lx-step-where mono">
            {s.file.slice(s.file.lastIndexOf('/') + 1)}
            {s.line ? `:${s.line}` : ''}
          </span>
        </li>
      ))}
    </ol>
  );
}

function TechExplain() {
  const sel = useStory((s) => s.tech);
  const t = techs[sel] ?? techs[0];
  if (!t) return null;
  const ev = t.evidence[0];
  const where = t.files.map((f) => `${f.path}${f.line ? `:${f.line}` : ''}`);
  const connects = t.connections.length ? t.connections.map((c) => (c.direction === 'in' ? `${c.name} → ${t.name}` : `${t.name} → ${c.name}`) + (c.labels.length ? ` · ${c.labels.join(', ')}` : '')) : t.usedBy.map((u) => `used by ${u}`);
  return (
    <>
      <div className="lx-techs" role="tablist" aria-label="Technologies">
        {techs.map((x, i) => (
          <button key={x.id} role="tab" aria-selected={i === sel} onClick={() => setStory({ tech: i })}>
            {x.name}
          </button>
        ))}
      </div>
      <motion.dl key={t.id} className="lx-explain" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease: EASE }} role="tabpanel" aria-label={t.name}>
        <div>
          <dt>What it is</dt>
          <dd>{t.general ?? 'No general description is stored for it.'}</dd>
        </div>
        <div>
          <dt>What it does here</dt>
          <dd>{t.role}</dd>
        </div>
        <div>
          <dt>Why it is used</dt>
          <dd>
            {t.why} <ConfidenceBadge level={t.confidence} compact />
          </dd>
        </div>
        <div>
          <dt>Where</dt>
          <dd className="mono small">{where.length ? where.join(' · ') : '—'}</dd>
        </div>
        <div>
          <dt>How it connects</dt>
          <dd>{connects.join(' · ') || '—'}</dd>
        </div>
        {ev && (
          <div>
            <dt>Evidence</dt>
            <dd>
              <code className="mono">{ev.snippet ?? ev.detail}</code>
              <span className="mono faint small lx-ev-where">
                {ev.file}
                {ev.line ? `:${ev.line}` : ''}
              </span>
            </dd>
          </div>
        )}
      </motion.dl>
    </>
  );
}

/** A small analysis console in the hero: the real totals of the analysis behind the scene. */
export function Hud() {
  const chapter = useStory((s) => s.chapter);
  const visible = useStory((s) => s.visible);
  return (
    <aside className={`lx-hud glass${visible && chapter === 0 ? '' : ' is-hidden'}`} aria-label="Codebase analysis">
      <p className="lx-hud-title mono">
        Codebase analysis <span className="faint">· codepilot{snapshot.commit ? `@${snapshot.commit.slice(0, 7)}` : ''}</span>
      </p>
      <dl>
        {COUNTS.map((c) => (
          <div key={c.label}>
            <dt>{c.label}</dt>
            <dd className="mono">{c.value.toLocaleString()}</dd>
          </div>
        ))}
      </dl>
      <ul>
        {STATUS.map((s) => (
          <li key={s.label} className="is-done">
            <Check size={11} aria-hidden="true" /> {s.label}
          </li>
        ))}
      </ul>
      <p className="lx-hud-foot mono">Analysis complete</p>
    </aside>
  );
}
