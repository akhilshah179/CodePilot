import { Ban, ChevronDown, ChevronRight, File, FileCode2, FileJson, FileText, FlaskConical, Folder, FolderOpen, Image, Lock, Settings, Palette, Code2, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { bytes, fileIconKind, flatten, type FileIconKind, type TreeNode } from './tree.ts';
import { useVirtual } from './useVirtual.ts';

const ROW = 26;

const ICONS: Record<FileIconKind, typeof File> = {
  code: FileCode2,
  json: FileJson,
  markup: Code2,
  style: Palette,
  doc: FileText,
  config: Settings,
  image: Image,
  lock: Lock,
  binary: Ban,
  text: FileText,
  test: FlaskConical,
};

/** Short reason labels for entries that were not stored (the full text is in the title). */
const SHORT: Record<string, string> = {
  'excluded-directory': 'not entered',
  'secret-file': 'sensitive',
  'secret-content': 'private key',
  generated: 'generated',
  lockfile: 'lockfile',
  binary: 'binary',
  symlink: 'symlink',
  'too-large': '> 1 MB',
};

export function Explorer(props: {
  root: TreeNode;
  reasons: Record<string, string>;
  active: string | null;
  expanded: Set<string>;
  onToggle(path: string, open?: boolean): void;
  onOpen(node: TreeNode): void;
  reveal: { path: string; nonce: number } | null;
}) {
  const { root, reasons, active, expanded, onToggle, onOpen, reveal } = props;
  const [filter, setFilter] = useState('');
  const rows = useMemo(() => flatten(root, expanded, filter), [root, expanded, filter]);
  const ref = useRef<HTMLDivElement>(null);
  const { start, end, total } = useVirtual(ref, rows.length, ROW);
  const [focus, setFocus] = useState(0);
  const keyboard = useRef(false);

  // Reveal the active file: scroll its row into view.
  useEffect(() => {
    if (!reveal) return;
    const i = rows.findIndex((r) => r.node.path === reveal.path);
    if (i < 0 || !ref.current) return;
    setFocus(i);
    const el = ref.current;
    if (i * ROW < el.scrollTop || (i + 1) * ROW > el.scrollTop + el.clientHeight) el.scrollTop = i * ROW - el.clientHeight / 3;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal, rows.length]);

  useEffect(() => {
    if (!keyboard.current) return;
    keyboard.current = false;
    const el = ref.current;
    if (!el) return;
    if (focus * ROW < el.scrollTop) el.scrollTop = focus * ROW;
    else if ((focus + 1) * ROW > el.scrollTop + el.clientHeight) el.scrollTop = (focus + 1) * ROW - el.clientHeight;
    requestAnimationFrame(() => el.querySelector<HTMLElement>(`[data-index="${focus}"]`)?.focus());
  }, [focus]);

  const onKey = (e: KeyboardEvent) => {
    const row = rows[focus];
    const move = (i: number) => {
      e.preventDefault();
      keyboard.current = true;
      setFocus(Math.max(0, Math.min(rows.length - 1, i)));
    };
    if (e.key === 'ArrowDown') move(focus + 1);
    else if (e.key === 'ArrowUp') move(focus - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(rows.length - 1);
    else if (e.key === 'PageDown') move(focus + 15);
    else if (e.key === 'PageUp') move(focus - 15);
    else if (!row) return;
    else if (e.key === 'ArrowRight' && row.node.dir && !row.node.reason) {
      e.preventDefault();
      if (!expanded.has(row.node.path)) onToggle(row.node.path, true);
      else move(focus + 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (row.node.dir && expanded.has(row.node.path)) onToggle(row.node.path, false);
      else {
        const parent = row.node.path.slice(0, row.node.path.lastIndexOf('/'));
        const i = rows.findIndex((r) => r.node.path === parent);
        if (i >= 0) move(i);
      }
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (row.node.dir && !row.node.reason) onToggle(row.node.path);
      else onOpen(row.node);
    }
  };

  return (
    <div className="cx">
      <div className="cx-filter">
        <Search size={13} aria-hidden="true" />
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter files" aria-label="Filter files by path" spellCheck={false} />
        {filter && (
          <button type="button" className="icon-btn" onClick={() => setFilter('')} aria-label="Clear filter">
            <X size={13} />
          </button>
        )}
      </div>
      <div className="cx-list" ref={ref} role="tree" aria-label="Repository files" onKeyDown={onKey}>
        {rows.length === 0 && <p className="cx-empty small faint">{filter ? `No file path contains “${filter}”.` : 'No files.'}</p>}
        <div style={{ height: total, position: 'relative' }}>
          {rows.slice(start, end).map((r, k) => {
            const i = start + k;
            const n = r.node;
            const open = n.dir && expanded.has(n.path);
            const Icon = n.dir ? (open ? FolderOpen : Folder) : ICONS[fileIconKind(n.path, n.entry?.l, n.reason)];
            const reasonText = n.reason ? reasons[n.reason] ?? n.reason : '';
            return (
              <div
                key={n.path}
                role="treeitem"
                aria-level={r.depth + 1}
                aria-expanded={n.dir && !n.reason ? open : undefined}
                aria-selected={active === n.path}
                aria-label={n.reason ? `${n.name}${n.dir ? '/' : ''} — not stored: ${reasonText}` : n.name}
                tabIndex={i === focus ? 0 : -1}
                data-index={i}
                className={`cx-row${active === n.path ? ' is-active' : ''}${n.reason ? ' is-excluded' : ''}`}
                style={{ top: i * ROW, paddingLeft: 8 + r.depth * 14 }}
                title={n.reason ? `${n.path}${n.dir ? '/' : ''} — not stored: ${reasonText}` : `${n.path}${n.entry?.s != null ? ` · ${bytes(n.entry.s)}` : ''}`}
                onClick={() => {
                  setFocus(i);
                  if (n.dir && !n.reason) onToggle(n.path);
                  else onOpen(n);
                }}
              >
                <span className="cx-caret" aria-hidden="true">
                  {n.dir && !n.reason ? open ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : null}
                </span>
                <Icon size={14} className={`cx-icon k-${n.dir ? 'dir' : fileIconKind(n.path, n.entry?.l, n.reason)}`} aria-hidden="true" />
                <span className="cx-name">
                  {n.name}
                  {n.dir && n.reason ? '/' : ''}
                </span>
                {n.reason ? <span className="cx-reason">{SHORT[n.reason] ?? n.reason}</span> : n.entry?.m ? <span className="cx-masked" title={`${n.entry.m} secret value${n.entry.m === 1 ? '' : 's'} masked`}><Lock size={10} /></span> : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
