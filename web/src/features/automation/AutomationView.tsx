import {
  ArrowRightLeft,
  Check,
  CheckCircle2,
  Cpu,
  Edit2,
  ExternalLink,
  Info,
  Layers,
  ShieldCheck,
  Sparkles,
  Workflow,
  Wrench,
  X,
} from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { ConfidenceBadge, ErrorNotice } from '../../components/ui.tsx';
import {
  data,
  type AutomationCoverageV4,
  type DataSource,
  type FlowNode,
  type FlowV4,
  type GlobalMiddleware,
  type Project,
} from '../../lib/api.ts';
import { useAsync } from '../../lib/hooks.ts';
import { CoverageDisclosureModal } from './CoverageDisclosureModal.tsx';
import { FlowExplanationPanelV4 } from './FlowExplanationPanelV4.tsx';
import { FlowchartCanvas } from './FlowchartCanvas.tsx';
import { NodeInspector } from './NodeInspector.tsx';
import { SwapFlowModal } from './SwapFlowModal.tsx';

interface Props {
  src: DataSource;
  project: Project;
  projectId?: string;
  focusFlow?: string;
  initialQuery?: string;
  onWireframe?(path: string): void;
  onArchitecture?(target: { flow?: string; focus?: string; tech?: string }): void;
  onIntelligence?(tech: string): void;
}

