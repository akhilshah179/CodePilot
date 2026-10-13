import { TYPE_LABELS } from '@codepilot/analyzer/shapes';
import { Check, Copy, Crosshair, ExternalLink, Flag, FlagTriangleRight, Layers, X } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { ErrorNotice, ShapeIcon } from '../../components/ui.tsx';
import type { GraphModel } from '../../graph/model.ts';
import { data, type DataSource, type NodeDetails, type NodeType, type Project } from '../../lib/api.ts';
import { fileOpener } from '../../lib/fileLinks.ts';
import { basename, bytes, plural } from '../../lib/format.ts';
import { useAsync, usePrefersReducedMotion } from '../../lib/hooks.ts';
import { IncidentTag } from '../collective/IncidentTag.tsx';

interface Props {
  src: DataSource;
  project: Project;
  commitSha: string | null;
  model: GraphModel;
  nodeId: string;
  depth: 1 | 2 | 3;
  onDepth(d: 1 | 2 | 3): void;
  onSelect(id: string): void;
  onClose(): void;
  /** Show only this file and its direct dependencies and dependents. */
  onIsolate(id: string): void;
  isolated?: boolean;
  /** Show this file's component in the Architecture view. */
  onArchitecture?(path: string): void;
  onPathFrom?(id: string): void;
  onPathTo?(id: string): void;
  onCycle(ci: number): void;
}

function Symbols({ symbols }: { symbols: string[] }) {
  if (!symbols.length) return <span className="faint">side effect</span>;
  return <span className="symbols">{symbols.map((s) => (s === '*' ? '* (namespace)' : s)).join(', ')}</span>;
}

function NodeLink({ id, type, onSelect }: { id: string; type?: NodeType; onSelect(id: string): void }) {
  return (
    <button className="node-link" onClick={() => onSelect(id)} title={id}>
      {type && <ShapeIcon type={type} size={12} />}
      <span className="mono">{id.startsWith('ext:') ? id.slice(4) : id.startsWith('unresolved:') ? id.slice(11) : id}</span>
    </button>
  );
}

const complexityWord = (max: number) => (max <= 10 ? 'low' : max <= 20 ? 'moderate' : 'high');

