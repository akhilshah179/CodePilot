import { ArrowDownLeft, ArrowUpRight, CircleDot, ExternalLink, Network, Play, Sparkles, Table2, X } from 'lucide-react';
import { motion } from 'motion/react';
import { ConfidenceBadge, EvidenceItem } from '../../components/ui.tsx';
import { data, type ArchitectureResponse, type ArchNode, type DataSource, type Evidence, type SystemMap, type SystemNode } from '../../lib/api.ts';
import type { FileOpener } from '../../lib/fileLinks.ts';
import { basename } from '../../lib/format.ts';
import { useAsync, usePrefersReducedMotion } from '../../lib/hooks.ts';
import { linkStyle } from './SystemMap.tsx';

type FlowSummary = ArchitectureResponse['architecture']['flows'][number];

interface Props {
  src: DataSource;
  node: SystemNode;
  /** The architecture node this component is (tools, services, apps), for its version and reasoning. */
  arch?: ArchNode;
  map: SystemMap;
  evidence: Record<string, Evidence>;
  flows: FlowSummary[];
  opener: FileOpener;
  onSelect(id: string): void;
  onWireframe?(path: string): void;
  onFlow(id: string): void;
  onMatrix(archId: string): void;
  /** Explain the technology in Technology Intelligence. */
  onIntelligence?(archId: string): void;
  onClose(): void;
}

const KIND_TEXT: Record<SystemNode['kind'], string> = {
  client: 'Client',
  transport: 'Transport',
  api: 'API group',
  proxy: 'Gateway / proxy',
  middleware: 'Middleware',
  handler: 'Route handlers',
  service: 'Service module',
  tool: 'Data store',
  queue: 'Queue / broker',
  worker: 'Worker',
  external: 'External service',
  infra: 'Infrastructure',
};

/**
 * One system component: what it is, what connects to it and how, the routes it serves, the files
 * it lives in, and the evidence behind each claim. Service and handler modules also show who
 * depends on them (blast radius from the import graph).
 */
