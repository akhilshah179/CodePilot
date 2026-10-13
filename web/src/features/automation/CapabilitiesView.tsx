import {
  Boxes,
  ChevronDown,
  ChevronRight,
  Cpu,
  ExternalLink,
  Layers,
  Network,
  Server,
  Workflow,
} from 'lucide-react';
import { useState } from 'react';
import type { CapabilityGroup, Flow } from '../../lib/api.ts';

interface Props {
  capabilities: CapabilityGroup[];
  allFlows: Flow[];
  onSelectFlow(flowId: string): void;
}

export function CapabilitiesView({ capabilities, allFlows, onSelectFlow }: Props) {
  const [expandedCap, setExpandedCap] = useState<string | null>(capabilities[0]?.id ?? null);
  const flowMap = new Map(allFlows.map((f) => [f.id, f]));

  if (!capabilities || capabilities.length === 0) {
    return (
      <div className="ae-story-empty">
        <Boxes size={32} />
        <h3>No Capability Groups Detected</h3>
        <p>The repository could not be partitioned into domain capabilities from evidence.</p>
      </div>
    );
  }

  return (
    <div className="ae-capabilities-container">
      {/* Narrative Header */}
      <div className="ae-story-header">
        <div className="ae-story-badge">
          <Boxes size={13} />
          <span>CAPABILITY GROUPS · LEVEL 2</span>
        </div>
        <h2 className="ae-story-title">Functional Architecture & Capabilities</h2>
        <p className="ae-story-desc">
          Discovered from repository route prefixes, feature packages, shared services, and call relationships.
          Each capability coordinates real execution units verified against source code.
        </p>
      </div>

      {/* Grid of Capability Cards */}
      <div className="ae-capabilities-grid">
        {capabilities.map((cap) => {
          const isExpanded = expandedCap === cap.id;
          const memberFlows = cap.flowIds.map((id) => flowMap.get(id)).filter((f): f is Flow => !!f);

          return (
            <div key={cap.id} className={`ae-cap-card ${isExpanded ? 'is-expanded' : ''}`}>
              <div
                className="ae-cap-header"
                onClick={() => setExpandedCap(isExpanded ? null : cap.id)}
                role="button"
                tabIndex={0}
              >
                <div className="ae-cap-title-row">
                  <div className="ae-cap-icon-box">
                    <Boxes size={16} />
                  </div>
                  <div>
                    <h3 className="ae-cap-name">{cap.name}</h3>
                    <div className="ae-cap-stats-sub">
                      <span>{cap.flowCount} flows</span>
                      <span className="dot">·</span>
                      <span>{cap.requestCount} requests</span>
                    </div>
                  </div>
                </div>

                <div className="ae-cap-toggle-icon">
                  {isExpanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                </div>
              </div>

              {/* Summary */}
              <p className="ae-cap-summary">{cap.summary}</p>

              {/* Technology & Service Badges */}
              <div className="ae-cap-tags-row">
                {cap.importantTechnologies.slice(0, 4).map((tech, i) => (
                  <span key={i} className="ae-cap-tech-tag">
                    <Cpu size={10} />
                    <span>{tech}</span>
                  </span>
                ))}
                {cap.externalServices.map((srv, i) => (
                  <span key={i} className="ae-cap-srv-tag">
                    <Server size={10} />
                    <span>{srv}</span>
                  </span>
                ))}
              </div>

              {/* Near-Duplicate Pattern Notice */}
              {cap.mergedPatterns && cap.mergedPatterns.length > 0 && (
                <div className="ae-near-dup-box">
                  <Network size={13} className="ae-nd-icon" />
                  <div>
                    <strong>Near-duplicate execution patterns detected:</strong>
                    <span>
                      {' '}
                      {cap.mergedPatterns.length} group{cap.mergedPatterns.length > 1 ? 's' : ''} of endpoints share identical execution sequences.
                    </span>
                  </div>
                </div>
              )}

              {/* Member Flows List (Shown when expanded) */}
              {isExpanded && (
                <div className="ae-cap-flows-list">
                  <div className="ae-cap-flows-header">
                    <span>MEMBER FLOWS & REPOSITORIES EVIDENCE ({memberFlows.length})</span>
                  </div>
                  {memberFlows.map((f) => {
                    const why = cap.whyBelongs[f.id] ?? f.whyBelongsToCapability;
                    const importance = f.importance?.level ?? 'MEDIUM';

                    return (
                      <div
                        key={f.id}
                        className="ae-cap-flow-item"
                        onClick={() => onSelectFlow(f.id)}
                        role="button"
                        tabIndex={0}
                      >
                        <div className="ae-cap-flow-top">
                          <span className="ae-cap-flow-title">{f.name ?? f.title}</span>
                          <span className={`ae-imp-badge imp-${importance.toLowerCase()}`}>
                            {importance}
                          </span>
                        </div>
                        <div className="ae-cap-flow-trigger">
                          <code>{f.trigger.method ? `${f.trigger.method} ${f.trigger.path}` : f.title}</code>
                          <span className="ae-cap-flow-steps">{f.steps.length} steps</span>
                        </div>
                        {why && <div className="ae-cap-flow-why">↳ {why}</div>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
