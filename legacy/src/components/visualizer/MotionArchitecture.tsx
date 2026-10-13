import React, { useState, useEffect } from 'react';
import { Project, RequestFlow } from '../../types';
import { Play, Pause, RotateCcw, ChevronRight, ChevronLeft, Zap, Clock, FileCode, CheckCircle2 } from 'lucide-react';

interface MotionArchitectureProps {
  project: Project;
  activeFlow: RequestFlow | null;
  onSelectFlow: (flow: RequestFlow) => void;
  currentStepIndex: number;
  onStepChange: (stepIndex: number) => void;
  isPlaying: boolean;
  onTogglePlay: () => void;
}

export const MotionArchitecture: React.FC<MotionArchitectureProps> = ({
  project,
  activeFlow,
  onSelectFlow,
  currentStepIndex,
  onStepChange,
  isPlaying,
  onTogglePlay,
}) => {
  const [speed, setSpeed] = useState<number>(1);

  // Auto progression timer when isPlaying is true
  useEffect(() => {
    if (!isPlaying || !activeFlow) return;

    const interval = setInterval(() => {
      onStepChange((currentStepIndex + 1) % activeFlow.steps.length);
    }, 2800 / speed);

    return () => clearInterval(interval);
  }, [isPlaying, currentStepIndex, activeFlow, speed, onStepChange]);

  if (!activeFlow) {
    return (
      <div className="p-4 bg-slate-900/90 border border-slate-800 rounded-xl flex items-center justify-between text-xs">
        <span className="text-slate-400">No active request flow selected</span>
        {project.flows.length > 0 && (
          <button
            onClick={() => onSelectFlow(project.flows[0])}
            className="px-3 py-1.5 rounded-lg bg-brand-500/20 text-brand-300 border border-brand-500/30 hover:bg-brand-500/30"
          >
            Select Default Flow
          </button>
        )}
      </div>
    );
  }

  const currentStep = activeFlow.steps[currentStepIndex] || activeFlow.steps[0];
  const currentNode = project.nodes.find(n => n.id === currentStep?.nodeId);

  return (
    <div className="bg-[#0e131f]/90 backdrop-blur-xl border border-slate-800/90 rounded-2xl p-4 shadow-2xl space-y-4">
      {/* Flow Header & Selector */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-800/80">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-cyan-500/20 to-brand-500/20 border border-cyan-500/30 flex items-center justify-center text-cyan-400 shadow-lg shadow-cyan-500/10">
            <Zap className="w-5 h-5 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h4 className="font-semibold text-white text-sm tracking-wide">{activeFlow.name}</h4>
              <span className="px-2 py-0.5 rounded-full bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 font-mono text-[10px] uppercase font-bold">
                Motion Architecture
              </span>
            </div>
            <p className="text-xs text-slate-400 font-mono mt-0.5">{activeFlow.trigger}</p>
          </div>
        </div>

        {/* Flow Dropdown Switcher */}
        <div className="flex items-center gap-2">
          <select
            value={activeFlow.id}
            onChange={e => {
              const f = project.flows.find(item => item.id === e.target.value);
              if (f) {
                onSelectFlow(f);
                onStepChange(0);
              }
            }}
            className="bg-slate-900 border border-slate-700/80 rounded-lg px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-brand-500"
          >
            {project.flows.map(flow => (
              <option key={flow.id} value={flow.id}>
                {flow.name}
              </option>
            ))}
          </select>

          {/* Speed Toggle */}
          <button
            onClick={() => setSpeed(s => (s === 1 ? 2 : s === 2 ? 0.5 : 1))}
            className="px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-700/80 text-[11px] font-mono text-slate-300 hover:text-white"
            title="Toggle playback speed"
          >
            {speed}x
          </button>
        </div>
      </div>

      {/* Playback Controls & Step Bar */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => onStepChange(Math.max(0, currentStepIndex - 1))}
            disabled={currentStepIndex === 0}
            className="p-2 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-300 disabled:opacity-40 disabled:hover:bg-slate-800/80 transition-colors"
            title="Previous Step"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>

          <button
            onClick={onTogglePlay}
            className="px-4 py-2 rounded-xl bg-gradient-to-r from-cyan-500 to-brand-600 hover:from-cyan-400 hover:to-brand-500 text-white font-medium text-xs flex items-center gap-2 shadow-lg shadow-brand-500/20 transition-all"
          >
            {isPlaying ? <Pause className="w-4 h-4 fill-white" /> : <Play className="w-4 h-4 fill-white" />}
            <span>{isPlaying ? 'Pause' : 'Play Flow'}</span>
          </button>

          <button
            onClick={() => onStepChange(Math.min(activeFlow.steps.length - 1, currentStepIndex + 1))}
            disabled={currentStepIndex === activeFlow.steps.length - 1}
            className="p-2 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-300 disabled:opacity-40 disabled:hover:bg-slate-800/80 transition-colors"
            title="Next Step"
          >
            <ChevronRight className="w-4 h-4" />
          </button>

          <button
            onClick={() => {
              onStepChange(0);
            }}
            className="p-2 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-300 transition-colors"
            title="Restart Flow"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
        </div>

        {/* Step Progress Segments */}
        <div className="flex-1 flex items-center gap-1.5">
          {activeFlow.steps.map((step, idx) => {
            const isCurrent = idx === currentStepIndex;
            const isCompleted = idx < currentStepIndex;
            return (
              <button
                key={step.stepIndex}
                onClick={() => onStepChange(idx)}
                className={`flex-1 h-2.5 rounded-full transition-all duration-300 ${
                  isCurrent
                    ? 'bg-cyan-400 ring-2 ring-cyan-400/40 shadow-md shadow-cyan-400/50 scale-y-125'
                    : isCompleted
                    ? 'bg-brand-500/70 hover:bg-brand-400'
                    : 'bg-slate-800 hover:bg-slate-700'
                }`}
                title={`Step ${step.stepIndex}: ${step.action}`}
              />
            );
          })}
        </div>
      </div>

      {/* Current Step Narration Card */}
      {currentStep && (
        <div className="p-3.5 rounded-xl bg-slate-900/90 border border-cyan-500/20 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="px-2 py-0.5 rounded bg-brand-500/20 text-brand-300 font-mono font-bold text-xs">
                Step {currentStep.stepIndex} of {activeFlow.steps.length}
              </span>
              <span className="font-medium text-white text-xs">{currentStep.action}</span>
            </div>
            <div className="flex items-center gap-3 text-xs">
              {currentStep.latencyEstimate && (
                <span className="text-slate-400 font-mono flex items-center gap-1">
                  <Clock className="w-3.5 h-3.5 text-cyan-400" />
                  {currentStep.latencyEstimate}
                </span>
              )}
              <span className="px-2 py-0.5 rounded-md bg-slate-800 text-cyan-300 font-mono text-[11px] border border-slate-700">
                {currentNode?.label || currentStep.nodeId}
              </span>
            </div>
          </div>

          <p className="text-xs text-slate-300 leading-relaxed">{currentStep.description}</p>

          {/* Payload Preview or Code Snippet */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-[11px]">
            {currentStep.payloadPreview && (
              <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800/80 font-mono text-cyan-300 overflow-x-auto">
                <div className="text-[10px] text-slate-400 font-semibold mb-1 uppercase tracking-wider">Payload / State Preview</div>
                <pre className="whitespace-pre-wrap">{currentStep.payloadPreview}</pre>
              </div>
            )}
            {currentStep.sourceCode && (
              <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800/80 font-mono text-emerald-300 overflow-x-auto">
                <div className="text-[10px] text-slate-400 font-semibold mb-1 uppercase tracking-wider flex items-center gap-1">
                  <FileCode className="w-3 h-3 text-emerald-400" />
                  {currentStep.sourceFile || 'Source Snippet'}
                </div>
                <pre className="whitespace-pre-wrap">{currentStep.sourceCode}</pre>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
