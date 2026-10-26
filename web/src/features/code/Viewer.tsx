import { Check, ChevronRight, Copy, ExternalLink, Link2, Lock } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { CodeFile, CodeRelations } from '../../lib/api.ts';
import { highlight, isHighlighted, MASK, type Token } from './highlight.ts';
import { bytes } from './tree.ts';
import { useVirtual } from './useVirtual.ts';

export const LINE_HEIGHT = 20;

type Import = CodeRelations['imports'][number];

export interface ViewerProps {
  file: CodeFile;
  range: { from: number; to: number } | null;
  /** Changes when the view should scroll to `range`. */
  scrollNonce: number;
  imports: Import[];
  githubHref: string | null;
  copied: 'code' | 'path' | null;
  onCrumb(folder: string): void;
  onOpen(path: string, line?: number): void;
  onLine(line: number, extend: boolean): void;
  onCopy(what: 'code' | 'path'): void;
  onNote(message: string): void;
}

/** Number of columns a line takes (tabs at 4), for the scroll width. */
const cols = (line: string) => {
  let n = 0;
  for (const c of line) n += c === '\t' ? 4 - (n % 4) : 1;
  return n;
};

export function Viewer(p: ViewerProps) {
  const { file } = p;
  const crumbs = file.path.split('/');
  return (
    <div className="cv">
      <div className="cv-head">
        <nav className="cv-crumbs mono" aria-label="File path" ref={(el) => {
          if (el) el.scrollLeft = el.scrollWidth;
        }}>
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            return (
              <span key={i} className="cv-crumb">
                {i > 0 && <ChevronRight size={12} aria-hidden="true" className="faint" />}
                {last ? (
                  <span aria-current="page">{c}</span>
                ) : (
                  <button type="button" onClick={() => p.onCrumb(crumbs.slice(0, i + 1).join('/'))} title={`Show ${crumbs.slice(0, i + 1).join('/')} in the explorer`}>
                    {c}
                  </button>
                )}
              </span>
            );
          })}
        </nav>
        <div className="cv-actions">
          {file.stored && (
            <span className="cv-meta mono">
              {file.language === 'text' ? 'plain text' : file.language} · {file.lines.toLocaleString()} lines · {bytes(file.size)}
            </span>
          )}
          {file.stored && file.maskedLines.length > 0 && (
            <span className="cv-masked-badge" title={`Secret values on line${file.maskedLines.length === 1 ? '' : 's'} ${file.maskedLines.join(', ')} were replaced with ${MASK} when the repository was imported. They are masked in search and copy too.`}>
              <Lock size={11} aria-hidden="true" /> {file.maskedLines.length} masked
            </span>
          )}
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => p.onCopy('path')} aria-label="Copy file path">
            {p.copied === 'path' ? <Check size={13} /> : <Link2 size={13} />} Path
          </button>
          {file.stored && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => p.onCopy('code')} aria-label="Copy file contents">
              {p.copied === 'code' ? <Check size={13} /> : <Copy size={13} />} Copy
            </button>
          )}
          {p.githubHref && (
            <a className="btn btn-sm btn-ghost" href={p.githubHref} target="_blank" rel="noreferrer" aria-label="Open on GitHub at this commit">
              <ExternalLink size={13} />
            </a>
          )}
        </div>
      </div>
      {file.stored ? <Code {...p} file={file} /> : <NotStored file={file} />}
    </div>
  );
}

function NotStored({ file }: { file: Extract<CodeFile, { stored: false }> }) {
  return (
    <div className="cv-state">
      <Lock size={18} aria-hidden="true" className="faint" />
      <h3>
        {file.path}
        {file.directory ? '/' : ''} was not stored
      </h3>
      <p>{file.reasonText}.</p>
      <p className="small faint">
        {file.reason === 'secret-file' || file.reason === 'secret-content'
          ? 'Sensitive files are skipped at import, so their contents never reach CodePilot’s storage.'
          : file.reason === 'excluded-directory'
            ? 'Dependency, build and tool directories are not part of the repository’s own code, so they are not imported.'
            : file.reason === 'too-large'
              ? `Files over the size limit are not imported${file.size ? ` (this one is ${bytes(file.size)})` : ''}.`
              : 'Only readable text files are imported.'}
      </p>
    </div>
  );
}

