import { CaseSensitive, FileSearch, FolderTree, PanelRightClose, PanelRightOpen, RotateCw, Search, WholeWord, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ErrorNotice } from '../../components/ui.tsx';
import { api, ApiError, code, type CodeFile, type CodeSearchResult, type CodeTree, type Project } from '../../lib/api.ts';
import { useAsync, useMediaQuery } from '../../lib/hooks.ts';
import { Explorer } from './Explorer.tsx';
import { IntelPanel } from './IntelPanel.tsx';
import { QuickOpen } from './QuickOpen.tsx';
import { SearchResults } from './SearchResults.tsx';
import { ancestors, buildTree, bytes, parseLines, type TreeNode } from './tree.ts';
import { Viewer } from './Viewer.tsx';

/*
 * The Code tab: the repository as imported, readable while the analysis is still running.
 * The URL is the source of truth for the open file and highlighted lines (?file=…&line=12-20),
 * so file:line links from every other view land here; the snapshot is pinned once resolved.
 */

export interface CodeLocation {
  file: string | null;
  line?: string | null;
  analysisId?: string;
}

interface Props {
  project: Project;
  file?: string;
  line?: string;
  commit?: string;
  analysisId?: string;
  onLocation(loc: CodeLocation, replace?: boolean): void;
}

const STAGE_TEXT: Record<string, string> = { queued: 'queued', cloning: 'cloning', scanning: 'scanning', parsing: 'parsing', resolving: 'resolving', building: 'building', storing: 'storing files' };

