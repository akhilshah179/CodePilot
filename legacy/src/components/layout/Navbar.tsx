import React from 'react';
import { Project } from '../../types';
import { SAMPLE_PROJECTS } from '../../data/sampleProjects';
import {
  Compass,
  GitBranch,
  Code2,
  Search,
  Download,
  Settings,
  PlusCircle,
  RefreshCw,
  ExternalLink,
  ChevronDown,
  Sparkles,
  ShieldCheck,
} from 'lucide-react';

interface NavbarProps {
  currentProject: Project;
  onSelectProject: (project: Project) => void;
  onOpenImportModal: () => void;
  onOpenExportModal: () => void;
  onOpenSettingsModal: () => void;
  onOpenCommandPalette: () => void;
  isSyncing: boolean;
  onSyncRepo: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  currentProject,
  onSelectProject,
  onOpenImportModal,
  onOpenExportModal,
  onOpenSettingsModal,
  onOpenCommandPalette,
  isSyncing,
  onSyncRepo,
}) => {
  return (
    <header className="h-16 border-b border-slate-800 bg-[#080b11]/90 backdrop-blur-xl px-4 flex items-center justify-between z-30 sticky top-0">
      {/* Brand & Project Selector */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-brand-600 via-cyan-500 to-indigo-500 p-0.5 shadow-lg shadow-brand-500/20">
            <div className="w-full h-full bg-[#080b11] rounded-[10px] flex items-center justify-center text-cyan-400 font-black">
              <Compass className="w-5 h-5 animate-spin-slow" />
            </div>
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="font-bold text-white text-base tracking-tight bg-gradient-to-r from-white via-slate-100 to-slate-400 bg-clip-text text-transparent">
                CodePilot
              </span>
              <span className="px-1.5 py-0.2 rounded bg-brand-500/20 text-brand-400 font-mono text-[9px] font-bold border border-brand-500/30">
                PRO
              </span>
            </div>
            <p className="text-[10px] text-slate-400 font-mono hidden sm:block">
              Codebase Intelligence Layer
            </p>
          </div>
        </div>

        <div className="h-6 w-px bg-slate-800 hidden md:block" />

        {/* Project Switcher Dropdown */}
        <div className="relative group hidden sm:block">
          <button className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-900/90 border border-slate-800 hover:border-slate-700 text-xs text-slate-200 transition-colors">
            <div className="w-2 h-2 rounded-full bg-emerald-400" />
            <span className="font-semibold text-white truncate max-w-[160px]">
              {currentProject.name}
            </span>
            <span className="text-[10px] text-slate-500 font-mono hidden lg:inline">
              ({currentProject.branch})
            </span>
            <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
          </button>

          {/* Switcher Menu */}
          <div className="absolute top-full left-0 mt-1.5 w-64 p-1.5 rounded-xl bg-[#0e131f] border border-slate-800 shadow-2xl opacity-0 translate-y-1 invisible group-hover:opacity-100 group-hover:translate-y-0 group-hover:visible transition-all duration-200 z-50">
            <div className="px-2 py-1 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
              Switch Repository
            </div>
            {SAMPLE_PROJECTS.map(p => (
              <button
                key={p.id}
                onClick={() => onSelectProject(p)}
                className={`w-full text-left px-2.5 py-2 rounded-lg text-xs flex items-center justify-between transition-colors ${
                  p.id === currentProject.id
                    ? 'bg-brand-500/10 text-brand-300 font-medium'
                    : 'text-slate-300 hover:bg-slate-800/80'
                }`}
              >
                <div className="truncate">
                  <div className="font-medium text-white truncate">{p.name}</div>
                  <div className="text-[10px] text-slate-400 truncate">{p.fullName}</div>
                </div>
                {p.id === currentProject.id && (
                  <ShieldCheck className="w-3.5 h-3.5 text-brand-400 shrink-0" />
                )}
              </button>
            ))}
            <div className="border-t border-slate-800/80 my-1 pt-1">
              <button
                onClick={onOpenImportModal}
                className="w-full text-left px-2.5 py-1.5 rounded-lg text-xs text-cyan-400 hover:bg-cyan-500/10 flex items-center gap-1.5 transition-colors font-medium"
              >
                <PlusCircle className="w-3.5 h-3.5" />
                <span>Connect GitHub Repository...</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Center Command Search Trigger */}
      <div className="flex-1 max-w-md mx-4 hidden md:block">
        <button
          onClick={onOpenCommandPalette}
          className="w-full flex items-center justify-between px-3 py-1.5 rounded-xl bg-slate-900/80 hover:bg-slate-900 border border-slate-800 hover:border-slate-700 text-xs text-slate-400 transition-all shadow-inner"
        >
          <div className="flex items-center gap-2">
            <Search className="w-3.5 h-3.5 text-slate-400" />
            <span>Search components, files, flows, tech...</span>
          </div>
          <kbd className="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 font-mono text-[10px] text-slate-400">
            Ctrl + K
          </kbd>
        </button>
      </div>

      {/* Right Controls */}
      <div className="flex items-center gap-2">
        {/* Sync Button */}
        <button
          onClick={onSyncRepo}
          disabled={isSyncing}
          className="p-2 rounded-xl bg-slate-900 border border-slate-800 hover:border-slate-700 text-slate-300 hover:text-white transition-colors"
          title="Sync / Re-analyze repository"
        >
          <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-spin text-cyan-400' : ''}`} />
        </button>

        {/* GitHub Direct Link */}
        {currentProject.repoUrl && (
          <a
            href={currentProject.repoUrl}
            target="_blank"
            rel="noreferrer"
            className="hidden lg:flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-800 hover:border-slate-700 text-xs text-slate-300 hover:text-white transition-colors"
          >
            <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
            </svg>
            <span>GitHub</span>
            <ExternalLink className="w-3 h-3 text-slate-500" />
          </a>
        )}

        {/* Import Repo Button */}
        <button
          onClick={onOpenImportModal}
          className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-brand-600/20 hover:bg-brand-600/30 text-brand-300 border border-brand-500/30 font-medium text-xs transition-colors"
        >
          <PlusCircle className="w-3.5 h-3.5 text-brand-400" />
          <span>Connect Repo</span>
        </button>

        {/* Export Button */}
        <button
          onClick={onOpenExportModal}
          className="p-2 rounded-xl bg-slate-900 border border-slate-800 hover:border-slate-700 text-slate-300 hover:text-white transition-colors"
          title="Export Architecture & Reports"
        >
          <Download className="w-4 h-4" />
        </button>

        {/* Settings Button */}
        <button
          onClick={onOpenSettingsModal}
          className="p-2 rounded-xl bg-slate-900 border border-slate-800 hover:border-slate-700 text-slate-300 hover:text-white transition-colors"
          title="Settings & AI Providers"
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
};