function Code(p: ViewerProps & { file: Extract<CodeFile, { stored: true }> }) {
  const { file, range } = p;
  const lines = useMemo(() => highlight(file.content, file.language), [file.content, file.language]);
  const width = useMemo(() => {
    let max = 0;
    for (const l of file.content.split('\n')) max = Math.max(max, cols(l));
    return max;
  }, [file.content]);
  const ref = useRef<HTMLDivElement>(null);
  const { start, end, total } = useVirtual(ref, lines.length, LINE_HEIGHT, 20);
  const gutter = String(lines.length).length + 2;
  const byLine = useMemo(() => {
    const m = new Map<number, Import[]>();
    for (const i of p.imports) m.set(i.line, [...(m.get(i.line) ?? []), i]);
    return m;
  }, [p.imports]);
  const masked = useMemo(() => new Set(file.maskedLines), [file.maskedLines]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!range) {
      el.scrollTop = 0;
      return;
    }
    const top = (range.from - 1) * LINE_HEIGHT;
    el.scrollTop = Math.max(0, top - Math.min(el.clientHeight / 3, 160));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.scrollNonce, file.path]);

  if (!lines.length) {
    return (
      <div className="cv-state">
        <h3>This file is empty</h3>
        <p className="small faint">It is stored, but has no content.</p>
      </div>
    );
  }
  return (
    <>
      {!isHighlighted(file.language) && <p className="cv-note small faint">No syntax highlighting for this file type — shown as plain text.</p>}
      <div className="cv-scroll" ref={ref} tabIndex={0} role="region" aria-label={`Contents of ${file.path}, ${file.lines} lines, read-only`}>
        <div className="cv-canvas" style={{ height: total, width: `calc(${gutter + width + 4}ch + 32px)`, ['--gutter' as string]: `${gutter}ch` }}>
          {Array.from({ length: Math.max(0, end - start) }, (_, k) => {
            const n = start + k + 1;
            const inRange = !!range && n >= range.from && n <= range.to;
            return (
              <CodeLine
                key={n}
                n={n}
                tokens={lines[n - 1]}
                top={(n - 1) * LINE_HEIGHT}
                hl={inRange ? (n === range!.from ? 'first' : 'in') : null}
                masked={masked.has(n)}
                imports={byLine.get(n)}
                onLine={p.onLine}
                onOpen={p.onOpen}
                onNote={p.onNote}
              />
            );
          })}
        </div>
      </div>
      <span className="sr-only" aria-live="polite">
        {range ? `Line ${range.from}${range.to !== range.from ? ` to ${range.to}` : ''} highlighted.` : ''}
      </span>
    </>
  );
}

const CodeLine = memo(function CodeLine(props: {
  n: number;
  tokens: Token[];
  top: number;
  hl: 'first' | 'in' | null;
  masked: boolean;
  imports?: Import[];
  onLine(line: number, extend: boolean): void;
  onOpen(path: string, line?: number): void;
  onNote(message: string): void;
}) {
  const { n, tokens, imports } = props;
  const used = new Set<Import>();
  const parts: ReactNode[] = tokens.map(([k, t], i) => {
    if (k === 'm')
      return (
        <span key={i} className="t-m" title="Secret value masked by CodePilot at import">
          {t}
        </span>
      );
    // An import's specifier links to what it resolves to; unresolved ones say why, never guess.
    if (k === 's' && imports) {
      const spec = t.slice(1, -1);
      const imp = imports.find((x) => !used.has(x) && x.specifier === spec);
      if (imp) {
        used.add(imp);
        const label = imp.resolved && !imp.external ? `Open ${imp.target}` : imp.external ? `External package ${imp.packageName ?? spec} — not part of this repository` : `Unresolved import: ${imp.reason}`;
        return (
          <span key={i} className="t-s">
            {t[0]}
            <button
              type="button"
              className={`cv-imp ${imp.resolved ? (imp.external ? 'is-external' : 'is-resolved') : 'is-unresolved'}`}
              title={label}
              aria-label={label}
              onClick={() => (imp.resolved && !imp.external && imp.target ? props.onOpen(imp.target) : props.onNote(`${spec}: ${label.replace(/^Unresolved import: /, 'unresolved — ')}`))}
            >
              {spec}
            </button>
            {t[t.length - 1]}
          </span>
        );
      }
    }
    return (
      <span key={i} className={k ? `t-${k}` : undefined}>
        {t}
      </span>
    );
  });
  return (
    <div className={`cv-line${props.hl ? ` is-hl${props.hl === 'first' ? ' is-first' : ''}` : ''}${props.masked ? ' has-mask' : ''}`} style={{ top: props.top }}>
      <button type="button" className="cv-ln" onClick={(e) => props.onLine(n, e.shiftKey)} aria-label={`Line ${n}`} tabIndex={-1}>
        {n}
      </button>
      <span className="cv-text">{parts.length ? parts : '​'}</span>
    </div>
  );
});
