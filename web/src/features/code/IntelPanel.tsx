import { ArrowDownLeft, ArrowUpRight, Box, ChevronDown, ChevronRight, ListTree } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { CodeOutline, CodeRelations } from '../../lib/api.ts';
import type { AsyncState } from '../../lib/hooks.ts';

/** Right panel: the file's outline, who imports it, and what it imports. */
export function IntelPanel(props: {
  path: string;
  outline: AsyncState<CodeOutline>;
  relations: AsyncState<CodeRelations>;
  onOpen(path: string, line?: number): void;
  onLine(line: number): void;
}) {
  const { outline, relations } = props;
  const r = relations.data;
  return (
    <div className="ci" aria-label="Code intelligence">
      <Section title="Outline" icon={<ListTree size={13} />} count={outline.data?.symbols.length}>
        {outline.loading && !outline.data ? (
          <p className="ci-note">Reading symbols…</p>
        ) : outline.error ? (
          <p className="ci-note">{outline.error.message}</p>
        ) : !outline.data?.supported ? (
          <p className="ci-note">No outline for {outline.data?.language ? `${outline.data.language} files` : 'this file'}.</p>
        ) : !outline.data.symbols.length ? (
          <p className="ci-note">No functions, classes or types declared here.</p>
        ) : (
          <ul className="ci-list">
            {outline.data.symbols.map((s, i) => (
              <li key={i}>
                <button type="button" className="ci-item" style={{ paddingLeft: 8 + s.depth * 12 }} onClick={() => props.onLine(s.line)} title={`${s.kind} ${s.name} — line ${s.line}`}>
                  <span className={`ci-kind k-${s.kind}`} aria-hidden="true">
                    {KIND[s.kind] ?? s.kind[0]}
                  </span>
                  <span className="ci-name mono">{s.name}</span>
                  <span className="ci-line mono">{s.line}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Used by" icon={<ArrowDownLeft size={13} />} count={r?.status === 'ready' ? new Set(r.importers.map((i) => i.path)).size : undefined}>
        <Relations state={relations} empty={r?.importsAnalyzed === false ? 'Import links are traced for JavaScript and TypeScript files.' : 'No file in this snapshot imports this file.'}>
          {r?.importers.map((i, k) => (
            <li key={k}>
              <button type="button" className="ci-item" onClick={() => props.onOpen(i.path, i.line)} title={`${i.path}:${i.line} imports ${i.symbols.length ? i.symbols.join(', ') : 'this file'}${i.typeOnly ? ' (types only)' : ''}`}>
                <span className="ci-name mono">{i.path}</span>
                <span className="ci-line mono">{i.line}</span>
              </button>
            </li>
          ))}
        </Relations>
      </Section>
      <Section title="Imports" icon={<ArrowUpRight size={13} />} count={r?.status === 'ready' ? r.imports.length : undefined}>
        <Relations state={relations} empty={r?.importsAnalyzed === false ? 'Import links are traced for JavaScript and TypeScript files.' : 'This file imports nothing.'} list={r?.imports}>
          {r?.imports.map((i, k) => (
            <li key={k}>
              {i.resolved && !i.external && i.target ? (
                <button type="button" className="ci-item" onClick={() => props.onOpen(i.target!)} title={`Line ${i.line}: ${i.specifier} → ${i.target}`}>
                  <span className="ci-name mono">{i.target}</span>
                  <span className="ci-line mono">{i.line}</span>
                </button>
              ) : (
                <button type="button" className="ci-item is-static" onClick={() => props.onLine(i.line)} title={i.external ? `External package — not part of this repository` : `Unresolved: ${i.reason}`}>
                  {i.external ? <Box size={12} aria-hidden="true" className="faint" /> : <span className="ci-unresolved">unresolved</span>}
                  <span className="ci-name mono">{i.external ? (i.packageName ?? i.specifier) : i.specifier}</span>
                  <span className="ci-line mono">{i.line}</span>
                </button>
              )}
              {!i.resolved && <p className="ci-reason">{i.reason}</p>}
            </li>
          ))}
        </Relations>
      </Section>
    </div>
  );
}

const KIND: Record<string, string> = { function: 'ƒ', method: 'm', class: 'C', component: '◇', interface: 'I', type: 'T', enum: 'E', struct: 'S', trait: 'T', module: '{}', heading: '#', variable: 'v' };

function Relations({ state, empty, children, list }: { state: AsyncState<CodeRelations>; empty: string; children: ReactNode; list?: unknown[] }) {
  const r = state.data;
  if (state.loading && !r) return <p className="ci-note">Reading the dependency graph…</p>;
  if (state.error) return <p className="ci-note">{state.error.message}</p>;
  if (!r) return null;
  if (r.status === 'pending') return <p className="ci-note">Available when the analysis of this snapshot finishes.</p>;
  if (r.status === 'unavailable') return <p className="ci-note">The dependency graph of this snapshot is not stored.</p>;
  const items = list ?? r.importers;
  if (!items.length) return <p className="ci-note">{empty}</p>;
  return <ul className="ci-list">{children}</ul>;
}

function Section({ title, icon, count, children }: { title: string; icon: ReactNode; count?: number; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  const id = `ci-${title.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <section className="ci-section">
      <h3>
        <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
          {icon}
          <span>{title}</span>
          {count !== undefined && <span className="ci-count mono">{count}</span>}
        </button>
      </h3>
      {open && <div id={id}>{children}</div>}
    </section>
  );
}
