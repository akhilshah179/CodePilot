import { TYPE_LABELS } from '@codepilot/analyzer/shapes';
import { CircleDot, FileCode2, Layers, Sigma, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ErrorNotice, ShapeIcon } from '../../components/ui.tsx';
import { GraphCanvas, type GraphCanvasHandle } from '../../graph/GraphCanvas.tsx';
import { computeHighlight, computeVisibility, defaultFilters, GraphModel, type Filters } from '../../graph/model.ts';
import { connectedNeighbors, pickNeighbor } from '../../graph/navigation.ts';
import { categoryOf, CATEGORY_COLORS, CATEGORY_LABELS, isDefaultThread, ringLayout, type RingCategory } from '../../graph/ring.ts';
import { RingCanvas, type RingCanvasHandle } from '../../graph/RingCanvas.tsx';
import type { LabelLevel } from '../../graph/ringRenderer.ts';
import { api, data, type DataSource, type Project } from '../../lib/api.ts';
import { basename, num } from '../../lib/format.ts';
import { useAsync, useMediaQuery } from '../../lib/hooks.ts';
import { DetailsPanel } from './DetailsPanel.tsx';
import { FilterPanel } from './FilterPanel.tsx';
import { SearchDialog, type PaletteItem } from './SearchDialog.tsx';
import { ShareDialog } from './ShareDialog.tsx';
import { MobileWireframe } from './wireframe/MobileWireframe.tsx';
import { MODES, WireframeToolbar, type WireMode } from './wireframe/WireframeToolbar.tsx';
import { WireframeSummary } from './wireframe/WireframeSummary.tsx';

interface Props {
  src: DataSource;
  project: Project;
  initialFocus?: string;
  initialPinned?: string[];
  /** Minimal chrome for embeds. */
  embed?: boolean;
  /** Show a file's component in the Architecture view (cross-link). */
  onArchitecture?(path: string): void;
}

const MODE_KEY = 'codepilot.wireframe.mode';
/** The load sequence plays once per project per session; later visits show the ring directly. */
const revealedProjects = new Set<string>();

function readMode(): WireMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (MODES.some((m) => m.id === v)) return v as WireMode;
  } catch {
    /* storage unavailable */
  }
  return 'ring';
}

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