export function CodeView({ project, file, line, commit, analysisId, onLocation }: Props) {
  const [snap, setSnap] = useState<{ analysisId?: string; commit?: string }>({ analysisId, commit });
  const [poll, setPoll] = useState(0);
  // A link to another commit or snapshot switches the snapshot shown.
  useEffect(() => {
    setSnap((s) => (s.analysisId === analysisId && s.commit === commit ? s : { analysisId, commit }));
  }, [analysisId, commit]);
  const tree = useAsync(() => code.tree(project.id, snap), [project.id, snap.analysisId, snap.commit, poll]);
  const [last, setLast] = useState<CodeTree | undefined>();
  useEffect(() => {
    if (tree.data) setLast(tree.data);
  }, [tree.data]);
  const t = tree.data ?? last;
  const pinned = t?.snapshot.analysisId;

  // While files are being imported, keep the listing fresh.
  useEffect(() => {
    if (!t || (t.state !== 'storing' && t.state !== 'pending')) return;
    const h = setTimeout(() => setPoll((n) => n + 1), 1500);
    return () => clearTimeout(h);
  }, [t]);

  const root = useMemo(() => buildTree(t?.entries ?? []), [t?.entries]);
  const entryByPath = useMemo(() => new Map((t?.entries ?? []).map((e) => [e.p.replace(/\/$/, ''), e])), [t?.entries]);

  // Open tabs (per project and snapshot, for this browser session).
  const tabsKey = `codepilot.code.tabs.${project.id}.${pinned ?? ''}`;
  const [tabs, setTabs] = useState<string[]>([]);
  useEffect(() => {
    if (!pinned) return;
    try {
      const saved = JSON.parse(sessionStorage.getItem(tabsKey) ?? '[]') as string[];
      setTabs((cur) => [...new Set([...saved.filter((p) => entryByPath.has(p)), ...cur])]);
    } catch {
      /* storage unavailable */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinned]);
  useEffect(() => {
    try {
      if (pinned) sessionStorage.setItem(tabsKey, JSON.stringify(tabs.slice(-20)));
    } catch {
      /* storage unavailable */
    }
  }, [tabs, tabsKey, pinned]);

  const active = file ?? null;
  const range = useMemo(() => parseLines(line), [line]);
  const [scrollNonce, setScrollNonce] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [reveal, setReveal] = useState<{ path: string; nonce: number } | null>(null);

  // The URL changed (a link from another view, a tab, back/forward): show that file and lines.
  useEffect(() => {
    if (!active) return;
    setTabs((cur) => (cur.includes(active) ? cur : [...cur, active]));
    setExpanded((cur) => {
      const need = ancestors(active).filter((a) => !cur.has(a));
      return need.length ? new Set([...cur, ...need]) : cur;
    });
    setReveal({ path: active, nonce: Date.now() });
    setScrollNonce((n) => n + 1);
  }, [active, line]);

  const open = useCallback(
    (path: string, ln?: number | string | null) => {
      onLocation({ file: path, line: ln == null ? null : String(ln) }, path === active);
    },
    [onLocation, active],
  );

  // File, outline and relations of the active tab; contents are cached per snapshot.
  const cache = useRef(new Map<string, CodeFile>());
  const fileState = useAsync(async () => {
    if (!active || !pinned || !t || t.state === 'pending') return undefined;
    const key = `${pinned}:${active}`;
    const hit = cache.current.get(key);
    if (hit) return hit;
    const f = await code.file(project.id, pinned, active);
    cache.current.set(key, f);
    return f;
  }, [project.id, pinned, active, t?.state === 'pending']);
  const stored = fileState.data?.stored ? fileState.data : null;
  const outline = useAsync(() => (stored && pinned ? code.outline(project.id, pinned, stored.path) : Promise.resolve(undefined as never)), [project.id, pinned, stored?.path]);
  const relations = useAsync(() => (stored && pinned ? code.relations(project.id, pinned, stored.path) : Promise.resolve(undefined as never)), [project.id, pinned, stored?.path, t?.snapshot.analysisStatus]);

  // Layout: the intelligence panel folds away on narrower screens, the explorer on phones.
  const wide = useMediaQuery('(min-width: 1101px)');
  const phone = useMediaQuery('(max-width: 760px)');
  const [intelOpen, setIntelOpen] = useState<boolean | null>(null);
  const showIntel = intelOpen ?? wide;
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [left, setLeft] = useState<'files' | 'search'>('files');

  // Search across stored files.
  const [query, setQuery] = useState('');
  const [caseSensitive, setCase] = useState(false);
  const [wholeWord, setWord] = useState(false);
  const [search, setSearch] = useState<{ result: CodeSearchResult | null; loading: boolean; error: ApiError | null }>({ result: null, loading: false, error: null });
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!pinned || !query.trim()) {
      setSearch({ result: null, loading: false, error: null });
      return;
    }
    const ctl = new AbortController();
    setSearch((s) => ({ ...s, loading: true, error: null }));
    const h = setTimeout(() => {
      code
        .search(project.id, pinned, query, { caseSensitive, wholeWord }, ctl.signal)
        .then((result) => !ctl.signal.aborted && setSearch({ result, loading: false, error: null }))
        .catch((error: unknown) => !ctl.signal.aborted && setSearch({ result: null, loading: false, error: error instanceof ApiError ? error : new ApiError(0, { code: 'unknown', message: 'Search failed. Try again.' }) }));
    }, 250);
    return () => {
      clearTimeout(h);
      ctl.abort();
    };
  }, [project.id, pinned, query, caseSensitive, wholeWord]);

  // Keyboard: Ctrl/⌘+P opens a file, Ctrl/⌘+Shift+F searches code.
  const [quick, setQuick] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setQuick(true);
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setLeft('search');
        if (phone) setExplorerOpen(true);
        searchInput.current?.focus();
        searchInput.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phone]);

  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState<'code' | 'path' | null>(null);
  useEffect(() => {
    if (!note) return;
    const h = setTimeout(() => setNote(null), 6000);
    return () => clearTimeout(h);
  }, [note]);
  const copy = async (what: 'code' | 'path') => {
    const f = fileState.data;
    if (!f) return;
    try {
      // The stored content is already masked, so copied code never contains a secret value.
      await navigator.clipboard.writeText(what === 'path' ? f.path : f.stored ? f.content : '');
      setCopied(what);
      setNote(what === 'path' ? `Copied ${f.path}` : `Copied ${f.stored ? f.lines.toLocaleString() : 0} lines${f.stored && f.maskedLines.length ? ' — masked secrets stay masked' : ''}`);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setNote('The browser blocked clipboard access.');
    }
  };

  const [retrying, setRetrying] = useState<ApiError | 'busy' | null>(null);
  const retry = async () => {
    setRetrying('busy');
    try {
      const r = await api.createProject(project.owner, project.repo, project.branch);
      setRetrying(null);
      setSnap({ analysisId: r.analysisId });
      onLocation({ file: null, analysisId: r.analysisId }, true);
    } catch (e) {
      setRetrying(e as ApiError);
    }
  };

  const closeTab = (path: string) => {
    const i = tabs.indexOf(path);
    const next = tabs.filter((p) => p !== path);
    setTabs(next);
    if (path === active) onLocation({ file: next[Math.min(i, next.length - 1)] ?? null }, true);
  };

  const toggle = useCallback((path: string, openIt?: boolean) => {
    setExpanded((cur) => {
      const n = new Set(cur);
      if (openIt ?? !n.has(path)) n.add(path);
      else n.delete(path);
      return n;
    });
  }, []);
  const openNode = useCallback(
    (n: TreeNode) => {
      open(n.path);
      if (phone) setExplorerOpen(false);
    },
    [open, phone],
  );

  /* ---------------------------------------------------------------- states */

  if (!t) {
    if (tree.error) {
      return (
        <div className="view-pad narrow">
          <ErrorNotice error={tree.error} onRetry={tree.reload} />
        </div>
      );
    }
    return (
      <div className="code-shell is-loading" aria-busy="true">
        <p className="code-loading faint">Loading the repository’s files…</p>
      </div>
    );
  }

  const failureTitle = (stage: string) => `Import failed at ${STAGE_TEXT[stage] ?? stage}`;
  const retryButton = t.canRetry && (
    <button type="button" className="btn btn-sm btn-primary" onClick={retry} disabled={retrying === 'busy'}>
      <RotateCw size={13} /> {retrying === 'busy' ? 'Retrying…' : 'Retry'}
    </button>
  );

  if (t.state === 'empty' || t.state === 'failed' || t.state === 'pending' || t.state === 'not-stored') {
    const github = project.htmlUrl;
    return (
      <div className="code-shell">
        <div className="code-state" role={t.state === 'failed' ? 'alert' : 'status'}>
          {t.state === 'empty' ? (
            <>
              <h2>Repository was empty</h2>
              <p>
                {project.fullName} has no files on <span className="mono">{t.snapshot.branch}</span> to import yet. Push a commit, then re-analyze.
              </p>
              {retryButton}
            </>
          ) : t.state === 'failed' ? (
            <>
              <h2>{failureTitle(t.failure?.stage ?? 'storing')}</h2>
              <p>{t.failure?.message ?? t.storeError ?? 'The import did not finish.'}</p>
              {retryButton}
              {!t.canRetry && <p className="small faint">Only the project owner can start the import again.</p>}
            </>
          ) : t.state === 'pending' ? (
            <>
              <h2>Importing the repository…</h2>
              <p>
                {STAGE_TEXT[t.snapshot.analysisStage] ? `Now ${STAGE_TEXT[t.snapshot.analysisStage]}. ` : ''}Files appear here as soon as they are stored — before the analysis finishes.
              </p>
            </>
          ) : (
            <>
              <h2>Files for this snapshot weren’t stored</h2>
              <p>It was analyzed before the Code tab existed. Re-analyze to import its files.</p>
              {retryButton}
              {github && (
                <a className="btn btn-sm btn-ghost" href={github} target="_blank" rel="noreferrer">
                  Open on GitHub
                </a>
              )}
            </>
          )}
          {retrying && retrying !== 'busy' && <ErrorNotice error={retrying} />}
        </div>
      </div>
    );
  }

  const githubHref = active && project.htmlUrl && t.snapshot.commitSha ? `${project.htmlUrl}/blob/${t.snapshot.commitSha}/${active.split('/').map(encodeURIComponent).join('/')}${range ? `#L${range.from}${range.to !== range.from ? `-L${range.to}` : ''}` : ''}` : null;
  const reasonsTitle = Object.entries(t.counts.byReason)
    .map(([r, n]) => `${n} · ${t.reasons[r] ?? r}`)
    .join('\n');

  return (
    <div className={`code-shell${showIntel ? ' has-intel' : ''}${explorerOpen ? ' explorer-open' : ''}`}>
      <div className="code-top">
        {phone && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setExplorerOpen(!explorerOpen)} aria-expanded={explorerOpen} aria-label="Files and search">
            <FolderTree size={14} />
          </button>
        )}
        <div className="code-snap mono" title={`Snapshot ${t.snapshot.analysisId}`}>
          {t.snapshot.branch}
          {t.snapshot.commitSha ? ` @ ${t.snapshot.commitSha.slice(0, 7)}` : ''}
        </div>
        <div className="code-counts" title={reasonsTitle || undefined}>
          <strong>{t.counts.stored.toLocaleString()}</strong> files stored · <strong>{t.counts.notStored.toLocaleString()}</strong> not stored
          {t.counts.notStoredDirectories > 0 && <span className="faint"> ({t.counts.notStoredDirectories} {t.counts.notStoredDirectories === 1 ? 'directory' : 'directories'} not entered)</span>}
        </div>
        <div className="spacer" />
        <button type="button" className="btn btn-sm btn-ghost code-goto" onClick={() => setQuick(true)} title="Go to file (Ctrl+P)">
          <FileSearch size={14} /> <span>Go to file</span> <kbd>Ctrl P</kbd>
        </button>
        <div className={`code-search${left === 'search' ? ' is-active' : ''}`}>
          <Search size={13} aria-hidden="true" />
          <input
            ref={searchInput}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setLeft('search');
            }}
            onFocus={() => query && setLeft('search')}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setLeft('files');
                (e.target as HTMLInputElement).blur();
              }
            }}
            placeholder="Search code  (Ctrl Shift F)"
            aria-label="Search the repository’s code"
            spellCheck={false}
          />
          <button type="button" className="icon-btn" aria-pressed={caseSensitive} onClick={() => setCase(!caseSensitive)} title="Match case">
            <CaseSensitive size={14} />
          </button>
          <button type="button" className="icon-btn" aria-pressed={wholeWord} onClick={() => setWord(!wholeWord)} title="Whole word">
            <WholeWord size={14} />
          </button>
        </div>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setIntelOpen(!showIntel)} aria-pressed={showIntel} title={showIntel ? 'Hide outline and usage' : 'Show outline and usage'}>
          {showIntel ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
        </button>
      </div>

      {(t.state === 'storing' || t.failure || t.truncated || t.snapshot.analysisStatus === 'running' || t.snapshot.analysisStatus === 'queued') && (
        <div className="code-banner" role="status">
          {t.state === 'storing' ? (
            <span>Storing files… {t.counts.stored.toLocaleString()} stored so far. You can read them now.</span>
          ) : t.snapshot.analysisStatus === 'running' || t.snapshot.analysisStatus === 'queued' ? (
            <span>Analysis is still running — files are ready to read; Used by and import links appear when it finishes.</span>
          ) : null}
          {t.truncated && <span>Only the first {t.counts.stored.toLocaleString()} files were stored (the import limit).</span>}
          {t.failure && (
            <span className="code-banner-risk">
              {failureTitle(t.failure.stage)} for a newer import{t.failure.message ? ` — ${t.failure.message}` : ''}. Showing the last stored snapshot. {retryButton}
            </span>
          )}
        </div>
      )}

      <div className="code-body">
        <aside className="code-left" aria-label="Files and search">
          <div className="code-left-tabs" role="tablist" aria-label="Left panel">
            <button role="tab" aria-selected={left === 'files'} onClick={() => setLeft('files')}>
              Files
            </button>
            <button role="tab" aria-selected={left === 'search'} onClick={() => setLeft('search')}>
              Search{search.result ? ` · ${search.result.matches.toLocaleString()}` : ''}
            </button>
            {phone && (
              <button type="button" className="icon-btn" onClick={() => setExplorerOpen(false)} aria-label="Close files">
                <X size={14} />
              </button>
            )}
          </div>
          {left === 'files' ? (
            <Explorer root={root} reasons={t.reasons} active={active} expanded={expanded} onToggle={toggle} onOpen={openNode} reveal={reveal} />
          ) : (
            <div className="code-search-results">
              <SearchResults
                query={query}
                {...search}
                onOpen={(path, ln) => {
                  open(path, ln);
                  if (phone) setExplorerOpen(false);
                }}
              />
            </div>
          )}
        </aside>

        <section className="code-center" aria-label="Code viewer">
          {tabs.length > 0 && (
            <div className="code-tabs" role="tablist" aria-label="Open files">
              {tabs.map((p) => {
                const e = entryByPath.get(p);
                return (
                  <div key={p} className={`code-tab${p === active ? ' is-active' : ''}${e?.r ? ' is-excluded' : ''}`} role="presentation">
                    <button role="tab" aria-selected={p === active} onClick={() => p !== active && onLocation({ file: p })} onAuxClick={(ev) => ev.button === 1 && closeTab(p)} title={p}>
                      {p.slice(p.lastIndexOf('/') + 1)}
                    </button>
                    <button type="button" className="code-tab-x" onClick={() => closeTab(p)} aria-label={`Close ${p}`}>
                      <X size={12} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {!active ? (
            <div className="cv-state">
              <h3>{t.counts.stored ? 'Choose a file' : 'No readable files were stored'}</h3>
              <p className="small faint">
                {t.counts.stored
                  ? `${t.counts.stored.toLocaleString()} files from ${t.snapshot.branch}${t.snapshot.commitSha ? ` @ ${t.snapshot.commitSha.slice(0, 7)}` : ''} · ${bytes(t.counts.bytes)}. Press Ctrl+P to open one by name, or Ctrl+Shift+F to search.`
                  : 'Everything in this snapshot was excluded; the explorer shows each entry and why.'}
              </p>
            </div>
          ) : fileState.error ? (
            <div className="cv-state">
              <h3>{fileState.error.status === 404 ? 'This file is not in this snapshot' : 'Could not load this file'}</h3>
              <p className="small faint mono">{active}</p>
              <p className="small">{fileState.error.message}</p>
              {fileState.error.status !== 404 && (
                <button type="button" className="btn btn-sm" onClick={fileState.reload}>
                  Retry
                </button>
              )}
            </div>
          ) : !fileState.data || fileState.data.path !== active ? (
            <div className="cv-state" aria-busy="true">
              <p className="faint small">Opening {active}…</p>
            </div>
          ) : (
            <Viewer
              file={fileState.data}
              range={range}
              scrollNonce={scrollNonce}
              imports={relations.data?.status === 'ready' ? relations.data.imports : []}
              githubHref={githubHref}
              copied={copied}
              onCrumb={(folder) => {
                setExpanded((cur) => new Set([...cur, ...ancestors(`${folder}/x`)]));
                setLeft('files');
                if (phone) setExplorerOpen(true);
                setReveal({ path: folder, nonce: Date.now() });
              }}
              onOpen={(path, ln) => open(path, ln)}
              onLine={(n, extend) => {
                const from = extend && range ? Math.min(range.from, n) : n;
                const to = extend && range ? Math.max(range.from, n) : n;
                onLocation({ file: active, line: from === to ? String(from) : `${from}-${to}` }, true);
              }}
              onCopy={copy}
              onNote={setNote}
            />
          )}
          <p className="code-note small" role="status" aria-live="polite">
            {note ?? ''}
          </p>
        </section>

        {showIntel && (
          <aside className="code-right" aria-label="Outline and usage">
            {stored ? (
              <IntelPanel path={stored.path} outline={outline} relations={relations} onOpen={(p, ln) => open(p, ln)} onLine={(n) => onLocation({ file: stored.path, line: String(n) }, true)} />
            ) : (
              <p className="ci-note">Open a file to see its outline and which files use it.</p>
            )}
          </aside>
        )}
      </div>
      {quick && (
        <QuickOpen
          entries={t.entries}
          onClose={() => setQuick(false)}
          onOpen={(p, ln) => {
            setQuick(false);
            open(p, ln);
          }}
        />
      )}
    </div>
  );
}
