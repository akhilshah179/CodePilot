import React from 'react';
import { Project } from '../../types';
import { EvidenceBadge } from '../visualizer/EvidenceBadge';
import {
  Activity,
  Layers,
  Cpu,
  FileCode,
  ShieldCheck,
  Zap,
  ArrowRight,
  GitBranch,
  AlertTriangle,
  GraduationCap,
  MessageSquare,
  Network,
} from 'lucide-react';

interface OverviewTabProps {
  project: Project;
  onNavigateTab: (tabId: string, extra?: any) => void;
  onSelectNode: (nodeId: string) => void;
}

export const OverviewTab: React.FC<OverviewTabProps> = ({
  project,
  onNavigateTab,
  onSelectNode,
}) => {
  return (
    <div className="space-y-6 pb-12">
      {/* Hero Banner Card */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-slate-900 via-[#0e131f] to-slate-900 border border-slate-800 p-6 shadow-2xl">
        <div className="absolute top-0 right-0 -mt-8 -mr-8 w-64 h-64 bg-brand-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 left-1/3 -mb-8 w-64 h-64 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none" />

        <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="space-y-2 max-w-2xl">
            <div className="flex items-center gap-2">
              <span className="px-2.5 py-0.5 rounded-full bg-brand-500/20 text-brand-300 font-mono text-[11px] font-semibold border border-brand-500/30">
                LIVING CODEBASE MAP
              </span>
              <span className="text-xs text-slate-400 font-mono flex items-center gap-1">
                <GitBranch className="w-3.5 h-3.5 text-cyan-400" />
                {project.branch}
              </span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
              {project.name}
            </h1>
            <p className="text-sm text-slate-300 leading-relaxed">{project.description}</p>
          </div>

          {/* Health Score Circular Badge */}
          <div className="flex items-center gap-4 bg-slate-950/80 border border-slate-800/80 rounded-2xl p-4 shrink-0 shadow-lg">
            <div className="relative w-16 h-16 flex items-center justify-center">
              <svg className="w-full h-full transform -rotate-90" viewBox="0 0 36 36">
                <path
                  className="text-slate-800"
                  strokeWidth="3.5"
                  stroke="currentColor"
                  fill="none"
                  d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                />
                <path
                  className="text-cyan-400 drop-shadow-[0_0_6px_rgba(0,245,255,0.6)]"
                  strokeDasharray={`${project.stats.healthScore}, 100`}
                  strokeWidth="3.5"
                  strokeLinecap="round"
                  stroke="currentColor"
                  fill="none"
                  d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                />
              </svg>
              <div className="absolute text-center">
                <span className="text-lg font-black text-white font-mono">
                  {project.stats.healthScore}
                </span>
                <span className="text-[9px] text-cyan-400 font-bold block -mt-1">%</span>
              </div>
            </div>
            <div>
              <div className="text-xs font-semibold text-white">Architecture Health</div>
              <div className="text-[11px] text-slate-400 font-mono">
                {project.auditItems.length} optimization points
              </div>
              <button
                onClick={() => onNavigateTab('audit')}
                className="text-[11px] text-cyan-400 hover:text-cyan-300 font-medium flex items-center gap-1 mt-1 transition-colors"
              >
                View Audit Report <ArrowRight className="w-3 h-3" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Metrics Row */}
      <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-4 rounded-xl bg-[#0e131f] border border-slate-800/90 shadow-lg space-y-1">
          <div className="flex items-center justify-between text-slate-400 text-xs">
            <span className="font-medium">Lines of Code</span>
            <FileCode className="w-4 h-4 text-brand-400" />
          </div>
          <div className="text-2xl font-bold text-white font-mono">
            {project.stats.linesOfCode.toLocaleString()}
          </div>
          <div className="text-[11px] text-slate-400 font-mono">
            Across {project.stats.filesCount} repository files
          </div>
        </div>

        <div className="p-4 rounded-xl bg-[#0e131f] border border-slate-800/90 shadow-lg space-y-1">
          <div className="flex items-center justify-between text-slate-400 text-xs">
            <span className="font-medium">Detected Tech</span>
            <Cpu className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-2xl font-bold text-white font-mono">
            {project.technologies.length}
          </div>
          <div className="text-[11px] text-emerald-400 font-medium flex items-center gap-1">
            <ShieldCheck className="w-3 h-3" /> 100% Evidence Grounded
          </div>
        </div>

        <div className="p-4 rounded-xl bg-[#0e131f] border border-slate-800/90 shadow-lg space-y-1">
          <div className="flex items-center justify-between text-slate-400 text-xs">
            <span className="font-medium">Architecture Nodes</span>
            <Layers className="w-4 h-4 text-cyan-400" />
          </div>
          <div className="text-2xl font-bold text-white font-mono">{project.nodes.length}</div>
          <div className="text-[11px] text-slate-400 font-mono">
            {project.edges.length} connected relationships
          </div>
        </div>

        <div className="p-4 rounded-xl bg-[#0e131f] border border-slate-800/90 shadow-lg space-y-1">
          <div className="flex items-center justify-between text-slate-400 text-xs">
            <span className="font-medium">Request Flows</span>
            <Activity className="w-4 h-4 text-purple-400" />
          </div>
          <div className="text-2xl font-bold text-white font-mono">{project.flows.length}</div>
          <div className="text-[11px] text-purple-400 font-medium flex items-center gap-1">
            <Zap className="w-3 h-3" /> Animated Motion Ready
          </div>
        </div>
      </div>

      {/* Language Breakdown Bar */}
      <div className="p-4 rounded-xl bg-[#0e131f] border border-slate-800 space-y-2">
        <div className="flex items-center justify-between text-xs text-slate-300 font-medium">
          <span>Languages & Manifests</span>
          <span className="text-[11px] text-slate-400 font-mono">
            {project.stats.languages.map(l => `${l.name} (${l.percentage}%)`).join(' • ')}
          </span>
        </div>
        <div className="h-2.5 w-full rounded-full bg-slate-800 flex overflow-hidden">
          {project.stats.languages.map(l => (
            <div
              key={l.name}
              style={{ width: `${l.percentage}%`, backgroundColor: l.color }}
              className="h-full transition-all duration-500 hover:opacity-80"
              title={`${l.name}: ${l.percentage}%`}
            />
          ))}
        </div>
      </div>

      {/* 2-Column Section: Verified Tech Stack & Quick Jump Features */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left 2 Cols: Tech Stack Catalog Preview */}
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-white text-sm tracking-wide flex items-center gap-2">
              <Cpu className="w-4 h-4 text-emerald-400" />
              Verified Technology Matrix ({project.technologies.length})
            </h3>
            <button
              onClick={() => onNavigateTab('technologies')}
              className="text-xs text-cyan-400 hover:text-cyan-300 font-medium flex items-center gap-1 transition-colors"
            >
              View All Evidence <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {project.technologies.slice(0, 6).map(tech => (
              <div
                key={tech.id}
                className="p-3.5 rounded-xl bg-[#0e131f] hover:bg-[#131b2e] border border-slate-800 hover:border-slate-700 transition-all space-y-2"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span
                      className="w-2.5 h-2.5 rounded-full"
                      style={{ backgroundColor: tech.color || '#0e8ce9' }}
                    />
                    <span className="font-semibold text-white text-xs">{tech.name}</span>
                    <span className="font-mono text-[10px] text-slate-400">v{tech.version}</span>
                  </div>
                  <EvidenceBadge confidence={tech.confidence} size="sm" />
                </div>
                <div className="text-[11px] text-slate-300 line-clamp-2">{tech.purpose}</div>
                <div className="text-[10px] text-slate-400 font-mono flex items-center justify-between pt-1 border-t border-slate-800/60">
                  <span className="text-slate-400 uppercase font-semibold">{tech.category}</span>
                  <span className="text-cyan-400">{tech.evidence.length} evidence lines</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right 1 Col: Quick Feature Launch Cards */}
        <div className="space-y-3">
          <h3 className="font-bold text-white text-sm tracking-wide flex items-center gap-2">
            <Zap className="w-4 h-4 text-cyan-400" />
            Explore Intelligence
          </h3>

          <button
            onClick={() => onNavigateTab('architecture')}
            className="w-full text-left p-3.5 rounded-xl bg-gradient-to-br from-brand-600/20 to-cyan-500/10 hover:from-brand-600/30 hover:to-cyan-500/20 border border-cyan-500/30 transition-all group"
          >
            <div className="flex items-center justify-between mb-1">
              <span className="font-semibold text-white text-xs flex items-center gap-2">
                <Network className="w-4 h-4 text-cyan-400" />
                Motion Architecture
              </span>
              <ArrowRight className="w-3.5 h-3.5 text-cyan-400 group-hover:translate-x-1 transition-transform" />
            </div>
            <p className="text-[11px] text-slate-300">
              Watch live animated particles flow through API gateways, Redis cache, and DB transactions.
            </p>
          </button>

          <button
            onClick={() => onNavigateTab('interview')}
            className="w-full text-left p-3.5 rounded-xl bg-slate-900/90 hover:bg-slate-800/90 border border-slate-800 hover:border-slate-700 transition-all group"
          >
            <div className="flex items-center justify-between mb-1">
              <span className="font-semibold text-white text-xs flex items-center gap-2">
                <GraduationCap className="w-4 h-4 text-amber-400" />
                Project Interview Prep
              </span>
              <ArrowRight className="w-3.5 h-3.5 text-slate-400 group-hover:translate-x-1 transition-transform" />
            </div>
            <p className="text-[11px] text-slate-400">
              30s elevator pitch, 5min deep dive, and repository-specific system design questions.
            </p>
          </button>

          <button
            onClick={() => onNavigateTab('impact')}
            className="w-full text-left p-3.5 rounded-xl bg-slate-900/90 hover:bg-slate-800/90 border border-slate-800 hover:border-slate-700 transition-all group"
          >
            <div className="flex items-center justify-between mb-1">
              <span className="font-semibold text-white text-xs flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-rose-400" />
                Blast Radius Simulator
              </span>
              <ArrowRight className="w-3.5 h-3.5 text-slate-400 group-hover:translate-x-1 transition-transform" />
            </div>
            <p className="text-[11px] text-slate-400">
              Test what would break if you modify or refactor any service or database component.
            </p>
          </button>

          <button
            onClick={() => onNavigateTab('chat')}
            className="w-full text-left p-3.5 rounded-xl bg-slate-900/90 hover:bg-slate-800/90 border border-slate-800 hover:border-slate-700 transition-all group"
          >
            <div className="flex items-center justify-between mb-1">
              <span className="font-semibold text-white text-xs flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-purple-400" />
                AI Codebase Explainer
              </span>
              <ArrowRight className="w-3.5 h-3.5 text-slate-400 group-hover:translate-x-1 transition-transform" />
            </div>
            <p className="text-[11px] text-slate-400">
              Ask grounded questions about architecture, authentication, or query routes with citations.
            </p>
          </button>
        </div>
      </div>
    </div>
  );
};
