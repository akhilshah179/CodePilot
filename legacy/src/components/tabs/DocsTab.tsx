import React, { useState } from 'react';
import { Project } from '../../types';
import {
  FileText,
  Copy,
  Check,
  Download,
  BookOpen,
  Layers,
  Terminal,
  Server,
  Code2,
} from 'lucide-react';

interface DocsTabProps {
  project: Project;
  onOpenExportModal: () => void;
}

export const DocsTab: React.FC<DocsTabProps> = ({ project, onOpenExportModal }) => {
  const [activeDocSection, setActiveDocSection] = useState<
    'overview' | 'architecture' | 'api' | 'dataFlow' | 'setup' | 'deployment'
  >('overview');
  const [isCopied, setIsCopied] = useState(false);

  const docSections = [
    { id: 'overview', label: '1. Executive Overview', icon: BookOpen },
    { id: 'architecture', label: '2. System Architecture & Mermaid', icon: Layers },
    { id: 'api', label: '3. API Endpoints Reference', icon: Code2 },
    { id: 'dataFlow', label: '4. Data & Request Flow Journey', icon: Server },
    { id: 'setup', label: '5. Local Setup & Runbook', icon: Terminal },
    { id: 'deployment', label: '6. Production Deployment', icon: Server },
  ];

  const getDocContent = () => {
    switch (activeDocSection) {
      case 'overview':
        return project.docs.overview;
      case 'architecture':
        return project.docs.architecture;
      case 'api':
        return project.docs.apiReference;
      case 'dataFlow':
        return project.docs.dataFlow;
      case 'setup':
        return project.docs.setupGuide;
      case 'deployment':
        return project.docs.deployment;
      default:
        return project.docs.overview;
    }
  };

  const currentContent = getDocContent();

  const handleCopy = () => {
    navigator.clipboard.writeText(currentContent);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  return (
    <div className="space-y-6 pb-12">
      {/* Header Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5 rounded-2xl bg-[#0e131f] border border-slate-800 shadow-xl">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="px-2.5 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400 font-mono text-[11px] font-bold border border-cyan-500/30 flex items-center gap-1">
              <FileText className="w-3.5 h-3.5" />
              LIVING DOCUMENTATION GENERATOR
            </span>
            <span className="text-xs text-slate-400 font-mono">Automatically derived</span>
          </div>
          <h2 className="text-xl font-bold text-white tracking-tight">
            Comprehensive Engineering Runbook & Specs
          </h2>
          <p className="text-xs text-slate-400">
            Exportable living technical documentation that synchronizes with repository changes.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleCopy}
            className="px-3.5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs text-slate-200 font-medium flex items-center gap-1.5 transition-colors"
          >
            {isCopied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{isCopied ? 'Copied' : 'Copy Markdown'}</span>
          </button>
          <button
            onClick={onOpenExportModal}
            className="px-3.5 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-medium flex items-center gap-1.5 shadow-lg shadow-cyan-500/20 transition-all"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export Docs / PDF</span>
          </button>
        </div>
      </div>

      {/* 2-Column Split: Doc TOC on left, Markdown Preview on right */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left TOC Column (4 cols) */}
        <div className="lg:col-span-4 space-y-2">
          <div className="text-xs font-bold text-slate-400 uppercase tracking-wider px-1 font-mono">
            Document Sections
          </div>

          <div className="space-y-1.5">
            {docSections.map(sec => {
              const Icon = sec.icon;
              const isActive = activeDocSection === sec.id;
              return (
                <button
                  key={sec.id}
                  onClick={() => setActiveDocSection(sec.id as any)}
                  className={`w-full text-left p-3 rounded-xl flex items-center gap-3 text-xs font-medium transition-all ${
                    isActive
                      ? 'bg-brand-600/20 text-white border border-brand-500/40 shadow-md shadow-brand-500/10'
                      : 'bg-[#0e131f] text-slate-400 hover:text-slate-200 hover:bg-[#131b2e] border border-slate-800'
                  }`}
                >
                  <Icon className={`w-4 h-4 ${isActive ? 'text-cyan-400' : 'text-slate-500'}`} />
                  <span>{sec.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Right Markdown Preview (8 cols) */}
        <div className="lg:col-span-8 bg-[#0e131f] border border-slate-800 rounded-2xl p-6 shadow-2xl space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800 text-xs">
            <span className="font-mono text-cyan-400 font-bold uppercase">Markdown Living View</span>
            <span className="text-slate-500 font-mono text-[11px]">Rendered Spec</span>
          </div>

          <div className="prose prose-invert max-w-none text-xs leading-relaxed space-y-4">
            <pre className="p-4 rounded-xl bg-slate-950 font-mono text-xs text-slate-200 overflow-x-auto whitespace-pre-wrap border border-slate-800/90 font-medium">
              {currentContent}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
};