export function SystemInspector(p: Props) {
  const n = p.node;
  const arch = p.arch;
  const reduced = usePrefersReducedMotion();
  const byId = new Map(p.map.nodes.map((x) => [x.id, x]));
  const incoming = p.map.links.filter((l) => l.target === n.id);
  const outgoing = p.map.links.filter((l) => l.source === n.id);
  const file = n.kind === 'service' || n.kind === 'handler' ? n.files[0]?.path : undefined;
  const deps = useAsync(() => (file ? data.node(p.src, file) : Promise.resolve(null)), [p.src.base, file]);
  // Flows that pass through this component: its routes, its files, or its technology.
  const related = p.flows.filter((f) => {
    if (n.routes?.some((r) => f.trigger.path === r.path && (f.trigger.method === r.method || !f.trigger.method))) return true;
    return false;
  });
  const ev = n.evidence.map((id) => p.evidence[id]).filter(Boolean);

  const connection = (l: SystemMap['links'][number], dir: 'in' | 'out') => {
    const other = byId.get(dir === 'in' ? l.source : l.target);
    const s = linkStyle(l);
    return (
      <li key={l.id}>
        <button type="button" className="si-conn" onClick={() => other && p.onSelect(other.id)}>
          {dir === 'in' ? <ArrowDownLeft size={13} /> : <ArrowUpRight size={13} />}
          <span className="si-conn-name">{other?.name ?? (dir === 'in' ? l.source : l.target)}</span>
          <span className="si-conn-label mono" style={{ color: s.color }}>
            {l.label}
            {l.count > 1 ? ` ×${l.count}` : ''}
            {l.async ? ' · async' : ''}
          </span>
          <ConfidenceBadge level={l.confidence} compact />
        </button>
      </li>
    );
  };

  return (
    <motion.aside
      className="inspector sys-inspector glass"
      initial={reduced ? false : { opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      aria-label={`${KIND_TEXT[n.kind]} ${n.name}`}
    >
      <header className="si-head">
        <div>
          <p className="eyebrow">{KIND_TEXT[n.kind]}</p>
          <h2 className="si-name">{n.name}</h2>
          <p className="si-detail mono">{n.detail}</p>
        </div>
        <button type="button" className="icon-btn" aria-label="Close inspector" onClick={p.onClose}>
          <X size={15} />
        </button>
      </header>

      <div className="si-body">
        <div className="si-row">
          <ConfidenceBadge level={n.confidence} />
          {arch?.version && (
            <span className="tag mono" title={`from ${arch.version.source}${arch.version.line ? `:${arch.version.line}` : ''}`}>
              {arch.version.package ? `${arch.version.package} ` : ''}
              {arch.version.value}
            </span>
          )}
          {n.libraries?.map((lib) => (
            <span key={lib} className="tag mono">
              {lib}
            </span>
          ))}
        </div>
        {arch?.reason && <p className="si-reason">{arch.reason}</p>}
        {arch?.description && <p className="faint small si-reason">{arch.description}</p>}

        <div className="si-actions">
          {n.arch && (n.kind === 'tool' || n.kind === 'external' || n.kind === 'queue' || n.kind === 'infra' || n.kind === 'proxy') && (
            <button type="button" className="btn btn-sm" onClick={() => p.onMatrix(n.arch!)}>
              <Table2 size={13} /> In technology matrix
            </button>
          )}
          {n.arch && p.onIntelligence && !n.id.startsWith('app:') && !n.id.startsWith('client:') && (
            <button type="button" className="btn btn-sm" onClick={() => p.onIntelligence!(n.arch!)}>
              <Sparkles size={13} /> Explain in this project
            </button>
          )}
          {file && p.onWireframe && (
            <button type="button" className="btn btn-sm" onClick={() => p.onWireframe!(file)}>
              <Network size={13} /> Show in Wireframe
            </button>
          )}
        </div>

        {n.routes && n.routes.length > 0 && (
          <section className="si-section">
            <h3>Routes · {n.routes.length}</h3>
            <ul className="si-routes">
              {n.routes.map((r) => {
                const f = p.flows.find((x) => x.trigger.path === r.path && x.trigger.method === r.method);
                const href = p.opener.href(r.file, r.line);
                return (
                  <li key={`${r.method} ${r.path} ${r.line}`}>
                    <span className={`method mono m-${r.method.toLowerCase()}`}>{r.method}</span>
                    <span className="mono si-path">{r.path}</span>
                    {r.auth && <span className="tag">auth</span>}
                    {href ? (
                      <a className="mono faint small" href={href} target="_blank" rel="noreferrer">
                        {basename(r.file)}:{r.line}
                      </a>
                    ) : (
                      <span className="mono faint small">
                        {basename(r.file)}:{r.line}
                      </span>
                    )}
                    {f && (
                      <button type="button" className="icon-btn" aria-label={`Trace ${r.method} ${r.path}`} title="Trace this request" onClick={() => p.onFlow(f.id)}>
                        <Play size={12} />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {(incoming.length > 0 || outgoing.length > 0) && (
          <section className="si-section">
            <h3>Connections</h3>
            <ul className="si-conns">
              {incoming.map((l) => connection(l, 'in'))}
              {outgoing.map((l) => connection(l, 'out'))}
            </ul>
          </section>
        )}

        {related.length > 0 && !n.routes && (
          <section className="si-section">
            <h3>Request flows</h3>
            <ul className="si-flows">
              {related.slice(0, 6).map((f) => (
                <li key={f.id}>
                  <button type="button" className="link-btn" onClick={() => p.onFlow(f.id)}>
                    <Play size={12} /> {f.action?.label ?? f.title}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {file && (
          <section className="si-section">
            <h3>Blast radius</h3>
            {deps.data ? (
              <dl className="si-blast">
                {([1, 2, 3] as const).map((d) => (
                  <div key={d}>
                    <dt>{d === 1 ? 'Direct dependents' : `${d} hops`}</dt>
                    <dd className="mono con-count">{deps.data!.transitive.dependents[d].length}</dd>
                  </div>
                ))}
                <div>
                  <dt>Depends on</dt>
                  <dd className="mono dep-count">{deps.data.counts.dependencies}</dd>
                </div>
              </dl>
            ) : (
              <p className="faint small">{deps.error ? 'Dependency data unavailable.' : 'Loading…'}</p>
            )}
          </section>
        )}

        {n.files.length > 0 && (
          <section className="si-section">
            <h3>Files</h3>
            <ul className="si-files">
              {n.files.map((f) => {
                const href = p.opener.href(f.path, f.line);
                return (
                  <li key={`${f.path}:${f.line ?? ''}`}>
                    {href ? (
                      <a className="mono" href={href} target="_blank" rel="noreferrer" title={p.opener.label}>
                        {f.path}
                        {f.line ? `:${f.line}` : ''} <ExternalLink size={11} />
                      </a>
                    ) : (
                      <span className="mono">
                        {f.path}
                        {f.line ? `:${f.line}` : ''}
                      </span>
                    )}
                    {p.onWireframe && (
                      <button type="button" className="icon-btn" aria-label={`Show ${f.path} in the Wireframe`} title="Show in Wireframe" onClick={() => p.onWireframe!(f.path)}>
                        <CircleDot size={12} />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {ev.length > 0 && (
          <section className="si-section">
            <h3>Evidence</h3>
            <ul className="ev-list">
              {ev.map((e) => (
                <EvidenceItem key={e.id} ev={e} href={p.opener.href(e.file, e.line)} />
              ))}
            </ul>
          </section>
        )}
      </div>
    </motion.aside>
  );
}
