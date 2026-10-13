import { ExternalLink, Info, ShieldCheck, X } from 'lucide-react';
import type { MainFlowsCoverage, Project } from '../../lib/api.ts';
import { fileOpener } from '../../lib/fileLinks.ts';

interface Props {
  project: Project;
  commitSha?: string | null;
  coverage: MainFlowsCoverage;
  onClose(): void;
}

export function FoldedCoverageModal({ project, commitSha, coverage, onClose }: Props) {
  const opener = fileOpener(project, commitSha ?? null);
  const openCode = (path: string, line?: number) => {
    const href = opener.href(path, line);
    if (href) window.open(href, '_blank', 'noreferrer');
  };

  return (
    <div className="ae-modal-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="fc-title">
      <div className="ae-modal-content aev3-coverage-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ae-modal-header">
          <div className="ae-modal-title-row">
            <ShieldCheck size={20} className="ae-modal-icon" />
            <div>
              <h3 id="fc-title">Entry Points Audit & Folded Items</h3>
              <p>Full disclosure of covered, folded-in, and minor omitted entry points.</p>
            </div>
          </div>
          <button className="ae-close-btn" onClick={onClose} aria-label="Close modal">
            <X size={18} />
          </button>
        </div>

        <div className="aev3-cov-stat-banner">
          <div className="aev3-cov-stat-num">{coverage.coveragePercent}%</div>
          <div className="aev3-cov-stat-desc">
            Covers <strong>{coverage.coveredEntryPoints}</strong> of <strong>{coverage.totalEntryPoints}</strong> entry points.
            {' '}{coverage.minorFoldedOrOmittedCount} minor ones (health check, redirects, share links, static config) are folded into the nearest main flow or omitted honestly.
          </div>
        </div>

        <div className="aev3-folded-table-container">
          <table className="aev3-folded-table">
            <thead>
              <tr>
                <th>Entry Point / Route</th>
                <th>Category</th>
                <th>Disposition / Reason</th>
                <th>Source Code</th>
              </tr>
            </thead>
            <tbody>
              {coverage.foldedItems.map((item) => (
                <tr key={item.id}>
                  <td className="aev3-route-cell">
                    <code>{item.detail || item.name}</code>
                  </td>
                  <td>
                    <span className={`aev3-kind-pill kind-${item.kind}`}>{item.kind}</span>
                  </td>
                  <td className="aev3-reason-cell">{item.reason}</td>
                  <td className="aev3-source-cell">
                    {item.file ? (
                      <button
                        type="button"
                        className="aev3-file-link"
                        onClick={() => openCode(item.file, item.line)}
                        title={`Open ${item.file}${item.line ? `:${item.line}` : ''}`}
                      >
                        <code>
                          {item.file.split('/').slice(-2).join('/')}
                          {item.line ? `:${item.line}` : ''}
                        </code>
                        <ExternalLink size={10} />
                      </button>
                    ) : (
                      <span className="faint">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
