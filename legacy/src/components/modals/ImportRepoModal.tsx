import React, { useState } from 'react';
import { Project } from '../../types';
import { parseGitHubUrl, fetchGitHubRepoData } from '../../services/githubService';
import { SAMPLE_PROJECTS } from '../../data/sampleProjects';
import {
  PlusCircle,
  X,
  Sparkles,
  CheckCircle2,
  AlertCircle,
  ShieldCheck,
  Cpu,
  Layers,
} from 'lucide-react';

interface ImportRepoModalProps {
  isOpen: boolean;
  onClose: () => void;
  onProjectImported: (project: Project) => void;
}

export const ImportRepoModal: React.FC<ImportRepoModalProps> = ({
  isOpen,
  onClose,
  onProjectImported,
}) => {
  const [repoInput, setRepoInput] = useState('');
  const [githubToken, setGithubToken] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [currentStepText, setCurrentStepText] = useState('');
  const [progressPercent, setProgressPercent] = useState(0);
  const [errorMessage, setErrorMessage] = useState('');

  if (!isOpen) return null;

  const handleImportLiveRepo = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage('');

    const parsed = parseGitHubUrl(repoInput);
    if (!parsed) {
      setErrorMessage('Please enter a valid GitHub repository in "owner/repo" or "https://github.com/owner/repo" format.');
      return;
    }

    setIsLoading(true);
    setCurrentStepText('Connecting to GitHub API...');
    setProgressPercent(10);

    try {
      const importedProject = await fetchGitHubRepoData(
        parsed.owner,
        parsed.repo,
        githubToken.trim() || undefined,
        (step, pct) => {
          setCurrentStepText(step);
          setProgressPercent(pct);
        }
      );

      onProjectImported(importedProject);
      onClose();
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to ingest repository from GitHub. Check token and repo visibility.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleLoadSample = (sample: Project) => {
    onProjectImported(sample);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-md flex items-center justify-center p-4">
      <div className="w-full max-w-xl bg-[#0e131f] border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Modal Header */}
        <div className="p-5 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-brand-500/10 border border-brand-500/30 flex items-center justify-center text-brand-400">
              <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
              </svg>
            </div>
            <div>
              <h3 className="font-bold text-white text-sm">Connect GitHub Repository</h3>
              <p className="text-[11px] text-slate-400">
                Transform any public or authorized repository into a living architecture map
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={isLoading}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 space-y-6 text-xs">
          {/* Form */}
          <form onSubmit={handleImportLiveRepo} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-slate-300 font-semibold block">
                GitHub Repository URL or Name
              </label>
              <input
                type="text"
                placeholder="e.g. facebook/react or https://github.com/tiangolo/fastapi"
                value={repoInput}
                onChange={e => setRepoInput(e.target.value)}
                disabled={isLoading}
                className="w-full bg-slate-900 border border-slate-700/80 rounded-xl px-3.5 py-2.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-brand-500"
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-slate-400 font-medium block">
                  GitHub Personal Access Token <span className="text-slate-500">(Optional for private repos)</span>
                </label>
                <span className="text-[10px] text-slate-500 font-mono">repo / read:org</span>
              </div>
              <input
                type="password"
                placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                value={githubToken}
                onChange={e => setGithubToken(e.target.value)}
                disabled={isLoading}
                className="w-full bg-slate-900 border border-slate-700/80 rounded-xl px-3.5 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-brand-500"
              />
            </div>

            {/* Error Message */}
            {errorMessage && (
              <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 flex items-start gap-2 text-xs">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                <span>{errorMessage}</span>
              </div>
            )}

            {/* Loading & Progress Animation */}
            {isLoading && (
              <div className="p-4 rounded-xl bg-slate-950 border border-cyan-500/30 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-cyan-400 font-semibold flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping" />
                    {currentStepText}
                  </span>
                  <span className="font-mono text-cyan-300 font-bold">{progressPercent}%</span>
                </div>
                <div className="h-2 w-full bg-slate-800 rounded-full overflow-hidden">
                  <div
                    style={{ width: `${progressPercent}%` }}
                    className="h-full bg-gradient-to-r from-brand-500 to-cyan-400 transition-all duration-300"
                  />
                </div>
              </div>
            )}

            <button
              type="submit"
              disabled={!repoInput.trim() || isLoading}
              className="w-full py-2.5 px-4 rounded-xl bg-gradient-to-r from-brand-600 to-cyan-600 hover:from-brand-500 hover:to-cyan-500 text-white font-semibold text-xs flex items-center justify-center gap-2 shadow-lg shadow-brand-500/20 disabled:opacity-40 transition-all"
            >
              <PlusCircle className="w-4 h-4" />
              <span>{isLoading ? 'Ingesting Repository...' : 'Ingest & Analyze Repository'}</span>
            </button>
          </form>

          {/* Or Load Benchmark Showcase Repos */}
          <div className="space-y-3 pt-3 border-t border-slate-800">
            <div className="text-[10.5px] font-mono text-slate-400 uppercase font-semibold">
              Or Explore Pre-Analyzed Benchmark Repositories:
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {SAMPLE_PROJECTS.map(p => (
                <button
                  key={p.id}
                  onClick={() => handleLoadSample(p)}
                  disabled={isLoading}
                  className="p-3 rounded-xl bg-slate-900/80 hover:bg-slate-800 border border-slate-800 hover:border-slate-700 text-left transition-all group"
                >
                  <div className="font-semibold text-white group-hover:text-cyan-300 text-xs mb-1">
                    {p.name}
                  </div>
                  <div className="text-[11px] text-slate-400 line-clamp-2">{p.description}</div>
                  <div className="mt-2 text-[10px] font-mono text-cyan-400 flex items-center justify-between">
                    <span>{p.technologies.length} Techs</span>
                    <span>{p.nodes.length} Nodes</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
