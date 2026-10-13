import { ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { GraphModel, Visibility } from '../../../graph/model.ts';
import { CATEGORY_COLORS, CATEGORY_LABELS, type RingLayout } from '../../../graph/ring.ts';
import { basename } from '../../../lib/format.ts';

interface Props {
  model: GraphModel;
  layout: RingLayout;
  vis: Visibility;
  selected: number | null;
  onSelect(i: number | null): void;
}

/**
 * Small screens: the ring's categories as a vertical list. Selecting a file shows exactly what it
 * imports and what imports it, with the import lines — the same facts the ring draws.
 */
export function MobileWireframe({ model, layout, vis, selected, onSelect }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const lineOf = (pi: number) => model.edges[model.pairs[pi].edges[0]]?.line;
  const focus = useMemo(() => {
    if (selected === null) return null;
    return {
      out: model.outPairs[selected].filter((pi) => vis.pairs[pi]).map((pi) => ({ i: model.pairs[pi].t, line: lineOf(pi), pi })),
      in: model.inPairs[selected].filter((pi) => vis.pairs[pi]).map((pi) => ({ i: model.pairs[pi].s, line: lineOf(pi), pi })),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, vis, selected]);

  return (
    <div className="wire-mobile">
      {selected !== null && focus && (
        <section className="wm-focus" aria-label={`Dependencies of ${model.nodes[selected].path}`}>
          <p className="mono wm-path">{model.nodes[selected].path}</p>
          <h3 className="wm-h dep-count">
            <ArrowUpRight size={13} /> Imports {focus.out.length}
          </h3>
          <ul className="wm-list">
            {focus.out.map((x) => (
              <li key={x.pi}>
                <button type="button" onClick={() => onSelect(x.i)} className="mono">
                  {basename(model.nodes[x.i].path)}
                </button>
                {x.line ? <span className="faint mono">line {x.line}</span> : null}
              </li>
            ))}
          </ul>
          <h3 className="wm-h con-count">
            <ArrowDownLeft size={13} /> Imported by {focus.in.length}
          </h3>
          <ul className="wm-list">
            {focus.in.map((x) => (
              <li key={x.pi}>
                <button type="button" onClick={() => onSelect(x.i)} className="mono">
                  {basename(model.nodes[x.i].path)}
                </button>
                {x.line ? <span className="faint mono">line {x.line}</span> : null}
              </li>
            ))}
          </ul>
          <button type="button" className="btn btn-sm" onClick={() => onSelect(null)}>
            Back to categories
          </button>
        </section>
      )}
      {layout.arcs.map((arc) => {
        const members = arc.members.filter((i) => vis.nodes[i]);
        if (!members.length) return null;
        const isOpen = open === arc.category;
        return (
          <section key={arc.category} className="wm-cat" style={{ ['--cat' as string]: CATEGORY_COLORS[arc.category] }}>
            <button type="button" className="wm-cat-head" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : arc.category)}>
              <span className="wm-bar" aria-hidden="true" />
              <span>{CATEGORY_LABELS[arc.category]}</span>
              <span className="faint mono">{members.length}</span>
            </button>
            {isOpen && (
              <ul className="wm-files">
                {members.map((i) => {
                  const n = model.nodes[i];
                  return (
                    <li key={n.id}>
                      <button type="button" aria-pressed={selected === i} onClick={() => onSelect(i)}>
                        <span className="mono">{basename(n.path)}</span>
                        <span className="faint small mono">{n.directory}</span>
                        <span className="wm-counts mono">
                          <span className="dep-count">{n.fanOut}↗</span> <span className="con-count">{n.fanIn}↙</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
