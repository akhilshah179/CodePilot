import { Boxes, Download, Expand, Layers, Maximize2, Minus, Network, Plus, RefreshCw, RotateCcw, Search, Share2, Sigma, Table2, Users, Workflow } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ErrorNotice, IconButton } from '../../components/ui.tsx';
import { api, data, type ApiError, type ArchitectureResponse, type DataSource, type Flow, type Project, type SystemNode } from '../../lib/api.ts';
import { fileOpener } from '../../lib/fileLinks.ts';
import { useAsync, useMediaQuery } from '../../lib/hooks.ts';
import { SearchDialog, type PaletteItem } from '../project/SearchDialog.tsx';
import { ShareDialog } from '../project/ShareDialog.tsx';
import { ArchSummaryPanel } from './ArchPanels.tsx';
import { CategoryIcon } from './CategoryIcon.tsx';
import { Lifecycle } from './Lifecycle.tsx';
import { SystemInspector } from './SystemInspector.tsx';
import { SystemMap, type SystemMapHandle } from './SystemMap.tsx';
import { TechMatrix } from './TechMatrix.tsx';
import { CollectivePanel } from '../collective/CollectivePanel.tsx';

type Mode = 'system' | 'matrix' | 'flows' | 'collective';
const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: 'system', label: 'System map', hint: 'How the system works: clients, transports, APIs, middleware, handlers, services, data and external services' },
  { id: 'matrix', label: 'Technologies', hint: 'Every detected technology with version, role, users and evidence' },
  { id: 'flows', label: 'Request flows', hint: 'What happens when a user performs an action, step by step' },
  { id: 'collective', label: 'Collective', hint: 'How this architecture compares with anonymized contributing projects (aggregate statistics only)' },
];
const MODE_KEY = 'codepilot.architecture.mode';
const introPlayed = new Set<string>();
const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

function readMode(): Mode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (MODES.some((m) => m.id === v)) return v as Mode;
  } catch {
    /* storage unavailable */
  }
  return 'system';
}

interface Props {
  src: DataSource;
  project: Project;
  embed?: boolean;
  /** Select the component that contains this file (cross-link from the Wireframe). */
  focusFile?: string;
  /** Open a file in the Wireframe (cross-link). */
  onWireframe?(path: string): void;
  /** Focus a technology's connections on the map / open a request flow (cross-links). */
  focusTech?: string;
  openFlowId?: string;
  /** Explain a technology in Technology Intelligence (cross-link). */
  onIntelligence?(techId: string): void;
  onAutomation?(flowId: string): void;
}

/**
 * Architecture answers "how does the system work?": a layered system map, the technologies that
 * power it, and traced request lifecycles — every element backed by evidence from the code.
 */
