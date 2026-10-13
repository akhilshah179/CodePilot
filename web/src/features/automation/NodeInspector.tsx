import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  CheckCircle2,
  Code,
  CornerDownRight,
  Database,
  ExternalLink,
  FileCode,
  GitBranch,
  HelpCircle,
  Layers,
  MousePointer,
  Play,
  Server,
  Wrench,
  X,
} from 'lucide-react';
import React from 'react';
import type { FlowEdge, FlowNode, FlowV4 } from '../../lib/api.ts';

interface NodeInspectorProps {
  node: FlowNode;
  flow: FlowV4;
  onClose: () => void;
  onNavigateToCode?: (file: string, line?: number) => void;
}

export function NodeInspector({
  node,
  flow,
  onClose,
  onNavigateToCode,
}: NodeInspectorProps) {
  const inEdges = flow.edges.filter((e) => e.target === node.id);
  const outEdges = flow.edges.filter((e) => e.source === node.id);

  const getBadgeColor = () => {
    switch (node.type) {
      case 'trigger':
        return '#10b981';
      case 'ui_step':
        return '#0ea5e9';
      case 'request':
        return '#06b6d4';
      case 'server_step':
        return '#6366f1';
      case 'decision':
        return '#f59e0b';
      case 'data_store':
        return '#14b8a6';
      case 'external_service':
        return '#a855f7';
      case 'background_job':
        return '#f97316';
      case 'end':
        return '#10b981';
      case 'jump':
        return '#3b82f6';
      case 'unknown':
      default:
        return '#ef4444';
    }
  };

  return (
    <div className="node-inspector-drawer">
      <div className="node-inspector-header">
        <div className="node-inspector-title-group">
          <span
            className="node-inspector-type-badge"
            style={{ backgroundColor: `${getBadgeColor()}20`, color: getBadgeColor(), borderColor: getBadgeColor() }}
          >
            {node.type.replace('_', ' ').toUpperCase()}
          </span>
          <span className="node-inspector-lane-badge">
            {node.lane.toUpperCase()} LANE
          </span>
        </div>
        <button
          type="button"
          className="node-inspector-close-btn"
          onClick={onClose}
          aria-label="Close Inspector"
        >
          <X size={16} />
        </button>
      </div>

      <div className="node-inspector-body">
        <h3 className="node-inspector-node-title">{node.label}</h3>

        {/* Tooltip & Purpose */}
        {node.tooltip && (
          <div className="node-inspector-section">
            <div className="node-inspector-section-label">Explanation</div>
            <p className="node-inspector-text">{node.tooltip}</p>
          </div>
        )}

        {/* File : Line Citation */}
        <div className="node-inspector-section">
          <div className="node-inspector-section-label">Source Citation</div>
          <div className="node-inspector-cite-card">
            <FileCode size={14} className="node-inspector-cite-icon" />
            <span className="node-inspector-file-path">
              {node.file}:{node.line ?? 1}
            </span>
            {onNavigateToCode && (
              <button
                type="button"
                className="node-inspector-open-code-btn"
                onClick={() => onNavigateToCode(node.file, node.line)}
                title="Open in Code View"
              >
                <span>View Code</span>
                <ExternalLink size={12} />
              </button>
            )}
          </div>
        </div>

        {/* Code Snippet / AST Expression */}
        {node.decisionExpr ? (
          <div className="node-inspector-section">
            <div className="node-inspector-section-label">Decision Condition (AST)</div>
            <pre className="node-inspector-code-block">
              <code>{node.decisionExpr}</code>
            </pre>
            {node.decisionOutcomes && (
              <div className="node-inspector-outcomes-list">
                {node.decisionOutcomes.map((outcome, idx) => (
                  <div key={idx} className="node-inspector-outcome-pill">
                    <GitBranch size={12} />
                    <span>{outcome}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}

        {/* Data In & Data Out (Payload Moving Along Edges) */}
        <div className="node-inspector-section">
          <div className="node-inspector-section-label">Data In / Out Flow</div>
          <div className="node-inspector-io-grid">
            <div className="node-inspector-io-col">
              <div className="node-inspector-io-header in">
                <ArrowDown size={12} />
                <span>Payload In</span>
              </div>
              {inEdges.length > 0 ? (
                inEdges.map((e) => (
                  <div key={e.id} className="node-inspector-io-item">
                    <span className="node-inspector-payload-name">{e.label || 'Direct call'}</span>
                  </div>
                ))
              ) : (
                <span className="node-inspector-io-empty">Flow entry trigger</span>
              )}
            </div>

            <div className="node-inspector-io-col">
              <div className="node-inspector-io-header out">
                <ArrowUp size={12} />
                <span>Payload Out</span>
              </div>
              {outEdges.length > 0 ? (
                outEdges.map((e) => (
                  <div key={e.id} className="node-inspector-io-item">
                    <span className="node-inspector-payload-name">{e.label || 'Direct sequence'}</span>
                  </div>
                ))
              ) : (
                <span className="node-inspector-io-empty">Terminal state</span>
              )}
            </div>
          </div>
        </div>

        {/* Tools Used on Node */}
        <div className="node-inspector-section">
          <div className="node-inspector-section-label">Technologies Used on Node</div>
          {node.tools.length > 0 ? (
            <div className="node-inspector-tools-chips">
              {node.tools.map((t) => (
                <span key={t} className="node-inspector-tool-chip">
                  <Wrench size={11} />
                  <span>{t}</span>
                </span>
              ))}
            </div>
          ) : (
            <span className="node-inspector-io-empty">Native project runtime</span>
          )}
        </div>

        {/* Unknown Step Reason */}
        {node.unknownReason && (
          <div className="node-inspector-section warning">
            <div className="node-inspector-section-label">Trace Gap Reason</div>
            <p className="node-inspector-warn-text">
              <AlertTriangle size={13} />
              <span>{node.unknownReason}</span>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
