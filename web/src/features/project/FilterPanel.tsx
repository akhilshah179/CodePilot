import { TYPE_LABELS } from '@codepilot/analyzer/shapes';
import { useMemo } from 'react';
import { ShapeIcon } from '../../components/ui.tsx';
import type { EdgeKind, NodeType } from '../../lib/api.ts';
import { ALL_KINDS, FILE_TYPES, type Filters, type GraphModel } from '../../graph/model.ts';

interface Props {
  model: GraphModel;
  filters: Filters;
  onChange(f: Filters): void;
  onReset(): void;
}

const KIND_LABELS: Record<EdgeKind, string> = { static: 'Static import', dynamic: 'Dynamic import()', 're-export': 'Re-export', require: 'require()' };

/** Filters operate on the real graph: they only hide nodes and edges, never add any. */
export function FilterPanel({ model, filters, onChange, onReset }: Props) {
  const counts = useMemo(() => {
    const byType = new Map<NodeType, number>();
    const byDir = new Map<string, number>();
    const byKind = new Map<EdgeKind, number>();
    let tests = 0;
    for (const n of model.nodes) {
      byType.set(n.type, (byType.get(n.type) ?? 0) + 1);
      if (n.type !== 'external' && n.type !== 'unresolved') byDir.set(n.directory, (byDir.get(n.directory) ?? 0) + 1);
      if (n.isTest) tests++;
    }
    for (const e of model.edges) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
    return { byType, byDir: [...byDir].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])), byKind, tests };
  }, [model]);

  const toggleType = (t: NodeType, on: boolean) => {
    const types = new Set(filters.types);
    if (on) types.add(t);
    else types.delete(t);
    onChange({ ...filters, types });
  };
  const toggleDir = (d: string, on: boolean) => {
    const dirs = new Set(filters.directories ?? counts.byDir.map(([name]) => name));
    if (on) dirs.add(d);
    else dirs.delete(d);
    onChange({ ...filters, directories: dirs.size === counts.byDir.length ? null : dirs });
  };
  const toggleKind = (k: EdgeKind, on: boolean) => {
    const kinds = new Set(filters.kinds);
    if (on) kinds.add(k);
    else kinds.delete(k);
    onChange({ ...filters, kinds });
  };

  return (
    <div className="filters" aria-label="Graph filters">
      <fieldset className="filters-group">
        <legend className="filters-title">Node type</legend>
        {FILE_TYPES.filter((t) => counts.byType.get(t)).map((t) => (
          <label key={t} className="check">
            <input type="checkbox" checked={filters.types.has(t)} onChange={(e) => toggleType(t, e.target.checked)} />
            <ShapeIcon type={t} size={12} />
            <span className="grow">{TYPE_LABELS[t]}</span>
            <span className="faint mono">{counts.byType.get(t)}</span>
          </label>
        ))}
      </fieldset>

      <fieldset className="filters-group">
        <legend className="filters-title">Show</legend>
        <label className="check">
          <input type="checkbox" checked={filters.types.has('unresolved')} onChange={(e) => toggleType('unresolved', e.target.checked)} />
          <ShapeIcon type="unresolved" size={12} />
          <span className="grow">Unresolved imports</span>
          <span className="faint mono">{counts.byType.get('unresolved') ?? 0}</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={filters.types.has('external')} onChange={(e) => toggleType('external', e.target.checked)} />
          <ShapeIcon type="external" size={12} />
          <span className="grow">External packages</span>
          <span className="faint mono">{counts.byType.get('external') ?? 0}</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={!filters.hideTests} onChange={(e) => onChange({ ...filters, hideTests: !e.target.checked })} />
          <span className="grow">Test files</span>
          <span className="faint mono">{counts.tests}</span>
        </label>
      </fieldset>

      <fieldset className="filters-group">
        <legend className="filters-title">Edge type</legend>
        {ALL_KINDS.map((k) => (
          <label key={k} className="check">
            <input type="checkbox" checked={filters.kinds.has(k)} onChange={(e) => toggleKind(k, e.target.checked)} />
            <span className={`edge-swatch edge-${k}`} aria-hidden="true" />
            <span className="grow">{KIND_LABELS[k]}</span>
            <span className="faint mono">{counts.byKind.get(k) ?? 0}</span>
          </label>
        ))}
        <label className="check">
          <input type="checkbox" checked={filters.showTypeOnly} onChange={(e) => onChange({ ...filters, showTypeOnly: e.target.checked })} />
          <span className="grow">Type-only imports</span>
        </label>
      </fieldset>

      {counts.byDir.length > 1 && (
        <fieldset className="filters-group">
          <legend className="filters-title">Directory</legend>
          <div className="dir-list">
            {counts.byDir.map(([d, c]) => (
              <label key={d} className="check">
                <input type="checkbox" checked={!filters.directories || filters.directories.has(d)} onChange={(e) => toggleDir(d, e.target.checked)} />
                <span className="grow mono">{d === '.' ? '(root)' : d + '/'}</span>
                <span className="faint mono">{c}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <button className="btn btn-sm" onClick={onReset}>
        Reset filters
      </button>
    </div>
  );
}
