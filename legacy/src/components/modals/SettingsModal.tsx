import React, { useState } from 'react';
import { AISettings } from '../../services/aiService';
import { Settings, Bot, Key, Save, Check, X, ShieldCheck } from 'lucide-react';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  aiSettings: AISettings;
  onSaveAISettings: (settings: AISettings) => void;
  githubToken: string;
  onSaveGithubToken: (token: string) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  aiSettings,
  onSaveAISettings,
  githubToken,
  onSaveGithubToken,
}) => {
  const [provider, setProvider] = useState<AISettings['provider']>(aiSettings.provider || 'built-in');
  const [apiKey, setApiKey] = useState<string>(aiSettings.apiKey || '');
  const [model, setModel] = useState<string>(aiSettings.model || 'gpt-4o-mini');
  const [ghToken, setGhToken] = useState<string>(githubToken || '');
  const [savedSuccess, setSavedSuccess] = useState(false);

  if (!isOpen) return null;

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    onSaveAISettings({
      provider,
      apiKey: apiKey.trim() || undefined,
      model,
    });
    onSaveGithubToken(ghToken.trim());
    setSavedSuccess(true);
    setTimeout(() => {
      setSavedSuccess(false);
      onClose();
    }, 1000);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-md flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-[#0e131f] border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        <div className="p-5 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-purple-500/10 border border-purple-500/30 flex items-center justify-center text-purple-400">
              <Settings className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-bold text-white text-sm">Platform & AI Intelligence Settings</h3>
              <p className="text-[11px] text-slate-400">
                Configure LLM reasoning providers and GitHub connection credentials
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSave} className="p-6 space-y-5 text-xs">
          {/* AI Provider Section */}
          <div className="space-y-3">
            <div className="font-semibold text-slate-200 flex items-center gap-2">
              <Bot className="w-4 h-4 text-purple-400" />
              <span>AI Explainer & Chat Engine</span>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setProvider('built-in')}
                className={`p-3 rounded-xl border text-left transition-all ${
                  provider === 'built-in'
                    ? 'bg-purple-500/15 border-purple-500/50 text-white'
                    : 'bg-slate-900 border-slate-800 text-slate-400'
                }`}
              >
                <div className="font-bold text-xs">Built-in RAG (Zero Setup)</div>
                <div className="text-[10px] text-slate-400 mt-0.5">
                  Heuristic AST & Knowledge Graph engine
                </div>
              </button>

              <button
                type="button"
                onClick={() => setProvider('openai')}
                className={`p-3 rounded-xl border text-left transition-all ${
                  provider === 'openai'
                    ? 'bg-purple-500/15 border-purple-500/50 text-white'
                    : 'bg-slate-900 border-slate-800 text-slate-400'
                }`}
              >
                <div className="font-bold text-xs">Custom OpenAI Key</div>
                <div className="text-[10px] text-slate-400 mt-0.5">
                  Direct GPT-4o inference
                </div>
              </button>
            </div>

            {provider === 'openai' && (
              <div className="space-y-3 pt-2">
                <div className="space-y-1">
                  <label className="text-slate-400 font-medium">OpenAI API Key</label>
                  <input
                    type="password"
                    placeholder="sk-..."
                    value={apiKey}
                    onChange={e => setApiKey(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-700/80 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-purple-500"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-slate-400 font-medium">Model</label>
                  <select
                    value={model}
                    onChange={e => setModel(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-700/80 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-purple-500"
                  >
                    <option value="gpt-4o-mini">gpt-4o-mini (Fast & Recommended)</option>
                    <option value="gpt-4o">gpt-4o (Deep Reasoning)</option>
                  </select>
                </div>
              </div>
            )}
          </div>

          {/* GitHub Token Section */}
          <div className="space-y-3 pt-3 border-t border-slate-800">
            <div className="font-semibold text-slate-200 flex items-center gap-2">
              <svg className="w-4 h-4 fill-current text-cyan-400" viewBox="0 0 24 24">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
              </svg>
              <span>GitHub API Access Token</span>
            </div>
            <div className="space-y-1">
              <input
                type="password"
                placeholder="ghp_xxxxxxxxxxxxxxxxxxxx (Optional for private repos)"
                value={ghToken}
                onChange={e => setGhToken(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700/80 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500"
              />
              <p className="text-[10.5px] text-slate-500">
                Increases rate limit from 60 to 5,000 requests/hour and unlocks authorized private repositories.
              </p>
            </div>
          </div>

          {/* Save Button */}
          <div className="pt-2">
            <button
              type="submit"
              className="w-full py-2.5 px-4 rounded-xl bg-gradient-to-r from-brand-600 to-purple-600 hover:from-brand-500 hover:to-purple-500 text-white font-semibold text-xs flex items-center justify-center gap-2 shadow-lg shadow-purple-500/20 transition-all"
            >
              {savedSuccess ? (
                <>
                  <Check className="w-4 h-4 text-emerald-400" />
                  <span>Preferences Saved!</span>
                </>
              ) : (
                <>
                  <Save className="w-4 h-4" />
                  <span>Save Configuration</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
