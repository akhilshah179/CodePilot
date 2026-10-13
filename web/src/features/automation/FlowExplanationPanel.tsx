import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Cpu,
  Database,
  ExternalLink,
  HelpCircle,
  Layers,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import type { MainFlow, Project } from '../../lib/api.ts';
import { fileOpener } from '../../lib/fileLinks.ts';

interface Props {
  project: Project;
  commitSha?: string | null;
  flow: MainFlow;
  activeStageIndex: number;
  onSelectStage(stageIndex: number): void;
}

export function FlowExplanationPanel({ project, commitSha, flow, activeStageIndex, onSelectStage }: Props) {
  const exp = flow.explanation;
  const opener = fileOpener(project, commitSha ?? null);
  const openCode = (path: string, line?: number) => {
    const href = opener.href(path, line);
    if (href) window.open(href, '_blank', 'noreferrer');
  };

  return (
    <aside className="aev3-panel" aria-label="Flow explanation">
      {/* Panel Header */}
      <div className="aev3-panel-head">
        <div className="aev3-panel-tag">
          <Sparkles size={13} className="aev3-accent-icon" />
          <span>EVIDENCE-GROUNDED EXPLANATION</span>
        </div>
        <h3 className="aev3-panel-title">{flow.name}</h3>
        <p className="aev3-panel-purpose">{flow.purpose}</p>
      </div>

      <div className="aev3-panel-body">
        {/* 1. What it does */}
        <section className="aev3-section">
          <h4 className="aev3-section-title">What it does</h4>
          <p className="aev3-text">{exp.whatItDoes}</p>
        </section>

        {/* 2. Why it exists */}
        <section className="aev3-section">
          <h4 className="aev3-section-title">Why it exists</h4>
          <p className="aev3-text">{exp.whyItExists}</p>
        </section>

        {/* 3. Step by step */}
        <section className="aev3-section">
          <div className="aev3-section-head">
            <h4 className="aev3-section-title">Step by step</h4>
            <span className="aev3-badge-subtle">{exp.stepByStep.length} stages</span>
          </div>
          <ol className="aev3-steps-list">
            {exp.stepByStep.map((s, idx) => {
              const isActive = activeStageIndex === idx;
              return (
                <li
                  key={s.stepNumber}
                  className={`aev3-step-item ${isActive ? 'is-active' : ''}`}
                  onClick={() => onSelectStage(idx)}
                >
                  <div className="aev3-step-num-pill">{String(s.stepNumber).padStart(2, '0')}</div>
                  <div className="aev3-step-content">
                    <div className="aev3-step-header">
                      <span className="aev3-step-name">{s.title}</span>
                      {s.file && (
                        <button
                          type="button"
                          className="aev3-file-link"
                          onClick={(e) => {
                            e.stopPropagation();
                            openCode(s.file, s.line);
                          }}
                          title={`Open ${s.file}${s.line ? `:${s.line}` : ''}`}
                        >
                          <code>
                            {s.file.split('/').slice(-2).join('/')}
                            {s.line ? `:${s.line}` : ''}
                          </code>
                          <ExternalLink size={10} />
                        </button>
                      )}
                    </div>
                    <p className="aev3-step-desc">{s.narrative}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>

        {/* 4. Tools and services */}
        <section className="aev3-section">
          <h4 className="aev3-section-title">Tools and services</h4>
          <div className="aev3-tools-grid">
            {exp.toolsAndServices.map((t) => (
              <div key={t.name} className="aev3-tool-card">
                <div className="aev3-tool-name">
                  <Cpu size={12} className="aev3-tool-icon" />
                  <strong>{t.name}</strong>
                </div>
                <p className="aev3-tool-role">{t.role}</p>
                {t.file && (
                  <button
                    type="button"
                    className="aev3-file-link small"
                    onClick={() => openCode(t.file!, t.line)}
                  >
                    <code>
                      {t.file.split('/').slice(-2).join('/')}
                      {t.line ? `:${t.line}` : ''}
                    </code>
                    <ExternalLink size={9} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* 5. Data in and out */}
        <section className="aev3-section">
          <h4 className="aev3-section-title">Data in and out</h4>
          <div className="aev3-data-grid">
            <div className="aev3-data-box">
              <span className="aev3-data-label">Key inputs</span>
              <ul className="aev3-bullet-list">
                {exp.dataInAndOut.inputs.map((inItem, i) => (
                  <li key={i}>{inItem}</li>
                ))}
              </ul>
            </div>
            <div className="aev3-data-box">
              <span className="aev3-data-label">What is stored</span>
              <ul className="aev3-bullet-list">
                {exp.dataInAndOut.stored.map((stItem, i) => (
                  <li key={i}>{stItem}</li>
                ))}
              </ul>
            </div>
            <div className="aev3-data-box">
              <span className="aev3-data-label">What is returned</span>
              <ul className="aev3-bullet-list">
                {exp.dataInAndOut.returned.map((retItem, i) => (
                  <li key={i}>{retItem}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* 6. If something fails */}
        <section className="aev3-section">
          <h4 className="aev3-section-title">If something fails</h4>
          <div className="aev3-failures-list">
            {exp.ifSomethingFails.map((fail, i) => (
              <div key={i} className="aev3-failure-card">
                <div className="aev3-failure-head">
                  <AlertTriangle size={13} className="aev3-warn-icon" />
                  <strong>{fail.failurePoint}</strong>
                </div>
                <div className="aev3-failure-details">
                  <div>
                    <span className="aev3-prop-label">Handling:</span> {fail.handling}
                  </div>
                  <div>
                    <span className="aev3-prop-label">User sees:</span> {fail.userVisibleImpact}
                  </div>
                </div>
                {fail.file && (
                  <button
                    type="button"
                    className="aev3-file-link small"
                    onClick={() => openCode(fail.file!, fail.line)}
                  >
                    <code>
                      {fail.file.split('/').slice(-2).join('/')}
                      {fail.line ? `:${fail.line}` : ''}
                    </code>
                    <ExternalLink size={9} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* 7. Included smaller flows */}
        <section className="aev3-section">
          <div className="aev3-section-head">
            <h4 className="aev3-section-title">Included smaller flows</h4>
            <span className="aev3-badge-subtle">{exp.includedSmallerFlows.length} folded</span>
          </div>
          {exp.includedSmallerFlows.length === 0 ? (
            <p className="aev3-text faint">No additional endpoints folded into this flow.</p>
          ) : (
            <div className="aev3-folded-list">
              {exp.includedSmallerFlows.map((fm, i) => (
                <div key={i} className="aev3-folded-item">
                  <div className="aev3-folded-head">
                    <span className="aev3-folded-name">{fm.name}</span>
                    {fm.file && (
                      <button
                        type="button"
                        className="aev3-file-link small"
                        onClick={() => openCode(fm.file!, fm.line)}
                      >
                        <code>
                          {fm.file.split('/').slice(-2).join('/')}
                          {fm.line ? `:${fm.line}` : ''}
                        </code>
                        <ExternalLink size={9} />
                      </button>
                    )}
                  </div>
                  <p className="aev3-folded-detail">{fm.detail}</p>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 8. Confidence */}
        <section className="aev3-section aev3-confidence-sec">
          <div className="aev3-section-head">
            <h4 className="aev3-section-title">Confidence</h4>
            <span className="aev3-confidence-pill">
              <CheckCircle2 size={12} />
              <span>{exp.confidence.percent}% Traced</span>
            </span>
          </div>
          <p className="aev3-text">
            {exp.confidence.fullyTracedCount} of {exp.confidence.totalCount} stages fully traced to verified source code.
          </p>
          {exp.confidence.unknownSteps.length > 0 && (
            <div className="aev3-unknown-steps-box">
              <span className="aev3-prop-label">Unresolved next hops:</span>
              <ul>
                {exp.confidence.unknownSteps.map((u, i) => (
                  <li key={i}>
                    <strong>{u.stage}:</strong> {u.reason} ({u.file}:{u.line ?? 1})
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}