export function ArchitectureView({ src, project, embed, focusFile, onWireframe, focusTech, openFlowId, onIntelligence, onAutomation }: Props) {
  const [nonce, setNonce] = useState(0);
  const overview = useAsync(() => data.architecture(src), [src.base, nonce]);
  const [regenerated, setRegenerated] = useState<ArchitectureResponse | null>(null);
  const res = regenerated ?? overview.data;
  const arch = res?.architecture;
  const [mode, setModeState] = useState<Mode>(readMode);
  const [selected, setSelected] = useState<string | null>(null);
  const [focus, setFocus] = useState<Set<string> | null>(null);
  const [techHighlight, setTechHighlight] = useState<string | null>(null);
  const [flowId, setFlowId] = useState<string | null>(null);
  const [summary, setSummary] = useState(false);
  const [palette, setPalette] = useState(false);
  const [share, setShare] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [regenError, setRegenError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [announce, setAnnounce] = useState('');
  const mapRef = useRef<SystemMapHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const small = useMediaQuery('(max-width: 760px)');
  const opener = fileOpener(project, res?.analysis.commitSha ?? null);

  const flowsReq = useAsync(() => (arch?.flows.length ? data.flows(src) : Promise.resolve({ flows: [] as Flow[], evidence: {} })), [src.base, arch?.id]);
  const flows = flowsReq.data?.flows ?? [];
  const byId = useMemo(() => new Map(arch?.nodes.map((n) => [n.id, n]) ?? []), [arch]);
  const system = arch?.system;
  const sysById = useMemo(() => new Map(system?.nodes.map((n) => [n.id, n]) ?? []), [system]);

  const setMode = useCallback((m: Mode) => {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* storage unavailable */
    }
  }, []);

  const select = useCallback(
    (id: string | null) => {
      setSelected(id);
      setFocus(null);
      const n = id ? sysById.get(id) : undefined;
      if (n) setAnnounce(`Selected ${n.name}: ${n.detail}`);
    },
    [sysById],
  );

  /** Focus a technology (or an application's libraries) in the system map. */
  const focusArch = useCallback(
    (archId: string) => {
      if (!system) return;
      const n = byId.get(archId);
      const ids = new Set<string>();
      for (const sn of system.nodes) if (sn.arch === archId) ids.add(sn.id);
      // Libraries render inside the applications that use them.
      if (!ids.size) for (const h of n?.hosts ?? [archId]) for (const sn of system.nodes) if (sn.arch === h || sn.app === h) ids.add(sn.id);
      for (const l of system.links) if (ids.has(l.source) || ids.has(l.target)) (ids.add(l.source), ids.add(l.target));
      setMode('system');
      setSelected(null);
      setFocus(ids);
      setAnnounce(`Showing ${n?.name ?? archId} and its connections.`);
      setTimeout(() => mapRef.current?.fit([...ids]), 30);
    },
    [system, byId, setMode],
  );

  const openFlow = useCallback(
    (id: string) => {
      setFlowId(id);
      setMode('flows');
    },
    [setMode],
  );

  // Cross-link from the Wireframe: select the component containing the file.
  useEffect(() => {
    if (!focusFile || !system) return;
    const n = system.nodes.find((x) => x.files.some((f) => f.path === focusFile) && (x.kind === 'handler' || x.kind === 'service')) ?? system.nodes.find((x) => x.files.some((f) => f.path === focusFile));
    if (n) {
      setMode('system');
      setSelected(n.id);
      setTimeout(() => mapRef.current?.fit([n.id]), 60);
    }
  }, [focusFile, system, setMode]);

  // Cross-links from Technology Intelligence: a technology's connections, or a request flow.
  useEffect(() => {
    if (focusTech && system && byId.has(focusTech)) focusArch(focusTech);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTech, system]);
  useEffect(() => {
    if (openFlowId) openFlow(openFlowId);
  }, [openFlowId, openFlow]);

  const reset = useCallback(() => {
    setSelected(null);
    setFocus(null);
    setTechHighlight(null);
    mapRef.current?.fit();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette(true);
        return;
      }
      if (palette || share || isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '/') {
        e.preventDefault();
        setPalette(true);
      } else if ((e.key === 'f' || e.key === 'F') && mode === 'system') mapRef.current?.fit();
      else if (e.key === 'r' || e.key === 'R') reset();
      else if (e.key === 'Escape') {
        if (selected || focus) reset();
        else setSummary(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [palette, share, mode, selected, focus, reset]);

  const regenerate = async () => {
    setBusy(true);
    setRegenError(null);
    try {
      setRegenerated(await data.regenerate(src));
      setSelected(null);
      setFocus(null);
      setAnnounce('Architecture regenerated from the stored analysis.');
    } catch (e) {
      setRegenError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  if (overview.error && !regenerated) {
    const unavailable = overview.error.body.code === 'architecture_unavailable';
    return (
      <div className="view-pad narrow">
        <ErrorNotice error={unavailable ? { message: overview.error.body.message } : overview.error} onRetry={unavailable ? undefined : () => setNonce((n) => n + 1)} />
      </div>
    );
  }
  if (!arch || !res) return <div className="view-pad faint">Loading architecture…</div>;

  if (!arch.nodes.some((n) => n.display === 'node')) {
    return (
      <div className="view-pad narrow">
        <div className="empty-state glass">
          <Boxes size={22} />
          <h2>No architecture could be established</h2>
          <p className="muted">The analysis found no runnable application, technology or infrastructure with evidence in this repository. CodePilot does not draw what it cannot trace.</p>
        </div>
      </div>
    );
  }

  const selectedNode = selected ? sysById.get(selected) : undefined;
  const paletteItems: PaletteItem[] = [
    ...(system?.nodes ?? []).map((n: SystemNode) => ({
      id: `sys-${n.id}`,
      label: n.name,
      detail: `${n.kind} · ${n.detail}`,
      key: `${n.name} ${n.kind} ${n.detail} ${n.files.map((f) => f.path).join(' ')} ${(n.routes ?? []).map((r) => r.path).join(' ')}`,
      group: 'Components',
      run: () => {
        setMode('system');
        select(n.id);
        setTimeout(() => mapRef.current?.fit([n.id]), 30);
      },
    })),
    ...arch.nodes
      .filter((n) => n.kind !== 'app')
      .map((n) => ({ id: `tech-${n.id}`, label: n.name, detail: `${n.category} · ${n.role}`, key: `${n.name} ${n.category}`, group: 'Technologies', icon: <CategoryIcon category={n.category} size={13} />, run: () => focusArch(n.id) })),
  ];
  const actions: PaletteItem[] = [
    ...MODES.map((m) => ({ id: `mode-${m.id}`, label: m.label, group: 'Commands', run: () => setMode(m.id) })),
    ...arch.flows.map((f) => ({ id: `flow-${f.id}`, label: `Trace: ${f.action?.label ?? f.title}`, group: 'Request flows', icon: <Workflow size={13} />, run: () => openFlow(f.id) })),
    { id: 'summary', label: 'Summary: pattern, strengths, risks', group: 'Commands', run: () => setSummary(true) },
  ];

  return (
    <div className={`arch-workspace arch-v3 mode-${mode}${selectedNode && mode === 'system' ? ' with-inspector' : ''}${embed ? ' is-embed' : ''}`} ref={rootRef}>
      <div className="arch-main">
        <header className="arch-header">
          <div className="arch-heading">
            <h2>Architecture</h2>
            <p className="small muted">
              {arch.totals.apps} application{arch.totals.apps === 1 ? '' : 's'} · {arch.totals.tools} technologies · {system ? `${system.nodes.length} components` : `${arch.totals.edges} connections`} · {arch.flows.length} traced flow{arch.flows.length === 1 ? '' : 's'} · {arch.totals.evidence} evidence lines
              {arch.patterns[0] ? (
                <>
                  {' '}
                  · <span className="pattern-name">{arch.patterns.map((p) => p.name).join(' + ')}</span>
                </>
              ) : null}
            </p>
          </div>
          <div className="arch-modes" role="tablist" aria-label="Architecture view">
            {MODES.filter((m) => m.id !== 'collective' || !src.readOnly).map((m) => (
              <button key={m.id} type="button" role="tab" aria-selected={mode === m.id} onClick={() => setMode(m.id)} data-tip={m.hint} className={m.id === 'collective' ? 'is-collective' : undefined}>
                {m.id === 'system' ? <Layers size={14} /> : m.id === 'matrix' ? <Table2 size={14} /> : m.id === 'flows' ? <Workflow size={14} /> : <Users size={14} />}
                <span>{m.label}</span>
              </button>
            ))}
          </div>
          <div className="arch-actions">
            <IconButton label="Search components, technologies and flows" shortcut="/" onClick={() => setPalette(true)}>
              <Search size={15} />
            </IconButton>
            <IconButton label="Summary: pattern, strengths, risks" pressed={summary} onClick={() => setSummary((v) => !v)}>
              <Sigma size={15} />
            </IconButton>
            <div className="menu-wrap">
              <IconButton label="Export" pressed={exportOpen} onClick={() => setExportOpen((v) => !v)}>
                <Download size={15} />
              </IconButton>
              {exportOpen && (
                <div className="menu glass menu-right" role="menu" onClick={() => setExportOpen(false)}>
                  {(
                    [
                      ['png', 'PNG', 'architecture diagram image'],
                      ['svg', 'SVG', 'vector diagram'],
                      ['pdf', 'PDF one-pager', 'diagram, pattern, risks and technologies'],
                      ['mermaid', 'Mermaid', 'paste into docs and READMEs'],
                      ['json', 'JSON', 'every node, component, flow and evidence line'],
                    ] as const
                  ).map(([f, label, hint]) => (
                    <a key={f} role="menuitem" href={data.archExportUrl(src, f, 'dataflow')} download>
                      <span>{label}</span>
                      <span className="faint small">{hint}</span>
                    </a>
                  ))}
                </div>
              )}
            </div>
            {!src.readOnly && (
              <>
                <IconButton label={busy ? 'Regenerating…' : 'Regenerate architecture from the stored analysis'} onClick={regenerate} disabled={busy}>
                  <RefreshCw size={15} className={busy ? 'spin' : ''} />
                </IconButton>
                <IconButton label="Share a read-only or embeddable link" onClick={() => setShare(true)}>
                  <Share2 size={15} />
                </IconButton>
              </>
            )}
            <IconButton
              label="Fullscreen"
              onClick={() => {
                if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
                else rootRef.current?.requestFullscreen?.().catch(() => {});
              }}
            >
              <Expand size={15} />
            </IconButton>
          </div>
        </header>

        {regenError && <ErrorNotice error={regenError} />}

        {mode === 'system' &&
          (!system || !system.nodes.length ? (
            <div className="view-pad narrow">
              <div className="empty-state glass">
                <Network size={22} />
                <h2>System map not available for this analysis</h2>
                <p className="muted">This architecture was computed before system maps existed. {src.readOnly ? 'The owner can regenerate it.' : 'Regenerate it from the stored analysis, or re-analyze the repository.'}</p>
                {!src.readOnly && (
                  <button type="button" className="btn btn-primary" onClick={regenerate} disabled={busy}>
                    <RefreshCw size={14} /> Regenerate
                  </button>
                )}
              </div>
            </div>
          ) : small ? (
            <SystemList map={system} onSelect={select} selected={selected} />
          ) : (
            <div className="arch-canvas-area">
              <SystemMap
                ref={mapRef}
                key={arch.id}
                map={system}
                archById={byId}
                selected={selected}
                focus={focus}
                playIntro={!introPlayed.has(src.base + arch.id)}
                onIntroDone={() => introPlayed.add(src.base + arch.id)}
                onSelect={select}
              />
              <div className="floating-toolbar glass sys-toolbar" role="toolbar" aria-label="Map controls">
                <IconButton label="Zoom out" shortcut="−" onClick={() => mapRef.current?.zoomBy(1 / 1.3)}>
                  <Minus size={15} />
                </IconButton>
                <IconButton label="Zoom in" shortcut="+" onClick={() => mapRef.current?.zoomBy(1.3)}>
                  <Plus size={15} />
                </IconButton>
                <IconButton label="Fit" shortcut="F" onClick={() => mapRef.current?.fit()}>
                  <Maximize2 size={15} />
                </IconButton>
                <IconButton label="Reset" shortcut="R" onClick={reset}>
                  <RotateCcw size={15} />
                </IconButton>
                {focus && (
                  <button type="button" className="btn btn-sm" onClick={() => setFocus(null)}>
                    Show all
                  </button>
                )}
              </div>
              <div className="arch-legend sys-legend glass" aria-label="Legend">
                <ul>
                  {(
                    [
                      ['#00d2ff', '', 'Transport (REST, SSE, WebSocket…)'],
                      ['rgba(255,255,255,0.55)', '', 'Routes / calls between modules'],
                      ['#4c9aff', '', 'Reads / queries'],
                      ['#10b981', '', 'Writes'],
                      ['#ffb020', '6 4', 'Async (queue, does not block)'],
                      ['#ef4444', '1.5 4', 'Target unknown'],
                    ] as const
                  ).map(([c, dash, label]) => (
                    <li key={label}>
                      <svg width="30" height="8" aria-hidden="true">
                        <path d="M1 4H24" stroke={c} strokeWidth="1.8" strokeDasharray={dash || undefined} />
                        <path d="M29 4L23 1V7Z" fill={c} />
                      </svg>
                      {label}
                    </li>
                  ))}
                </ul>
                <p className="faint small">Arrows point in the direction of the call. Dashed card = strong inference; dotted = possible. Click a component for its evidence.</p>
              </div>
            </div>
          ))}

        {mode === 'collective' && (src.readOnly ? <div className="view-pad faint">Collective Intelligence is not available on shared links.</div> : <CollectivePanel project={project} />)}

        {mode === 'matrix' && (
          <TechMatrix
            arch={arch}
            opener={opener}
            highlight={techHighlight}
            onExplain={onIntelligence}
            onFocus={(id) => {
              setTechHighlight(id);
              focusArch(id);
            }}
          />
        )}

        {mode === 'flows' &&
          (flowsReq.loading && !flows.length ? (
            <div className="view-pad faint">Loading request flows…</div>
          ) : (
            <Lifecycle
              flows={flows}
              evidence={{ ...arch.evidence, ...(flowsReq.data?.evidence ?? {}) }}
              archById={byId}
              opener={opener}
              flowId={flowId}
              onFlow={setFlowId}
              onWireframe={onWireframe}
              onNode={focusArch}
              onAutomation={onAutomation}
            />
          ))}

        {summary && (
          <ArchSummaryPanel
            src={src}
            opener={opener}
            onFocus={(ids) => {
              if (ids[0]) focusArch(ids[0]);
            }}
            onClose={() => setSummary(false)}
          />
        )}
        <div className="visually-hidden" aria-live="polite">
          {announce}
        </div>
      </div>

      {selectedNode && mode === 'system' && system && (
        <SystemInspector
          src={src}
          node={selectedNode}
          arch={selectedNode.arch ? byId.get(selectedNode.arch) : undefined}
          map={system}
          evidence={arch.evidence}
          flows={arch.flows}
          opener={opener}
          onSelect={(id) => {
            select(id);
            mapRef.current?.fit([id]);
          }}
          onWireframe={onWireframe}
          onFlow={openFlow}
          onMatrix={(id) => {
            setTechHighlight(id);
            setMode('matrix');
          }}
          onIntelligence={onIntelligence}
          onClose={() => select(null)}
        />
      )}
      {palette && <SearchDialog items={paletteItems} actions={actions} placeholder="Search components, technologies, routes and flows…" emptyHint="Try a route (/api/…), a technology (Redis), a file, or a flow." onClose={() => setPalette(false)} />}
      {share && src.projectId && <ShareDialog kind="architecture" create={() => api.createShare(src.projectId!, 'architecture')} onClose={() => setShare(false)} />}
    </div>
  );
}

/** Small screens: the system map as a vertical list, layer by layer. */
function SystemList({ map, selected, onSelect }: { map: NonNullable<ArchitectureResponse['architecture']['system']>; selected: string | null; onSelect(id: string | null): void }) {
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  return (
    <div className="sys-list">
      {map.layers.map((layer) => (
        <section key={layer} className="sys-list-layer">
          <h3 className="eyebrow">{layer === 'client' ? 'Client / Frontend' : layer === 'transport' ? 'Transport / API' : layer === 'backend' ? 'Backend / Application' : layer === 'services' ? 'Services' : layer === 'data' ? 'Data / Cache' : layer === 'async' ? 'Async workers' : layer === 'external' ? 'External services' : 'Deployment / Infrastructure'}</h3>
          <ul>
            {map.nodes
              .filter((n) => n.layer === layer)
              .map((n) => {
                const out = map.links.filter((l) => l.source === n.id);
                return (
                  <li key={n.id}>
                    <button type="button" aria-expanded={selected === n.id} onClick={() => onSelect(selected === n.id ? null : n.id)}>
                      <strong>{n.name}</strong>
                      <span className="faint small mono">{n.detail}</span>
                    </button>
                    {selected === n.id && out.length > 0 && (
                      <ul className="sys-list-links">
                        {out.map((l) => (
                          <li key={l.id} className="mono small">
                            → {byId.get(l.target)?.name ?? l.target} <span className="faint">{l.label}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
          </ul>
        </section>
      ))}
    </div>
  );
}
