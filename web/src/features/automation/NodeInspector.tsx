import { Crosshair, Cpu, ExternalLink, Layers, Network, Share2, X } from 'lucide-react';
import { ConfidenceBadge } from '../../components/ui.tsx';
import type { AutoEdge, AutoNode, AutomationFlow } from '../../lib/api.ts';
import type { FileOpener } from '../../lib/fileLinks.ts';
import { NODE_META } from './FlowChart.tsx';

interface Props {
  flow: AutomationFlow;
  node: AutoNode;
  opener: FileOpener;
  onClose(): void;
  onFocusBranch(): void;
  onSelect(id: string): void;
  onWireframe?(path: string): void;
  onArchitecture?(target: { focus?: string; tech?: string }): void;
  onIntelligence?(tech: string): void;
  onJump?(key: string): void;
}

const where = (e: { file: string; line?: number }) => `${e.file}${e.line ? `:${e.line}` : ''}`;

/** Everything about one step: where it is, the code, what goes in and out, tools, and links into the code. */
export function NodeInspector({ flow, node: n, opener, onClose, onFocusBranch, onSelect, onWireframe, onArchitecture, onIntelligence, onJump }: Props) {
  const meta = NODE_META[n.type];
  const Icon = meta.icon;
  const incoming = flow.edges.filter((e) => e.target === n.id);
  const outgoing = flow.edges.filter((e) => e.source === n.id);
  const label = (id: string) => flow.nodes.find((x) => x.id === id)?.label ?? id;
  const href = opener.href(n.file, n.line);
  const toolName = (id: string) => flow.tools.find((t) => t.id === id)?.name ?? id.replace(/^(tool|host|app):/, '');
  const edgeText = (e: AutoEdge, other: string) => `${e.label ? `${e.label} · ` : ''}${label(other)}`;

  return (
    <aside className="fc2-overlay fc2-inspector" aria-label={`${meta.label}: ${n.label}`}>
      <header>
        <span className="fc2-kind">
          <Icon size={14} aria-hidden="true" /> {meta.label}
        </span>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close inspector">
          <X size={15} />
        </button>
      </header>
      <h3>{n.label}</h3>
      <p className="mono small fc2-path">{where(n)}</p>
      <div className="fc2-insp-badges">
        <ConfidenceBadge level={n.confidence === 'unknown' ? 'unknown' : n.confidence} compact />
      </div>
      {n.detail && <p className="small">{n.detail}</p>}
      {n.decision && (
        <dl className="fc2-kv">
          <dt>Condition</dt>
          <dd className="mono">{n.decision.condition}</dd>
        </dl>
      )}
      {n.evidence.some((e) => e.snippet) && (
        <section>
          <h4>Code</h4>
          {n.evidence
            .filter((e) => e.snippet)
            .slice(0, 4)
            .map((e, i) => (
              <figure key={i} className="fc2-code">
                <code className="mono">{e.snippet}</code>
                <figcaption className="mono small faint">{where(e)}</figcaption>
              </figure>
            ))}
        </section>
      )}
      {(n.dataIn || n.dataOut) && (
        <dl className="fc2-kv">
          {n.dataIn && (
            <>
              <dt>Data in</dt>
              <dd className="mono">{n.dataIn}</dd>
            </>
          )}
          {n.dataOut && (
            <>
              <dt>Data out</dt>
              <dd className="mono">{n.dataOut}</dd>
            </>
          )}
        </dl>
      )}
      {n.tools.length > 0 && (
        <section>
          <h4>Tools</h4>
          <div className="fc2-chips">
            {n.tools.map((t) => (
              <button key={t} type="button" className="fc2-chip is-link" onClick={() => onIntelligence?.(t)} disabled={!onIntelligence}>
                <Cpu size={12} /> {toolName(t)}
              </button>
            ))}
          </div>
        </section>
      )}
      {n.members && (
        <section>
          <h4>Folded endpoints</h4>
          <ul className="fc2-members">
            {n.members.map((m, i) => (
              <li key={i}>
                <span>{m.label}</span>
                <span className="mono small faint">{where(m)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {(incoming.length > 0 || outgoing.length > 0) && (
        <section>
          <h4>Connections</h4>
          <ul className="fc2-conns">
            {incoming.map((e) => (
              <li key={e.id}>
                <button type="button" className="link-btn" onClick={() => onSelect(e.source)}>
                  ← {edgeText(e, e.source)}
                </button>
              </li>
            ))}
            {outgoing.map((e) => (
              <li key={e.id}>
                <button type="button" className="link-btn" onClick={() => onSelect(e.target)}>
                  → {edgeText(e, e.target)}
                </button>
                <span className={`fc2-edge-kind k-${e.kind}`}>{e.kind}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="fc2-insp-actions">
        {href ? (
          <a className="btn btn-sm" href={href} target="_blank" rel="noreferrer">
            <ExternalLink size={13} /> Open in Code
          </a>
        ) : (
          onWireframe && (
            <button type="button" className="btn btn-sm" onClick={() => onWireframe(n.file)} title="This project has no remote; open the file in the Wireframe">
              <ExternalLink size={13} /> Open in Code
            </button>
          )
        )}
        <button type="button" className="btn btn-sm" onClick={onFocusBranch}>
          <Crosshair size={13} /> Focus branch
        </button>
        {onWireframe && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => onWireframe(n.file)}>
            <Network size={13} /> In wireframe
          </button>
        )}
        {onArchitecture && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => onArchitecture({ focus: n.file })}>
            <Layers size={13} /> In architecture
          </button>
        )}
        {n.jumpTo && onJump && (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => onJump(n.jumpTo!)}>
            <Share2 size={13} /> Go to flow
          </button>
        )}
      </div>
    </aside>
  );
}
