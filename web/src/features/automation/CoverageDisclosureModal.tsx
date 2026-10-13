import {
  CheckCircle2,
  FileCode,
  Filter,
  Info,
  Layers,
  Minimize2,
  Search,
  X,
} from 'lucide-react';
import React, { useMemo, useState } from 'react';
import type { AutomationCoverageV4, EntryPointItem } from '../../lib/api.ts';

interface CoverageDisclosureModalProps {
  coverage: AutomationCoverageV4;
  onClose: () => void;
  onSelectEntryPoint?: (item: EntryPointItem) => void;
}

export function CoverageDisclosureModal({
  coverage,
  onClose,
  onSelectEntryPoint,
}: CoverageDisclosureModalProps) {
  const [activeTab, setActiveTab] = useState<'all' | 'shown' | 'folded' | 'omitted'>('all');
  const [search, setSearch] = useState('');

  const allItems = useMemo(() => {
    return [...coverage.shown, ...coverage.folded, ...coverage.omitted];
  }, [coverage]);

  const filteredItems = useMemo(() => {
    let list: EntryPointItem[] = [];
    if (activeTab === 'all') list = allItems;
    else if (activeTab === 'shown') list = coverage.shown;
    else if (activeTab === 'folded') list = coverage.folded;
    else if (activeTab === 'omitted') list = coverage.omitted;

    if (!search.trim()) return list;
    const q = search.toLowerCase();
    return list.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        item.file.toLowerCase().includes(q) ||
        item.kind.toLowerCase().includes(q) ||
        (item.reason && item.reason.toLowerCase().includes(q)),
    );
  }, [activeTab, search, allItems, coverage]);

  const arithmeticConsistent =
    coverage.shownCount + coverage.foldedCount + coverage.omittedCount ===
    coverage.totalEntryPoints;

  return (
    <div className="aev4-modal-overlay" onClick={onClose}>
      <div className="aev4-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="aev4-modal-header">
          <div className="aev4-modal-title-group">
            <h3 className="aev4-modal-title">Entry Point Trace Coverage</h3>
            <span className="aev4-modal-subtitle">
              Verified breakdown of all code entry points across project
            </span>
          </div>
          <button
            type="button"
            className="aev4-modal-close-btn"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Arithmetic Invariant Banner */}
        <div className="aev4-coverage-equation-bar">
          <div className="aev4-equation-pill total">
            <span className="eq-label">Total Analyzed</span>
            <span className="eq-val">{coverage.totalEntryPoints}</span>
          </div>
          <span className="eq-symbol">=</span>
          <div className="aev4-equation-pill shown">
            <span className="eq-label">Shown in Flows</span>
            <span className="eq-val">{coverage.shownCount}</span>
          </div>
          <span className="eq-symbol">+</span>
          <div className="aev4-equation-pill folded">
            <span className="eq-label">Folded Endpoints</span>
            <span className="eq-val">{coverage.foldedCount}</span>
          </div>
          <span className="eq-symbol">+</span>
          <div className="aev4-equation-pill omitted">
            <span className="eq-label">Omitted Minor</span>
            <span className="eq-val">{coverage.omittedCount}</span>
          </div>

          {arithmeticConsistent && (
            <div className="aev4-verified-badge" title="Sum exactly equals total entry points">
              <CheckCircle2 size={13} />
              <span>Arithmetically Consistent</span>
            </div>
          )}
        </div>

        {/* Tabs & Search */}
        <div className="aev4-modal-controls">
          <div className="aev4-modal-tabs">
            <button
              type="button"
              className={`aev4-tab-btn ${activeTab === 'all' ? 'active' : ''}`}
              onClick={() => setActiveTab('all')}
            >
              All ({allItems.length})
            </button>
            <button
              type="button"
              className={`aev4-tab-btn ${activeTab === 'shown' ? 'active' : ''}`}
              onClick={() => setActiveTab('shown')}
            >
              Shown ({coverage.shownCount})
            </button>
            <button
              type="button"
              className={`aev4-tab-btn ${activeTab === 'folded' ? 'active' : ''}`}
              onClick={() => setActiveTab('folded')}
            >
              Folded ({coverage.foldedCount})
            </button>
            <button
              type="button"
              className={`aev4-tab-btn ${activeTab === 'omitted' ? 'active' : ''}`}
              onClick={() => setActiveTab('omitted')}
            >
              Omitted ({coverage.omittedCount})
            </button>
          </div>

          <div className="aev4-modal-search">
            <Search size={14} className="aev4-search-icon" />
            <input
              type="text"
              placeholder="Search route, component or file..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="aev4-search-input"
            />
            {search && (
              <button
                type="button"
                className="aev4-search-clear"
                onClick={() => setSearch('')}
              >
                <X size={12} />
              </button>
            )}
          </div>
        </div>

        {/* Entry Points List */}
        <div className="aev4-modal-list">
          {filteredItems.length === 0 ? (
            <div className="aev4-list-empty">
              <Info size={20} />
              <p>No entry points match the search filter.</p>
            </div>
          ) : (
            filteredItems.map((item) => (
              <div
                key={item.id}
                className={`aev4-entry-item disposition-${item.disposition}`}
                onClick={() => onSelectEntryPoint?.(item)}
              >
                <div className="aev4-entry-badge-col">
                  <span className={`aev4-disp-badge ${item.disposition}`}>
                    {item.disposition.toUpperCase()}
                  </span>
                  <span className="aev4-kind-badge">{item.kind}</span>
                </div>

                <div className="aev4-entry-info-col">
                  <div className="aev4-entry-name">{item.name}</div>
                  <div className="aev4-entry-cite">
                    <FileCode size={12} />
                    <span>{item.file}:{item.line}</span>
                  </div>
                </div>

                <div className="aev4-entry-reason-col">
                  <span className="aev4-reason-text">{item.reason || 'Traced entry point'}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