export function WireframeView({ src, project, initialFocus, initialPinned, embed, onArchitecture }: Props) {
  const [mode, setModeState] = useState<WireMode>(readMode);
  const { data: graph, error, loading, reload } = useAsync(() => data.graph(src, 'layered'), [src.base]);
  const model = useMemo(() => (graph ? new GraphModel(graph.nodes, graph.edges, { cycles: graph.cycles, orphans: graph.orphans, entryPoints: graph.entryPoints }) : null), [graph]);
  const ring = useMemo(() => (model ? ringLayout(model) : null), [model]);
  const evidenceById = useMemo(() => new Map(graph?.nodes.map((n) => [n.id, n.classification_evidence]) ?? []), [graph]);
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [selectedId, setSelectedId] = useState<string | null>(initialFocus ?? initialPinned?.[0] ?? null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [kbFocus, setKbFocus] = useState<number | null>(null);
  const [arc, setArc] = useState<RingCategory | null>(null);
  const [arcTarget, setArcTarget] = useState<RingCategory | null>(null);
  const [isolatedId, setIsolatedId] = useState<string | null>(null);
  const [hoverPair, setHoverPair] = useState<{ pair: number; x: number; y: number } | null>(null);
  const [showIntra, setShowIntra] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [threshold, setThreshold] = useState<number | null>(null);
  const [level, setLevel] = useState<LabelLevel>('ticks');
  const [palette, setPalette] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [share, setShare] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const smallScreen = useMediaQuery('(max-width: 760px)');
  const ringRef = useRef<RingCanvasHandle>(null);
  const graphRef = useRef<GraphCanvasHandle>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const initialFocusDone = useRef(false);

  const vis = useMemo(() => (model ? computeVisibility(model, filters) : null), [model, filters]);
  const selected = model && selectedId ? (model.index.get(selectedId) ?? null) : null;
  const isolated = model && isolatedId ? (model.index.get(isolatedId) ?? null) : null;
  const maxWeight = useMemo(() => (model ? Math.min(12, Math.max(1, ...model.pairs.map((p) => p.weight))) : 1), [model]);
  // Default threshold: on dense graphs, single-symbol imports are the noise to hide first.
  const effectiveThreshold = threshold ?? (model && model.pairs.length > 1200 ? 2 : 1);
  const options = useMemo(() => ({ showIntra, showAll, threshold: effectiveThreshold }), [showIntra, showAll, effectiveThreshold]);
  const baseCount = useMemo(() => {
    if (!model || !ring || !vis) return 0;
    let c = 0;
    for (let pi = 0; pi < model.pairs.length; pi++) if (isDefaultThread(model, ring, pi, vis, options)) c++;
    return c;
  }, [model, ring, vis, options]);
  const focus = hovered ?? selected;
  const hl = useMemo(() => (model && vis ? computeHighlight(model, vis, focus, 1) : null), [model, vis, focus]);

  const setMode = (m: WireMode) => {
    setModeState(m);
    setHovered(null);
    setHoverPair(null);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* storage unavailable */
    }
  };

  const describe = useCallback(
    (i: number) => {
      if (!model || !vis) return '';
      const n = model.nodes[i];
      const deps = model.outPairs[i].filter((p) => vis.pairs[p]).length;
      const cons = model.inPairs[i].filter((p) => vis.pairs[p]).length;
      return `${n.path}, ${TYPE_LABELS[n.type].toLowerCase()}, imports ${deps} files, imported by ${cons}`;
    },
    [model, vis],
  );

  const select = useCallback(
    (i: number | null, opts: { camera?: boolean } = {}) => {
      if (!model) return;
      setSelectedId(i === null ? null : model.nodes[i].id);
      setHoverPair(null);
      if (i !== null) {
        setKbFocus(i);
        setArc(null);
        setArcTarget(null);
        setAnnouncement(`Selected ${describe(i)}`);
        if (opts.camera) {
          ringRef.current?.focusNode(i);
          graphRef.current?.focusNode(i);
        }
      } else setAnnouncement('Selection cleared');
    },
    [model, describe],
  );

  const isolate = useCallback(
    (i: number | null) => {
      if (!model) return;
      if (i === null || model.nodes[i].id === isolatedId) {
        setIsolatedId(null);
        setAnnouncement('Showing all files');
        return;
      }
      setIsolatedId(model.nodes[i].id);
      setSelectedId(model.nodes[i].id);
      setArc(null);
      setArcTarget(null);
      setAnnouncement(`Isolated ${describe(i)}`);
    },
    [model, isolatedId, describe],
  );

  const chooseArc = (c: RingCategory | null, target: RingCategory | null = null) => {
    setArc(c);
    setArcTarget(target);
    setIsolatedId(null);
    if (c) {
      setSelectedId(null);
      setAnnouncement(target ? `Showing dependencies from ${CATEGORY_LABELS[c]} to ${CATEGORY_LABELS[target]}` : `Showing dependencies touching ${CATEGORY_LABELS[c]}`);
    }
  };

  // Apply ?focus= / a pinned cycle once the graph arrives.
  useEffect(() => {
    if (!model || initialFocusDone.current) return;
    initialFocusDone.current = true;
    const id = initialFocus ?? initialPinned?.[0];
    if (id && model.index.has(id)) {
      const i = model.index.get(id)!;
      const n = model.nodes[i];
      if (n.type === 'external' || n.type === 'unresolved') setFilters((f) => ({ ...f, types: new Set([...f.types, n.type]) }));
      setTimeout(() => {
        ringRef.current?.focusNode(i);
        graphRef.current?.focusNode(i);
      }, 60);
    }
  }, [model, initialFocus, initialPinned]);

  const reset = useCallback(() => {
    setFilters(defaultFilters());
    setShowIntra(false);
    setShowAll(false);
    setThreshold(null);
    setIsolatedId(null);
    setArc(null);
    setArcTarget(null);
    select(null);
    setTimeout(() => {
      ringRef.current?.fit();
      graphRef.current?.fit();
    }, 0);
  }, [select]);

  const fit = () => (mode === 'ring' ? ringRef.current?.fit() : graphRef.current?.fit());
  const zoomBy = (f: number) => (mode === 'ring' ? ringRef.current?.zoomBy(f) : graphRef.current?.zoomBy(f));
  const fullscreen = () => {
    const el = wrapRef.current?.closest('.wireframe') as HTMLElement | null;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen?.().catch(() => {});
  };

  const clearAll = useCallback(() => {
    if (isolatedId) setIsolatedId(null);
    else if (selectedId) select(null);
    else if (arc) chooseArc(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isolatedId, selectedId, arc, select]);

  // Global shortcuts: / and Ctrl/⌘K open the palette, F fits, R resets, Escape steps back.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette(true);
        return;
      }
      if (palette || isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '/') {
        e.preventDefault();
        setPalette(true);
      } else if (e.key === 'f' || e.key === 'F') fit();
      else if (e.key === 'r' || e.key === 'R') reset();
      else if (e.key === 'Escape') clearAll();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [palette, reset, clearAll, mode]);

  const reveal = (i: number) => {
    if (!model || !vis) return;
    const n = model.nodes[i];
    if (!vis.nodes[i]) setFilters((f) => ({ ...f, types: new Set([...f.types, n.type]), directories: null, hideTests: false }));
    if (mode === 'summary') setMode('ring');
    select(i, { camera: true });
  };

  // Ring keyboard: ←/→ walk the ring, ↑/↓ step through the focused file's connections, Enter locks,
  // D isolates, +/− zoom.
  const onRingKey = (e: React.KeyboardEvent) => {
    if (!model || !vis || !ring) return;
    const visible = (i: number) => vis.nodes[i] === 1;
    const from = kbFocus ?? selected;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      const n = ring.order.length;
      let k = from === null ? (dir > 0 ? -1 : 0) : ring.rank[from];
      for (let step = 0; step < n; step++) {
        k = (k + dir + n) % n;
        if (visible(ring.order[k])) break;
      }
      const next = ring.order[k];
      setKbFocus(next);
      setHovered(next);
      setAnnouncement(describe(next));
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (from === null) return;
      const nb = connectedNeighbors(model, vis, from).sort((a, b) => ring.rank[a] - ring.rank[b]);
      if (!nb.length) {
        setAnnouncement('This file has no visible connections.');
        return;
      }
      const cur = nb.indexOf(kbFocus ?? -1);
      const next = nb[(cur + (e.key === 'ArrowDown' ? 1 : nb.length - 1)) % nb.length];
      setKbFocus(next);
      setHovered(next);
      setAnnouncement(`${describe(next)}. Connected to ${basename(model.nodes[from].path)}.`);
    } else if (e.key === 'Enter' && kbFocus !== null) {
      select(kbFocus);
    } else if ((e.key === 'd' || e.key === 'D') && (selected ?? kbFocus) !== null) {
      isolate(selected ?? kbFocus);
    } else if (e.key === '+' || e.key === '=') zoomBy(1.5);
    else if (e.key === '-') zoomBy(1 / 1.5);
  };

  const paletteItems: PaletteItem[] = useMemo(
    () =>
      model
        ? model.nodes.map((n, i) => ({ id: n.id, label: basename(n.path), detail: n.path, key: n.path, group: 'Files', icon: <ShapeIcon type={n.type} size={12} />, run: () => reveal(i) }))
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, vis, mode],
  );
  const paletteActions: PaletteItem[] = [
    { id: 'mode-ring', label: 'Ring view', group: 'Commands', icon: <CircleDot size={13} />, run: () => setMode('ring') },
    { id: 'mode-layered', label: 'Layered view', group: 'Commands', icon: <Layers size={13} />, run: () => setMode('layered') },
    { id: 'mode-summary', label: 'Summary and file table', group: 'Commands', icon: <Sigma size={13} />, run: () => setMode('summary') },
    ...(ring?.arcs.map((a) => ({ id: `arc-${a.category}`, label: `Dependencies touching ${CATEGORY_LABELS[a.category]}`, group: 'Commands', icon: <FileCode2 size={13} />, run: () => (setMode('ring'), chooseArc(a.category)) })) ?? []),
    { id: 'intra', label: `${showIntra ? 'Hide' : 'Show'} intra-group dependencies`, group: 'Commands', run: () => setShowIntra((v) => !v) },
    { id: 'all', label: `${showAll ? 'Reduce noise' : 'Show all dependencies'}`, group: 'Commands', run: () => setShowAll((v) => !v) },
    { id: 'fit', label: 'Fit', group: 'Commands', run: fit },
    { id: 'reset', label: 'Reset view', group: 'Commands', run: reset },
  ];


  if (error) return <div className="view-pad"><ErrorNotice error={error} onRetry={reload} /></div>;
  if (!graph || !model || !vis || !hl || !ring) return <div className="view-pad faint">{loading ? 'Loading graph…' : ''}</div>;

  const hoverPos = hovered !== null && mode === 'ring' ? ringRef.current?.screenOf(hovered) : hovered !== null ? graphRef.current?.screenOf(hovered) : null;
  const hn = hovered !== null ? model.nodes[hovered] : null;
  const pairInfo = hoverPair ? model.pairs[hoverPair.pair] : null;
  const isoInfo =
    isolated !== null
      ? { deps: model.outPairs[isolated].filter((p) => vis.pairs[p]).length, cons: model.inPairs[isolated].filter((p) => vis.pairs[p]).length }
      : null;
  const arcInfo = arc
    ? (() => {
        let out = 0;
        let inn = 0;
        model.pairs.forEach((p, pi) => {
          if (!vis.pairs[pi]) return;
          const a = categoryOf(model.nodes[p.s].type);
          const b = categoryOf(model.nodes[p.t].type);
          if (arcTarget) {
            if (a === arc && b === arcTarget) out++;
          } else if (a === arc && b !== arc) out++;
          else if (b === arc && a !== arc) inn++;
        });
        return { out, inn, files: ring.arcs.find((x) => x.category === arc)?.members.filter((i) => vis.nodes[i]).length ?? 0 };
      })()
    : null;
  const count = mode === 'ring' ? `${num(vis.nodeCount)} files · ${num(baseCount)} of ${num(vis.pairCount)} threads` : `${num(vis.nodeCount)} files · ${num(vis.pairCount)} dependencies`;

  return (
    <div className={`wireframe wire-v3 mode-${mode}${filtersOpen && !smallScreen ? ' with-filters' : ''}${selectedId && !smallScreen && mode !== 'summary' ? ' with-details' : ''}${embed ? ' is-embed' : ''}`}>
      {filtersOpen && !smallScreen && <FilterPanel model={model} filters={filters} onChange={setFilters} onReset={() => setFilters(defaultFilters())} />}

      <div className="canvas-area" ref={wrapRef}>
        {smallScreen ? (
          <MobileWireframe model={model} layout={ring} vis={vis} selected={selected} onSelect={(i) => select(i)} />
        ) : (
          <div className="canvas-wrap">
            {mode === 'ring' && (
              <RingCanvas
                ref={ringRef}
                model={model}
                layout={ring}
                vis={vis}
                options={options}
                hovered={hovered}
                selected={selected}
                arc={arc}
                arcTarget={arcTarget}
                isolated={isolated}
                kbFocus={kbFocus}
                reveal={!revealedProjects.has(src.base)}
                onRevealDone={() => revealedProjects.add(src.base)}
                ariaLabel={`Dependency ring of ${project.fullName}: ${vis.nodeCount} files in ${ring.arcs.length} categories and ${vis.pairCount} file dependencies. Use the arrow keys to move around the ring and through a file's connections.`}
                ariaDescribedBy="ring-help"
                onHover={setHovered}
                onHoverPair={setHoverPair}
                onSelect={(i) => select(i)}
                onArc={(c) => chooseArc(c)}
                onIsolate={(i) => isolate(i)}
                onKey={onRingKey}
                onLevel={setLevel}
              />
            )}
            {mode === 'layered' && (
              <GraphCanvas
                ref={graphRef}
                model={model}
                vis={vis}
                hl={hl}
                selected={selected}
                hovered={hovered}
                kbFocus={kbFocus}
                ariaLabel={`Layered dependency graph of ${project.fullName}: ${vis.nodeCount} files and ${vis.pairCount} dependencies, routes and pages at the top.`}
                ariaDescribedBy="ring-help"
                onHover={setHovered}
                onSelect={(i) => select(i)}
                onNavigate={(dir) => {
                  const from = kbFocus ?? selected;
                  if (from === null) return;
                  const next = pickNeighbor(model, vis, from, dir);
                  if (next !== null) {
                    setKbFocus(next);
                    setAnnouncement(describe(next));
                    graphRef.current?.focusNode(next);
                  }
                }}
                onActivate={() => kbFocus !== null && select(kbFocus)}
                onEscape={() => select(null)}
              />
            )}
            {mode === 'summary' && (
              <WireframeSummary
                model={model}
                vis={vis}
                selected={selected}
                evidence={evidenceById}
                onSelect={(i) => reveal(i)}
                onCategories={(r, c) => {
                  setMode('ring');
                  chooseArc(r, c);
                }}
              />
            )}

            <WireframeToolbar
              mode={mode}
              onMode={setMode}
              count={count}
              filtersOpen={filtersOpen}
              onFilters={() => setFiltersOpen((v) => !v)}
              onSearch={() => setPalette(true)}
              ring={{ showIntra, showAll, threshold: effectiveThreshold, maxWeight, onIntra: setShowIntra, onAll: setShowAll, onThreshold: setThreshold }}
              onZoom={zoomBy}
              onFit={fit}
              onReset={reset}
              onFullscreen={fullscreen}
              compact={embed}
              exports={[
                {
                  label: 'PNG of current view',
                  hint: 'exactly what is on screen',
                  onClick: async () => {
                    const blob = mode === 'ring' ? await ringRef.current?.toBlob() : await graphRef.current?.toBlob();
                    if (!blob) return;
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = `${project.fullName.replace('/', '-')}-${mode}.png`;
                    a.click();
                    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
                  },
                },
                { label: 'SVG (layered)', hint: 'current type filters', href: data.graphExportUrl(src, 'svg', 'layered', [...filters.types]) },
                { label: 'PNG (layered)', hint: 'current type filters', href: data.graphExportUrl(src, 'png', 'layered', [...filters.types]) },
                { label: 'JSON', hint: 'nodes, edges, exports, repository metadata', href: data.graphExportUrl(src, 'json', 'layered', [...filters.types]) },
              ]}
              onShare={src.readOnly ? undefined : () => setShare(true)}
            />
            <p id="ring-help" className="visually-hidden">
              Arrow keys move around the ring and through the focused file's connections. Enter locks the focus and opens the inspector. D isolates the file. Escape steps back. Plus and minus zoom; F fits; R resets. Press slash or Control K to search.
            </p>

            {mode !== 'summary' && (isoInfo || arcInfo) && (
              <div className="focus-chip glass" role="status">
                {isoInfo && isolated !== null ? (
                  <>
                    <span className="fc-k">Isolated</span>
                    <span className="mono">{basename(model.nodes[isolated].path)}</span>
                    <span className="dep-count mono">{isoInfo.deps} dependencies</span>
                    <span className="con-count mono">{isoInfo.cons} dependents</span>
                    <button type="button" className="btn btn-sm" onClick={() => isolate(null)}>
                      Show all
                    </button>
                  </>
                ) : arc && arcInfo ? (
                  <>
                    <span className="fc-dot" style={{ background: CATEGORY_COLORS[arc] }} />
                    <span className="fc-k">{arcTarget ? `${CATEGORY_LABELS[arc]} → ${CATEGORY_LABELS[arcTarget]}` : CATEGORY_LABELS[arc]}</span>
                    {!arcTarget && <span className="mono faint">{arcInfo.files} files</span>}
                    <span className="dep-count mono">{arcInfo.out} {arcTarget ? 'threads' : 'outgoing'}</span>
                    {!arcTarget && <span className="con-count mono">{arcInfo.inn} incoming</span>}
                    <button type="button" className="icon-btn" aria-label="Clear category focus" onClick={() => chooseArc(null)}>
                      <X size={14} />
                    </button>
                  </>
                ) : null}
              </div>
            )}

            {hn && hoverPos && !hoverPair && mode !== 'summary' && (
              <div className="graph-tooltip glass" style={{ left: Math.min(hoverPos.x + 14, (wrapRef.current?.clientWidth ?? 9999) - 280), top: hoverPos.y + 12 }} role="presentation">
                <div className="mono tt-path">{hn.path}</div>
                <div className="tt-meta">
                  <ShapeIcon type={hn.type} size={11} /> {TYPE_LABELS[hn.type]}
                  <span className="dep-count mono">imports {hn.fanOut}</span>
                  <span className="con-count mono">imported by {hn.fanIn}</span>
                </div>
                {selected === null && <div className="tt-hint faint">Click to lock · double-click to isolate</div>}
              </div>
            )}
            {pairInfo && hoverPair && (
              <div className="graph-tooltip glass" style={{ left: hoverPair.x + 14, top: hoverPair.y + 12 }} role="presentation">
                <div className="mono tt-path">
                  {basename(model.nodes[pairInfo.s].path)} <span className="dep-count">→</span> {basename(model.nodes[pairInfo.t].path)}
                </div>
                {pairInfo.edges.slice(0, 3).map((ei) => {
                  const e = model.edges[ei];
                  return (
                    <div key={ei} className="tt-meta mono">
                      <span className="faint">{e.kind}</span> {e.symbols.length ? e.symbols.slice(0, 4).join(', ') : 'side effect'} <span className="faint">· line {e.line}</span>
                    </div>
                  );
                })}
              </div>
            )}

            {mode === 'ring' && (
              <div className="legend ring-legend glass" aria-label="Legend">
                <ul>
                  <li>
                    <svg width="26" height="8" aria-hidden="true">
                      <line x1="0" y1="4" x2="20" y2="4" stroke="#ff5c5c" strokeWidth="2" />
                      <path d="M20 0.5L26 4L20 7.5z" fill="#ff5c5c" />
                    </svg>
                    Imports (A → B)
                  </li>
                  <li>
                    <svg width="26" height="8" aria-hidden="true">
                      <line x1="0" y1="4" x2="20" y2="4" stroke="#4c9aff" strokeWidth="2" />
                      <path d="M20 0.5L26 4L20 7.5z" fill="#4c9aff" />
                    </svg>
                    Imported by (when focused)
                  </li>
                  <li>
                    <svg width="26" height="8" aria-hidden="true">
                      <line x1="0" y1="4" x2="26" y2="4" stroke="#ff5c5c" strokeWidth="1.6" strokeDasharray="5 3" />
                    </svg>
                    Dynamic import()
                  </li>
                  <li>
                    <svg width="26" height="8" aria-hidden="true">
                      <line x1="0" y1="4" x2="26" y2="4" stroke="#a0a0a0" strokeWidth="1.6" strokeDasharray="1.5 3" />
                    </svg>
                    Unresolved
                  </li>
                </ul>
                <p className="mono small ring-count">{count}</p>
                <p className="faint small">
                  {level === 'ticks' ? 'Zoom in for file names.' : level === 'names' ? 'Zoom in further for directories.' : 'Showing names, directories and types.'} Hover a file · click to lock · double-click to isolate · click a category band.
                </p>
              </div>
            )}
          </div>
        )}
        <div className="visually-hidden" aria-live="polite">
          {announcement}
        </div>
      </div>

      {selectedId && !smallScreen && mode !== 'summary' && (
        <DetailsPanel
          src={src}
          project={project}
          commitSha={graph.analysis.commitSha}
          model={model}
          nodeId={selectedId}
          depth={1}
          onDepth={() => {}}
          onSelect={(id) => {
            const i = model.index.get(id);
            if (i !== undefined) reveal(i);
          }}
          onClose={() => {
            select(null);
            setIsolatedId(null);
          }}
          isolated={isolatedId === selectedId}
          onArchitecture={onArchitecture}
          onIsolate={(id) => {
            const i = model.index.get(id);
            if (i !== undefined) isolate(i);
          }}
          onCycle={(ci) => {
            const first = model.index.get(model.cycles[ci].members[0]);
            if (first !== undefined) reveal(first);
          }}
        />
      )}

      {palette && <SearchDialog items={paletteItems} actions={paletteActions} onClose={() => setPalette(false)} emptyHint={`${num(model.nodes.length)} files. Type a file name, path or directory, or a command.`} />}
      {share && src.projectId && <ShareDialog create={() => api.createShare(src.projectId!, 'wireframe')} onClose={() => setShare(false)} kind="wireframe" />}
    </div>
  );
}
