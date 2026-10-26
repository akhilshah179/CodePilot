import { useEffect, useRef } from 'react';
import type { AutomationFlow, ExplanationItem } from '../../lib/api.ts';

/**
 * The explanation below the canvas, in a fixed order. Every sentence carries its file:line; a
 * step selects its node, and selecting a node scrolls to its step.
 */
export function Explanation({ flow, selected, onSelect }: { flow: AutomationFlow; selected: string | null; onSelect(id: string): void }) {
  const x = flow.explanation;
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!selected || !ref.current) return;
    // Only follow along when the explanation is on screen; a click in the canvas must not scroll the page away from it.
    const r = ref.current.getBoundingClientRect();
    if (r.top > window.innerHeight - 80 || r.bottom < 0) return;
    ref.current.querySelector(`[data-node="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selected]);

  const Item = ({ i }: { i: ExplanationItem }) =>
    i.nodeId ? (
      <li data-node={i.nodeId} className={selected === i.nodeId ? 'is-selected' : undefined}>
        <button type="button" className="ex-item" onClick={() => onSelect(i.nodeId!)}>
          {i.text}
        </button>
      </li>
    ) : (
      <li>{i.text}</li>
    );

  const Section = ({ n, title, items, empty, ordered = false }: { n: number; title: string; items: ExplanationItem[]; empty?: string; ordered?: boolean }) => (
    <section className="ex-section" aria-labelledby={`ex-${n}`}>
      <h3 id={`ex-${n}`}>
        <span className="mono">{n}</span> {title}
      </h3>
      {items.length ? (
        ordered ? (
          <ol className="ex-list ex-steps">
            {items.map((i, k) => (
              <Item key={k} i={i} />
            ))}
          </ol>
        ) : (
          <ul className="ex-list">
            {items.map((i, k) => (
              <Item key={k} i={i} />
            ))}
          </ul>
        )
      ) : (
        <p className="small faint">{empty}</p>
      )}
    </section>
  );

  return (
    <article className="ex" ref={ref} aria-label={`Explanation of ${flow.name}`}>
      <Section n={1} title="What it does" items={x.what} />
      <Section n={2} title="Step by step" items={x.steps} ordered />
      <section className="ex-section" aria-labelledby="ex-3">
        <h3 id="ex-3">
          <span className="mono">3</span> Data in and out
        </h3>
        <div className="ex-cols">
          <div>
            <h4>In</h4>
            {x.data.inputs.length ? (
              <ul className="ex-list">
                {x.data.inputs.map((i, k) => (
                  <Item key={k} i={i} />
                ))}
              </ul>
            ) : (
              <p className="small faint">No request data is named in the traced code.</p>
            )}
          </div>
          <div>
            <h4>Stored</h4>
            {x.data.stored.length ? (
              <ul className="ex-list">
                {x.data.stored.map((i, k) => (
                  <Item key={k} i={i} />
                ))}
              </ul>
            ) : (
              <p className="small faint">Nothing is written to a data store on this path.</p>
            )}
          </div>
          <div>
            <h4>Returned</h4>
            {x.data.returned.length ? (
              <ul className="ex-list">
                {x.data.returned.map((i, k) => (
                  <Item key={k} i={i} />
                ))}
              </ul>
            ) : (
              <p className="small faint">No response shape is written in the traced code.</p>
            )}
          </div>
        </div>
      </section>
      <Section n={4} title="Decisions and failure paths" items={x.decisions} />
      <Section n={5} title="Tools and services in this flow" items={x.tools} empty="This flow uses no detected tool or external service." />
      <Section n={6} title="Included smaller endpoints" items={x.folded} empty="No endpoints are folded into this flow." />
      <section className="ex-section" aria-labelledby="ex-7">
        <h3 id="ex-7">
          <span className="mono">7</span> Confidence
        </h3>
        <p>
          {x.confidence.percent}% of steps fully traced ({x.confidence.traced} of {x.confidence.total}).
        </p>
        {x.confidence.unknown.length > 0 && (
          <ul className="ex-list">
            {x.confidence.unknown.map((i, k) => (
              <Item key={k} i={i} />
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}
