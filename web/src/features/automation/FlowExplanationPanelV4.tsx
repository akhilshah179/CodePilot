import {
  AlertCircle,
  AlertOctagon,
  ArrowRight,
  ArrowRightLeft,
  CheckCircle2,
  Clock,
  CornerDownRight,
  Cpu,
  Database,
  ExternalLink,
  FileCode,
  GitBranch,
  HelpCircle,
  Info,
  Layers,
  MousePointer,
  Play,
  Server,
  ShieldCheck,
  Sparkles,
  Wrench,
} from 'lucide-react';
import React from 'react';
import type { FlowNode, FlowV4, Project } from '../../lib/api.ts';
import { fileOpener } from '../../lib/fileLinks.ts';

interface FlowExplanationPanelV4Props {
  project: Project;
  commitSha?: string | null;
  flow: FlowV4;
  selectedNode: FlowNode | null;
  onSelectNode: (node: FlowNode | null) => void;
  onOpenCode?: (file: string, line?: number) => void;
}

export function FlowExplanationPanelV4({
  project,
  commitSha,
  flow,
  selectedNode,
  onSelectNode,
  onOpenCode,
}: FlowExplanationPanelV4Props) {
  const opener = fileOpener(project, commitSha ?? null);
  const openCode = (path: string, line?: number) => {
    if (onOpenCode) {
      onOpenCode(path, line);
      return;
    }
    const href = opener.href(path, line);
    if (href) window.open(href, '_blank', 'noreferrer');
  };

  const decisionNodes = flow.nodes.filter((n) => n.type === 'decision');
  const jumpNodes = flow.nodes.filter((n) => n.type === 'jump');
  const externalNodes = flow.nodes.filter((n) => n.type === 'external_service');

  return (
    <aside className="aev4-explanation-panel" aria-label="Flow Explanation">
      {/* Panel Header */}
      <div className="aev4-panel-header">
        <div className="aev4-tag-row">
          <span className="aev4-tag">
            <Sparkles size={12} />
            <span>FLOWCHART EXPLANATION</span>
          </span>
          <span className="aev4-node-count-badge">
            {flow.nodes.length} nodes · {flow.edges.length} connections
          </span>
        </div>
        <h3 className="aev4-flow-title">{flow.name}</h3>
        <p className="aev4-flow-purpose">{flow.purpose || flow.summary.whatItDoes}</p>
      </div>

      <div className="aev4-panel-content">
        {/* 1. What it does */}
        <section className="aev4-section">
          <h4 className="aev4-section-heading">What it does</h4>
          <p className="aev4-section-text">{flow.summary.whatItDoes}</p>
        </section>

        {/* 2. Data that moves through it */}
        <section className="aev4-section">
          <h4 className="aev4-section-heading">Data Moving Through Flow</h4>
          <div className="aev4-data-moving-card">
            <ArrowRightLeft size={14} className="aev4-data-icon" />
            <p className="aev4-data-text">{flow.summary.dataMoving}</p>
          </div>
        </section>

        {/* 3. What happens on failure */}
        <section className="aev4-section">
          <h4 className="aev4-section-heading">Failure Handling</h4>
          <div className="aev4-failure-card">
            <AlertCircle size={14} className="aev4-failure-icon" />
            <p className="aev4-failure-text">{flow.summary.failureHandling}</p>
          </div>
        </section>

        {/* 4. Why it exists (ONLY if supported by evidence) */}
        {flow.summary.whyItExists && (
          <section className="aev4-section">
            <h4 className="aev4-section-heading">Why it exists</h4>
            <p className="aev4-section-text">{flow.summary.whyItExists}</p>
          </section>
        )}

        {/* 5. Tool chips: strictly computed union of tools across nodes in THIS flow */}
        <section className="aev4-section">
          <div className="aev4-section-header-split">
            <h4 className="aev4-section-heading">Technologies Involved</h4>
            <span className="aev4-subtle-count">{flow.tools.length} detected</span>
          </div>
          {flow.tools.length > 0 ? (
            <div className="aev4-tools-union-grid">
              {flow.tools.map((tool) => (
                <div key={tool} className="aev4-tool-chip-badge">
                  <Wrench size={12} />
                  <span>{tool}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="aev4-empty-hint">Standard core runtime without external dependencies.</p>
          )}
        </section>

        {/* 6. Control Flow Decisions (Diamonds) */}
        {decisionNodes.length > 0 && (
          <section className="aev4-section">
            <div className="aev4-section-header-split">
              <h4 className="aev4-section-heading">Condition Diamonds</h4>
              <span className="aev4-subtle-count">{decisionNodes.length} branches</span>
            </div>
            <div className="aev4-decisions-list">
              {decisionNodes.map((dn) => (
                <div
                  key={dn.id}
                  className={`aev4-decision-item ${selectedNode?.id === dn.id ? 'active' : ''}`}
                  onClick={() => onSelectNode(dn)}
                >
                  <div className="aev4-decision-top">
                    <GitBranch size={13} className="aev4-decision-icon" />
                    <span className="aev4-decision-label">{dn.label}</span>
                  </div>
                  {dn.decisionExpr && (
                    <code className="aev4-decision-code">{dn.decisionExpr}</code>
                  )}
                  <div className="aev4-decision-cite">
                    <span>{dn.file}:{dn.line}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* 7. Flowchart Legend (Distinct Shapes, Icons & Colors) */}
        <section className="aev4-section legend">
          <h4 className="aev4-section-heading">Flowchart Legend</h4>
          <div className="aev4-legend-grid">
            <div className="aev4-legend-item">
              <div className="legend-shape pill trigger">
                <Play size={10} />
              </div>
              <span className="legend-label">Trigger (Start)</span>
            </div>

            <div className="aev4-legend-item">
              <div className="legend-shape box ui">
                <MousePointer size={10} />
              </div>
              <span className="legend-label">UI Step</span>
            </div>

            <div className="aev4-legend-item">
              <div className="legend-shape box req">
                <ArrowRight size={10} />
              </div>
              <span className="legend-label">HTTP Request</span>
            </div>

            <div className="aev4-legend-item">
              <div className="legend-shape box server">
                <Server size={10} />
              </div>
              <span className="legend-label">Server Step</span>
            </div>

            <div className="aev4-legend-item">
              <div className="legend-shape diamond">
                <HelpCircle size={10} />
              </div>
              <span className="legend-label">Decision Diamond</span>
            </div>

            <div className="aev4-legend-item">
              <div className="legend-shape cylinder">
                <Database size={10} />
              </div>
              <span className="legend-label">Data Store</span>
            </div>

            <div className="aev4-legend-item">
              <div className="legend-shape hexagon">
                <ExternalLink size={10} />
              </div>
              <span className="legend-label">External Service</span>
            </div>

            <div className="aev4-legend-item">
              <div className="legend-shape dashed bg">
                <Clock size={10} />
              </div>
              <span className="legend-label">Background Job</span>
            </div>

            <div className="aev4-legend-item">
              <div className="legend-shape pill end">
                <CheckCircle2 size={10} />
              </div>
              <span className="legend-label">Outcome / End</span>
            </div>

            <div className="aev4-legend-item">
              <div className="legend-shape pill jump">
                <CornerDownRight size={10} />
              </div>
              <span className="legend-label">Jump to Flow</span>
            </div>

            <div className="aev4-legend-item">
              <div className="legend-shape dashed unknown">
                <AlertOctagon size={10} />
              </div>
              <span className="legend-label">Unknown Step</span>
            </div>
          </div>
        </section>
      </div>
    </aside>
  );
}
