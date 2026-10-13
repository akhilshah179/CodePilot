import React, { useState, useEffect } from 'react';
import { Project } from '../../types';
import { Search, Layers, Cpu, Activity, FileCode, ArrowRight, X } from 'lucide-react';

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  project: Project;
  onSelectNode: (nodeId: string) => void;
  onSelectTab: (tabId: string) => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  project,
  onSelectNode,
  onSelectTab,
}) => {
  const [query, setQuery] = useState('');

  // Handle Escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        if (isOpen) onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const q = query.toLowerCase();

  // Search matches
  const matchedNodes = project.nodes.filter(
    n => n.label.toLowerCase().includes(q) || n.description.toLowerCase().includes(q)
  );

  const matchedTech = project.technologies.filter(
    t => t.name.toLowerCase().includes(q) || t.purpose.toLowerCase().includes(q)
  );

  const matchedFlows = project.flows.filter(
    f => f.name.toLowerCase().includes(q) || f.trigger.toLowerCase().includes(q)
  );

  const matchedFiles = project.files.filter(f => f.path.toLowerCase().includes(q));

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-md flex items-start justify-center pt-24 px-4">
      <div className="w-full max-w-2xl bg-[#0e131f] border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Search Input Bar */}
        <div className="p-4 border-b border-slate-800 flex items-center gap-3">
          <Search className="w-5 h-5 text-cyan-400" />
          <input
            autoFocus
            type="text"
            placeholder="Type to search components, technologies, flows, files..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            className="flex-1 bg-transparent text-slate-100 placeholder-slate-500 text-sm focus:outline-none font-medium"
          />
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Results List */}
        <div className="max-h-96 overflow-y-auto p-3 space-y-4 text-xs">
          {/* Architecture Nodes */}
          {matchedNodes.length > 0 && (
            <div className="space-y-1">
              <div className="px-2 text-[10px] font-mono text-slate-400 uppercase font-semibold">
                Architecture Components ({matchedNodes.length})
              </div>
              {matchedNodes.slice(0, 5).map(node => (
                <button
                  key={node.id}
                  onClick={() => {
                    onSelectNode(node.id);
                    onSelectTab('architecture');
                    onClose();
                  }}
                  className="w-full text-left p-2.5 rounded-xl hover:bg-slate-800/80 flex items-center justify-between group transition-colors"
                >
                  <div className="flex items-center gap-2.5">
                    <Layers className="w-4 h-4 text-brand-400" />
                    <div>
                      <div className="font-semibold text-white group-hover:text-cyan-300">
                        {node.label}
                      </div>
                      <div className="text-[11px] text-slate-400 truncate max-w-md">
                        {node.description}
                      </div>
                    </div>
                  </div>
                  <span className="text-[10px] font-mono text-slate-500 uppercase">{node.layer}</span>
                </button>
              ))}
            </div>
          )}

          {/* Technologies */}
          {matchedTech.length > 0 && (
            <div className="space-y-1">
              <div className="px-2 text-[10px] font-mono text-slate-400 uppercase font-semibold">
                Verified Technologies ({matchedTech.length})
              </div>
              {matchedTech.slice(0, 4).map(tech => (
                <button
                  key={tech.id}
                  onClick={() => {
                    onSelectTab('technologies');
                    onClose();
                  }}
                  className="w-full text-left p-2.5 rounded-xl hover:bg-slate-800/80 flex items-center justify-between group transition-colors"
                >
                  <div className="flex items-center gap-2.5">
                    <Cpu className="w-4 h-4 text-emerald-400" />
                    <div>
                      <div className="font-semibold text-white group-hover:text-emerald-300">
                        {tech.name}
                      </div>
                      <div className="text-[11px] text-slate-400 truncate max-w-md">
                        {tech.purpose}
                      </div>
                    </div>
                  </div>
                  <span className="text-[10px] font-mono text-emerald-400">{tech.category}</span>
                </button>
              ))}
            </div>
          )}

          {/* Request Flows */}
          {matchedFlows.length > 0 && (
            <div className="space-y-1">
              <div className="px-2 text-[10px] font-mono text-slate-400 uppercase font-semibold">
                Request & Data Flows ({matchedFlows.length})
              </div>
              {matchedFlows.slice(0, 3).map(flow => (
                <button
                  key={flow.id}
                  onClick={() => {
                    onSelectTab('trace');
                    onClose();
                  }}
                  className="w-full text-left p-2.5 rounded-xl hover:bg-slate-800/80 flex items-center justify-between group transition-colors"
                >
                  <div className="flex items-center gap-2.5">
                    <Activity className="w-4 h-4 text-cyan-400" />
                    <div>
                      <div className="font-semibold text-white group-hover:text-cyan-300">
                        {flow.name}
                      </div>
                      <div className="text-[10px] text-slate-400 font-mono">{flow.trigger}</div>
                    </div>
                  </div>
                  <ArrowRight className="w-3.5 h-3.5 text-slate-500" />
                </button>
              ))}
            </div>
          )}

          {/* Files */}
          {matchedFiles.length > 0 && (
            <div className="space-y-1">
              <div className="px-2 text-[10px] font-mono text-slate-400 uppercase font-semibold">
                Source Files ({matchedFiles.length})
              </div>
              {matchedFiles.slice(0, 4).map(file => (
                <button
                  key={file.path}
                  onClick={() => {
                    onSelectTab('files');
                    onClose();
                  }}
                  className="w-full text-left p-2.5 rounded-xl hover:bg-slate-800/80 flex items-center justify-between group transition-colors"
                >
                  <div className="flex items-center gap-2.5">
                    <FileCode className="w-4 h-4 text-purple-400" />
                    <span className="font-mono text-slate-300 group-hover:text-purple-300">
                      {file.path}
                    </span>
                  </div>
                  <span className="text-[10px] font-mono text-slate-500">{file.size} B</span>
                </button>
              ))}
            </div>
          )}

          {matchedNodes.length === 0 && matchedTech.length === 0 && matchedFlows.length === 0 && (
            <div className="p-8 text-center text-slate-500 text-xs">
              No matching elements found for "{query}"
            </div>
          )}
        </div>

        {/* Footer info */}
        <div className="p-2.5 border-t border-slate-800/80 bg-slate-950/60 flex items-center justify-between text-[10px] text-slate-500 font-mono">
          <span>Navigate with mouse or arrow keys</span>
          <span>ESC to close</span>
        </div>
      </div>
    </div>
  );
};
