import {
  AlertCircle,
  ArrowDown,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Cpu,
  ExternalLink,
  FastForward,
  GitBranch,
  HelpCircle,
  Pause,
  Play,
  RotateCcw,
  ShieldCheck,
  SkipBack,
  SkipForward,
  Workflow,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { GlobalMiddleware, MainFlow, MainFlowJoin, MainFlowStage, Project } from '../../lib/api.ts';
import { fileOpener } from '../../lib/fileLinks.ts';

interface Props {
  project: Project;
  commitSha?: string | null;
  flow: MainFlow;
  globalMiddleware?: GlobalMiddleware;
  activeStageIndex: number;
  onSelectStage(stageIndex: number | ((prev: number) => number)): void;
}

const SPEEDS = [0.5, 1, 2] as const;

export function MainFlowPipeline({
  project,
  commitSha,
  flow,
  globalMiddleware,
  activeStageIndex,
  onSelectStage,
}: Props) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
  const [showInlineMiddleware, setShowInlineMiddleware] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const opener = fileOpener(project, commitSha ?? null);
  const openCode = (path: string, line?: number) => {
    const href = opener.href(path, line);
    if (href) window.open(href, '_blank', 'noreferrer');
  };

  const foregroundStages = flow.stages;
  const backgroundStages = flow.backgroundStages ?? [];
  const allStages = [...foregroundStages, ...backgroundStages];

  // Detect system reduced motion preference
  useEffect(() => {
    if (typeof window !== 'undefined' && window.matchMedia) {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      setPrefersReducedMotion(mq.matches);
      const listener = (e: MediaQueryListEvent) => setPrefersReducedMotion(e.matches);
      mq.addEventListener('change', listener);
      return () => mq.removeEventListener('change', listener);
    }
  }, []);

  // Playback timer
  useEffect(() => {
    if (!isPlaying) {
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }

    if (prefersReducedMotion) {
      // Reduced motion: step-through only, pause autoplay
      setIsPlaying(false);
      return;
    }

    const intervalMs = Math.round(1800 / speed);
    timerRef.current = setInterval(() => {
      onSelectStage((prev) => {
        const next = prev + 1;
        if (next >= allStages.length) {
          setIsPlaying(false);
          return 0;
        }
        return next;
      });
    }, intervalMs);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isPlaying, speed, allStages.length, prefersReducedMotion, onSelectStage]);

  const handleStepBack = () => {
    setIsPlaying(false);
    onSelectStage((prev) => Math.max(0, prev - 1));
  };

  const handleStepForward = () => {
    setIsPlaying(false);
    onSelectStage((prev) => Math.min(allStages.length - 1, prev + 1));
  };

  const handleReset = () => {
    setIsPlaying(false);
    onSelectStage(0);
  };

  const activeStage = allStages[activeStageIndex] ?? allStages[0];

  return (
    <div className="aev3-diagram-column" aria-label="Horizontal pipeline diagram">
      {/* 1. Global Middleware Strip */}
      {globalMiddleware && globalMiddleware.steps.length > 0 && (
        <div className="aev3-mw-strip" role="region" aria-label="Global middleware">
          <div className="aev3-mw-head">
            <div className="aev3-mw-tag">
              <ShieldCheck size={13} className="aev3-mw-icon" />
              <span>EVERY REQUEST PASSES THROUGH:</span>
            </div>
            <div className="aev3-mw-items">
              {globalMiddleware.steps.map((mw) => (
                <span key={mw.id} className="aev3-mw-pill" title={mw.explanation}>
                  {mw.name}
                </span>
              ))}
            </div>
            <button
              type="button"
              className="aev3-mw-toggle-btn"
              onClick={() => setShowInlineMiddleware(!showInlineMiddleware)}
              title="Toggle detailed middleware chain"
            >
              <span>{showInlineMiddleware ? 'Hide inline' : 'Show inline'}</span>
              {showInlineMiddleware ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
          </div>

          {showInlineMiddleware && (
            <div className="aev3-mw-inline-tray">
              {globalMiddleware.steps.map((mw) => (
                <div key={mw.id} className="aev3-mw-card">
                  <div className="aev3-mw-card-title">{mw.name}</div>
                  <div className="aev3-mw-card-desc">{mw.explanation}</div>
                  <button
                    type="button"
                    className="aev3-file-link small"
                    onClick={() => openCode(mw.file, mw.line)}
                  >
                    <code>
                      {mw.file.split('/').slice(-2).join('/')}:{mw.line}
                    </code>
                    <ExternalLink size={9} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 2. Playback Control Bar */}
      <div className="aev3-playback-bar" role="toolbar" aria-label="Pipeline playback controls">
        <div className="aev3-playback-left">
          <button
            type="button"
            className="aev3-play-btn"
            onClick={() => setIsPlaying(!isPlaying)}
            aria-label={isPlaying ? 'Pause execution playback' : 'Play execution playback'}
            title={isPlaying ? 'Pause playback' : 'Play stage-by-stage execution'}
          >
            {isPlaying ? <Pause size={14} /> : <Play size={14} />}
            <span>{isPlaying ? 'Pause' : 'Play'}</span>
          </button>

          <button
            type="button"
            className="aev3-icon-btn"
            onClick={handleStepBack}
            disabled={activeStageIndex <= 0}
            aria-label="Previous stage"
            title="Step backward"
          >
            <SkipBack size={13} />
          </button>

          <button
            type="button"
            className="aev3-icon-btn"
            onClick={handleStepForward}
            disabled={activeStageIndex >= allStages.length - 1}
            aria-label="Next stage"
            title="Step forward"
          >
            <SkipForward size={13} />
          </button>

          <button
            type="button"
            className="aev3-icon-btn"
            onClick={handleReset}
            aria-label="Reset to start"
            title="Reset to stage 1"
          >
            <RotateCcw size={13} />
          </button>
        </div>

        <div className="aev3-playback-center">
          <div className="aev3-stage-indicator">
            <span className="aev3-indicator-dot" />
            <span className="aev3-indicator-label">
              Stage {String(activeStageIndex + 1).padStart(2, '0')} of {String(allStages.length).padStart(2, '0')}:
            </span>
            <span className="aev3-indicator-name">{activeStage?.title}</span>
          </div>

          <div className="aev3-progress-track">
            <div
              className="aev3-progress-fill"
              style={{
                width: `${allStages.length > 1 ? (activeStageIndex / (allStages.length - 1)) * 100 : 100}%`,
              }}
            />
          </div>
        </div>

        <div className="aev3-playback-right">
          <div className="aev3-speed-segmented" role="group" aria-label="Playback speed">
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                className={`aev3-speed-btn ${speed === s ? 'is-active' : ''}`}
                onClick={() => setSpeed(s)}
              >
                {s}x
              </button>
            ))}
          </div>

          {prefersReducedMotion && (
            <span className="aev3-reduced-badge" title="Reduced motion active: manual step-through enabled">
              Step-only
            </span>
          )}
        </div>
      </div>

      {/* 3. Horizontal Pipeline Container */}
      <div className="aev3-canvas-scrollbox">
        {/* Main Row: Foreground Pipeline */}
        <div className="aev3-pipeline-row-label">
          <Workflow size={13} />
          <span>FOREGROUND PIPELINE (SYNCHRONOUS REQUEST STAGES)</span>
        </div>

        <div className="aev3-stages-row">
          {foregroundStages.map((stage, idx) => {
            const isActive = activeStageIndex === idx;
            const join = flow.joins.find(
              (j) => j.sourceStageId === stage.id && j.relationshipType !== 'enqueue-worker',
            );
            const bgJoin = flow.joins.find(
              (j) => j.sourceStageId === stage.id && j.relationshipType === 'enqueue-worker',
            );

            return (
              <div key={stage.id} className="aev3-stage-col-wrapper">
                {/* Stage Card */}
                <div
                  className={`aev3-stage-card ${isActive ? 'is-active' : ''} ${stage.isUnknown ? 'is-unknown' : ''}`}
                  onClick={() => onSelectStage(idx)}
                  role="button"
                  tabIndex={0}
                  aria-pressed={isActive}
                >
                  {/* Moving packet dot when active */}
                  {isActive && <div className="aev3-stage-pulse-packet" />}

                  <div className="aev3-card-header">
                    <span className="aev3-card-num">0{idx + 1}</span>
                    <span className="aev3-card-substeps">{stage.subStepsCount} sub-steps</span>
                  </div>

                  <h4 className="aev3-card-title">{stage.title}</h4>

                  <div className="aev3-card-trigger">
                    <code>{stage.trigger}</code>
                  </div>

                  {stage.tools && stage.tools.length > 0 && (
                    <div className="aev3-card-tools">
                      {stage.tools.slice(0, 3).map((tool) => (
                        <span key={tool} className="aev3-card-tool-tag">
                          {tool}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Branch / Fork label */}
                  {stage.forkLabel && (
                    <div className="aev3-branch-tag">
                      <GitBranch size={11} />
                      <span>{stage.forkLabel}</span>
                    </div>
                  )}

                  {/* Unknown next hop notice */}
                  {stage.isUnknown && (
                    <div className="aev3-unknown-tag" title={stage.unresolvedReason ?? 'Target not confirmed in source'}>
                      <HelpCircle size={11} />
                      <span>Unknown next step: {stage.unresolvedReason ?? 'unresolved'}</span>
                    </div>
                  )}

                  {/* File:Line link */}
                  <div className="aev3-card-footer">
                    <button
                      type="button"
                      className="aev3-code-link"
                      onClick={(e) => {
                        e.stopPropagation();
                        openCode(stage.file, stage.line);
                      }}
                      title={`Open ${stage.file}${stage.line ? `:${stage.line}` : ''} in Code view`}
                    >
                      <code>
                        {stage.file.split('/').slice(-2).join('/')}
                        {stage.line ? `:${stage.line}` : ''}
                      </code>
                      <ExternalLink size={10} />
                    </button>
                  </div>

                  {/* Connector arrow pointing to background row if triggering worker */}
                  {bgJoin && backgroundStages.length > 0 && (
                    <div className="aev3-downward-branch-indicator" title="Enqueues background worker">
                      <ArrowDown size={12} />
                      <span>spawns background worker</span>
                    </div>
                  )}
                </div>

                {/* Join Connector Arrow to Next Foreground Stage */}
                {idx < foregroundStages.length - 1 && (
                  <div className="aev3-join-slot">
                    <div className="aev3-join-line" />
                    <div
                      className={`aev3-join-pill ${join ? `rel-${join.relationshipType}` : ''}`}
                      title={join ? `${join.relationshipType}: ${join.explanation}` : 'Sequential pipeline step'}
                    >
                      <ArrowRight size={11} />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Second Row: Background Work */}
        {backgroundStages.length > 0 && (
          <div className="aev3-bg-section">
            <div className="aev3-bg-row-label">
              <span className="aev3-bg-pulse-dot" />
              <span>RUNS IN THE BACKGROUND, DOES NOT BLOCK</span>
            </div>

            <div className="aev3-stages-row aev3-bg-stages-row">
              {backgroundStages.map((bgStage, bgIdx) => {
                const totalIdx = foregroundStages.length + bgIdx;
                const isActive = activeStageIndex === totalIdx;

                return (
                  <div key={bgStage.id} className="aev3-stage-col-wrapper">
                    <div
                      className={`aev3-stage-card is-background ${isActive ? 'is-active' : ''}`}
                      onClick={() => onSelectStage(totalIdx)}
                      role="button"
                      tabIndex={0}
                      aria-pressed={isActive}
                    >
                      {isActive && <div className="aev3-stage-pulse-packet is-bg" />}

                      <div className="aev3-card-header">
                        <span className="aev3-card-num">BG-{bgIdx + 1}</span>
                        <span className="aev3-bg-pill">async worker</span>
                      </div>

                      <h4 className="aev3-card-title">{bgStage.title}</h4>

                      <div className="aev3-card-trigger">
                        <code>{bgStage.trigger}</code>
                      </div>

                      {bgStage.tools && bgStage.tools.length > 0 && (
                        <div className="aev3-card-tools">
                          {bgStage.tools.slice(0, 3).map((tool) => (
                            <span key={tool} className="aev3-card-tool-tag is-bg">
                              {tool}
                            </span>
                          ))}
                        </div>
                      )}

                      <div className="aev3-card-footer">
                        <button
                          type="button"
                          className="aev3-code-link"
                          onClick={(e) => {
                            e.stopPropagation();
                            openCode(bgStage.file, bgStage.line);
                          }}
                          title={`Open ${bgStage.file}${bgStage.line ? `:${bgStage.line}` : ''} in Code view`}
                        >
                          <code>
                            {bgStage.file.split('/').slice(-2).join('/')}
                            {bgStage.line ? `:${bgStage.line}` : ''}
                          </code>
                          <ExternalLink size={10} />
                        </button>
                      </div>
                    </div>

                    {bgIdx < backgroundStages.length - 1 && (
                      <div className="aev3-join-slot">
                        <div className="aev3-join-line is-bg" />
                        <div className="aev3-join-pill is-bg">
                          <ArrowRight size={11} />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
