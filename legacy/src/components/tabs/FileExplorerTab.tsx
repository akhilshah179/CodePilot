import React, { useState } from 'react';
import { Project, ProjectFile } from '../../types';
import {
  FolderTree,
  FileCode,
  Code2,
  Search,
  MessageSquare,
  AlertTriangle,
  ArrowRight,
  Layers,
  Sparkles,
} from 'lucide-react';

interface FileExplorerTabProps {
  project: Project;
  onNavigateTab: (tabId: string, extra?: any) => void;
}

export const FileExplorerTab: React.FC<FileExplorerTabProps> = ({
  project,
  onNavigateTab,
}) => {
  const [selectedFilePath, setSelectedFilePath] = useState<string>(
    project.files[0]?.path || ''
  );
  const [searchQuery, setSearchQuery] = useState('');

  const filteredFiles = project.files.filter(f =>
    f.path.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const selectedFile =
    project.files.find(f => f.path === selectedFilePath) || project.files[0];

  return (
    <div className="space-y-6 pb-12">
      {/* Header Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5 rounded-2xl bg-[#0e131f] border border-slate-800 shadow-xl">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="px-2.5 py-0.5 rounded-full bg-brand-500/10 text-brand-400 font-mono text-[11px] font-bold border border-brand-500/30 flex items-center gap-1">
              <FolderTree className="w-3.5 h-3.5" />
              AST & FILE INTELLIGENCE EXPLORER
            </span>
            <span className="text-xs text-slate-400 font-mono">{project.files.length} indexed files</span>
          </div>
          <h2 className="text-xl font-bold text-white tracking-tight">
            Repository File Hierarchy & Code Symbols
          </h2>
          <p className="text-xs text-slate-400">
            Inspect AST declarations, classes, exported routes, and dependencies for any indexed file.
          </p>
        </div>
      </div>

      {/* 2-Column Split: File list on left, AST symbol & source inspector on right */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: File Tree & Search (4 cols) */}
        <div className="lg:col-span-4 bg-[#0e131f] border border-slate-800 rounded-2xl p-4 shadow-xl space-y-3">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
            <input
              type="text"
              placeholder="Search repository files..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full bg-slate-900 border border-slate-800 rounded-xl pl-8 pr-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-brand-500"
            />
          </div>

          <div className="space-y-1 max-h-[550px] overflow-y-auto pr-1">
            {filteredFiles.map(file => {
              const isSelected = file.path === selectedFile?.path;
              return (
                <button
                  key={file.path}
                  onClick={() => setSelectedFilePath(file.path)}
                  className={`w-full text-left p-2.5 rounded-xl flex items-center justify-between text-xs transition-colors ${
                    isSelected
                      ? 'bg-brand-600/20 text-brand-300 font-semibold border border-brand-500/30'
                      : 'text-slate-300 hover:bg-slate-900/80 border border-transparent'
                  }`}
                >
                  <div className="flex items-center gap-2 truncate">
                    <FileCode className={`w-4 h-4 shrink-0 ${isSelected ? 'text-brand-400' : 'text-slate-500'}`} />
                    <span className="font-mono truncate">{file.path}</span>
                  </div>
                  <span className="text-[10px] font-mono text-slate-500 shrink-0">
                    {file.extension.toUpperCase()}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Right Column: AST Symbols, Imports & Content (8 cols) */}
        <div className="lg:col-span-8">
          {selectedFile ? (
            <div className="bg-[#0e131f] border border-slate-800 rounded-2xl p-6 shadow-2xl space-y-5">
              {/* File Header */}
              <div className="flex items-center justify-between pb-4 border-b border-slate-800">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <FileCode className="w-5 h-5 text-cyan-400" />
                    <h3 className="text-base font-bold text-white font-mono">{selectedFile.path}</h3>
                  </div>
                  <span className="text-xs text-slate-400 font-mono">
                    Type: <span className="text-cyan-400 uppercase font-semibold">{selectedFile.type}</span> • Size: {selectedFile.size} Bytes
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() =>
                      onNavigateTab('chat', {
                        initialPrompt: `Explain the purpose of \`${selectedFile.path}\` in ${project.name}, its exported symbols, and which services depend on it.`,
                      })
                    }
                    className="px-3 py-1.5 rounded-xl bg-purple-500/10 hover:bg-purple-500/20 text-purple-300 border border-purple-500/30 text-xs font-medium flex items-center gap-1.5 transition-colors"
                  >
                    <MessageSquare className="w-3.5 h-3.5" />
                    <span>Explain File</span>
                  </button>
                </div>
              </div>

              {/* AST Symbols Detected */}
              {selectedFile.symbols && selectedFile.symbols.length > 0 && (
                <div className="space-y-2">
                  <span className="text-xs font-semibold text-slate-400 font-mono uppercase">
                    AST Code Symbols Detected ({selectedFile.symbols.length})
                  </span>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {selectedFile.symbols.map((sym, i) => (
                      <div
                        key={i}
                        className="p-2.5 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between text-xs"
                      >
                        <div className="flex items-center gap-2">
                          <Code2 className="w-3.5 h-3.5 text-emerald-400" />
                          <span className="font-mono font-semibold text-white">{sym.name}</span>
                        </div>
                        <span className="px-2 py-0.5 rounded bg-slate-900 text-cyan-400 font-mono text-[10px] uppercase border border-slate-800">
                          {sym.kind} {sym.line ? `:L${sym.line}` : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Imports Detected */}
              {selectedFile.imports && selectedFile.imports.length > 0 && (
                <div className="space-y-2">
                  <span className="text-xs font-semibold text-slate-400 font-mono uppercase">
                    Import Dependencies ({selectedFile.imports.length})
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedFile.imports.map((imp, idx) => (
                      <span
                        key={idx}
                        className="px-2.5 py-1 rounded-lg bg-slate-900 border border-slate-800 font-mono text-xs text-brand-300"
                      >
                        import {imp}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Code Snippet / Manifest Content Preview */}
              {selectedFile.content && (
                <div className="space-y-2">
                  <span className="text-xs font-semibold text-slate-400 font-mono uppercase">
                    File Content Preview
                  </span>
                  <pre className="p-4 rounded-xl bg-slate-950 font-mono text-xs text-emerald-300 overflow-x-auto whitespace-pre-wrap border border-slate-800/90 max-h-72">
                    {selectedFile.content}
                  </pre>
                </div>
              )}
            </div>
          ) : (
            <div className="p-12 text-center bg-[#0e131f] border border-slate-800 rounded-2xl text-slate-500 text-xs">
              Select a file from the repository tree to inspect.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
