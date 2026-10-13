import { useMemo } from 'react';
import type { GraphModel, Visibility } from '../../../graph/model.ts';
import { categoryOf, CATEGORY_COLORS, CATEGORY_LABELS, RING_CATEGORIES, type RingCategory } from '../../../graph/ring.ts';
import type { GraphNode } from '../../../lib/api.ts';
import { basename, num } from '../../../lib/format.ts';
import { ListView } from '../ListView.tsx';

interface Props {
  model: GraphModel;
  vis: Visibility;
  selected: number | null;
  evidence: Map<string, GraphNode['classification_evidence']>;
  onSelect(i: number): void;
  /** Open the ring focused on dependencies between two categories. */
  onCategories(source: RingCategory, target: RingCategory): void;
}

/**
 * Summary mode: the same graph as numbers. Every count here is computed from the pairs the ring
 * draws, with the current filters applied.
 */
export function WireframeSummary({ model, vis, selected, evidence, onSelect, onCategories }: Props) {
  const stats = useMemo(() => {
    const cats = RING_CATEGORIES.filter((c) => model.nodes.some((n, i) => vis.nodes[i] && categoryOf(n.type) === c));
    const matrix = new Map<string, number>();
    const perCat = new Map<RingCategory, { files: number; out: number; in: number; top: number | null }>();
    for (const c of cats) perCat.set(c, { files: 0, out: 0, in: 0, top: null });
    model.nodes.forEach((n, i) => {
      if (!vis.nodes[i]) return;
      const pc = perCat.get(categoryOf(n.type))!;
      pc.files++;
      if (pc.top === null || n.fanIn > model.nodes[pc.top].fanIn) pc.top = i;
    });
    let inter = 0;
    let unresolved = 0;
    let dynamic = 0;
    let pairs = 0;
    model.pairs.forEach((p, pi) => {
      if (!vis.pairs[pi]) return;
      pairs++;
      const a = categoryOf(model.nodes[p.s].type);
      const b = categoryOf(model.nodes[p.t].type);
      if (a !== b) inter++;
      if (!p.resolved) unresolved++;
      if (p.dynamic) dynamic++;
      matrix.set(`${a}>${b}`, (matrix.get(`${a}>${b}`) ?? 0) + 1);
      perCat.get(a) && perCat.get(a)!.out++;
      perCat.get(b) && perCat.get(b)!.in++;
    });
    const max = Math.max(1, ...matrix.values());
    const hubs = model.nodes
      .map((n, i) => ({ n, i }))
      .filter(({ i, n }) => vis.nodes[i] && n.fanIn > 0)
      .sort((a, b) => b.n.fanIn - a.n.fanIn || a.n.path.localeCompare(b.n.path))
      .slice(0, 8);
    return { cats, matrix, max, perCat, inter, unresolved, dynamic, pairs, hubs, files: vis.nodeCount };
  }, [model, vis]);

  return (
    <div className="wire-summary">
      <dl className="ws-totals">
        <div>
          <dt>Files</dt>
          <dd className="mono">{num(stats.files)}</dd>
        </div>
        <div>
          <dt>File dependencies</dt>
          <dd className="mono">{num(stats.pairs)}</dd>
        </div>
        <div>
          <dt>Between categories</dt>
          <dd className="mono">{stats.pairs ? Math.round((stats.inter / stats.pairs) * 100) : 0}%</dd>
        </div>
        <div>
          <dt>Import cycles</dt>
          <dd className="mono">{model.cycles.length}</dd>
        </div>
        <div>
          <dt>Dynamic</dt>
          <dd className="mono">{num(stats.dynamic)}</dd>
        </div>
        <div>
          <dt>Unresolved</dt>
          <dd className="mono">{num(stats.unresolved)}</dd>
        </div>
      </dl>

      <div className="ws-grid">
        <section className="ws-card" aria-labelledby="ws-matrix">
          <h3 id="ws-matrix">Category dependency matrix</h3>
          <p className="faint small">File pairs where a row category imports a column category. Select a cell to see those threads on the ring.</p>
          <div className="ws-matrix-wrap">
            <table className="ws-matrix">
              <thead>
                <tr>
                  <th scope="col">
                    <span className="visually-hidden">Importer</span>
                  </th>
                  {stats.cats.map((c) => (
                    <th key={c} scope="col" title={CATEGORY_LABELS[c]}>
                      <span className="ws-cat-dot" style={{ background: CATEGORY_COLORS[c] }} />
                      {CATEGORY_LABELS[c].slice(0, 4)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stats.cats.map((r) => (
                  <tr key={r}>
                    <th scope="row">
                      <span className="ws-cat-dot" style={{ background: CATEGORY_COLORS[r] }} />
                      {CATEGORY_LABELS[r]}
                    </th>
                    {stats.cats.map((c) => {
                      const v = stats.matrix.get(`${r}>${c}`) ?? 0;
                      return (
                        <td key={c}>
                          {v ? (
                            <button
                              type="button"
                              style={{ background: `rgba(255, 92, 92, ${0.08 + (v / stats.max) * 0.5})` }}
                              onClick={() => onCategories(r, c)}
                              aria-label={`${CATEGORY_LABELS[r]} import ${CATEGORY_LABELS[c]}: ${v} file pairs`}
                            >
                              {v}
                            </button>
                          ) : (
                            <span className="faint">·</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="ws-card" aria-labelledby="ws-cats">
          <h3 id="ws-cats">Categories</h3>
          <table className="ws-table">
            <thead>
              <tr>
                <th scope="col">Category</th>
                <th scope="col">Files</th>
                <th scope="col">Imports</th>
                <th scope="col">Imported by</th>
                <th scope="col">Most depended on</th>
              </tr>
            </thead>
            <tbody>
              {stats.cats.map((c) => {
                const pc = stats.perCat.get(c)!;
                return (
                  <tr key={c}>
                    <th scope="row">
                      <span className="ws-cat-dot" style={{ background: CATEGORY_COLORS[c] }} />
                      {CATEGORY_LABELS[c]}
                    </th>
                    <td className="mono">{pc.files}</td>
                    <td className="mono dep-count">{pc.out}</td>
                    <td className="mono con-count">{pc.in}</td>
                    <td>
                      {pc.top !== null && model.nodes[pc.top].fanIn > 0 ? (
                        <button type="button" className="link-btn mono" onClick={() => onSelect(pc.top!)} title={model.nodes[pc.top].path}>
                          {basename(model.nodes[pc.top].path)} <span className="faint">({model.nodes[pc.top].fanIn})</span>
                        </button>
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <section className="ws-card" aria-labelledby="ws-hubs">
          <h3 id="ws-hubs">Most depended-on files</h3>
          <ol className="ws-list">
            {stats.hubs.map(({ n, i }) => (
              <li key={n.id}>
                <button type="button" className="link-btn mono" onClick={() => onSelect(i)} title={n.path}>
                  {n.path}
                </button>
                <span className="con-count mono">{n.fanIn} dependents</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="ws-card" aria-labelledby="ws-cycles">
          <h3 id="ws-cycles">Import cycles</h3>
          {model.cycles.length ? (
            <ol className="ws-list">
              {model.cycles.slice(0, 8).map((c, ci) => (
                <li key={ci}>
                  <button type="button" className="link-btn mono" onClick={() => onSelect(model.index.get(c.members[0])!)}>
                    {c.members.map((m) => basename(m)).join(' → ')}
                  </button>
                  <span className="faint mono">{c.members.length} files</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="faint small">No files import each other in a loop.</p>
          )}
        </section>
      </div>

      <section className="ws-card ws-files" aria-labelledby="ws-files">
        <h3 id="ws-files">Files</h3>
        <ListView model={model} vis={vis} selected={selected} onSelect={onSelect} evidence={evidence} />
      </section>
    </div>
  );
}