export function AutomationView({
  src,
  project,
  focusFlow,
  onArchitecture,
}: Props) {
  // Fetch v4 automation flows
  const req = useAsync(() => data.automationFlowsV4(src), [src.base]);
  const [flows, setFlows] = useState<FlowV4[]>([]);
  const [coverage, setCoverage] = useState<AutomationCoverageV4 | null>(null);
  const [globalMiddleware, setGlobalMiddleware] = useState<GlobalMiddleware | null>(null);

  const [selectedFlowId, setSelectedFlowId] = useState<string>('');
  const [selectedNode, setSelectedNode] = useState<FlowNode | null>(null);

  // Rename state
  const [editingFlowId, setEditingFlowId] = useState<string | null>(null);
  const [editNameText, setEditNameText] = useState<string>('');
  const [renameError, setRenameError] = useState<string | null>(null);

  // Swap modal state
  const [swapModalFlow, setSwapModalFlow] = useState<FlowV4 | null>(null);

  // Coverage modal state
  const [showCoverageModal, setShowCoverageModal] = useState(false);

  // Global middleware strip inline toggle
  const [showMiddlewareInline, setShowMiddlewareInline] = useState(false);

  // Sync data from async response
  useEffect(() => {
    if (req.data) {
      setFlows(req.data.flows || []);
      setCoverage(req.data.coverage || null);
      setGlobalMiddleware(req.data.globalMiddleware || null);

      if (!selectedFlowId || !req.data.flows.some((f) => f.id === selectedFlowId)) {
        const preferred = focusFlow && req.data.flows.find((f) => f.id === focusFlow);
        setSelectedFlowId(preferred ? preferred.id : req.data.flows[0]?.id ?? '');
      }
    }
  }, [req.data, focusFlow]);

  // Reset selected node when switching flow
  useEffect(() => {
    setSelectedNode(null);
  }, [selectedFlowId]);

  if (req.loading && flows.length === 0) {
    return (
      <div className="aev3-loading">
        <Workflow className="aev3-spin-icon" size={28} />
        <p>Synthesizing main automation flowcharts from code AST...</p>
      </div>
    );
  }

  if (req.error && flows.length === 0) {
    return (
      <div className="view-pad narrow">
        <ErrorNotice error={req.error} onRetry={req.reload} />
      </div>
    );
  }

  if (flows.length === 0) {
    return (
      <div className="aev3-empty-state">
        <Workflow size={32} />
        <h3>No automation flows detected</h3>
        <p>No traced entry points or client handlers were detected for this project.</p>
      </div>
    );
  }

  const currentFlow = flows.find((f) => f.id === selectedFlowId) || flows[0];

  const handleStartRename = (flow: FlowV4, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingFlowId(flow.id);
    setEditNameText(flow.name);
    setRenameError(null);
  };

  const handleSaveRename = async (flowId: string) => {
    if (!editNameText.trim()) return;
    try {
      const res = await data.renameAutomationFlowV4(src, flowId, editNameText.trim());
      if (res.flows) {
        setFlows(res.flows);
      }
      setEditingFlowId(null);
    } catch (err: unknown) {
      setRenameError(err instanceof Error ? err.message : 'Failed to rename flow');
    }
  };

  const handleCancelRename = () => {
    setEditingFlowId(null);
    setEditNameText('');
    setRenameError(null);
  };

  const handleSwapFlow = async (replacementFlowId: string) => {
    if (!swapModalFlow) return;
    try {
      const res = await data.replaceAutomationFlowV4(src, swapModalFlow.id, replacementFlowId);
      if (res.flows) {
        setFlows(res.flows);
        setSelectedFlowId(replacementFlowId);
      }
      setSwapModalFlow(null);
    } catch (err: unknown) {
      console.error('Failed to swap flow:', err);
    }
  };

  const handleJumpToFlow = (flowName: string) => {
    const target = flows.find((f) => f.name.toLowerCase().includes(flowName.toLowerCase()));
    if (target) {
      setSelectedFlowId(target.id);
    }
  };

  return (
    <div className="aev3-wrapper aev4-wrapper">
      {/* 1. Header & Navigation Tabs (At most 4 main flows, never padded) */}
      <header className="aev3-header">
        <div className="aev3-header-top">
          <div className="aev3-title-block">
            <h2 className="aev3-page-title">Automation Engine v4</h2>
            <span className="aev3-page-subtitle">
              True Flowcharts of Main Flows · Triggers, Decision Diamonds & Connected Paths
            </span>
          </div>

          <div className="aev3-header-meta">
            <span className="aev3-badge-counter">
              Showing {flows.length} main {flows.length === 1 ? 'flow' : 'flows'}
            </span>
          </div>
        </div>

        {/* Global Middleware Strip */}
        {globalMiddleware && globalMiddleware.steps.length > 0 && (
          <div className="aev4-middleware-strip">
            <div className="aev4-middleware-label">
              <ShieldCheck size={13} className="aev4-shield-icon" />
              <span>EVERY REQUEST PASSES THROUGH:</span>
            </div>
            <div className="aev4-middleware-steps">
              {globalMiddleware.steps.map((step, idx) => (
                <React.Fragment key={idx}>
                  <div className="aev4-middleware-pill" title={`${step.file}:${step.line}`}>
                    <span>{step.name}</span>
                    <code>{step.file.split('/').pop()}</code>
                  </div>
                  {idx < globalMiddleware.steps.length - 1 && (
                    <span className="aev4-middleware-arrow">→</span>
                  )}
                </React.Fragment>
              ))}
            </div>
            <button
              type="button"
              className={`aev4-middleware-toggle ${showMiddlewareInline ? 'active' : ''}`}
              onClick={() => setShowMiddlewareInline(!showMiddlewareInline)}
            >
              {showMiddlewareInline ? 'Hide inline' : 'Show inline'}
            </button>
          </div>
        )}

        {/* The Up-To-Four Flow Cards Across Top */}
        <div className="aev3-tabs-grid" role="tablist">
          {flows.map((f, index) => {
            const isSelected = f.id === currentFlow.id;
            const isEditing = editingFlowId === f.id;

            return (
              <div
                key={f.id}
                role="tab"
                aria-selected={isSelected}
                tabIndex={0}
                className={`aev3-flow-card ${isSelected ? 'is-selected' : ''}`}
                onClick={() => setSelectedFlowId(f.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelectedFlowId(f.id);
                  }
                }}
              >
                <div className="aev3-card-top">
                  <div className="aev3-card-index">0{index + 1}</div>

                  <div className="aev3-card-actions">
                    <button
                      type="button"
                      className="aev3-card-action-btn"
                      onClick={(e) => handleStartRename(f, e)}
                      title="Rename flow"
                      aria-label="Rename flow"
                    >
                      <Edit2 size={12} />
                    </button>
                    {f.allCandidates && f.allCandidates.length > 1 && (
                      <button
                        type="button"
                        className="aev3-card-action-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSwapModalFlow(f);
                        }}
                        title="Swap with another candidate flow"
                        aria-label="Swap flow"
                      >
                        <ArrowRightLeft size={12} />
                      </button>
                    )}
                  </div>
                </div>

                {/* Flow Name / Inline Edit */}
                {isEditing ? (
                  <div className="aev3-inline-rename" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="text"
                      className="aev3-rename-input"
                      value={editNameText}
                      autoFocus
                      onChange={(e) => setEditNameText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSaveRename(f.id);
                        if (e.key === 'Escape') handleCancelRename();
                      }}
                    />
                    <div className="aev3-rename-btns">
                      <button
                        type="button"
                        className="aev3-rename-confirm"
                        onClick={() => handleSaveRename(f.id)}
                        title="Save name"
                      >
                        <Check size={12} />
                      </button>
                      <button
                        type="button"
                        className="aev3-rename-cancel"
                        onClick={handleCancelRename}
                        title="Cancel"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  </div>
                ) : (
                  <h3 className="aev3-flow-name" title={f.name}>
                    {f.name}
                  </h3>
                )}

                {renameError && isEditing && (
                  <div className="aev3-rename-error">{renameError}</div>
                )}

                {/* Purpose Line */}
                <p className="aev3-flow-purpose-line" title={f.purpose || f.summary.whatItDoes}>
                  {f.purpose || f.summary.whatItDoes}
                </p>

                {/* Card Bottom: Node count & Union of Tools */}
                <div className="aev3-card-bottom">
                  <span className="aev3-step-count-pill">
                    {f.nodes.length} nodes
                  </span>

                  {f.tools.length > 0 && (
                    <div className="aev3-tools-chips-row">
                      {f.tools.slice(0, 3).map((tool) => (
                        <span key={tool} className="aev3-tool-chip">
                          {tool}
                        </span>
                      ))}
                      {f.tools.length > 3 && (
                        <span className="aev3-tool-chip more">
                          +{f.tools.length - 3}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* 2. Strict Arithmetic Coverage Line */}
        {coverage && (
          <div
            className="aev3-coverage-line"
            onClick={() => setShowCoverageModal(true)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setShowCoverageModal(true);
            }}
          >
            <div className="aev3-coverage-text">
              <CheckCircle2 size={14} className="aev3-coverage-icon" />
              <span>
                <strong>{coverage.totalEntryPoints} entry points total:</strong>{' '}
                {coverage.shownCount} shown in flows, {coverage.foldedCount} folded (listed),{' '}
                {coverage.omittedCount} omitted (listed).
              </span>
            </div>
            <button type="button" className="aev3-coverage-expand-btn">
              <span>View full breakdown</span>
              <ExternalLink size={12} />
            </button>
          </div>
        )}
      </header>

      {/* 3. Main Workspace: Flowchart Canvas (Left ~65%) and Explanation/Inspector (Right ~35%) */}
      <main className="aev3-workspace">
        <section className="aev3-diagram-column aev4-canvas-col" aria-label="Interactive Flowchart Canvas">
          <FlowchartCanvas
            flow={currentFlow}
            selectedNodeId={selectedNode?.id}
            onSelectNode={(node) => setSelectedNode(node)}
            onJumpToFlow={handleJumpToFlow}
          />
        </section>

        <section className="aev3-explanation-column" aria-label="Flow Inspector & Explanation">
          {selectedNode ? (
            <NodeInspector
              node={selectedNode}
              flow={currentFlow}
              onClose={() => setSelectedNode(null)}
              onNavigateToCode={(file, line) => {
                if (onArchitecture) {
                  onArchitecture({ focus: `${file}:${line || 1}` });
                }
              }}
            />
          ) : (
            <FlowExplanationPanelV4
              project={project}
              flow={currentFlow}
              selectedNode={selectedNode}
              onSelectNode={(node) => setSelectedNode(node)}
              onOpenCode={(file, line) => {
                if (onArchitecture) {
                  onArchitecture({ focus: `${file}:${line || 1}` });
                }
              }}
            />
          )}
        </section>
      </main>

      {/* Coverage Disclosure Modal */}
      {showCoverageModal && coverage && (
        <CoverageDisclosureModal
          coverage={coverage}
          onClose={() => setShowCoverageModal(false)}
        />
      )}

      {/* Swap Flow Modal */}
      {swapModalFlow && swapModalFlow.allCandidates && (
        <SwapFlowModal
          currentFlow={swapModalFlow}
          candidates={swapModalFlow.allCandidates}
          onSwap={handleSwapFlow}
          onClose={() => setSwapModalFlow(null)}
        />
      )}
    </div>
  );
}
