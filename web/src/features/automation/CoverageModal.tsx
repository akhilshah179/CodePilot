import { AlertCircle, CheckCircle2, FileCode, ShieldAlert, X } from 'lucide-react';
import type { TraceCoverage } from '../../lib/api.ts';

interface Props {
  coverage?: TraceCoverage | null;
  onClose(): void;
  onSelectFlow(flowId: string): void;
}

export function CoverageModal({ coverage, onClose, onSelectFlow }: Props) {
  if (!coverage) return null;

  return (
    <div className="ae-modal-backdrop" onClick={onClose}>
      <div className="ae-modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="ae-modal-header">
          <div className="ae-modal-title-row">
            <ShieldAlert size={20} className="ae-modal-icon" />
            <div>
              <h3>Execution Trace Coverage & Reliability</h3>
              <p>Auditing verified execution paths versus unresolved dynamic hops.</p>
            </div>
          </div>
          <button className="ae-close-btn" onClick={onClose} aria-label="Close modal">
            <X size={18} />
          </button>
        </div>

        {/* Coverage Overview Stats */}
        <div className="ae-coverage-overview">
          <div className="ae-cov-score-box">
            <div className="ae-cov-percent">{coverage.coveragePercent}%</div>
            <div className="ae-cov-label">TRACE COVERAGE</div>
          </div>

          <div className="ae-cov-metrics-grid">
            <div className="ae-cov-metric">
              <span className="cov-num">{coverage.fullyTracedFlows} / {coverage.totalFlows}</span>
              <span className="cov-lbl">Fully Traced Flows</span>
            </div>
            <div className="ae-cov-metric">
              <span className="cov-num">{coverage.requests}</span>
              <span className="cov-lbl">Request Flows</span>
            </div>
            <div className="ae-cov-metric">
              <span className="cov-num">{coverage.backgroundFlows}</span>
              <span className="cov-lbl">Background Workers</span>
            </div>
            <div className="ae-cov-metric">
              <span className="cov-num">{coverage.entryPoints}</span>
              <span className="cov-lbl">Detected Entry Points</span>
            </div>
          </div>
        </div>

        {/* Unresolved Steps Audit Table */}
        <div className="ae-unresolved-section">
          <h4>
            Unresolved Execution Steps ({coverage.unresolvedSteps?.length ?? 0})
          </h4>
          <p className="ae-unresolved-desc">
            Points in the codebase where static tracing encountered dynamic calls, untyped callbacks, or runtime targets instead of guessing.
          </p>

          {(!coverage.unresolvedSteps || coverage.unresolvedSteps.length === 0) ? (
            <div className="ae-all-clean-notice">
              <CheckCircle2 size={18} />
              <span>All detected flows have complete end-to-end static resolution.</span>
            </div>
          ) : (
            <div className="ae-unresolved-table-wrapper">
              <table className="ae-unresolved-table">
                <thead>
                  <tr>
                    <th>Flow</th>
                    <th>Location</th>
                    <th>Reason</th>
                    <th>Explanation</th>
                  </tr>
                </thead>
                <tbody>
                  {coverage.unresolvedSteps.map((step, idx) => (
                    <tr key={idx} onClick={() => { onSelectFlow(step.flowId); onClose(); }}>
                      <td className="flow-cell">
                        <strong>{step.flowTitle}</strong>
                      </td>
                      <td className="loc-cell">
                        <code>{step.file}{step.line ? `:${step.line}` : ''}</code>
                      </td>
                      <td className="reason-cell">
                        <span className={`reason-pill reason-${step.reason.replace(/\s+/g, '-')}`}>
                          {step.reason}
                        </span>
                      </td>
                      <td className="exp-cell">{step.explanation}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
