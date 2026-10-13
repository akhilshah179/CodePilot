import { ArrowRightLeft, X } from 'lucide-react';

interface CandidateItem {
  id: string;
  name: string;
  purpose?: string;
  score?: number;
  stepCount?: number;
  nodeCount?: number;
  tools: string[];
}

interface Props {
  currentFlow: { id: string; name: string };
  candidates: CandidateItem[];
  onSwap(replacementFlowId: string): void;
  onClose(): void;
}

export function SwapFlowModal({ currentFlow, candidates, onSwap, onClose }: Props) {
  // Filter out the current active flow from candidates
  const available = candidates.filter((c) => c.id !== currentFlow.id);

  return (
    <div className="ae-modal-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="swap-title">
      <div className="ae-modal-content aev3-swap-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ae-modal-header">
          <div className="ae-modal-title-row">
            <ArrowRightLeft size={20} className="ae-modal-icon" />
            <div>
              <h3 id="swap-title">Use a Different Flow Here</h3>
              <p>
                Replace <strong>{currentFlow.name}</strong> with another ranked capability flow for this project.
              </p>
            </div>
          </div>
          <button className="ae-close-btn" onClick={onClose} aria-label="Close modal">
            <X size={18} />
          </button>
        </div>

        <div className="aev3-swap-body">
          {available.length === 0 ? (
            <p className="aev3-text faint">
              No alternative capability flows available. All detected execution paths are already covered in the main flows.
            </p>
          ) : (
            <div className="aev3-candidates-list">
              {available.map((c, idx) => (
                <div key={c.id} className="aev3-candidate-card">
                  <div className="aev3-candidate-header">
                    <div className="aev3-candidate-title-block">
                      <span className="aev3-candidate-rank">Rank #{idx + 1}</span>
                      <h4 className="aev3-candidate-name">{c.name}</h4>
                    </div>
                    <span className="aev3-candidate-score">Score: {c.score}</span>
                  </div>

                  <p className="aev3-candidate-purpose">{c.purpose}</p>

                  <div className="aev3-candidate-meta">
                    <span className="aev3-candidate-steps">{c.stepCount} steps</span>
                    {c.tools.length > 0 && (
                      <div className="aev3-candidate-tools">
                        {c.tools.slice(0, 4).map((t) => (
                          <span key={t} className="aev3-candidate-tool-pill">
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <button
                    type="button"
                    className="aev3-swap-action-btn"
                    onClick={() => {
                      onSwap(c.id);
                      onClose();
                    }}
                  >
                    <span>Use this flow</span>
                    <ArrowRightLeft size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