export function DetailsPanel(p: Props) {
  const { src, project, commitSha, model, nodeId, depth, onDepth, onSelect, onClose } = p;
  const { data: d, error, loading, reload } = useAsync(() => data.node(src, nodeId), [src.base, nodeId]);
  const [copied, setCopied] = useState(false);
  const reduced = usePrefersReducedMotion();
  const opener = fileOpener(project, commitSha);
  useEffect(() => setCopied(false), [nodeId]);
  const index = model.index.get(nodeId);
  const mn = index !== undefined ? model.nodes[index] : undefined;
  const health = index !== undefined ? model.health(index) : null;
  const cycles = index !== undefined ? (model.cycleOf.get(index) ?? []) : [];

  const lineLink = (path: string, line: number) => {
    const href = opener.href(path, line);
    return href ? (
      <a className="line-link mono" href={href} target="_blank" rel="noreferrer" title={`Open ${path} at line ${line}`}>
        L{line}
      </a>
    ) : (
      <span className="line-link mono">L{line}</span>
    );
  };

  // Which files use each exported symbol (from the consumers' imported symbols).
  const exportConsumers = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const c of d?.consumers ?? []) {
      for (const s of c.symbols) {
        if (!out.has(s)) out.set(s, []);
        out.get(s)!.push(c.source);
      }
    }
    return out;
  }, [d]);

  return (
    <motion.aside
      className="details inspector glass"
      aria-label="File inspector"
      aria-busy={loading}
      initial={reduced ? false : { opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="details-head">
        <div className="details-title">
          {d && <ShapeIcon type={d.node.type} size={16} />}
          <div>
            <p className="eyebrow">{d ? TYPE_LABELS[d.node.type] : 'File'}</p>
            <h2 tabIndex={-1} className="mono" title={nodeId}>
              {d?.node.type === 'external' ? d.node.path : basename(nodeId.replace(/^unresolved:/, ''))}
            </h2>
          </div>
        </div>
        <button className="tool-btn" onClick={onClose} aria-label="Close inspector (Escape)">
          <X size={14} />
        </button>
      </div>

      {error && <ErrorNotice error={error} onRetry={reload} />}
      {!d && loading && <p className="faint details-loading">Loading details…</p>}
      {d && renderBody(d)}
    </motion.aside>
  );

  function renderBody(d: NodeDetails) {
    const n = d.node;
    const isFile = n.type !== 'external' && n.type !== 'unresolved';
    const href = isFile ? opener.href(n.path) : null;
    const deps = d.transitive.dependencies;
    const dependents = d.transitive.dependents;
    return (
      <div className="details-body">
        <div className="path-row">
          <code className="path">{n.path}</code>
        </div>
        <div className="details-actions">
          <button
            className="btn btn-sm"
            onClick={async () => {
              await navigator.clipboard?.writeText(n.path).catch(() => {});
              setCopied(true);
            }}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy path'}
          </button>
          {isFile &&
            (href ? (
              <a className="btn btn-sm" href={href} target="_blank" rel="noreferrer">
                <ExternalLink size={13} /> {opener.label}
              </a>
            ) : (
              <button className="btn btn-sm" disabled title="This project has no remote to open files from">
                <ExternalLink size={13} /> Open file
              </button>
            ))}
          <button className="btn btn-sm" onClick={() => p.onIsolate(n.id)} aria-pressed={!!p.isolated} title="Show only this file, its dependencies and its dependents (double-click a file)">
            <Crosshair size={13} /> {p.isolated ? 'Show all' : 'Isolate'}
          </button>
          {isFile && p.onArchitecture && (
            <button className="btn btn-sm btn-ghost" onClick={() => p.onArchitecture!(n.path)} title="Show the component this file belongs to in the Architecture view">
              <Layers size={13} /> In architecture
            </button>
          )}
          {isFile && p.onPathFrom && p.onPathTo && (
            <>
              <button className="btn btn-sm btn-ghost" onClick={() => p.onPathFrom?.(n.id)} title="Use as path finder start">
                <Flag size={13} /> Path from
              </button>
              <button className="btn btn-sm btn-ghost" onClick={() => p.onPathTo?.(n.id)} title="Use as path finder end">
                <FlagTriangleRight size={13} /> Path to
              </button>
            </>
          )}
        </div>
        {isFile && !p.src.readOnly && !p.project.isSample && (
          <div className="incident-wrap">
            <IncidentTag key={n.id} projectId={p.project.id} nodeId={n.id} />
          </div>
        )}
        <div aria-live="polite" className="visually-hidden">
          {copied ? 'Path copied to clipboard' : ''}
        </div>

        <dl className="metrics">
          <div>
            <dt>Language</dt>
            <dd>{n.language}</dd>
          </div>
          {isFile && (
            <div>
              <dt>Size</dt>
              <dd>{bytes(n.size)}</dd>
            </div>
          )}
          <div>
            <dt>LOC</dt>
            <dd>{n.loc ?? '—'}</dd>
          </div>
          <div>
            <dt>Complexity</dt>
            <dd title={n.complexity?.maxName ? `Highest in ${n.complexity.maxName}() at line ${n.complexity.maxLine}` : undefined}>
              {n.complexity ? `${n.complexity.max} · ${complexityWord(n.complexity.max)}` : '—'}
            </dd>
          </div>
          <div>
            <dt>Imported by</dt>
            <dd className="con-count">{d.counts.dependents}</dd>
          </div>
          <div>
            <dt>Imports</dt>
            <dd className="dep-count">{d.counts.dependencies}</dd>
          </div>
        </dl>

        <section>
          <h3>Health</h3>
          <ul className="health-list">
            {health?.cycle && <li className="h-risk">In {plural(cycles.length, 'import cycle')}</li>}
            {health?.orphan && <li className="h-warn">Orphan: parsed, not imported, and not an entry point</li>}
            {health?.highFanIn && mn && <li className="h-data">High fan-in: imported by {mn.fanIn} files (repository threshold {model.thresholds.fanIn})</li>}
            {health?.highFanOut && mn && <li className="h-data">High fan-out: imports {mn.fanOut} files (repository threshold {model.thresholds.fanOut})</li>}
            {d.entryPoint && <li className="h-ok">Entry point: {d.entryPoint.join('; ')}</li>}
            {n.flags?.secretsDetected ? <li className="h-risk">Credential-like value detected (value not stored)</li> : null}
            {health && !health.cycle && !health.orphan && !health.highFanIn && !health.highFanOut && !d.entryPoint && isFile && <li className="h-ok">No issues shown by the graph</li>}
          </ul>
          {cycles.map((ci) => {
            const c = model.cycles[ci];
            return (
              <button key={ci} className="cycle" onClick={() => p.onCycle(ci)}>
                <span className="cycle-head">
                  <span className="tag tag-risk">{plural(c.members.length, 'file')} in cycle</span>
                  {c.typeOnly && <span className="tag">type-only</span>}
                </span>
                <span className="chain mono">
                  {c.chain.map((hop, k) => (
                    <span key={k}>
                      {basename(hop.source)}
                      <span className="faint">:{hop.line}</span>
                      <span className="dep-arrow"> → </span>
                    </span>
                  ))}
                  {basename(c.chain[0]?.source ?? '')}
                </span>
              </button>
            );
          })}
        </section>

        <section>
          <div className="details-section-head">
            <h3>Dependency depth</h3>
            <div className="segmented" role="group" aria-label="Transitive depth">
              {([1, 2, 3] as const).map((dd) => (
                <button key={dd} aria-pressed={depth === dd} onClick={() => onDepth(dd)}>
                  {dd}
                </button>
              ))}
            </div>
          </div>
          <table className="reach">
            <thead>
              <tr>
                <th scope="col" />
                <th scope="col">1 hop</th>
                <th scope="col">2</th>
                <th scope="col">3</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">
                  <span className="swatch swatch-dep" /> Dependencies
                </th>
                <td>{deps[1].length}</td>
                <td>{deps[2].length}</td>
                <td>{deps[3].length}</td>
              </tr>
              <tr>
                <th scope="row">
                  <span className="swatch swatch-con" /> Dependents
                </th>
                <td>{dependents[1].length}</td>
                <td>{dependents[2].length}</td>
                <td>{dependents[3].length}</td>
              </tr>
            </tbody>
          </table>
        </section>

        {isFile && (
          <section>
            <h3>
              Exports <span className="count">{d.facts.exports.length}</span>
            </h3>
            {d.facts.exports.length === 0 ? (
              <p className="faint small">{n.analyzed ? 'No exports found.' : 'Exports were not extracted for this file.'}</p>
            ) : (
              <ul className="rows compact">
                {d.facts.exports.map((ex, i) => {
                  const users = exportConsumers.get(ex.name) ?? [];
                  return (
                    <li key={i}>
                      <div className="row-main">
                        {lineLink(n.path, ex.line)}
                        <code>{ex.name}</code>
                        <span className="tag">{ex.kind}</span>
                        {ex.from && <code className="faint">from '{ex.from}'</code>}
                      </div>
                      {users.length > 0 && (
                        <div className="row-sub">
                          <span className="faint small">used by</span>
                          {[...new Set(users)].slice(0, 4).map((u) => (
                            <NodeLink key={u} id={u} onSelect={onSelect} />
                          ))}
                          {users.length > 4 && <span className="faint small">+{users.length - 4}</span>}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}

        {isFile && (
          <section>
            <h3>
              Imports <span className="count">{d.imports.length}</span>
            </h3>
            {d.imports.length === 0 ? (
              <p className="faint small">{n.analyzed ? 'This file imports nothing.' : 'Imports were not extracted for this file.'}</p>
            ) : (
              <ul className="rows">
                {d.imports.map((imp) => (
                  <li key={imp.edgeId} className={imp.resolved ? '' : 'unresolved'}>
                    <div className="row-main">
                      {lineLink(n.path, imp.line)}
                      <code className="spec">'{imp.specifier}'</code>
                      <span className="tag">{imp.kind}</span>
                      {imp.typeOnly && <span className="tag">type</span>}
                    </div>
                    <div className="row-sub">
                      <Symbols symbols={imp.symbols} />
                      <span className="arrow" aria-hidden="true">
                        →
                      </span>
                      {imp.resolved ? <NodeLink id={imp.target} type={imp.targetType} onSelect={onSelect} /> : <span className="unresolved-label">Unresolved</span>}
                    </div>
                    {!imp.resolved && imp.unresolvedReason && <div className="row-note">{imp.unresolvedReason}</div>}
                    {imp.resolved && imp.resolution && <div className="row-note faint">{imp.resolution}</div>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <section>
          <h3>
            Imported by <span className="count">{d.consumers.length}</span>
          </h3>
          {d.consumers.length === 0 ? (
            <p className="faint small">Nothing imports this {isFile ? 'file' : 'module'}.</p>
          ) : (
            <ul className="rows">
              {d.consumers.map((c) => (
                <li key={c.edgeId}>
                  <div className="row-main">
                    <NodeLink id={c.source} type={c.sourceType} onSelect={onSelect} />
                    {lineLink(c.source, c.line)}
                  </div>
                  <div className="row-sub">
                    <span className="tag">{c.kind}</span>
                    <Symbols symbols={c.symbols} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h3>Classification evidence</h3>
          <ul className="evidence">
            {n.classification_evidence.map((ev, i) => (
              <li key={i}>
                <span>{ev.detail}</span>
                <span className="faint mono">
                  {ev.rule}
                  {ev.line ? ` · line ${ev.line}` : ''}
                </span>
              </li>
            ))}
          </ul>
          {!n.analyzed && n.not_analyzed_reason && <p className="faint small">{n.not_analyzed_reason}</p>}
        </section>

        {d.facts.diagnostics.length > 0 && (
          <section>
            <h3>Analysis notes</h3>
            <ul className="rows compact">
              {d.facts.diagnostics.map((dg, i) => (
                <li key={i}>
                  <div className="row-main">
                    {lineLink(n.path, dg.line)}
                    <span className="small">{dg.message}</span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    );
  }
}
