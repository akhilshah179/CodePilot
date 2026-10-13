import React, { useState } from 'react';
import { Project, ArchitectureAuditItem } from '../../types';
import {
  GitPullRequest,
  AlertTriangle,
  Zap,
  ArrowRight,
  ShieldCheck,
  Scale,
  RefreshCw,
  Layers,
  Sparkles,
} from 'lucide-react';

interface AuditTabProps {
  project: Project;
  onNavigateTab: (tabId: string, extra?: any) => void;
}

export const AuditTab: React.FC<AuditTabProps> = ({ project, onNavigateTab }) => {
  const [selectedAuditId, setSelectedAuditId] = useState<string>(
    project.auditItems[0]?.id || ''
  );

  const selectedAudit = project.auditItems.find(a => a.id === selectedAuditId) || project.auditItems[0];

  const getSeverityBadge = (sev: ArchitectureAuditItem['severity']) => {
    switch (sev) {
      case 'critical':
        return 'bg-rose-500/10 text-rose-400 border-rose-500/30';
      case 'high':
        return 'bg-amber-500/10 text-amber-400 border-amber-500/30';
      case 'medium':
        return 'bg-blue-500/10 text-blue-400 border-blue-500/30';
      default:
        return 'bg-slate-500/10 text-slate-400 border-slate-500/30';
    }
  };

  return (
    <div className="space-y-6 pb-12">
      {/* Header Banner */}
      <div className="p-5 rounded-2xl bg-[#0e131f] border border-slate-800 shadow-xl space-y-2">
        <div className="flex items-center gap-2">
          <span className="px-2.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400 font-mono text-[11px] font-bold border border-amber-500/30 flex items-center gap-1">
            <GitPullRequest className="w-3.5 h-3.5" />
            ARCHITECTURE AUDIT & TRADE-OFF ENGINE
          </span>
          <span className="text-xs text-slate-400 font-mono">
            {project.auditItems.length} optimization opportunities detected
          </span>
        </div>
        <h2 className="text-xl font-bold text-white tracking-tight">
          Current Architecture vs Architecture Analysis
        </h2>
        <p className="text-xs text-slate-400 max-w-3xl leading-relaxed">
          CodePilot distinguishes between how the repository operates today versus grounded engineering trade-offs for resilience, caching, scaling, and bottleneck elimination.
        </p>
      </div>

      {/* Main 2-Column Split View */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: List of Detected Architectural Bottlenecks (5 cols) */}
        <div className="lg:col-span-5 space-y-3">
          <div className="text-xs font-bold text-slate-400 uppercase tracking-wider px-1 font-mono">
            Audit Findings ({project.auditItems.length})
          </div>

          <div className="space-y-2.5">
            {project.auditItems.map(item => {
              const isSelected = item.id === selectedAudit?.id;
              return (
                <div
                  key={item.id}
                  onClick={() => setSelectedAuditId(item.id)}
                  className={`p-4 rounded-xl cursor-pointer transition-all border ${
                    isSelected
                      ? 'bg-[#111726] border-amber-500/60 shadow-lg shadow-amber-500/10'
                      : 'bg-[#0e131f] hover:bg-[#131b2e] border-slate-800'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-bold font-mono uppercase border ${getSeverityBadge(
                        item.severity
                      )}`}
                    >
                      {item.severity} Severity
                    </span>
                    <span className="font-mono text-[10px] text-slate-500 uppercase">
                      {item.type}
                    </span>
                  </div>

                  <h4 className="font-bold text-white text-xs mb-1.5 leading-snug">
                    {item.title}
                  </h4>
                  <p className="text-[11px] text-slate-400 line-clamp-2 leading-relaxed">
                    {item.reason}
                  </p>

                  <div className="mt-2.5 pt-2 border-t border-slate-800/80 flex items-center justify-between text-[10px] text-slate-500 font-mono">
                    <span>{item.affectedNodes.length} affected nodes</span>
                    <span className="text-amber-400 flex items-center gap-1 font-sans font-medium">
                      Inspect Trade-offs <ArrowRight className="w-3 h-3" />
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right Column: Side-by-Side Current vs Potential Improvement (7 cols) */}
        <div className="lg:col-span-7">
          {selectedAudit && (
            <div className="bg-[#0e131f] border border-slate-800 rounded-2xl p-6 shadow-2xl space-y-6 sticky top-24">
              {/* Finding Title & Severity */}
              <div className="flex items-start justify-between pb-4 border-b border-slate-800">
                <div className="space-y-1">
                  <span
                    className={`inline-block px-2.5 py-0.5 rounded-full text-[10px] font-bold font-mono uppercase border ${getSeverityBadge(
                      selectedAudit.severity
                    )}`}
                  >
                    {selectedAudit.severity} • {selectedAudit.type.toUpperCase()}
                  </span>
                  <h3 className="text-base font-bold text-white leading-snug">
                    {selectedAudit.title}
                  </h3>
                </div>
              </div>

              {/* Side-by-Side Comparison Boxes */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Current Architecture Box */}
                <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                  <div className="text-xs font-bold text-rose-400 flex items-center gap-1.5 font-mono uppercase">
                    <span className="w-2 h-2 rounded-full bg-rose-400" />
                    Current Architecture
                  </div>
                  <p className="text-xs text-slate-300 leading-relaxed">
                    {selectedAudit.currentArchitecture}
                  </p>
                </div>

                {/* Potential Improvement Box */}
                <div className="p-4 rounded-xl bg-slate-950 border border-emerald-500/30 space-y-2">
                  <div className="text-xs font-bold text-emerald-400 flex items-center gap-1.5 font-mono uppercase">
                    <Sparkles className="w-3.5 h-3.5" />
                    Potential Improvement
                  </div>
                  <p className="text-xs text-slate-200 leading-relaxed">
                    {selectedAudit.potentialImprovement}
                  </p>
                </div>
              </div>

              {/* Architectural Reasoning */}
              <div className="space-y-1.5 text-xs">
                <span className="font-semibold text-slate-400">Architectural Rationale</span>
                <p className="text-slate-200 leading-relaxed bg-slate-900/60 p-3 rounded-xl border border-slate-800">
                  {selectedAudit.reason}
                </p>
              </div>

              {/* Trade-Offs & Complexity */}
              <div className="p-4 rounded-xl bg-amber-500/5 border border-amber-500/20 space-y-2 text-xs">
                <span className="font-semibold text-amber-300 flex items-center gap-1.5">
                  <Scale className="w-4 h-4 text-amber-400" />
                  Engineering Trade-Offs
                </span>
                <p className="text-slate-300 leading-relaxed">{selectedAudit.tradeOffs}</p>
              </div>

              {/* Alternative Approach */}
              <div className="space-y-1.5 text-xs">
                <span className="font-semibold text-slate-400">Alternative Architecture Pattern</span>
                <div className="p-3 rounded-xl bg-slate-900/40 border border-slate-800 font-mono text-[11.5px] text-cyan-300">
                  {selectedAudit.alternative}
                </div>
              </div>

              {/* Affected Nodes & Quick Action */}
              <div className="pt-2 flex items-center justify-between border-t border-slate-800/80">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-slate-400 font-mono">Affected Nodes:</span>
                  <div className="flex items-center gap-1">
                    {selectedAudit.affectedNodes.map(nodeId => {
                      const n = project.nodes.find(item => item.id === nodeId);
                      return (
                        <span
                          key={nodeId}
                          className="px-2 py-0.5 rounded bg-slate-800 text-[10.5px] font-mono text-cyan-300 border border-slate-700"
                        >
                          {n?.label || nodeId}
                        </span>
                      );
                    })}
                  </div>
                </div>

                <button
                  onClick={() =>
                    onNavigateTab('chat', {
                      initialPrompt: `How should we implement the suggested improvement for "${selectedAudit.title}" in ${project.name}, and what are the specific step-by-step migration risks?`,
                    })
                  }
                  className="px-3.5 py-2 rounded-xl bg-brand-600/20 hover:bg-brand-600/30 text-brand-300 border border-brand-500/30 font-medium text-xs flex items-center gap-1.5 transition-colors"
                >
                  <Sparkles className="w-3.5 h-3.5 text-brand-400" />
                  Ask AI Implementation Plan
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
