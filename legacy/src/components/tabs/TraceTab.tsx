import React, { useState } from 'react';
import { Project, RequestFlow } from '../../types';
import {
  Activity,
  Play,
  ArrowRight,
  Clock,
  FileCode,
  CheckCircle2,
  Zap,
  Code2,
  Sparkles,
} from 'lucide-react';

interface TraceTabProps {
  project: Project;
  onNavigateTab: (tabId: string, extra?: any) => void;
}

export const TraceTab: React.FC<TraceTabProps> = ({ project, onNavigateTab }) => {
  const [selectedFlow, setSelectedFlow] = useState<RequestFlow>(project.flows[0] || null);
  const [activeStepIndex, setActiveStepIndex] = useState<number>(0);

  if (!selectedFlow) {
    return (
      <div className="p-8 text-center bg-[#0e131f] border border-slate-800 rounded-2xl text-slate-400 text-xs">
        No request flows defined for this repository yet.
      </div>
    );
  }

  const currentStep = selectedFlow.steps[activeStepIndex] || selectedFlow.steps[0];
  const currentNode = project.nodes.find(n => n.id === currentStep?.nodeId);

  return (
    <div className="space-y-6 pb-12">
      {/* Header Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-5 rounded-2xl bg-[#0e131f] border border-slate-800 shadow-xl">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="px-2.5 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400 font-mono text-[11px] font-bold border border-cyan-500/30 flex items-center gap-1">
              <Activity className="w-3.5 h-3.5" />
              REQUEST & DATA FLOW TRACE
            </span>
            <span className="text-xs text-slate-400 font-mono">{selectedFlow.category.toUpperCase()}</span>
          </div>
          <h2 className="text-xl font-bold text-white tracking-tight">{selectedFlow.name}</h2>
          <p className="text-xs text-slate-400">{selectedFlow.description}</p>
        </div>

        {/* Flow Selector */}
        <div className="flex items-center gap-3">
          <select
            value={selectedFlow.id}
            onChange={e => {
              const flow = project.flows.find(f => f.id === e.target.value);
              if (flow) {
                setSelectedFlow(flow);
                setActiveStepIndex(0);
              }
            }}
            className="bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-brand-500"
          >
            {project.flows.map(f => (
              <option key={f.id} value={f.id}>
                {f.name} ({f.steps.length} steps)
              </option>
            ))}
          </select>

          <button
            onClick={() => onNavigateTab('architecture')}
            className="px-3.5 py-2 rounded-xl bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 text-xs font-medium flex items-center gap-1.5 transition-colors shrink-0"
          >
            <Play className="w-3.5 h-3.5 fill-cyan-400" />
            <span>Watch in Motion View</span>
          </button>
        </div>
      </div>

      {/* Trigger & Endpoint Badge */}
      <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          <span className="text-slate-400 font-medium">Trigger Route:</span>
          <span className="font-mono text-cyan-400 font-bold bg-slate-900 px-2.5 py-1 rounded-lg border border-slate-800">
            {selectedFlow.trigger}
          </span>
        </div>
        <span className="text-slate-400 font-mono text-[11px]">
          {selectedFlow.steps.length} sequential execution stages
        </span>
      </div>

      {/* 2-Column Split: Step Progression Timeline on left, Deep Stage Inspector on right */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Interactive Step Progression Timeline (5 cols) */}
        <div className="lg:col-span-5 space-y-3">
          <div className="text-xs font-bold text-slate-400 uppercase tracking-wider px-1 font-mono">
            Execution Stages
          </div>

          <div className="space-y-2.5">
            {selectedFlow.steps.map((step, idx) => {
              const isSelected = idx === activeStepIndex;
              const stepNode = project.nodes.find(n => n.id === step.nodeId);

              return (
                <div
                  key={step.stepIndex}
                  onClick={() => setActiveStepIndex(idx)}
                  className={`p-3.5 rounded-xl cursor-pointer transition-all border ${
                    isSelected
                      ? 'bg-[#111726] border-cyan-500/60 shadow-lg shadow-cyan-500/10'
                      : 'bg-[#0e131f] hover:bg-[#131b2e] border-slate-800'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2">
                      <span
                        className={`w-6 h-6 rounded-full flex items-center justify-center font-mono text-xs font-bold ${
                          isSelected
                            ? 'bg-cyan-400 text-slate-950 shadow-md shadow-cyan-400/50'
                            : 'bg-slate-800 text-slate-300'
                        }`}
                      >
                        {step.stepIndex}
                      </span>
                      <span className="font-semibold text-white text-xs">{step.action}</span>
                    </div>

                    {step.latencyEstimate && (
                      <span className="text-[10px] font-mono text-cyan-400 flex items-center gap-1 bg-slate-900 px-1.5 py-0.5 rounded">
                        <Clock className="w-3 h-3 text-cyan-400" />
                        {step.latencyEstimate}
                      </span>
                    )}
                  </div>

                  <p className="text-slate-400 text-[11px] line-clamp-2 pl-8">
                    {step.description}
                  </p>

                  <div className="mt-2 pl-8 flex items-center gap-2 text-[10px] font-mono text-slate-500">
                    <span className="text-slate-400">{stepNode?.label || step.nodeId}</span>
                    {step.sourceFile && <span>• {step.sourceFile.split('/').pop()}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right Column: Deep Stage Detail & Code Inspector (7 cols) */}
        <div className="lg:col-span-7">
          {currentStep && (
            <div className="bg-[#0e131f] border border-slate-800 rounded-2xl p-6 shadow-2xl space-y-5 sticky top-24">
              {/* Stage Header */}
              <div className="flex items-start justify-between pb-4 border-b border-slate-800">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-400 font-mono text-xs font-bold">
                      Stage {currentStep.stepIndex} of {selectedFlow.steps.length}
                    </span>
                    <h3 className="text-base font-bold text-white">{currentStep.action}</h3>
                  </div>
                  <div className="text-xs text-slate-400 font-mono">
                    Executing Component:{' '}
                    <span className="text-cyan-300 font-semibold">{currentNode?.label || currentStep.nodeId}</span>
                  </div>
                </div>

                {currentStep.latencyEstimate && (
                  <div className="p-2 rounded-xl bg-slate-900 border border-slate-800 text-right font-mono">
                    <span className="text-[10px] text-slate-400 block">Est. Duration</span>
                    <span className="text-cyan-400 font-bold text-xs">{currentStep.latencyEstimate}</span>
                  </div>
                )}
              </div>

              {/* Description */}
              <div className="space-y-1">
                <span className="text-xs font-semibold text-slate-400">Step Explanation</span>
                <p className="text-xs text-slate-200 leading-relaxed bg-slate-900/60 p-3 rounded-xl border border-slate-800">
                  {currentStep.description}
                </p>
              </div>

              {/* Payload Preview */}
              {currentStep.payloadPreview && (
                <div className="space-y-1.5">
                  <span className="text-xs font-semibold text-cyan-400 flex items-center gap-1.5">
                    <Zap className="w-3.5 h-3.5" />
                    Payload / Headers / Query Parameters
                  </span>
                  <pre className="p-3 rounded-xl bg-slate-950 font-mono text-xs text-cyan-300 overflow-x-auto whitespace-pre-wrap border border-slate-800">
                    {currentStep.payloadPreview}
                  </pre>
                </div>
              )}

              {/* Source Code Snippet */}
              {currentStep.sourceCode && (
                <div className="space-y-1.5">
                  <span className="text-xs font-semibold text-emerald-400 flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <FileCode className="w-3.5 h-3.5 text-emerald-400" />
                      Source Implementation
                    </div>
                    {currentStep.sourceFile && (
                      <span className="font-mono text-[10.5px] text-slate-400">{currentStep.sourceFile}</span>
                    )}
                  </span>
                  <pre className="p-3 rounded-xl bg-slate-950 font-mono text-xs text-emerald-300 overflow-x-auto whitespace-pre-wrap border border-slate-800">
                    {currentStep.sourceCode}
                  </pre>
                </div>
              )}

              {/* Step Navigation Controls */}
              <div className="pt-2 flex items-center justify-between border-t border-slate-800/80 text-xs">
                <button
                  onClick={() => setActiveStepIndex(Math.max(0, activeStepIndex - 1))}
                  disabled={activeStepIndex === 0}
                  className="px-3 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-300 disabled:opacity-40 border border-slate-800 transition-colors"
                >
                  ← Previous Stage
                </button>
                <span className="text-[11px] font-mono text-slate-500">
                  {activeStepIndex + 1} / {selectedFlow.steps.length}
                </span>
                <button
                  onClick={() => setActiveStepIndex(Math.min(selectedFlow.steps.length - 1, activeStepIndex + 1))}
                  disabled={activeStepIndex === selectedFlow.steps.length - 1}
                  className="px-3 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white disabled:opacity-40 font-medium transition-colors"
                >
                  Next Stage →
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
