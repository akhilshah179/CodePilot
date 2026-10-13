import { ArrowDown, ArrowRight, CheckCircle2, Clock, Cpu, ExternalLink, Layers, Server, ShieldCheck, Sparkles, Workflow } from 'lucide-react';
import { useState } from 'react';
import type { HeroFlow, HeroJoin, HeroStage } from '../../lib/api.ts';
import { fileOpener } from '../../lib/fileLinks.ts';

interface Props {
  heroFlow?: HeroFlow | null;
  onSelectFlow(flowId: string): void;
}

export function HeroPipelineView({ heroFlow, onSelectFlow }: Props) {
  const [selectedStageId, setSelectedStageId] = useState<string | null>(heroFlow?.stages[0]?.id ?? null);
  const [selectedJoin, setSelectedJoin] = useState<HeroJoin | null>(null);

  if (!heroFlow || !heroFlow.stages.length) {
    return (
      <div className="ae-story-empty">
        <Workflow size={32} />
        <h3>No Project Story detected</h3>
        <p>The repository execution intelligence could not establish a verified end-to-end pipeline.</p>
      </div>
    );
  }

  const allStages = [...heroFlow.stages, ...(heroFlow.backgroundStages ?? [])];
  const selectedStage = allStages.find((s) => s.id === selectedStageId) ?? heroFlow.stages[0];

  return (
    <div className="ae-story-container">
      {/* Narrative Headline */}
      <div className="ae-story-header">
        <div className="ae-story-badge">
          <Sparkles size={13} />
          <span>PROJECT STORY · LEVEL 1</span>
        </div>
        <h2 className="ae-story-title">{heroFlow.title}</h2>
        <p className="ae-story-desc">{heroFlow.description}</p>
      </div>

      {/* Main Horizontal Pipeline */}
      <div className="ae-pipeline-section">
        <div className="ae-pipeline-label">
          <Workflow size={14} />
          <span>CORE EXECUTION PIPELINE (SYNCHRONOUS FLOW)</span>
        </div>

        <div className="ae-horizontal-pipeline">
          {heroFlow.stages.map((stage, idx) => {
            const isSelected = selectedStage?.id === stage.id;
            const join = stage.joinWithNext;

            return (
              <div key={stage.id} className="ae-pipeline-step-wrapper">
                {/* Stage Card */}
                <div
                  className={`ae-stage-card ${isSelected ? 'is-selected' : ''}`}
                  onClick={() => {
                    setSelectedStageId(stage.id);
                    setSelectedJoin(null);
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <div className="ae-stage-header">
                    <span className="ae-stage-num">0{idx + 1}</span>
                    <span className="ae-stage-steps-count">{stage.subStepsCount} steps</span>
                  </div>
                  <h4 className="ae-stage-name">{stage.title}</h4>
                  <div className="ae-stage-trigger" title={stage.trigger}>
                    <code>{stage.trigger}</code>
                  </div>
                  {stage.technology && (
                    <div className="ae-stage-tech">
                      <Cpu size={11} />
                      <span>{stage.technology}</span>
                    </div>
                  )}
                  <button
                    className="ae-stage-inspect-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectFlow(stage.flowId);
                    }}
                    title="Inspect complete source-traced execution path"
                  >
                    <span>Inspect Canvas</span>
                    <ExternalLink size={11} />
                  </button>
                </div>

                {/* Join Connector Arrow */}
                {idx < heroFlow.stages.length - 1 && (
                  <div className="ae-join-connector">
                    <button
                      className={`ae-join-badge ${join ? `rel-${join.relationshipType}` : ''}`}
                      onClick={() => {
                        if (join) setSelectedJoin(join);
                      }}
                      title={join ? `${join.relationshipType}: ${join.explanation}` : 'Sequential pipeline transition'}
                    >
                      <span className="ae-join-text">
                        {join?.relationshipType === 'route-param-reuse'
                          ? 'PARAM REUSE'
                          : join?.relationshipType === 'navigation-call'
                            ? 'NAVIGATION'
                            : join?.relationshipType === 'function-call'
                              ? 'CALL'
                              : 'PROVEN LINK'}
                      </span>
                      <ArrowRight size={13} className="ae-join-icon" />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Async Background Execution Branch */}
      {heroFlow.backgroundStages && heroFlow.backgroundStages.length > 0 && (
        <div className="ae-background-branch-section">
          <div className="ae-branch-stem">
            <div className="ae-branch-line-v" />
            <div className="ae-branch-marker">
              <ArrowDown size={14} />
              <span>ASYNC — DOES NOT BLOCK RESPONSE</span>
            </div>
          </div>

          <div className="ae-background-pipeline">
            {heroFlow.backgroundStages.map((bg, bIdx) => {
              const isSelected = selectedStage?.id === bg.id;
              return (
                <div key={bg.id} className="ae-pipeline-step-wrapper">
                  <div
                    className={`ae-stage-card is-background ${isSelected ? 'is-selected' : ''}`}
                    onClick={() => {
                      setSelectedStageId(bg.id);
                      setSelectedJoin(null);
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    <div className="ae-stage-header">
                      <span className="ae-stage-num bg-num">WORKER 0{bIdx + 1}</span>
                      <span className="ae-stage-steps-count">{bg.subStepsCount} ops</span>
                    </div>
                    <h4 className="ae-stage-name">{bg.title}</h4>
                    <div className="ae-stage-trigger" title={bg.trigger}>
                      <code>{bg.trigger}</code>
                    </div>
                    {bg.technology && (
                      <div className="ae-stage-tech">
                        <Server size={11} />
                        <span>{bg.technology}</span>
                      </div>
                    )}
                    <button
                      className="ae-stage-inspect-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectFlow(bg.flowId);
                      }}
                      title="Inspect worker execution"
                    >
                      <span>Inspect Canvas</span>
                      <ExternalLink size={11} />
                    </button>
                  </div>
                  {bIdx < heroFlow.backgroundStages.length - 1 && (
                    <div className="ae-join-connector">
                      <div className="ae-bg-arrow">
                        <ArrowRight size={14} />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Selected Join Details Popover / Box */}
      {selectedJoin && (
        <div className="ae-join-details-box">
          <div className="ae-join-box-header">
            <div className="ae-join-title">
              <ShieldCheck size={14} className="ae-join-ok-icon" />
              <span>
                PROVEN RELATIONSHIP:{' '}
                <strong>{selectedJoin.relationshipType.replace(/-/g, ' ').toUpperCase()}</strong>
              </span>
            </div>
            <button className="ae-close-btn" onClick={() => setSelectedJoin(null)}>
              ×
            </button>
          </div>
          <p className="ae-join-explanation">{selectedJoin.explanation}</p>
          <div className="ae-join-locations">
            <span>Source: <code>{selectedJoin.sourceFile}{selectedJoin.sourceLine ? `:${selectedJoin.sourceLine}` : ''}</code></span>
            <span>Target: <code>{selectedJoin.targetFile}{selectedJoin.targetLine ? `:${selectedJoin.targetLine}` : ''}</code></span>
          </div>
        </div>
      )}

      {/* Active Stage Detail Card */}
      {selectedStage && !selectedJoin && (
        <div className="ae-active-stage-inspector">
          <div className="ae-inspector-top">
            <div>
              <div className="ae-inspector-tag">
                {selectedStage.isBackground ? 'BACKGROUND WORKER STAGE' : `STAGE ${selectedStage.stageIndex}`}
              </div>
              <h3 className="ae-inspector-title">{selectedStage.title}</h3>
            </div>
            <button className="btn-primary" onClick={() => onSelectFlow(selectedStage.flowId)}>
              <span>Open Detailed Canvas</span>
              <ExternalLink size={13} />
            </button>
          </div>

          <div className="ae-inspector-grid">
            <div className="ae-inspector-col">
              <label>TRIGGER & ENTRY POINT</label>
              <code>{selectedStage.trigger}</code>
            </div>
            <div className="ae-inspector-col">
              <label>PRIMARY TECHNOLOGY / ENGINE</label>
              <div className="ae-inspector-tech-pill">
                <Cpu size={12} />
                <span>{selectedStage.technology ?? 'Repository Component'}</span>
              </div>
            </div>
            {selectedStage.subStepsSummary && (
              <div className="ae-inspector-col full-w">
                <label>INTERNAL EXECUTION STEPS</label>
                <div className="ae-substeps-list">
                  {selectedStage.subStepsSummary.map((sub, i) => (
                    <div key={i} className="ae-substep-item">
                      <span className="ae-step-bullet">›</span>
                      <span>{sub}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {selectedStage.evidence.length > 0 && (
              <div className="ae-inspector-col full-w">
                <label>SOURCE EVIDENCE CITATIONS ({selectedStage.evidence.length})</label>
                <div className="ae-evidence-tags">
                  {selectedStage.evidence.map((ev, i) => (
                    <span key={i} className="ae-ev-pill">
                      {ev}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
