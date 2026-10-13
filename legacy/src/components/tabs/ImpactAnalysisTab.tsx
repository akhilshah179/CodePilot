import React, { useState, useMemo } from 'react';
import { Project, GraphNode } from '../../types';
import { calculateBlastRadius } from '../../engine/blastRadius';
import {
  AlertTriangle,
  Layers,
  ArrowRight,
  ShieldAlert,
  CheckCircle2,
  GitPullRequest,
  FileCode,
  Activity,
  Flame,
} from 'lucide-react';

interface ImpactAnalysisTabProps {
  project: Project;
  initialNodeId?: string;
  onNavigateTab: (tabId: string, extra?: any) => void;
}

export const ImpactAnalysisTab: React.FC<ImpactAnalysisTabProps> = ({
  project,
  initialNodeId,
  onNavigateTab,
}) => {
  const [selectedNodeId, setSelectedNodeId] = useState<string>(
    initialNodeId || project.nodes[1]?.id || project.nodes[0]?.id
  );

  const impactResult = useMemo(() => {
    return calculateBlastRadius(selectedNodeId, project.nodes, project.edges);
  }, [selectedNodeId, project.nodes, project.edges]);

  const targetNode = project.nodes.find(n => n.id === selectedNodeId);

  const getRiskColor = (level: string) => {
    switch (level) {
      case 'CRITICAL':
        return 'text-rose-400 bg-rose-500/10 border-rose-500/30 ring-rose-500/20';
      case 'HIGH':
        return 'text-amber-400 bg-amber-500/10 border-amber-500/30 ring-amber-500/20';
      case 'MEDIUM':
        return 'text-blue-400 bg-blue-500/10 border-blue-500/30 ring-blue-500/20';
      default:
        return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30 ring-emerald-500/20';
    }
  };

  return (
    <div className="space-y-6 pb-12">
      {/* Header Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-5 rounded-2xl bg-[#0e131f] border border-slate-800 shadow-xl">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="px-2.5 py-0.5 rounded-full bg-rose-500/10 text-rose-400 font-mono text-[11px] font-bold border border-rose-500/30 flex items-center gap-1">
              <Flame className="w-3.5 h-3.5" />
              BLAST RADIUS & CHANGE IMPACT ENGINE
            </span>
          </div>
          <h2 className="text-xl font-bold text-white tracking-tight">
            Simulate "What Happens If I Change This?"
          </h2>
          <p className="text-xs text-slate-400">
            Traverses the Project Knowledge Graph to evaluate cascading breaking risks and upstream dependencies.
          </p>
        </div>

        {/* Target Component Dropdown */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400 font-medium">Select Component:</span>
          <select
            value={selectedNodeId}
            onChange={e => setSelectedNodeId(e.target.value)}
            className="bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-brand-500 max-w-xs"
          >
            {project.nodes.map(n => (
              <option key={n.id} value={n.id}>
                {n.label} ({n.layer})
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Risk Gauge & Target Summary Banner */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Blast Radius Score Card */}
        <div className="p-5 rounded-2xl bg-[#0e131f] border border-slate-800 shadow-lg flex items-center justify-between">
          <div className="space-y-1">
            <span className="text-xs text-slate-400 font-medium">Blast Radius Score</span>
            <div className="text-3xl font-extrabold text-white font-mono">
              {impactResult.blastRadiusScore}
              <span className="text-sm text-slate-500"> / 100</span>
            </div>
            <span
              className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-bold font-mono uppercase border ${getRiskColor(
                impactResult.riskLevel
              )}`}
            >
              {impactResult.riskLevel} Risk
            </span>
          </div>

          <div className="w-16 h-16 rounded-full bg-slate-950 border border-slate-800 flex items-center justify-center">
            <Flame
              className={`w-8 h-8 ${
                impactResult.riskLevel === 'CRITICAL'
                  ? 'text-rose-400 animate-pulse'
                  : impactResult.riskLevel === 'HIGH'
                  ? 'text-amber-400'
                  : 'text-emerald-400'
              }`}
            />
          </div>
        </div>

        {/* Direct Impact Count */}
        <div className="p-5 rounded-2xl bg-[#0e131f] border border-slate-800 shadow-lg space-y-1">
          <span className="text-xs text-slate-400 font-medium">Direct Upstream / Downstream</span>
          <div className="text-3xl font-bold text-cyan-400 font-mono">
            {impactResult.directDependents.length}
          </div>
          <p className="text-[11px] text-slate-400">
            Immediate services with synchronous calls or query contracts
          </p>
        </div>

        {/* Transitive Impact Count */}
        <div className="p-5 rounded-2xl bg-[#0e131f] border border-slate-800 shadow-lg space-y-1">
          <span className="text-xs text-slate-400 font-medium">Transitive Cascades</span>
          <div className="text-3xl font-bold text-purple-400 font-mono">
            {impactResult.transitiveDependents.length}
          </div>
          <p className="text-[11px] text-slate-400">
            Secondary services affected up to 3 graph hops away
          </p>
        </div>
      </div>

      {/* Breaking Risk Narrative */}
      <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800 flex items-start gap-3">
        <ShieldAlert className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
        <div className="space-y-1 text-xs">
          <div className="font-semibold text-white">Breaking Risk Evaluation</div>
          <p className="text-slate-300 leading-relaxed">{impactResult.breakingRisk}</p>
        </div>
      </div>

      {/* 2-Column Split: Direct Dependents on left, Transitive Chains & Prechecks on right */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Direct Dependents (6 cols) */}
        <div className="lg:col-span-6 space-y-3">
          <div className="text-xs font-bold text-slate-400 uppercase tracking-wider font-mono flex items-center justify-between">
            <span>Direct Dependents ({impactResult.directDependents.length})</span>
            <span className="text-cyan-400 text-[11px]">Immediate Radius</span>
          </div>

          <div className="space-y-2.5">
            {impactResult.directDependents.map((dep, idx) => (
              <div
                key={idx}
                className="p-3.5 rounded-xl bg-[#0e131f] border border-slate-800 space-y-1.5 hover:border-slate-700 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold text-white text-xs">{dep.label}</span>
                  <span className="px-2 py-0.5 rounded bg-slate-900 font-mono text-[10px] text-cyan-400 border border-slate-800 uppercase font-semibold">
                    {dep.relation}
                  </span>
                </div>
                <p className="text-[11px] text-slate-300">{dep.impact}</p>
                {dep.filePath && (
                  <div className="text-[10px] font-mono text-slate-500 truncate flex items-center gap-1 pt-1">
                    <FileCode className="w-3 h-3" />
                    {dep.filePath}
                  </div>
                )}
              </div>
            ))}

            {impactResult.directDependents.length === 0 && (
              <div className="p-6 text-center bg-[#0e131f] border border-slate-800 rounded-xl text-slate-500 text-xs">
                No direct dependents found. This component is isolated.
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Transitive Paths & Prechecks (6 cols) */}
        <div className="lg:col-span-6 space-y-4">
          {/* Transitive Chains */}
          <div className="space-y-3">
            <div className="text-xs font-bold text-slate-400 uppercase tracking-wider font-mono flex items-center justify-between">
              <span>Transitive Propagation Paths ({impactResult.transitiveDependents.length})</span>
              <span className="text-purple-400 text-[11px]">Depth 2-3 Hops</span>
            </div>

            <div className="space-y-2">
              {impactResult.transitiveDependents.map((t, idx) => (
                <div
                  key={idx}
                  className="p-3 rounded-xl bg-[#0e131f] border border-slate-800 flex items-center justify-between text-xs"
                >
                  <div className="space-y-1">
                    <span className="font-semibold text-white">{t.label}</span>
                    <div className="flex items-center gap-1.5 text-[10px] font-mono text-purple-300">
                      {t.path.map((p, i) => (
                        <React.Fragment key={i}>
                          <span>{p}</span>
                          {i < t.path.length - 1 && <ArrowRight className="w-2.5 h-2.5 text-slate-600" />}
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                  <span className="px-2 py-0.5 rounded bg-slate-900 text-slate-400 font-mono text-[10px] border border-slate-800">
                    Depth {t.depth}
                  </span>
                </div>
              ))}

              {impactResult.transitiveDependents.length === 0 && (
                <div className="p-4 text-center bg-[#0e131f] border border-slate-800 rounded-xl text-slate-500 text-xs">
                  No secondary transitive cascades detected.
                </div>
              )}
            </div>
          </div>

          {/* Recommended Pre-Checks */}
          <div className="p-4 rounded-2xl bg-[#0e131f] border border-slate-800 space-y-3">
            <div className="text-xs font-bold text-white flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              Recommended Safety Pre-Checks
            </div>
            <div className="space-y-2 text-xs">
              {impactResult.recommendedPreChecks.map((check, i) => (
                <div
                  key={i}
                  className="flex items-start gap-2 text-slate-300 p-2 rounded-lg bg-slate-950/60 border border-slate-800/60 text-[11.5px]"
                >
                  <span className="text-emerald-400 font-bold">•</span>
                  <span>{check}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
