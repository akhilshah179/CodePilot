import React, { useState, useMemo } from 'react';
import { Project, Technology, TechnologyCategory, ConfidenceLevel } from '../../types';
import { EvidenceBadge } from '../visualizer/EvidenceBadge';
import {
  Cpu,
  Search,
  Filter,
  Radio,
  FileCode,
  Zap,
  Layers,
  ShieldCheck,
  Code2,
  ExternalLink,
} from 'lucide-react';

interface TechnologiesTabProps {
  project: Project;
  onNavigateTab: (tabId: string, extra?: any) => void;
}

export const TechnologiesTab: React.FC<TechnologiesTabProps> = ({ project, onNavigateTab }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [selectedConfidence, setSelectedConfidence] = useState<string>('all');
  const [selectedTech, setSelectedTech] = useState<Technology | null>(project.technologies[0] || null);

  const categories = useMemo(() => {
    const set = new Set<string>();
    project.technologies.forEach(t => set.add(t.category));
    return Array.from(set);
  }, [project.technologies]);

  const filteredTech = useMemo(() => {
    return project.technologies.filter(tech => {
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const matchesName = tech.name.toLowerCase().includes(q);
        const matchesPurpose = tech.purpose.toLowerCase().includes(q);
        const matchesWhy = tech.whyUsed.toLowerCase().includes(q);
        if (!matchesName && !matchesPurpose && !matchesWhy) return false;
      }
      if (selectedCategory !== 'all' && tech.category !== selectedCategory) return false;
      if (selectedConfidence !== 'all' && tech.confidence !== selectedConfidence) return false;
      return true;
    });
  }, [project.technologies, searchQuery, selectedCategory, selectedConfidence]);

  return (
    <div className="space-y-6 pb-12">
      {/* Header & Stats Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5 rounded-2xl bg-[#0e131f] border border-slate-800">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
            <Cpu className="w-5 h-5 text-emerald-400" />
            Technology Detection & Evidence Engine
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Every technology is backed by repository manifests, AST imports, and active code calls.
          </p>
        </div>

        {/* Confidence Stats Pills */}
        <div className="flex items-center gap-2 text-xs font-mono">
          <div className="px-3 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>
              {project.technologies.filter(t => t.confidence === 'CONFIRMED').length} Confirmed
            </span>
          </div>
          <div className="px-3 py-1 rounded-lg bg-blue-500/10 border border-blue-500/30 text-blue-400">
            {project.technologies.filter(t => t.confidence === 'STRONG_INFERENCE').length} Inferred
          </div>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-1 max-w-md">
          <div className="relative w-full">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
            <input
              type="text"
              placeholder="Search technologies, roles, purposes..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full bg-[#0e131f] border border-slate-800 rounded-xl pl-9 pr-3 py-2 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-brand-500"
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <select
            value={selectedCategory}
            onChange={e => setSelectedCategory(e.target.value)}
            className="bg-[#0e131f] border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-300 focus:outline-none focus:border-brand-500"
          >
            <option value="all">All Categories ({categories.length})</option>
            {categories.map(cat => (
              <option key={cat} value={cat}>
                {cat}
              </option>
            ))}
          </select>

          <select
            value={selectedConfidence}
            onChange={e => setSelectedConfidence(e.target.value)}
            className="bg-[#0e131f] border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-300 focus:outline-none focus:border-brand-500"
          >
            <option value="all">All Confidence Levels</option>
            <option value="CONFIRMED">Confirmed</option>
            <option value="STRONG_INFERENCE">Strong Inference</option>
            <option value="POSSIBLE">Possible</option>
          </select>
        </div>
      </div>

      {/* Main 2-Column Split View: List on left, Deep Evidence Inspector on right */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Tech Cards Grid (5 cols) */}
        <div className="lg:col-span-5 space-y-3">
          {filteredTech.map(tech => {
            const isSelected = selectedTech?.id === tech.id;
            return (
              <div
                key={tech.id}
                onClick={() => setSelectedTech(tech)}
                className={`p-4 rounded-xl cursor-pointer transition-all ${
                  isSelected
                    ? 'bg-[#111726] border-2 border-brand-500 shadow-xl shadow-brand-500/10'
                    : 'bg-[#0e131f] hover:bg-[#131b2e] border border-slate-800 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2.5">
                    <span
                      className="w-3 h-3 rounded-full shrink-0"
                      style={{ backgroundColor: tech.color || '#0e8ce9' }}
                    />
                    <span className="font-bold text-white text-sm">{tech.name}</span>
                    <span className="font-mono text-[10.5px] text-slate-400 bg-slate-800/80 px-1.5 py-0.5 rounded">
                      v{tech.version}
                    </span>
                  </div>
                  <EvidenceBadge confidence={tech.confidence} size="sm" />
                </div>

                <div className="text-xs text-slate-300 line-clamp-2 leading-relaxed mb-3">
                  {tech.purpose}
                </div>

                <div className="flex items-center justify-between text-[10.5px] font-mono text-slate-400 pt-2 border-t border-slate-800/60">
                  <span className="text-cyan-400 uppercase font-semibold">{tech.category}</span>
                  <span className="text-slate-400">{tech.evidence.length} evidence lines</span>
                </div>
              </div>
            );
          })}

          {filteredTech.length === 0 && (
            <div className="p-8 text-center bg-[#0e131f] border border-slate-800 rounded-xl text-slate-500 text-xs">
              No technologies match the filter criteria.
            </div>
          )}
        </div>

        {/* Right Column: Deep Evidence & Why-Used Inspector (7 cols) */}
        <div className="lg:col-span-7">
          {selectedTech ? (
            <div className="bg-[#0e131f] border border-slate-800 rounded-2xl p-6 shadow-2xl space-y-6 sticky top-24">
              {/* Tech Header */}
              <div className="flex items-start justify-between pb-4 border-b border-slate-800">
                <div className="space-y-1">
                  <div className="flex items-center gap-3">
                    <span
                      className="w-4 h-4 rounded-full shadow-md"
                      style={{ backgroundColor: selectedTech.color || '#0e8ce9' }}
                    />
                    <h3 className="text-xl font-bold text-white">{selectedTech.name}</h3>
                    <span className="px-2 py-0.5 rounded-md bg-slate-800 font-mono text-xs text-slate-300 border border-slate-700">
                      v{selectedTech.version}
                    </span>
                  </div>
                  <span className="text-xs text-cyan-400 font-mono font-medium block">
                    {selectedTech.category} • {selectedTech.role}
                  </span>
                </div>
                <EvidenceBadge confidence={selectedTech.confidence} />
              </div>

              {/* Purpose & Why Used Section */}
              <div className="space-y-4 text-xs">
                <div>
                  <span className="text-slate-400 font-semibold block mb-1">Detected Role & Purpose</span>
                  <p className="text-slate-200 leading-relaxed bg-slate-900/60 p-3 rounded-xl border border-slate-800">
                    {selectedTech.purpose}
                  </p>
                </div>

                <div>
                  <span className="text-amber-300 font-semibold flex items-center gap-1.5 mb-1">
                    <Zap className="w-3.5 h-3.5 text-amber-400" />
                    Why This Technology Appears to Have Been Chosen
                  </span>
                  <p className="text-slate-200 leading-relaxed bg-amber-500/5 p-3 rounded-xl border border-amber-500/20 text-[12px]">
                    {selectedTech.whyUsed}
                  </p>
                </div>
              </div>

              {/* Used in Files */}
              <div className="space-y-2">
                <span className="text-slate-400 font-semibold text-xs flex items-center gap-1.5">
                  <FileCode className="w-3.5 h-3.5 text-slate-400" />
                  Files Ingesting or Importing {selectedTech.name} ({selectedTech.files.length})
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {selectedTech.files.map(f => (
                    <span
                      key={f}
                      className="px-2.5 py-1 rounded-lg bg-slate-900 border border-slate-800 font-mono text-[11px] text-cyan-300"
                    >
                      {f}
                    </span>
                  ))}
                </div>
              </div>

              {/* Verified Code Evidence */}
              <div className="space-y-3">
                <span className="text-slate-400 font-semibold text-xs flex items-center gap-1.5">
                  <Radio className="w-3.5 h-3.5 text-emerald-400" />
                  Underlying Repository Evidence ({selectedTech.evidence.length})
                </span>

                <div className="space-y-3 max-h-80 overflow-y-auto pr-1">
                  {selectedTech.evidence.map((ev, idx) => (
                    <div
                      key={idx}
                      className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 space-y-2"
                    >
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="font-mono text-cyan-400 font-semibold">
                          {ev.file}
                          {ev.line ? `:${ev.line}` : ''}
                        </span>
                        <span className="px-2 py-0.5 rounded bg-slate-800 text-[10px] font-mono text-emerald-400 uppercase font-bold border border-slate-700">
                          {ev.type}
                        </span>
                      </div>
                      <pre className="p-2.5 rounded-lg bg-slate-900/90 font-mono text-xs text-emerald-300 overflow-x-auto whitespace-pre-wrap border border-slate-800/80">
                        {ev.snippet}
                      </pre>
                      <p className="text-[11px] text-slate-400 italic">{ev.description}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Quick Action Button */}
              <div className="pt-2">
                <button
                  onClick={() =>
                    onNavigateTab('chat', {
                      initialPrompt: `Explain why ${selectedTech.name} is used in this repository, its architecture connections, and what would happen if it were replaced.`,
                    })
                  }
                  className="w-full py-2.5 px-4 rounded-xl bg-gradient-to-r from-brand-600 to-cyan-600 hover:from-brand-500 hover:to-cyan-500 text-white font-medium text-xs flex items-center justify-center gap-2 shadow-lg shadow-brand-500/20 transition-all"
                >
                  <Cpu className="w-4 h-4" />
                  Ask AI About {selectedTech.name} in this Codebase
                </button>
              </div>
            </div>
          ) : (
            <div className="p-12 text-center bg-[#0e131f] border border-slate-800 rounded-2xl text-slate-500 text-xs">
              Select a technology to inspect its evidence and reasoning.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
