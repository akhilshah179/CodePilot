import { Download, Expand, Layers, Maximize2, Minus, PanelLeft, Plus, RotateCcw, Search, Share2, Sigma, CircleDot } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { IconButton } from '../../../components/ui.tsx';

export type WireMode = 'ring' | 'layered' | 'summary';

export const MODES: { id: WireMode; label: string; hint: string; icon: ReactNode }[] = [
  { id: 'ring', label: 'Ring', hint: 'Files on one circle by category; dependencies as bundled threads', icon: <CircleDot size={14} /> },
  { id: 'layered', label: 'Layered', hint: 'Top to bottom: routes and pages → components → actions → services → utilities', icon: <Layers size={14} /> },
  { id: 'summary', label: 'Summary', hint: 'Statistics, category dependency matrix and the file table', icon: <Sigma size={14} /> },
];

export interface RingControls {
  showIntra: boolean;
  showAll: boolean;
  threshold: number;
  maxWeight: number;
  onIntra(v: boolean): void;
  onAll(v: boolean): void;
  onThreshold(v: number): void;
}

interface Props {
  mode: WireMode;
  onMode(m: WireMode): void;
  count: string;
  filtersOpen: boolean;
  onFilters(): void;
  onSearch(): void;
  ring: RingControls | null;
  onZoom?(f: number): void;
  onFit?(): void;
  onReset(): void;
  onFullscreen(): void;
  exports: { label: string; hint: string; href?: string; onClick?(): void }[];
  onShare?(): void;
  compact?: boolean;
}

/** Floating glass toolbar: every control has a label, a tooltip and (where relevant) a shortcut. */
export function WireframeToolbar(p: Props) {
  const [menu, setMenu] = useState<'export' | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setMenu(null);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(null);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [menu]);
  const canvas = p.mode !== 'summary';

  return (
    <div className="floating-toolbar wire-toolbar glass" role="toolbar" aria-label="Wireframe controls" ref={ref}>
      <div className="mode-tabs" role="tablist" aria-label="Wireframe view">
        {MODES.map((m) => (
          <button key={m.id} type="button" role="tab" aria-selected={p.mode === m.id} onClick={() => p.onMode(m.id)} data-tip={m.hint}>
            {m.icon}
            <span>{m.label}</span>
          </button>
        ))}
      </div>
      <span className="tool-sep" aria-hidden="true" />
      {!p.compact && (
        <IconButton label="Filter by node type, directory and import kind" pressed={p.filtersOpen} onClick={p.onFilters}>
          <PanelLeft size={15} />
        </IconButton>
      )}
      <button type="button" className="tool-search" onClick={p.onSearch} aria-label="Search files and commands">
        <Search size={14} />
        <span>Search</span>
        <kbd>/</kbd>
      </button>
      {p.ring && p.mode === 'ring' && (
        <>
          <span className="tool-sep" aria-hidden="true" />
          <label className="tool-check" data-tip="Draw dependencies between files of the same category (hidden by default to reduce noise)">
            <input type="checkbox" checked={p.ring.showIntra} onChange={(e) => p.ring!.onIntra(e.target.checked)} />
            Intra-group
          </label>
          <label className="tool-check" data-tip="Draw every dependency, ignoring the weight threshold and grouping">
            <input type="checkbox" checked={p.ring.showAll} onChange={(e) => p.ring!.onAll(e.target.checked)} />
            All
          </label>
          <label className="tool-range" data-tip="Hide threads that import fewer symbols than this (unresolved imports always show)">
            <span>Weight ≥</span>
            <input
              type="range"
              min={1}
              max={Math.max(2, p.ring.maxWeight)}
              value={p.ring.threshold}
              disabled={p.ring.showAll}
              onChange={(e) => p.ring!.onThreshold(Number(e.target.value))}
              aria-label="Dependency weight threshold"
            />
            <span className="mono">{p.ring.threshold}</span>
          </label>
        </>
      )}
      {canvas && (
        <>
          <span className="tool-sep" aria-hidden="true" />
          <IconButton label="Zoom out" shortcut="−" onClick={() => p.onZoom?.(1 / 1.5)}>
            <Minus size={15} />
          </IconButton>
          <IconButton label="Zoom in" shortcut="+" onClick={() => p.onZoom?.(1.5)}>
            <Plus size={15} />
          </IconButton>
          <IconButton label="Fit" shortcut="F" onClick={() => p.onFit?.()}>
            <Maximize2 size={15} />
          </IconButton>
        </>
      )}
      <IconButton label="Reset view, filters and selection" shortcut="R" onClick={p.onReset}>
        <RotateCcw size={15} />
      </IconButton>
      <IconButton label="Fullscreen" onClick={p.onFullscreen}>
        <Expand size={15} />
      </IconButton>
      <span className="tool-count mono">{p.count}</span>
      <div className="menu-wrap">
        <IconButton label="Export" pressed={menu === 'export'} onClick={() => setMenu(menu === 'export' ? null : 'export')}>
          <Download size={15} />
        </IconButton>
        {menu === 'export' && (
          <div className="menu glass menu-right" role="menu">
            {p.exports.map((e) =>
              e.href ? (
                <a key={e.label} role="menuitem" href={e.href} download onClick={() => setMenu(null)}>
                  <span>{e.label}</span>
                  <span className="faint small">{e.hint}</span>
                </a>
              ) : (
                <button
                  key={e.label}
                  role="menuitem"
                  onClick={() => {
                    e.onClick?.();
                    setMenu(null);
                  }}
                >
                  <span>{e.label}</span>
                  <span className="faint small">{e.hint}</span>
                </button>
              ),
            )}
          </div>
        )}
      </div>
      {p.onShare && (
        <IconButton label="Share a read-only link" onClick={p.onShare}>
          <Share2 size={15} />
        </IconButton>
      )}
    </div>
  );
}
